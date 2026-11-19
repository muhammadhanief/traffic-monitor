'use strict';

// lookup.js — menghubungkan IP lokal (dari tabel trafik) ke perangkat (MAC)
// lalu ke label yang ramah. Dipakai hampir semua endpoint.
//
// Aturan (DOKUMENTASI-UI.md §5.3): baris `device_ip_history` dengan to_ts IS NULL
// adalah pemetaan terakhir. Ambil SATU baris terbuka terbaru per IP, supaya aman
// kalau ada IP dengan lebih dari satu baris terbuka.
//
// Nama perangkat diambil dari `devices` saja (tidak ada tabel alias terpisah).

const db = require('../db');
const config = require('./config');

const OPEN_MAP_SQL = `
  SELECT h1.ip, h1.mac
    FROM device_ip_history h1
   WHERE h1.to_ts IS NULL
     AND h1.from_ts = (SELECT MAX(h2.from_ts) FROM device_ip_history h2
                        WHERE h2.ip = h1.ip AND h2.to_ts IS NULL)`;

const KOLOM_DEVICES = 'mac, hostname, nama, pemilik, grup, vendor, last_ip, sumber, aktif, last_seen, last_seen_ts';

/** Bentuk ringkas satu baris devices untuk respons API. */
function ringkasDev(dev, mac) {
  const m = mac || (dev && dev.mac) || null;
  return {
    mac: m,
    nama: (dev && dev.nama) || null,
    hostname: (dev && dev.hostname) || null,
    pemilik: (dev && dev.pemilik) || null,
    grup: (dev && dev.grup) || null,
    vendor: (dev && dev.vendor) || null,
    sumber: (dev && dev.sumber) || null,
    aktif: dev && dev.aktif !== undefined ? Number(dev.aktif) : null,
    last_ip: (dev && dev.last_ip) || null,
    last_seen: (dev && dev.last_seen) || null,
    last_seen_ts: dev && dev.last_seen_ts !== undefined && dev.last_seen_ts !== null
      ? Number(dev.last_seen_ts) : null,
    label: config.deviceLabel(dev || { mac: m }),
    // Ditandai manual oleh PATCH /api/devices/:mac (sumber='manual').
    // Jangan menebak dari `nama`: sync-mikrotik.js juga mengisi nama dari
    // komentar DHCP, jadi nama yang terisi belum tentu buatan manusia.
    manual: !!dev && dev.sumber === 'manual',
  };
}

/**
 * Peta IP -> perangkat untuk sekumpulan IP.
 * @returns {Promise<Map<string, ReturnType<typeof ringkasDev>>>}
 */
async function ipToDevice(ips = []) {
  const map = new Map();
  const uniq = [...new Set(ips.filter(Boolean))];
  if (!uniq.length) return map;

  const [maps] = await db.q(`${OPEN_MAP_SQL} AND h1.ip IN (?)`, [uniq]);
  if (!maps.length) return map;

  const macs = [...new Set(maps.map((m) => m.mac))];
  const [devs] = await db.q(`SELECT ${KOLOM_DEVICES} FROM devices WHERE mac IN (?)`, [macs]);
  const byMac = new Map(devs.map((d) => [d.mac, d]));

  for (const { ip, mac } of maps) {
    map.set(ip, ringkasDev(byMac.get(mac) || null, mac));
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

/** Perangkat + label untuk satu MAC, dipakai endpoint detail. */
async function byMac(mac) {
  const [rows] = await db.q(`SELECT ${KOLOM_DEVICES} FROM devices WHERE mac = ?`, [mac]);
  const dev = rows[0] || null;
  return { ...ringkasDev(dev, mac), device: dev };
}

module.exports = { ipToDevice, ipsForMac, byMac, ringkasDev, OPEN_MAP_SQL, KOLOM_DEVICES };
