'use strict';

// lookup.js — menghubungkan IP lokal (dari tabel trafik) ke perangkat (MAC)
// lalu ke label yang ramah. Dipakai hampir semua endpoint.
//
// Aturan (DOKUMENTASI-UI.md §5.3): baris `device_ip_history` dengan to_ts IS NULL
// adalah pemetaan terakhir. Ambil SATU baris terbuka terbaru per IP, supaya aman
// kalau ada IP dengan lebih dari satu baris terbuka.

const db = require('../db');
const config = require('./config');

const OPEN_MAP_SQL = `
  SELECT h1.ip, h1.mac
    FROM device_ip_history h1
   WHERE h1.to_ts IS NULL
     AND h1.from_ts = (SELECT MAX(h2.from_ts) FROM device_ip_history h2
                        WHERE h2.ip = h1.ip AND h2.to_ts IS NULL)`;

/**
 * Peta IP -> perangkat untuk sekumpulan IP.
 * @returns {Promise<Map<string, {mac,label,nama,hostname,pemilik,grup,aktif,last_seen_ts}>>}
 */
async function ipToDevice(ips = []) {
  const map = new Map();
  const uniq = [...new Set(ips.filter(Boolean))];
  if (!uniq.length) return map;

  const cfg = await config.loadConfig();

  const [maps] = await db.q(
    `${OPEN_MAP_SQL} AND h1.ip IN (?)`, [uniq]
  );
  if (!maps.length) return map;

  const macs = [...new Set(maps.map((m) => m.mac))];
  const [devs] = await db.q(
    'SELECT mac, hostname, nama, pemilik, grup, last_ip, aktif, last_seen, last_seen_ts FROM devices WHERE mac IN (?)',
    [macs]
  );
  const byMac = new Map(devs.map((d) => [d.mac, d]));

  for (const { ip, mac } of maps) {
    const dev = byMac.get(mac) || { mac };
    const alias = cfg.aliases.get(mac) || null;
    map.set(ip, {
      mac,
      label: config.deviceLabel(dev, cfg),
      nama: (alias && alias.nama) || dev.nama || null,
      hostname: dev.hostname || null,
      pemilik: (alias && alias.pemilik) || dev.pemilik || null,
      grup: (alias && alias.grup) || dev.grup || null,
      aktif: dev.aktif === undefined ? null : Number(dev.aktif),
      last_seen: dev.last_seen || null,
      last_seen_ts: dev.last_seen_ts === undefined ? null : Number(dev.last_seen_ts),
    });
  }
  return map;
}

/** Semua IP yang pernah dipetakan ke satu MAC (untuk detail perangkat). */
async function ipsForMac(mac) {
  const [rows] = await db.q(
    'SELECT ip, from_ts, to_ts FROM device_ip_history WHERE mac = ? ORDER BY from_ts DESC',
    [mac]
  );
  return rows;
}

/** Label untuk satu MAC, dipakai endpoint detail. */
async function byMac(mac) {
  const [rows] = await db.q(
    'SELECT mac, hostname, nama, pemilik, grup, vendor, last_ip, sumber, aktif, last_seen, last_seen_ts FROM devices WHERE mac = ?',
    [mac]
  );
  const dev = rows[0] || null;
  const cfg = await config.loadConfig();
  const alias = cfg.aliases.get(mac) || null;
  return {
    mac,
    device: dev,
    alias,
    label: dev || alias ? config.deviceLabel(dev || { mac }, cfg) : `Perangkat ${mac}`,
    pemilik: (alias && alias.pemilik) || dev?.pemilik || null,
    grup: (alias && alias.grup) || dev?.grup || null,
    nama: (alias && alias.nama) || dev?.nama || null,
  };
}

module.exports = { ipToDevice, ipsForMac, byMac, OPEN_MAP_SQL };
