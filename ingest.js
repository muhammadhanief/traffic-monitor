// ingest.js
// Menjalankan GoFlow2 di belakang layar, membaca flow NetFlow v9 dari MikroTik
// (JSON per baris), mengagregasi di memori, lalu menulis ke MySQL tiap menit.
//
// Catatan NAT: flow download dicatat router SEBELUM alamat tujuannya
// diterjemahkan balik, jadi tujuannya masih IP publik router. Untuk mencari
// perangkat pemiliknya, flow download dicocokkan dengan flow upload dari
// koneksi yang sama (protokol + IP remote + port remote + port lokal).
//
// Rollup jangka panjang (per jam/hari/bulan) dikerjakan rollup.js.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { createPool, ensureSchema, target } from './db.js';

// ====== KONFIGURASI (ubah di sini, atau lewat environment variable) ======
const CONFIG = {
  // Lokasi goflow2.exe
  goflowPath:
    process.env.GOFLOW_PATH ||
    'C:\\Users\\ipds3\\Downloads\\goflow2-2.2.7-windows-amd64.exe',
  // Port UDP yang didengarkan. Harus sama dengan port target di MikroTik.
  listen: process.env.GOFLOW_LISTEN || 'netflow://:2055',
  // Koneksi database (host/user/password/nama DB) ada di .env -> db.js
  // ifIndex interface "bridge" (di data kamu: 20)
  bridgeIf: Number(process.env.BRIDGE_IF || 20),
  flushSec: Number(process.env.FLUSH_SEC || 60),
  detailBucketSec: 300, // tabel detail dikelompokkan per 5 menit
  keepDetailDays: Number(process.env.KEEP_DETAIL_DAYS || 3),
  // traffic_1m: dashboard/chart harian; sudah dirangkum rollup.js ke atasnya
  keepMinuteDays: Number(process.env.KEEP_MINUTE_DAYS || 30),
  maxDetailKeys: 400000, // batas aman memori, flush lebih awal bila terlewati
  natTtlSec: Number(process.env.NAT_TTL_SEC || 1200), // umur catatan koneksi upload
  pendingSec: Number(process.env.PENDING_SEC || 120), // lama menunggu pasangan download
  // Diagnostik: tulis N record mentah pertama dari GoFlow2 ke log (0 = mati).
  // Dipakai untuk memeriksa field apa saja yang dikirim router.
  rawDump: Number(process.env.RAW_DUMP || 0),
};

const UNKNOWN = 'tidak-diketahui';

// ====== DATABASE ======
// MySQL: ingest menulis, dashboard di PC lain bisa membaca langsung.
const pool = createPool();

const BATCH_ROWS = 1000; // baris per INSERT (batasi ukuran paket ke server)

const SQL_SUMMARY = `
  INSERT INTO traffic_1m (ts, local_ip, dir, wan_if, bytes, packets) VALUES ?
  ON DUPLICATE KEY UPDATE
    bytes = bytes + VALUES(bytes), packets = packets + VALUES(packets)
`;
const SQL_DETAIL = `
  INSERT INTO flows_5m (ts, local_ip, remote_ip, svc_port, proto, dir, wan_if, bytes, packets) VALUES ?
  ON DUPLICATE KEY UPDATE
    bytes = bytes + VALUES(bytes), packets = packets + VALUES(packets)
`;
// Detak pipeline: dashboard membaca ini untuk tahu apakah data masih segar.
// last_flow_ts memakai GREATEST supaya flow yang datang tidak berurutan
// (mis. router mengirim ulang) tidak memundurkan penanda.
const SQL_HEARTBEAT = `
  INSERT INTO ingest_status
    (id, host, last_flow_ts, last_flush_at, rows_last_flush, flows_last_flush, total_rows)
  VALUES (1, ?, ?, NOW(), ?, ?, ?) AS v
  ON DUPLICATE KEY UPDATE
    host             = v.host,
    last_flow_ts     = GREATEST(COALESCE(ingest_status.last_flow_ts, 0), v.last_flow_ts),
    last_flush_at    = v.last_flush_at,
    rows_last_flush  = v.rows_last_flush,
    flows_last_flush = v.flows_last_flush,
    total_rows       = v.total_rows
`;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function writeBatch(sRows, dRows) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const part of chunk(sRows, BATCH_ROWS)) {
      await conn.query(SQL_SUMMARY, [
        part.map((r) => [r.ts, r.local, r.dir, r.wanIf, r.bytes, r.packets]),
      ]);
    }
    for (const part of chunk(dRows, BATCH_ROWS)) {
      await conn.query(SQL_DETAIL, [
        part.map((r) => [
          r.ts, r.local, r.remote, r.svcPort, r.proto, r.dir, r.wanIf,
          r.bytes, r.packets,
        ]),
      ]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

// ====== STATE ======
let summary = new Map();
let detail = new Map();

const newStats = () => ({
  flows: 0, up: 0, down: 0, skipped: 0, bad: 0, joined: 0,
  matched: 0, unknown: 0, direct: 0, // byte download menurut cara atribusinya
});
let stats = newStats();
let badShown = 0;
let rawDumped = 0;

// kunci koneksi -> [ip perangkat, terakhir terlihat (detik)]
const connMap = new Map();
// flow download yang belum ketemu pasangan upload-nya
let pending = [];

// Penanda untuk tabel ingest_status
let lastFlowTs = 0;      // epoch flow terakhir yang diterima
let flowsSinceFlush = 0; // jumlah flow sejak flush terakhir
let totalRows = 0;       // baris yang sudah ditulis sejak proses start

const nowSec = () => Math.floor(Date.now() / 1000);
const connKey = (proto, remoteIp, remotePort, localPort) =>
  `${proto}|${remoteIp}|${remotePort}|${localPort}`;

// ====== AGREGASI ======
const sumKey = (r) => `${r.ts}|${r.local}|${r.dir}|${r.wanIf}`;
const detKey = (r) => `${r.ts}|${r.local}|${r.remote}|${r.svcPort}|${r.proto}|${r.dir}|${r.wanIf}`;

function add(map, key, row, bytes, packets) {
  const cur = map.get(key);
  if (cur) {
    cur.bytes += bytes;
    cur.packets += packets;
  } else {
    map.set(key, { ...row, bytes, packets });
  }
}

function record(c, local, t, proto, bytes, packets) {
  const ts1 = t - (t % 60);
  const sRow = { ts: ts1, local, dir: c.dir, wanIf: c.wanIf };
  add(summary, sumKey(sRow), sRow, bytes, packets);

  const tsD = t - (t % CONFIG.detailBucketSec);
  const dRow = {
    ts: tsD, local, remote: c.remote, svcPort: c.svcPort, proto, dir: c.dir, wanIf: c.wanIf,
  };
  add(detail, detKey(dRow), dRow, bytes, packets);

  if (detail.size >= CONFIG.maxDetailKeys) requestFlush();
}

// Tentukan arah flow dari interface masuk/keluar.
// - in_if = bridge, out_if = interface lain  -> upload (LAN ke WAN)
// - out_if = bridge, in_if = interface lain  -> download (WAN ke LAN)
// - selain itu (ke/dari router sendiri, dll) -> dilewati
function classify(f) {
  const b = CONFIG.bridgeIf;
  if (f.in_if === b && f.out_if && f.out_if !== b) {
    return { dir: 'up', wanIf: f.out_if, local: f.src_addr, remote: f.dst_addr, svcPort: f.dst_port };
  }
  if (f.out_if === b && f.in_if && f.in_if !== b) {
    return { dir: 'down', wanIf: f.in_if, local: f.dst_addr, remote: f.src_addr, svcPort: f.src_port };
  }
  return null;
}

// Apakah alamat tujuan flow download masih perlu dicarikan pemiliknya?
// IP privat dan IPv6 tidak melewati NAT, jadi sudah merupakan IP perangkat.
function needsNatLookup(ip) {
  if (ip.includes(':')) return false;
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

// Waktu flow (detik). Pakai waktu selesai flow; kalau jam router melenceng
// jauh dari jam PC, pakai waktu terima.
function flowSeconds(f) {
  const recv = Math.floor(f.time_received_ns / 1e9);
  const end = Math.floor((f.time_flow_end_ns || 0) / 1e9);
  return end && Math.abs(end - recv) < 3600 ? end : recv;
}

function attributeDown(p, ip, kind) {
  stats.down += p.bytes;
  stats[kind] += p.bytes;
  record(p.c, ip, p.t, p.proto, p.bytes, p.packets);
}

// Coba cocokkan ulang flow download yang menunggu. Yang sudah terlalu lama
// menunggu (atau semuanya, saat `final`) dicatat sebagai 'tidak-diketahui'.
function resolvePending(final = false) {
  if (!pending.length) return;
  const now = nowSec();
  const keep = [];
  for (const p of pending) {
    const hit = connMap.get(p.key);
    if (hit) attributeDown(p, hit[0], 'matched');
    else if (final || now - p.since >= CONFIG.pendingSec) attributeDown(p, UNKNOWN, 'unknown');
    else keep.push(p);
  }
  pending = keep;
}

function pruneConnMap() {
  const limit = nowSec() - CONFIG.natTtlSec;
  for (const [k, v] of connMap) if (v[1] < limit) connMap.delete(k);
}

function handleLine(line) {
  if (line.charCodeAt(0) !== 123) return; // bukan JSON ('{')
  if (rawDumped < CONFIG.rawDump) {
    rawDumped++;
    console.log(`[raw ${rawDumped}/${CONFIG.rawDump}] ${line}`);
  }
  // GoFlow2 kadang menulis dua record sekaligus tanpa pemisah baris: {...}{...}
  if (line.includes('}{"type"')) {
    stats.joined++;
    for (const part of line.split(/(?<=\})(?=\{"type")/)) handleRecord(part);
  } else {
    handleRecord(line);
  }
}

function handleRecord(line) {
  let f;
  try {
    f = JSON.parse(line);
  } catch (e) {
    stats.bad++;
    if (badShown < 3) {
      badShown++;
      console.error(`[rusak] ${e.message} (panjang baris ${line.length})\n${line}`);
    }
    return;
  }
  if (!f.src_addr || !f.dst_addr) return;
  stats.flows++;

  const c = classify(f);
  if (!c) {
    stats.skipped++;
    return;
  }

  const mult = f.sampling_rate > 1 ? f.sampling_rate : 1;
  const bytes = (f.bytes || 0) * mult;
  const packets = (f.packets || 0) * mult;
  const t = flowSeconds(f);
  const proto = String(f.proto);
  if (t > lastFlowTs) lastFlowTs = t;
  flowsSinceFlush++;

  if (c.dir === 'up') {
    // Catat koneksi ini: remote + port remote + port asli perangkat -> IP perangkat
    connMap.set(connKey(proto, c.remote, c.svcPort, f.src_port), [c.local, nowSec()]);
    stats.up += bytes;
    record(c, c.local, t, proto, bytes, packets);
    return;
  }

  // dir === 'down'
  const p = { c, t, proto, bytes, packets, since: nowSec(), key: '' };
  if (!needsNatLookup(c.local)) {
    attributeDown(p, c.local, 'direct');
    return;
  }
  p.key = connKey(proto, c.remote, c.svcPort, f.dst_port);
  const hit = connMap.get(p.key);
  if (hit) attributeDown(p, hit[0], 'matched');
  else pending.push(p); // pasangan upload mungkin belum diekspor router
}

function printStats() {
  const mb = (n) => (n / 1e6).toFixed(1);
  const natTotal = stats.matched + stats.unknown;
  const natInfo = natTotal
    ? `${Math.round((stats.matched / natTotal) * 100)}% cocok, tidak diketahui ${mb(stats.unknown)}MB`
    : '-';
  const time = new Date().toLocaleTimeString('id-ID');
  console.log(
    `[${time}] flow=${stats.flows} up=${mb(stats.up)}MB down=${mb(stats.down)}MB ` +
    `| NAT: ${natInfo}, menunggu=${pending.length}, koneksi=${connMap.size} ` +
    `| dilewati=${stats.skipped} tergabung=${stats.joined} rusak=${stats.bad}`
  );
  stats = newStats();
}

// Kembalikan baris yang gagal ditulis ke buffer memori, supaya tidak hilang.
function mergeBack(rows, map, keyFn) {
  for (const r of rows) {
    const k = keyFn(r);
    const cur = map.get(k);
    if (cur) {
      cur.bytes += r.bytes;
      cur.packets += r.packets;
    } else {
      map.set(k, { ...r });
    }
  }
}

let flushing = false;
let flushAgain = false;

// Tulis detak ke ingest_status. Gagal di sini tidak boleh menghentikan ingest,
// jadi semua error ditelan (hanya dicatat di log).
async function writeHeartbeat(rowsThisFlush) {
  try {
    await pool.query(SQL_HEARTBEAT, [
      os.hostname(), lastFlowTs, rowsThisFlush, flowsSinceFlush, totalRows,
    ]);
    flowsSinceFlush = 0;
  } catch (e) {
    console.error('[db] gagal tulis ingest_status:', e.message);
  }
}

async function flushNow() {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      const s = [...summary.values()];
      const d = [...detail.values()];
      summary = new Map();
      detail = new Map();
      let written = 0;
      if (s.length || d.length) {
        try {
          await writeBatch(s, d);
          written = s.length + d.length;
          totalRows += written;
        } catch (e) {
          console.error('[db] gagal menulis:', e.message);
          mergeBack(s, summary, sumKey);
          mergeBack(d, detail, detKey);
        }
      }
      await writeHeartbeat(written);
    } while (flushAgain);
  } finally {
    flushing = false;
  }
  printStats();
}

// Dipanggil dari jalur panas (record): jangan menunggu I/O di sini.
let flushScheduled = false;
function requestFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    flushNow().catch((e) => console.error('[db]', e.message));
  });
}

async function cleanup() {
  const now = nowSec();
  try {
    const [r1] = await pool.query('DELETE FROM flows_5m WHERE ts < ?',
      [now - CONFIG.keepDetailDays * 86400]);
    const [r2] = await pool.query('DELETE FROM traffic_1m WHERE ts < ?',
      [now - CONFIG.keepMinuteDays * 86400]);
    if (r1.affectedRows || r2.affectedRows) {
      console.log(`[cleanup] hapus ${r1.affectedRows} baris detail, ${r2.affectedRows} baris ringkasan`);
    }
  } catch (e) {
    console.error('[cleanup] gagal:', e.message);
  }
}

// ====== MENJALANKAN GOFLOW2 ======
let child = null;
let stopping = false;

function startGoflow() {
  console.log(`[goflow2] start: ${CONFIG.goflowPath} -listen ${CONFIG.listen}`);
  child = spawn(CONFIG.goflowPath, ['-listen', CONFIG.listen], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  readline.createInterface({ input: child.stdout }).on('line', handleLine);
  child.stderr.on('data', (d) => process.stderr.write(`[goflow2] ${d}`));
  child.on('error', (e) => {
    console.error(`[goflow2] gagal start: ${e.message}`);
    if (e.code === 'ENOENT') {
      console.error('Cek GOFLOW_PATH, file goflow2.exe tidak ditemukan.');
      process.exit(1);
    }
  });
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    console.error(`[goflow2] berhenti (kode ${code}), start ulang 5 detik lagi`);
    setTimeout(startGoflow, 5000);
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nMenutup, menyimpan sisa data...');
  if (child) child.kill();
  resolvePending(true);
  // tunggu flush yang mungkin sedang berjalan (maks ~30 detik)
  for (let i = 0; i < 300 && flushing; i++) await new Promise((r) => setTimeout(r, 100));
  await flushNow().catch((e) => console.error('[db]', e.message));
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

// ====== MULAI ======
try {
  await ensureSchema(pool);
} catch (e) {
  console.error(`[db] tidak bisa menyiapkan MySQL (${target()}): ${e.message}`);
  console.error('Cek .env — host, user, password, dan pastikan database bisa diakses.');
  process.exit(1);
}
cleanup();
setInterval(() => {
  flushNow().catch((e) => console.error('[db]', e.message));
}, CONFIG.flushSec * 1000);
setInterval(resolvePending, Math.max(1, Math.min(10, Math.floor(CONFIG.pendingSec / 2))) * 1000);
setInterval(pruneConnMap, 60 * 1000);
setInterval(cleanup, 3600 * 1000);
startGoflow();
console.log(`Database: ${target()} | bridge ifIndex: ${CONFIG.bridgeIf}`);
