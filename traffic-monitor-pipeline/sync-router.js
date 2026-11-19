// sync-router.js — snapshot kesehatan, port, sesi login, dan log router.
//
// Dijalankan tiap menit oleh Scheduled Task (mis. NetflowSyncRouter).
// Berbeda dari sync-mikrotik.js yang menarik identitas perangkat (5–10 menit),
// script ini menarik hal-hal yang berubah cepat atau perlu dicatat sebagai
// riwayat: CPU/suhu, MAC di port mana, siapa login, dan log.
//
// Sumber (REST API RouterOS v7, GET baca-saja):
//   /system/resource        -> cpu-load, free/total-memory, uptime, version
//   /system/health          -> cpu-temperature, board-temperature1/2, fan, PSU
//   /system/ntp/client      -> enabled, status
//   /system/package/update  -> installed-version, channel
//   /interface/bridge/host  -> MAC <-> port (port_map)
//   /user/active            -> sesi login aktif (router_session)
//   /log                    -> 1.000 baris terakhir (router_log)
//
// Hasil: router_stat, port_map, router_session, router_log.
// Daftar endpoint lengkap: DOKUMENTASI-API-MIKROTIK.md
//
// Pemakaian:
//   node --env-file-if-exists=.env sync-router.js
//   node --env-file-if-exists=.env sync-router.js --dry-run   (tanpa tulis DB)

import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { DB, ensureSchema, target } from './db.js';
import { CFG as MT, mtGet } from './mt-rest.js';

const DRY = process.argv.includes('--dry-run');

const CFG = {
  // log router disimpan berapa hari
  logKeepDays: Number(process.env.LOG_KEEP_DAYS || 30),
  // sesi login yang sudah lama tidak terlihat boleh dibuang
  sessionKeepDays: Number(process.env.SESSION_KEEP_DAYS || 180),
  // port uplink (dipisah koma), mis. "ether1,ether7" — untuk pewarnaan di UI
  uplinkPorts: new Set(
    String(process.env.UPLINK_PORTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
};

const nowSec = () => Math.floor(Date.now() / 1000);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v) => {
  if (v === true || v === 'true' || v === 'yes') return 1;
  if (v === false || v === 'false' || v === 'no') return 0;
  return null;
};
const decode = (s) =>
  typeof s === 'string'
    ? s.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : s;

// "19h30m37s" / "1w2d3h" / "2d04:05:06" -> detik
function parseUptime(s) {
  if (!s) return null;
  const str = String(s);
  let sec = 0;
  let found = false;
  for (const [re, mult] of [
    [/(\d+)w/, 604800],
    [/(\d+)d/, 86400],
    [/(\d+)h/, 3600],
    [/(\d+)m/, 60],
    [/(\d+)s/, 1],
  ]) {
    const m = str.match(re);
    if (m) {
      sec += Number(m[1]) * mult;
      found = true;
    }
  }
  const c = str.match(/(\d+):(\d+):(\d+)/);
  if (c) {
    sec += Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]);
    found = true;
  }
  return found ? sec : null;
}

// Waktu router ("2026-11-19 09:02:49", zona router = WIB) -> epoch.
function routerTime(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isFinite(d.getTime()) ? Math.floor(d.getTime() / 1000) : null;
}

async function safe(path, fallback) {
  try {
    return await mtGet(path);
  } catch (e) {
    console.warn(`  lewati ${path}: ${e.message}`);
    return fallback;
  }
}

// ====== AMBIL & NORMALKAN ======
async function collect() {
  const [res, health, ntp, pkg] = await Promise.all([
    mtGet('/system/resource'),
    safe('/system/health', []),
    safe('/system/ntp/client', null),
    safe('/system/package/update', null),
  ]);

  const h = new Map();
  for (const row of health) if (row.name) h.set(row.name, row.value);
  const hv = (name) => num(h.get(name));

  const stat = {
    cpu_load: num(res['cpu-load']),
    free_memory: num(res['free-memory']),
    total_memory: num(res['total-memory']),
    uptime_sec: parseUptime(res.uptime),
    cpu_temp_c: hv('cpu-temperature'),
    board_temp1_c: hv('board-temperature1'),
    board_temp2_c: hv('board-temperature2'),
    fan1_rpm: hv('fan1-speed'),
    fan2_rpm: hv('fan2-speed'),
    psu1_state: h.get('psu1-state') ?? null,
    psu2_state: h.get('psu2-state') ?? null,
    fan_state: h.get('fan-state') ?? null,
    ntp_enabled: ntp ? bool(ntp.enabled) : null,
    ntp_synced: ntp ? (ntp.status === 'synchronized' ? 1 : 0) : null,
    ros_version: pkg?.['installed-version'] || res.version || null,
    update_channel: pkg?.channel || null,
  };

  const hosts = await safe('/interface/bridge/host', []);
  const ports = hosts
    .map((x) => {
      const mac = String(x['mac-address'] || '').trim().toLowerCase();
      if (!mac) return null;
      const port = x['on-interface'] || x.interface || null;
      return {
        mac,
        bridge: x.bridge ?? null,
        port,
        is_uplink: port && CFG.uplinkPorts.has(port) ? 1 : 0,
        is_local: bool(x.local) ?? 0,
      };
    })
    .filter(Boolean);

  const sessions = (await safe('/user/active', []))
    .map((x) => ({
      username: x.name || null,
      address: x.address || null,
      via: x.via || null,
      grup: x.group ?? null,
      started_str: x.when || null,
    }))
    .filter((x) => x.username && x.address);

  const logs = (await safe('/log', []))
    .map((x) => {
      const ts = routerTime(x.time);
      if (!ts) return null;
      const topics = x.topics ?? null;
      const message = decode(x.message) ?? '';
      const extra = decode(x['extra-info']) ?? null;
      return {
        ts,
        topics,
        severity: topics ? topics.split(',').pop() : null,
        message: message.slice(0, 512),
        extra: extra ? String(extra).slice(0, 255) : null,
        hash: createHash('sha1')
          .update(`${ts}|${topics}|${message}|${extra}`)
          .digest('hex'),
      };
    })
    .filter(Boolean);

  return { stat, ports, sessions, logs };
}

// ====== TULIS ======
async function writeStat(conn, ts, s) {
  await conn.query(
    `INSERT INTO router_stat
       (ts, cpu_load, free_memory, total_memory, uptime_sec, cpu_temp_c,
        board_temp1_c, board_temp2_c, fan1_rpm, fan2_rpm, psu1_state, psu2_state,
        fan_state, ntp_enabled, ntp_synced, ros_version, update_channel)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) AS v
     ON DUPLICATE KEY UPDATE
       cpu_load=v.cpu_load, free_memory=v.free_memory, total_memory=v.total_memory,
       uptime_sec=v.uptime_sec, cpu_temp_c=v.cpu_temp_c,
       board_temp1_c=v.board_temp1_c, board_temp2_c=v.board_temp2_c,
       fan1_rpm=v.fan1_rpm, fan2_rpm=v.fan2_rpm,
       psu1_state=v.psu1_state, psu2_state=v.psu2_state, fan_state=v.fan_state,
       ntp_enabled=v.ntp_enabled, ntp_synced=v.ntp_synced,
       ros_version=v.ros_version, update_channel=v.update_channel`,
    [
      ts, s.cpu_load, s.free_memory, s.total_memory, s.uptime_sec, s.cpu_temp_c,
      s.board_temp1_c, s.board_temp2_c, s.fan1_rpm, s.fan2_rpm, s.psu1_state,
      s.psu2_state, s.fan_state, s.ntp_enabled, s.ntp_synced, s.ros_version,
      s.update_channel,
    ]
  );
}

async function writePorts(conn, ts, ports) {
  if (!ports.length) return 0;
  const rows = ports.map((p) => [
    p.mac, p.bridge, p.port, p.is_uplink, p.is_local, ts, ts,
  ]);
  await conn.query(
    `INSERT INTO port_map
       (mac, bridge, port, is_uplink, is_local, first_seen, last_seen)
     VALUES ? AS v
     ON DUPLICATE KEY UPDATE
       bridge=v.bridge, port=v.port, is_uplink=v.is_uplink,
       is_local=v.is_local, last_seen=v.last_seen`,
    [rows]
  );
  return rows.length;
}

async function writeSessions(conn, ts, sessions) {
  let n = 0;
  for (const s of sessions) {
    const started = routerTime(s.started_str);
    if (!started) continue;
    const [r] = await conn.query(
      `INSERT INTO router_session (username, address, via, grup, started_at, last_seen)
       VALUES (?,?,?,?,?,?) AS v
       ON DUPLICATE KEY UPDATE grup=v.grup, last_seen=v.last_seen`,
      [s.username, s.address, s.via, s.grup, started, ts]
    );
    n += r.affectedRows;
  }
  return n;
}

// Hanya baris yang lebih baru dari yang tersimpan yang dicoba dimasukkan.
// Overlap 5 detik menjaga pesan pada detik yang sama tidak terlewat; hash unik
// yang mencegah duplikat.
async function writeLogs(conn, ts, logs) {
  if (!logs.length) return 0;
  const [[{ maxTs }]] = await conn.query(
    'SELECT COALESCE(MAX(ts), 0) AS maxTs FROM router_log'
  );
  const fresh = logs.filter((l) => l.ts >= Number(maxTs) - 5);
  if (!fresh.length) return 0;

  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < fresh.length; i += BATCH) {
    const rows = fresh
      .slice(i, i + BATCH)
      .map((l) => [l.ts, l.topics, l.severity, l.message, l.extra, l.hash]);
    const [r] = await conn.query(
      `INSERT IGNORE INTO router_log (ts, topics, severity, message, extra, hash)
       VALUES ?`,
      [rows]
    );
    inserted += r.affectedRows;
  }
  await conn.query('DELETE FROM router_log WHERE ts < ?', [
    ts - CFG.logKeepDays * 86400,
  ]);
  await conn.query('DELETE FROM router_session WHERE last_seen < ?', [
    ts - CFG.sessionKeepDays * 86400,
  ]);
  return inserted;
}

// ====== JALAN ======
console.log(
  `sync-router${DRY ? ' (dry-run)' : ''} | router=${MT.scheme}://${MT.host}:${MT.port} user=${MT.user}` +
  (DRY ? '' : ` | ${target()}`)
);

let data;
try {
  data = await collect();
} catch (e) {
  console.error(`Gagal mengambil data router: ${e.message}`);
  process.exit(1);
}

const s = data.stat;
console.log(
  `  cpu ${s.cpu_load}%  suhu ${s.cpu_temp_c}°C  ram bebas ` +
  `${(Number(s.free_memory) / 1073741824).toFixed(1)} GB  uptime ${s.uptime_sec} dtk  ` +
  `ntp ${s.ntp_synced ? 'sinkron' : 'TIDAK sinkron'}`
);
console.log(
  `  port ${data.ports.length} MAC | sesi ${data.sessions.length} | log ${data.logs.length} baris`
);

if (DRY) {
  console.log('\ncontoh stat:', JSON.stringify(s));
  for (const p of data.ports.slice(0, 3)) console.log('  port:', JSON.stringify(p));
  for (const x of data.sessions.slice(0, 3)) console.log('  sesi:', JSON.stringify(x));
  for (const l of data.logs.slice(0, 3)) console.log('  log :', JSON.stringify(l));
  process.exit(0);
}

const conn = await mysql.createConnection({ ...DB, dateStrings: true });
try {
  await ensureSchema(conn);
  const ts = nowSec();
  await conn.beginTransaction();
  try {
    await writeStat(conn, ts, s);
    const ports = await writePorts(conn, ts, data.ports);
    const sessions = await writeSessions(conn, ts, data.sessions);
    const logs = await writeLogs(conn, ts, data.logs);
    await conn.commit();
    console.log(`  ditulis: router_stat 1, port_map ${ports}, sesi ${sessions}, log baru ${logs}`);
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  }
} catch (e) {
  console.error(`Gagal: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end().catch(() => {});
}