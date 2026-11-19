// tools/cek-kesehatan.mjs — pemeriksaan baca-saja untuk pipeline netflow.
//
// Pemakaian:
//   node --env-file-if-exists=.env tools/cek-kesehatan.mjs
//
// Keluar dengan kode 1 kalau ada pemeriksaan yang ✗.

import mysql from 'mysql2/promise';

const c = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  dateStrings: true,
});

const one = async (sql, p = []) => (await c.query(sql, p))[0][0];

const hasil = [];
function cek(nama, ok, detail) {
  hasil.push({ nama, ok, detail });
}

const [[ver]] = await c.query('SELECT VERSION() v, @@time_zone tz');

// 1. data masuk?
const lag = await one(`
  SELECT TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(MAX(ts)), NOW()) d FROM traffic_1m`);
cek('ingest (traffic_1m)', lag.d !== null && lag.d < 180, `lag ${lag.d ?? '-'} detik`);

// 2. heartbeat
const hb = await one(`
  SELECT last_flow_ts, TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(last_flow_ts), NOW()) d,
         last_flush_at FROM ingest_status WHERE id = 1`);
cek('ingest_status', hb.last_flow_ts !== null && hb.d < 180,
  hb.last_flow_ts === null ? 'kosong — ingest belum di-restart' : `lag ${hb.d} detik, flush ${hb.last_flush_at}`);

// 3. cakupan rollup
const cov = await one(`
  SELECT ROUND(
    (SELECT SUM(bytes) FROM traffic_1h WHERE ts_hour >= UNIX_TIMESTAMP(CURDATE()))
    / NULLIF((SELECT SUM(bytes) FROM traffic_1m WHERE ts >= UNIX_TIMESTAMP(CURDATE())), 0)
    * 100, 1) p`);
cek('cakupan rollup', Number(cov.p) >= 95, `${cov.p ?? '-'}% (jam berjalan boleh < 100)`);

// 4. kelengkapan tabel rollup
const [[roll]] = await c.query(`
  SELECT (SELECT COUNT(*) FROM traffic_1h) h,
         (SELECT COUNT(*) FROM traffic_daily) d,
         (SELECT COUNT(*) FROM traffic_monthly) m,
         (SELECT COUNT(*) FROM flows_daily_ip) ip,
         (SELECT COUNT(*) FROM svc_hourly) sh,
         (SELECT COUNT(*) FROM svc_daily) sd`);
cek('tabel rollup', roll.h > 0 && roll.d > 0 && roll.m > 0 && roll.ip > 0,
  `1h ${roll.h}, daily ${roll.d}, monthly ${roll.m}, ip ${roll.ip}`);
cek('tabel layanan', roll.sh > 0 && roll.sd > 0,
  `svc_hourly ${roll.sh}, svc_daily ${roll.sd}` +
  (roll.sh > 0 ? '' : ' — jalankan: npm run rollup:svc'));

// 5. identitas perangkat
const dev = await one(`
  SELECT COUNT(*) total,
         SUM(hostname IS NOT NULL AND hostname <> '') bernama,
         MAX(last_seen_ts) seen_ts,
         TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(MAX(last_seen_ts)), NOW()) umur
    FROM devices`);
cek('devices', dev.umur !== null && dev.umur < 3600,
  `${dev.total} perangkat, ${dev.bernama} bernama, sync ${dev.umur ?? '-'} detik lalu`);

// 6. router_stat
const rs = await one(`
  SELECT COUNT(*) n, TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(MAX(ts)), NOW()) umur
    FROM router_stat`);
cek('router_stat', rs.n > 0 && rs.umur < 300,
  rs.n ? `${rs.n} baris, terakhir ${rs.umur} detik lalu` : 'kosong — sync-router belum dijadwalkan');

// 7. port_map + sesi + log
const pm = await one(`SELECT COUNT(*) n, MAX(last_seen) seen FROM port_map`);
const sess = await one(`
  SELECT COUNT(*) n FROM router_session WHERE last_seen >= UNIX_TIMESTAMP() - 300`);
const log = await one(`
  SELECT COUNT(*) n, TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(MAX(ts)), NOW()) umur FROM router_log`);
cek('port_map', pm.n > 0, `${pm.n} MAC`);
cek('router_session', true, `${sess.n} sesi aktif (<5 menit)`);
cek('router_log', log.n > 0 && log.umur < 600,
  log.n ? `${log.n} baris, terbaru ${log.umur} detik lalu` : 'kosong');

// 8. proporsi (lainnya)
const [lain] = await c.query(`
  SELECT dir, ROUND(SUM(CASE WHEN remote_ip='(lainnya)' THEN bytes ELSE 0 END)
                / SUM(bytes) * 100, 1) p
    FROM flows_daily_ip WHERE day = CURDATE() GROUP BY dir`);
for (const r of lain) {
  cek(`(lainnya) ${r.dir}`, Number(r.p) < 60, `${r.p}% tidak dirinci`);
}

console.log(`MySQL ${ver.v} | time_zone ${ver.tz}\n`);
let gagal = 0;
for (const r of hasil) {
  if (!r.ok) gagal++;
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.nama.padEnd(20)} ${r.detail}`);
}
console.log(`\n${gagal ? `${gagal} pemeriksaan GAGAL` : 'semua pemeriksaan LULUS'}`);
await c.end();
if (gagal) process.exitCode = 1;