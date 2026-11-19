'use strict';

// routes/devices.js — daftar, detail, dan penamaan perangkat.
//   GET   /api/devices?q=&segment=&online=&sort=&page=&perPage=
//   GET   /api/devices/:mac?range=24h
//   PATCH /api/devices/:mac   { nama, pemilik, grup }   (butuh peran admin)

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, badRequest, ApiError, intParam, strParam, enumParam,
  rangeQuery, metaFor, cached, cacheTtl,
} = require('../lib/util');
const config = require('../lib/config');
const lookup = require('../lib/lookup');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const normMac = (raw) => String(raw || '').trim().toLowerCase();
const assertMac = (raw) => {
  const mac = normMac(raw);
  if (!MAC_RE.test(mac)) throw badRequest('Format MAC tidak sah. Contoh: aa:bb:cc:dd:ee:ff');
  return mac;
};

const SORTS = {
  last_seen: 'last_seen_ts DESC, mac',
  ip: 'last_ip',
  hostname: 'hostname',
  mac: 'mac',
};

// ------------------------------------------------------------
//  Daftar perangkat
// ------------------------------------------------------------
router.get('/', asyncH(async (req, res) => {
  const q = strParam(req.query.q, 100).trim();
  const segmen = strParam(req.query.segment, 32).trim();
  const online = ['1', 'true', 'yes'].includes(String(req.query.online || '').toLowerCase());
  const sort = enumParam(req.query.sort, Object.keys(SORTS), 'last_seen');
  const page = intParam(req.query.page, 1, 1, 10000);
  const perPage = intParam(req.query.perPage, 50, 1, 500);
  const offset = (page - 1) * perPage;

  const like = `%${q}%`;
  const where = `
    WHERE (? = '' OR mac LIKE ? OR last_ip LIKE ? OR hostname LIKE ? OR nama LIKE ?)
      AND (? = '' OR CONCAT(SUBSTRING_INDEX(last_ip, '.', 3), '.0/24') = ?)
      AND (? = 0 OR (aktif = 1 AND last_seen_ts >= UNIX_TIMESTAMP() - 1800))`;
  const params = [q, like, like, like, like, segmen, segmen, online ? 1 : 0];

  const [[{ total }]] = await db.q(`SELECT COUNT(*) total FROM devices ${where}`, params);

  const [rows] = await db.q(
    `SELECT mac, hostname, nama, pemilik, grup, vendor, last_ip, sumber, aktif, last_seen, last_seen_ts
       FROM devices ${where}
      ORDER BY ${SORTS[sort]}
      LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  // Pemakaian hari ini untuk baris di halaman ini saja.
  const cfg = await config.loadConfig();
  const ips = rows.map((r) => r.last_ip).filter(Boolean);
  let usage = new Map();
  if (ips.length) {
    const [u] = await db.q(`
      SELECT local_ip,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM traffic_daily
       WHERE day >= ? AND local_ip IN (?)
       GROUP BY local_ip`, [rangeQuery(req).fromDay, ips]);
    usage = new Map(u.map((r) => [r.local_ip, r]));
  }

  const now = Math.floor(Date.now() / 1000);
  const data = rows.map((r) => {
    const alias = cfg.aliases.get(r.mac) || null;
    const u = usage.get(r.last_ip) || null;
    return {
      mac: r.mac,
      label: config.deviceLabel(r, cfg),
      nama: (alias && alias.nama) || r.nama || null,
      hostname: r.hostname || null,
      pemilik: (alias && alias.pemilik) || r.pemilik || null,
      grup: (alias && alias.grup) || r.grup || null,
      vendor: r.vendor || null,
      last_ip: r.last_ip || null,
      segmen: r.last_ip ? `${r.last_ip.split('.').slice(0, 3).join('.')}.0/24` : null,
      sumber: r.sumber,
      manual: !!(alias && (alias.nama || alias.pemilik || alias.grup)),
      online: Number(r.aktif) === 1 && r.last_seen_ts !== null && now - Number(r.last_seen_ts) <= 1800,
      last_seen: r.last_seen,
      last_seen_ts: r.last_seen_ts === null ? null : Number(r.last_seen_ts),
      down_bytes: Number(u?.down_bytes || 0),
      up_bytes: Number(u?.up_bytes || 0),
    };
  });

  ok(res, data, await metaFor(rangeQuery(req), {
    page,
    perPage,
    total: Number(total),
    totalPages: Math.ceil(Number(total) / perPage),
    sort,
    filter: { q, segment: segmen, online },
    sumber: 'devices + device_alias (konfigurasi)',
  }));
}));

// ------------------------------------------------------------
//  Detail perangkat
// ------------------------------------------------------------
router.get('/:mac', asyncH(async (req, res) => {
  const mac = assertMac(req.params.mac);
  const range = rangeQuery(req);

  const ident = await lookup.byMac(mac);
  if (!ident.device && !ident.alias) {
    throw new ApiError(404, 'NOT_FOUND', 'Perangkat tidak ditemukan.');
  }

  const ips = await lookup.ipsForMac(mac);
  const ipList = [...new Set(ips.map((r) => r.ip))];

  let usage = { up_bytes: 0, down_bytes: 0, packets_up: 0, packets_down: 0 };
  let perHari = [];
  let tujuan = [];

  if (ipList.length) {
    // ≤ 24 jam: traffic_1h (punya idx_local). > 24 jam: traffic_daily.
    const pakaiJam = range.range === 'today' || range.range === '24h';
    const [u] = pakaiJam
      ? await db.q(`SELECT dir, SUM(bytes) bytes, SUM(packets) packets
                      FROM traffic_1h WHERE local_ip IN (?) AND ts_hour >= ? GROUP BY dir`, [ipList, range.fromTs])
      : await db.q(`SELECT dir, SUM(bytes) bytes, SUM(packets) packets
                      FROM traffic_daily WHERE local_ip IN (?) AND day >= ? GROUP BY dir`, [ipList, range.fromDay]);

    for (const r of u) {
      if (r.dir === 'down') { usage.down_bytes = Number(r.bytes); usage.packets_down = Number(r.packets); }
      if (r.dir === 'up') { usage.up_bytes = Number(r.bytes); usage.packets_up = Number(r.packets); }
    }

    [perHari] = await db.q(`
      SELECT day,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM traffic_daily
       WHERE local_ip IN (?) AND day >= ?
       GROUP BY day ORDER BY day`, [ipList, range.fromDay]);

    [tujuan] = await db.q(`
      SELECT remote_ip,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM flows_daily_ip
       WHERE local_ip IN (?) AND day >= ? AND remote_ip <> '(lainnya)'
       GROUP BY remote_ip
       ORDER BY down_bytes DESC
       LIMIT ?`, [ipList, range.fromDay, intParam(req.query.limit, 20, 1, 100)]);
  }

  ok(res, {
    mac,
    label: ident.label,
    nama: ident.nama,
    pemilik: ident.pemilik,
    grup: ident.grup,
    vendor: ident.device?.vendor || null,
    sumber: ident.device?.sumber || (ident.alias ? 'manual' : null),
    aktif: ident.device ? Number(ident.device.aktif) === 1 : null,
    last_ip: ident.device?.last_ip || null,
    last_seen: ident.device?.last_seen || null,
    last_seen_ts: ident.device?.last_seen_ts ? Number(ident.device.last_seen_ts) : null,
    manual: ident.alias ? { nama: ident.alias.nama, pemilik: ident.alias.pemilik, grup: ident.alias.grup } : null,
    ip_history: ips.map((r) => ({ ip: r.ip, from_ts: Number(r.from_ts), sampai: r.to_ts ? Number(r.to_ts) : null })),
    pemakaian: {
      up_bytes: usage.up_bytes,
      down_bytes: usage.down_bytes,
      total_bytes: usage.up_bytes + usage.down_bytes,
      packets_up: usage.packets_up,
      packets_down: usage.packets_down,
    },
    per_hari: perHari.map((r) => ({
      day: r.day,
      down_bytes: Number(r.down_bytes || 0),
      up_bytes: Number(r.up_bytes || 0),
    })),
    top_tujuan: tujuan.map((t) => ({
      remote_ip: t.remote_ip,
      down_bytes: Number(t.down_bytes || 0),
      up_bytes: Number(t.up_bytes || 0),
    })),
  }, await metaFor(range, {
    sumber: range.range === 'today' || range.range === '24h' ? 'traffic_1h' : 'traffic_daily',
    catatan: 'Tujuan hanya yang >= 20 MB/hari; baris (lainnya) tidak ditampilkan.',
  }));
}));

// ------------------------------------------------------------
//  Beri nama (tulis ke skema konfigurasi, bukan ke netflow_monitor)
// ------------------------------------------------------------
router.patch('/:mac', requireAdmin, asyncH(async (req, res) => {
  const mac = assertMac(req.params.mac);
  const body = req.body || {};

  const field = (nama) => {
    if (!(nama in body)) return undefined;
    const v = body[nama];
    if (v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s.slice(0, 100);
  };
  const nama = field('nama');
  const pemilik = field('pemilik');
  const grup = field('grup');

  if (nama === undefined && pemilik === undefined && grup === undefined) {
    throw badRequest('Isi minimal satu dari: nama, pemilik, grup.');
  }
  if (!(await db.configReady())) {
    throw new ApiError(503, 'CONFIG_UNAVAILABLE',
      'Database konfigurasi belum siap. Jalankan sql/config-schema.sql (lihat api/README.md).');
  }

  const existing = await db.cq1('SELECT mac, nama, pemilik, grup FROM device_alias WHERE mac = ?', [mac]) || {};
  const merged = {
    nama: nama === undefined ? existing.nama ?? null : nama,
    pemilik: pemilik === undefined ? existing.pemilik ?? null : pemilik,
    grup: grup === undefined ? existing.grup ?? null : grup,
  };

  if (!merged.nama && !merged.pemilik && !merged.grup) {
    // Semua dikosongkan -> hapus penamaan manual, kembali ke hostname.
    await db.cq('DELETE FROM device_alias WHERE mac = ?', [mac]);
  } else {
    await db.cq(`
      INSERT INTO device_alias (mac, nama, pemilik, grup) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE nama = VALUES(nama), pemilik = VALUES(pemilik), grup = VALUES(grup)`,
    [mac, merged.nama, merged.pemilik, merged.grup]);
  }

  config.invalidate();
  const ident = await lookup.byMac(mac);
  ok(res, {
    mac,
    label: ident.label,
    nama: ident.nama,
    pemilik: ident.pemilik,
    grup: ident.grup,
    dihapus: !merged.nama && !merged.pemilik && !merged.grup,
  }, { sumber: 'device_alias (konfigurasi)' });
}));

module.exports = router;
