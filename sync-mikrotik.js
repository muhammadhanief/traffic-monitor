// sync-mikrotik.js — menarik identitas perangkat & nama tujuan dari router.
//
// Sumber (REST API RouterOS v7, HTTP port 80 atau HTTPS port 443):
//   /ip/dhcp-server/lease  -> host-name (nama komputer), mac-address
//                             (field `comment` tidak ada di ROS 7.25.1; kalau
//                             ada di versi lain, dipakai sebagai nama ramah)
//   /ip/arp                -> IP + MAC, untuk perangkat tanpa lease (IP statis)
//   /ip/dns/cache          -> nama domain -> IP
//
// Daftar endpoint lengkap + hasil probing: DOKUMENTASI-API-MIKROTIK.md
//
// Hasil ditulis ke tabel: devices, device_ip_history, dns_map.
//
// Kenapa begini: record NetFlow hanya membawa IP perangkat (MAC yang ada di
// flow adalah MAC interface router, bukan MAC klien). Jadi nama perangkat dan
// nama tujuan harus ditempel dari luar. DHCP lease = sumber nama perangkat
// terbaik; cache DNS router = sumber nama tujuan.
//
// Pemakaian:
//   node --env-file-if-exists=.env sync-mikrotik.js             (sekali jalan)
//   node --env-file-if-exists=.env sync-mikrotik.js --selftest  (uji tanpa router)
//
// Prasyarat di router (lihat README-MYSQL.md):
//   /ip service set www-ssl disabled=no available-from=<IP-server>/32
//   user 'collector' di grup dengan policy read,api,rest-api

import mysql from 'mysql2/promise';
import { DB, ensureSchema, target } from './db.js';
import { CFG as MT, mtGet } from './mt-rest.js';

const SELFTEST = process.argv.includes('--selftest');

const CFG = {
  ...MT,
  dnsKeepDays: Number(process.env.DNS_KEEP_DAYS || 1825),
};

// ====== BANTUAN ======
const nowSec = () => Math.floor(Date.now() / 1000);
const normMac = (s) => (s || '').trim().toLowerCase();
const isIPv4 = (s) => typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isIPv6 = (s) => typeof s === 'string' && /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i.test(s);
const looksLikeIp = (s) => isIPv4(s) || isIPv6(s);

// RouterOS memakai nama field bertanda hubung; ambil yang ada saja.
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

// Ubah lease + ARP menjadi daftar perangkat unik (kunci MAC).
function buildDevices(leases, arps) {
  const byMac = new Map();

  for (const l of leases) {
    const mac = normMac(pick(l, 'mac-address'));
    const ip = pick(l, 'address');
    if (!mac || !ip) continue;
    const prev = byMac.get(mac) || {};
    byMac.set(mac, {
      mac,
      ip,
      hostname: pick(l, 'host-name') || prev.hostname || null,
      comment: pick(l, 'comment') || prev.comment || null,
      sumber: 'dhcp',
    });
  }

  // ARP: hanya menambah yang belum tercakup lease (nama tidak tersedia).
  for (const a of arps) {
    const mac = normMac(pick(a, 'mac-address'));
    const ip = pick(a, 'address');
    if (!mac || !ip) continue;
    if (!byMac.has(mac)) byMac.set(mac, { mac, ip, hostname: null, comment: null, sumber: 'arp' });
  }

  return [...byMac.values()];
}

// Ubah cache DNS menjadi daftar (ip, name), buang entri yang bukan alamat IP.
function buildDns(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const name = pick(e, 'name');
    const ip = pick(e, 'data', 'address');
    const type = (pick(e, 'type') || '').toUpperCase();
    if (!name || !ip) continue;
    if (type === 'CNAME' || type === 'MX' || type === 'PTR' || type === 'TXT') continue;
    if (!looksLikeIp(ip)) continue;
    const key = `${ip}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ip, name });
  }
  return out;
}

// ====== TULIS KE DATABASE ======
async function writeDevices(conn, devices, ts) {
  if (!devices.length) return { count: 0, historyNew: 0, historyClosed: 0 };

  // 1. upsert devices. Field manual (nama/pemilik/grup) tidak ditimpa.
  //    Kolom: mac, hostname, nama, last_ip, last_seen, last_seen_ts, sumber
  //    last_seen (DATETIME, WIB) hanya untuk dibaca manusia; last_seen_ts
  //    (epoch) yang dipakai semua query "online" supaya bebas zona waktu.
  const devRows = devices.map((d) => [
    d.mac, d.hostname, d.comment, d.ip, new Date(ts * 1000), ts, d.sumber,
  ]);
  await conn.query(
    `INSERT INTO devices (mac, hostname, nama, last_ip, last_seen, last_seen_ts, sumber)
     VALUES ? AS v
     ON DUPLICATE KEY UPDATE
       hostname     = COALESCE(v.hostname, devices.hostname),
       nama         = COALESCE(devices.nama, v.nama),
       last_ip      = v.last_ip,
       last_seen    = v.last_seen,
       last_seen_ts = v.last_seen_ts,
       aktif        = 1,
       sumber       = IF(devices.sumber = 'manual', 'manual', v.sumber)`,
    [devRows]
  );

  // 2. riwayat IP -> MAC.
  const [open] = await conn.query(
    'SELECT ip, mac FROM device_ip_history WHERE to_ts IS NULL'
  );
  const openByIp = new Map(open.map((r) => [r.ip, r.mac]));
  const openByMac = new Map(open.map((r) => [r.mac, r.ip]));

  let closed = 0;
  let created = 0;

  // 2a. tutup baris lama: IP dipakai MAC lain, atau perangkat pindah IP.
  const toClose = new Set();
  for (const d of devices) {
    const ipOwner = openByIp.get(d.ip);
    if (ipOwner && ipOwner !== d.mac) toClose.add(d.ip);
    const macIp = openByMac.get(d.mac);
    if (macIp && macIp !== d.ip) toClose.add(macIp);
  }
  for (const ip of toClose) {
    await conn.query(
      'UPDATE device_ip_history SET to_ts = ? WHERE ip = ? AND to_ts IS NULL',
      [ts, ip]
    );
    closed++;
  }

  // 2b. buka baris baru untuk pasangan yang belum terbuka.
  for (const d of devices) {
    if (openByIp.get(d.ip) === d.mac && !toClose.has(d.ip)) continue;
    const [r] = await conn.query(
      'INSERT IGNORE INTO device_ip_history (ip, mac, from_ts, to_ts) VALUES (?,?,?,NULL)',
      [d.ip, d.mac, ts]
    );
    created += r.affectedRows;
  }

  return { count: devices.length, historyNew: created, historyClosed: closed };
}

async function writeDns(conn, dns, ts) {
  if (!dns.length) return 0;
  const rows = dns.map((d) => [d.ip, d.name, ts, ts, 'router-cache']);
  await conn.query(
    `INSERT INTO dns_map (ip, name, first_seen, last_seen, sumber)
     VALUES ? AS v
     ON DUPLICATE KEY UPDATE last_seen = GREATEST(dns_map.last_seen, v.last_seen)`,
    [rows]
  );
  return dns.length;
}

async function pruneDns(conn, ts) {
  if (!CFG.dnsKeepDays) return 0;
  const [r] = await conn.query('DELETE FROM dns_map WHERE last_seen < ?', [
    ts - CFG.dnsKeepDays * 86400,
  ]);
  return r.affectedRows;
}

// ====== SATU PUTARAN SINKRON ======
// tsOverride dipakai selftest supaya dua putaran tidak jatuh di detik yang sama
// (PK device_ip_history = (ip, from_ts), jadi detik kembar akan di-ignore).
async function sync(conn, data, tsOverride) {
  const ts = tsOverride ?? nowSec();
  const devices = buildDevices(data.leases, data.arps);
  const dns = buildDns(data.dns);
  const dev = await writeDevices(conn, devices, ts);
  const dnsRows = await writeDns(conn, dns, ts);
  const pruned = await pruneDns(conn, ts);
  return { ts, devices: dev, dnsRows, pruned };
}

function report(res) {
  console.log(
    `  perangkat: ${res.devices.count}` +
    ` (riwayat baru ${res.devices.historyNew}, ditutup ${res.devices.historyClosed})`
  );
  console.log(`  nama DNS : ${res.dnsRows} baris${res.pruned ? `, dipangkas ${res.pruned}` : ''}`);
}

// ====== SELFTEST (tanpa router; semua perubahan di-rollback) ======
// Alamat contoh memakai rentang TEST-NET (RFC 5737) yang tidak dipakai jaringan
// kantor, supaya tidak bertabrakan dengan data asli di tabel.
const MOCK = {
  leases: [
    { address: '192.0.2.40', 'mac-address': 'AA:BB:CC:00:00:01', 'host-name': 'A56', comment: 'milik Sukma', status: 'bound' },
    { address: '192.0.2.41', 'mac-address': 'AA:BB:CC:00:00:02', 'host-name': 'PC-KEUANGAN01', comment: '', status: 'bound' },
  ],
  arps: [
    { address: '192.0.2.40', 'mac-address': 'AA:BB:CC:00:00:01' },
    { address: '192.0.2.99', 'mac-address': 'AA:BB:CC:00:00:03' },
  ],
  dns: [
    { name: 'googlevideo.com', data: '203.0.113.100', type: 'A' },
    { name: 'youtube.com', data: '203.0.113.100', type: 'A' },
    { name: 'intranet.bps.local', data: '192.0.2.5', type: 'A' },
    { name: 'tak-dipakai.example', data: 'example.com', type: 'CNAME' }, // harus dibuang
  ],
};

const MOCK_MACS = ['aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02', 'aa:bb:cc:00:00:03'];
const MOCK_IPS = ['192.0.2.40', '192.0.2.41', '192.0.2.99'];
const MOCK_DNS_IPS = ['203.0.113.100', '192.0.2.5'];

async function selftest(conn) {
  console.log('selftest: pakai data contoh; semua perubahan DIBATALKAN (rollback).\n');
  await conn.beginTransaction();
  try {
    const res1 = await sync(conn, MOCK);
    console.log('putaran 1:');
    report(res1);

    const [[dv]] = await conn.query('SELECT COUNT(*) n FROM devices WHERE mac IN (?)', [MOCK_MACS]);
    const [[lt]] = await conn.query(
      'SELECT COUNT(*) n FROM devices WHERE mac IN (?) AND last_seen_ts = ?', [MOCK_MACS, res1.ts]);
    const [[hp]] = await conn.query(
      'SELECT COUNT(*) n FROM device_ip_history WHERE ip IN (?) AND to_ts IS NULL', [MOCK_IPS]);
    const [[dm]] = await conn.query('SELECT COUNT(*) n FROM dns_map WHERE ip IN (?)', [MOCK_DNS_IPS]);
    const [[cn]] = await conn.query("SELECT COUNT(*) n FROM dns_map WHERE name = 'tak-dipakai.example'");

    console.log('\nverifikasi putaran 1:');
    console.log(`  devices           : ${dv.n}  (harap 3)`);
    console.log(`  last_seen_ts      : ${lt.n}  (harap 3)`);
    console.log(`  riwayat terbuka   : ${hp.n}  (harap 3)`);
    console.log(`  dns_map           : ${dm.n}  (harap 3)`);
    console.log(`  CNAME dibuang     : ${cn.n === 0 ? 'ya' : 'TIDAK'}  (harap ya)`);

    // Putaran 2: perangkat .01 pindah dari 192.0.2.40 ke 192.0.2.99.
    const move = {
      leases: [{ address: '192.0.2.99', 'mac-address': 'AA:BB:CC:00:00:01', 'host-name': 'A56', comment: 'milik Sukma' }],
      arps: [
        { address: '192.0.2.99', 'mac-address': 'AA:BB:CC:00:00:01' },
        { address: '192.0.2.50', 'mac-address': 'AA:BB:CC:00:00:04' },
      ],
      dns: [{ name: 'googlevideo.com', data: '203.0.113.100', type: 'A' }],
    };
    const res2 = await sync(conn, move, res1.ts + 1);
    console.log('\nputaran 2 (perangkat .01 pindah ke 192.0.2.99):');
    report(res2);

    const [h40] = await conn.query(
      'SELECT to_ts FROM device_ip_history WHERE ip = ? ORDER BY from_ts', ['192.0.2.40']);
    const [h99] = await conn.query(
      'SELECT to_ts FROM device_ip_history WHERE ip = ? AND to_ts IS NULL', ['192.0.2.99']);
    const moved = h40.length === 1 && h40[0].to_ts !== null && h99.length === 1;
    console.log('\nverifikasi putaran 2:');
    console.log(`  192.0.2.40 ditutup & 192.0.2.99 dibuka: ${moved ? 'ya' : 'TIDAK'}  (harap ya)`);

    const allOk = dv.n === 3 && lt.n === 3 && hp.n === 3 && dm.n === 3 && cn.n === 0 && moved;
    console.log(`\nHASIL SELFTEST: ${allOk ? 'LULUS' : 'GAGAL'}`);
    if (!allOk) process.exitCode = 1;
  } finally {
    await conn.rollback();
    console.log('rollback selesai — database tidak berubah.');
  }
}

// ====== JALAN ======
console.log(
  SELFTEST
    ? `sync-mikrotik selftest | ${target()}`
    : `sync-mikrotik | router=${CFG.scheme}://${CFG.host}:${CFG.port} user=${CFG.user} | ${target()}`
);

const conn = await mysql.createConnection({ ...DB, dateStrings: true });
try {
  await ensureSchema(conn); // DDL di luar transaksi (MySQL tidak punya DDL transaksional)

  if (SELFTEST) {
    await selftest(conn);
  } else {
    if (!CFG.host || !CFG.user) {
      throw new Error('MIKROTIK_HOST / MIKROTIK_USER belum diisi di .env');
    }
    const [leases, arps, dns] = await Promise.all([
      mtGet('/ip/dhcp-server/lease'),
      mtGet('/ip/arp'),
      mtGet('/ip/dns/cache').catch((e) => {
        console.warn(`  catatan: cache DNS dilewati (${e.message})`);
        return [];
      }),
    ]);
    console.log(`  terbaca: ${leases.length} lease, ${arps.length} ARP, ${dns.length} entri DNS`);
    await conn.beginTransaction();
    try {
      const res = await sync(conn, { leases, arps, dns });
      await conn.commit();
      report(res);
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    }
  }
} catch (e) {
  console.error(`Gagal: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end().catch(() => {});
}
