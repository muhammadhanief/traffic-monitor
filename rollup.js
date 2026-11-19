// rollup.js — merangkum data netflow ke tabel jangka panjang.
//
// Pemakaian:
//   node --env-file-if-exists=.env rollup.js --hourly   (tiap jam)
//   node --env-file-if-exists=.env rollup.js --daily    (tiap hari 00:15)
//   node --env-file-if-exists=.env rollup.js            (keduanya, untuk manual/backfill)
//
// Prinsip: setiap rangkuman DIHITUNG ULANG lalu ditimpa (DELETE + INSERT dalam
// satu transaksi), bukan ditambahkan. Jadi aman dijalankan berulang, aman
// setelah server mati, dan tidak pernah menghitung ganda.

import mysql from 'mysql2/promise';
import { DB, ensureSchema, target } from './db.js';

const mode = process.argv.includes('--daily') ? 'daily'
  : process.argv.includes('--hourly') ? 'hourly'
  : 'all';

// --backfill: hitung ulang seluruh rentang yang masih tersedia, sekali jalan.
// Dipakai setelah task rollup lama tidak berjalan (jam-jam yang terlewat tidak
// bisa dipulihkan oleh jendela normal 26 jam).
const BACKFILL = process.argv.includes('--backfill');

const keepMinuteDays = Number(process.env.KEEP_MINUTE_DAYS || 30);
const keepDetailDays = Number(process.env.KEEP_DETAIL_DAYS || 3);

const CFG = {
  keepDetailDays,
  keepMinuteDays,
  keepHourDays: Number(process.env.KEEP_HOUR_DAYS || 730),
  keepDailyIpDays: Number(process.env.KEEP_DAILY_IP_DAYS || 1825),
  // ambang penyimpanan IP tujuan (byte). Di bawah ini digabung ke '(lainnya)'
  ipDailyMin: Number(process.env.IP_DAILY_MIN_BYTES || 20971520), // 20 MB/hari
  ipMonthlyMin: Number(process.env.IP_MONTHLY_MIN_BYTES || 52428800), // 50 MB/bulan
  // jendela hitung ulang
  hourWindow: BACKFILL ? keepMinuteDays * 24 : Number(process.env.ROLLUP_HOUR_WINDOW || 26),
  dayWindow: BACKFILL ? keepMinuteDays : Number(process.env.ROLLUP_DAY_WINDOW || 2),
  // flows_daily_ip hanya bisa dihitung dari flows_5m yang masih tersimpan
  detailWindow: Math.min(
    keepDetailDays,
    Number(process.env.ROLLUP_DETAIL_WINDOW || keepDetailDays)
  ),
};

const mb = (b) => (Number(b) / 1024 / 1024).toFixed(1);

// Jalankan DELETE + INSERT sebagai satu transaksi supaya pembaca tidak pernah
// melihat tabel dalam keadaan kosong.
async function refresh(conn, label, delSql, insSqls) {
  const ins = Array.isArray(insSqls) ? insSqls : [insSqls];
  await conn.beginTransaction();
  try {
    const [d] = await conn.query(delSql);
    let written = 0;
    for (const sql of ins) {
      const [r] = typeof sql === 'string' ? await conn.query(sql) : await conn.query(sql.sql, sql.params);
      written += r.affectedRows;
    }
    await conn.commit();
    console.log(`  ${label.padEnd(16)} hapus ${d.affectedRows} → tulis ${written} baris`);
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  }
}

// ---------- rollup per jam ----------
// Catatan: INTERVAL tidak bisa dikurangkan langsung dari hasil UNIX_TIMESTAMP()
// (menghasilkan NULL), jadi jendelanya dihitung sebagai pengurangan detik.
const HOUR_START = "UNIX_TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00'))";
const HOUR_WINDOW = `(${HOUR_START} - ${CFG.hourWindow * 3600})`;

async function hourly(conn) {
  console.log('\n[hourly] rangkum per jam / hari / bulan');

  await refresh(conn, 'traffic_1h',
    `DELETE FROM traffic_1h WHERE ts_hour >= ${HOUR_WINDOW}`,
    `INSERT INTO traffic_1h (ts_hour, local_ip, dir, wan_if, bytes, packets)
     SELECT ts - MOD(ts, 3600), local_ip, dir, wan_if, SUM(bytes), SUM(packets)
     FROM traffic_1m
     WHERE ts >= ${HOUR_WINDOW}
     GROUP BY ts - MOD(ts, 3600), local_ip, dir, wan_if`);

  await refresh(conn, 'traffic_daily',
    `DELETE FROM traffic_daily WHERE day >= CURDATE() - INTERVAL ${CFG.dayWindow} DAY`,
    `INSERT INTO traffic_daily (day, local_ip, dir, wan_if, bytes, packets)
     SELECT DATE(FROM_UNIXTIME(ts_hour)), local_ip, dir, wan_if, SUM(bytes), SUM(packets)
     FROM traffic_1h
     WHERE ts_hour >= UNIX_TIMESTAMP(CURDATE() - INTERVAL ${CFG.dayWindow} DAY)
     GROUP BY DATE(FROM_UNIXTIME(ts_hour)), local_ip, dir, wan_if`);

  await refresh(conn, 'traffic_monthly',
    `DELETE FROM traffic_monthly WHERE month >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')`,
    `INSERT INTO traffic_monthly (month, local_ip, dir, wan_if, bytes, packets)
     SELECT DATE_FORMAT(day, '%Y-%m-01'), local_ip, dir, wan_if, SUM(bytes), SUM(packets)
     FROM traffic_daily
     WHERE day >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')
     GROUP BY DATE_FORMAT(day, '%Y-%m-01'), local_ip, dir, wan_if`);
}

// ---------- rollup per hari ----------
async function daily(conn) {
  console.log('\n[daily] rangkum IP tujuan harian & bulanan');

  // 1. IP tujuan harian dari detail 5 menit (masih ada karena retensi 3 hari).
  await refresh(conn, 'flows_daily_ip',
    `DELETE FROM flows_daily_ip WHERE day >= CURDATE() - INTERVAL ${CFG.detailWindow} DAY`,
    [
      // 1a. IP yang melewati ambang
      {
        sql: `INSERT INTO flows_daily_ip (day, local_ip, remote_ip, dir, bytes, packets)
              SELECT DATE(FROM_UNIXTIME(ts)), local_ip, remote_ip, dir, SUM(bytes), SUM(packets)
              FROM flows_5m
              WHERE ts >= UNIX_TIMESTAMP(CURDATE() - INTERVAL ${CFG.detailWindow} DAY)
              GROUP BY DATE(FROM_UNIXTIME(ts)), local_ip, remote_ip, dir
              HAVING SUM(bytes) >= ?`,
        params: [CFG.ipDailyMin],
      },
      // 1b. sisanya digabung jadi '(lainnya)' per perangkat+arah
      {
        sql: `INSERT INTO flows_daily_ip (day, local_ip, remote_ip, dir, bytes, packets)
              SELECT t.day, t.local_ip, '(lainnya)', t.dir,
                     t.bytes - COALESCE(k.bytes, 0),
                     t.packets - COALESCE(k.packets, 0)
              FROM (
                SELECT DATE(FROM_UNIXTIME(ts)) AS day, local_ip, dir,
                       SUM(bytes) AS bytes, SUM(packets) AS packets
                FROM flows_5m
                WHERE ts >= UNIX_TIMESTAMP(CURDATE() - INTERVAL ${CFG.detailWindow} DAY)
                GROUP BY DATE(FROM_UNIXTIME(ts)), local_ip, dir
              ) t
              LEFT JOIN (
                SELECT day, local_ip, dir, SUM(bytes) AS bytes, SUM(packets) AS packets
                FROM flows_daily_ip
                WHERE day >= CURDATE() - INTERVAL ${CFG.detailWindow} DAY
                  AND remote_ip <> '(lainnya)'
                GROUP BY day, local_ip, dir
              ) k ON k.day = t.day AND k.local_ip = t.local_ip AND k.dir = t.dir
              WHERE t.bytes - COALESCE(k.bytes, 0) > 0`,
      },
    ]);

  // 2. IP tujuan bulanan, diturunkan dari tabel harian (bulan ini & sebelumnya).
  const monthFrom = "DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')";
  await refresh(conn, 'flows_monthly_ip',
    `DELETE FROM flows_monthly_ip WHERE month >= ${monthFrom}`,
    [
      {
        sql: `INSERT INTO flows_monthly_ip (month, local_ip, remote_ip, dir, bytes, packets)
              SELECT DATE_FORMAT(day, '%Y-%m-01'), local_ip, remote_ip, dir,
                     SUM(bytes), SUM(packets)
              FROM flows_daily_ip
              WHERE day >= ${monthFrom} AND remote_ip <> '(lainnya)'
              GROUP BY DATE_FORMAT(day, '%Y-%m-01'), local_ip, remote_ip, dir
              HAVING SUM(bytes) >= ?`,
        params: [CFG.ipMonthlyMin],
      },
      {
        sql: `INSERT INTO flows_monthly_ip (month, local_ip, remote_ip, dir, bytes, packets)
              SELECT t.month, t.local_ip, '(lainnya)', t.dir,
                     t.bytes - COALESCE(k.bytes, 0),
                     t.packets - COALESCE(k.packets, 0)
              FROM (
                SELECT DATE_FORMAT(day, '%Y-%m-01') AS month, local_ip, dir,
                       SUM(bytes) AS bytes, SUM(packets) AS packets
                FROM flows_daily_ip
                WHERE day >= ${monthFrom}
                GROUP BY DATE_FORMAT(day, '%Y-%m-01'), local_ip, dir
              ) t
              LEFT JOIN (
                SELECT month, local_ip, dir, SUM(bytes) AS bytes, SUM(packets) AS packets
                FROM flows_monthly_ip
                WHERE month >= ${monthFrom} AND remote_ip <> '(lainnya)'
                GROUP BY month, local_ip, dir
              ) k ON k.month = t.month AND k.local_ip = t.local_ip AND k.dir = t.dir
              WHERE t.bytes - COALESCE(k.bytes, 0) > 0`,
      },
    ]);
}

// ---------- pembersihan data lama ----------
async function cleanup(conn) {
  console.log('\n[cleanup] buang data yang lewat masa retensi');
  const jobs = [
    ['flows_5m', `DELETE FROM flows_5m WHERE ts < UNIX_TIMESTAMP(NOW() - INTERVAL ${CFG.keepDetailDays} DAY)`],
    ['traffic_1m', `DELETE FROM traffic_1m WHERE ts < UNIX_TIMESTAMP(NOW() - INTERVAL ${CFG.keepMinuteDays} DAY)`],
    ['traffic_1h', `DELETE FROM traffic_1h WHERE ts_hour < UNIX_TIMESTAMP(NOW() - INTERVAL ${CFG.keepHourDays} DAY)`],
    ['flows_daily_ip', `DELETE FROM flows_daily_ip WHERE day < CURDATE() - INTERVAL ${CFG.keepDailyIpDays} DAY`],
  ];
  for (const [label, sql] of jobs) {
    const [r] = await conn.query(sql);
    if (r.affectedRows) console.log(`  ${label.padEnd(16)} hapus ${r.affectedRows} baris`);
  }
}

// ---------- ringkasan isi tabel ----------
async function report(conn) {
  const [rows] = await conn.query(`
    SELECT 'traffic_1m' t, COUNT(*) baris FROM traffic_1m
    UNION ALL SELECT 'traffic_1h', COUNT(*) FROM traffic_1h
    UNION ALL SELECT 'traffic_daily', COUNT(*) FROM traffic_daily
    UNION ALL SELECT 'traffic_monthly', COUNT(*) FROM traffic_monthly
    UNION ALL SELECT 'flows_5m', COUNT(*) FROM flows_5m
    UNION ALL SELECT 'flows_daily_ip', COUNT(*) FROM flows_daily_ip
    UNION ALL SELECT 'flows_monthly_ip', COUNT(*) FROM flows_monthly_ip`);
  console.log('\n=== isi tabel ===');
  for (const r of rows) console.log(`  ${r.t.padEnd(18)} ${String(r.baris).padStart(10)} baris`);

  const [[sums]] = await conn.query(`
    SELECT
      (SELECT COALESCE(SUM(bytes),0) FROM traffic_1m) AS m1,
      (SELECT COALESCE(SUM(bytes),0) FROM traffic_daily) AS daily,
      (SELECT COALESCE(SUM(bytes),0) FROM flows_daily_ip) AS dip,
      (SELECT COALESCE(SUM(bytes),0) FROM flows_5m) AS detail`);
  console.log(`  cek keseimbangan (byte):`);
  console.log(`    traffic_daily ${mb(sums.daily)} MB  vs  traffic_1m ${mb(sums.m1)} MB`);
  console.log(`    flows_daily_ip ${mb(sums.dip)} MB  vs  flows_5m ${mb(sums.detail)} MB`);
}

// ---------- jalan ----------
console.log(`Rollup mode=${mode} | ${target()}`);

const conn = await mysql.createConnection({ ...DB, dateStrings: true, multipleStatements: false });
try {
  await ensureSchema(conn);
  if (mode === 'hourly' || mode === 'all') await hourly(conn);
  if (mode === 'daily' || mode === 'all') await daily(conn);
  await cleanup(conn);
  await report(conn);
  console.log('\nSelesai.');
} catch (e) {
  console.error(`Gagal: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end().catch(() => {});
}