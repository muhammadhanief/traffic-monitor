'use strict';

// routes/config.js — pengelolaan konfigurasi aplikasi.
//
//   GET    /api/config                 ringkasan + seluruh isi
//   GET    /api/config/:table          daftar isi satu tabel
//   POST   /api/config/:table          tambah
//   PATCH  /api/config/:table/:id      ubah
//   DELETE /api/config/:table/:id      hapus
//
// Tabel konfigurasi hidup di dalam netflow_monitor, jadi penulisan WAJIB lewat
// daftar putih TABLES di bawah. Tanpa daftar putih ini, endpoint akan menjadi
// jalan pintas untuk menulis ke tabel data (traffic_*, flows_*, devices, ...).
// Nama perangkat TIDAK dikelola di sini — pakai PATCH /api/devices/{mac}.
//
// Semua operasi tulis butuh peran admin dan memakai pool CFG_DB_USER.

const express = require('express');
const db = require('../db');
const { asyncH, ok, badRequest, ApiError, intParam, rangeQuery, metaFor } = require('../lib/util');
const config = require('../lib/config');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

const TABLES = {
  segment: {
    pk: 'id', auto: true,
    cols: ['cidr', 'nama', 'keterangan', 'aktif'],
    wajib: ['cidr', 'nama'],
    urut: 'cidr',
  },
  service_map: {
    pk: 'id', auto: true,
    cols: ['port', 'proto', 'nama', 'kategori', 'aktif'],
    wajib: ['port', 'nama'],
    urut: 'port',
  },
  // Catatan: penamaan perangkat TIDAK ada di sini. PATCH /api/devices/{mac}
  // menulis ke devices.nama/pemilik/grup, dan devices sengaja tidak masuk
  // daftar putih ini supaya konfigurasi tidak bisa menyentuh tabel data.
  alert_rule: {
    pk: 'id', auto: true,
    cols: ['kode', 'nama', 'tipe', 'target', 'operator', 'ambang', 'satuan', 'aktif'],
    wajib: ['kode', 'nama', 'tipe'],
    urut: 'id',
  },
  alert_event: {
    pk: 'id', auto: true,
    cols: ['rule_id', 'ts', 'nilai', 'pesan', 'diakui'],
    wajib: ['pesan'],
    urut: 'ts DESC',
  },
  setting: {
    pk: 'kunci', auto: false,
    cols: ['kunci', 'nilai'],
    wajib: ['kunci', 'nilai'],
    urut: 'kunci',
  },
};

function defTable(nama) {
  const def = TABLES[String(nama || '').toLowerCase()];
  if (!def) throw badRequest(`Tabel konfigurasi tidak dikenal. Pilihan: ${Object.keys(TABLES).join(', ')}`);
  return def;
}

async function assertReady() {
  if (!(await db.configReady())) {
    const { error } = db.configStatus();
    const pesan = error === 'ER_NO_SUCH_TABLE' || error === 'ER_BAD_DB_ERROR'
      ? 'Tabel konfigurasi belum dibuat. Jalankan: npm run db:config (lihat api/README.md).'
      : `Tabel konfigurasi tidak bisa dibaca (${error || 'tidak diketahui'}). Periksa CFG_DB_USER/CFG_DB_PASSWORD.`;
    throw new ApiError(503, 'CONFIG_UNAVAILABLE', pesan);
  }
}

/** Ambil hanya kolom yang diizinkan, buang yang undefined. */
function pick(def, body, { partial = false } = {}) {
  const out = {};
  for (const col of def.cols) {
    if (!(col in body)) continue;
    let v = body[col];
    if (v === null) { out[col] = null; continue; }
    if (typeof v === 'boolean') v = v ? 1 : 0;
    out[col] = typeof v === 'string' ? v.trim().slice(0, 255) : v;
  }
  if (!partial) {
    for (const col of def.wajib) {
      if (out[col] === undefined || out[col] === null || out[col] === '') {
        throw badRequest(`Kolom "${col}" wajib diisi.`);
      }
    }
  }
  return out;
}

// ---------- ringkasan ----------
router.get('/', asyncH(async (req, res) => {
  const siap = await db.configReady();
  if (!siap) {
    const { error } = db.configStatus();
    const pesan = error === 'ER_NO_SUCH_TABLE' || error === 'ER_BAD_DB_ERROR'
      ? 'Tabel konfigurasi belum dibuat. Jalankan: npm run db:config'
      : `Tabel konfigurasi tidak bisa dibaca (${error || 'tidak diketahui'}). Periksa CFG_DB_USER/CFG_DB_PASSWORD.`;
    return ok(res, { tersedia: false, tabel: {} }, await metaFor(rangeQuery(req), {
      catatan: `${pesan} API tetap jalan memakai nama bawaan.`,
      cara_membuat: 'npm run db:config',
    }));
  }

  const hasil = {};
  for (const [nama, def] of Object.entries(TABLES)) {
    const [rows] = await db.cq(`SELECT * FROM ${nama} ORDER BY ${def.urut} LIMIT 500`);
    hasil[nama] = rows;
  }
  return ok(res, { tersedia: true, tabel: hasil },
    await metaFor(rangeQuery(req), { jumlah_tabel: Object.keys(hasil).length }));
}));

// ---------- daftar ----------
router.get('/:table', asyncH(async (req, res) => {
  await assertReady();
  const def = defTable(req.params.table);
  const limit = intParam(req.query.limit, 500, 1, 2000);
  const [rows] = await db.cq(`SELECT * FROM ${req.params.table.toLowerCase()} ORDER BY ${def.urut} LIMIT ?`, [limit]);
  ok(res, rows, await metaFor(rangeQuery(req), { tabel: req.params.table.toLowerCase(), jumlah: rows.length }));
}));

// ---------- tambah ----------
router.post('/:table', requireAdmin, asyncH(async (req, res) => {
  await assertReady();
  const nama = req.params.table.toLowerCase();
  const def = defTable(nama);
  const data = pick(def, req.body || {});

  const cols = Object.keys(data);
  const [r] = await db.cq(
    `INSERT INTO ${nama} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => data[c])
  );
  config.invalidate();
  ok(res, { tersimpan: true, id: def.auto ? Number(r.insertId) : data[def.pk], data },
    await metaFor(rangeQuery(req), { tabel: nama }));
}));

// ---------- ubah ----------
router.patch('/:table/:id', requireAdmin, asyncH(async (req, res) => {
  await assertReady();
  const nama = req.params.table.toLowerCase();
  const def = defTable(nama);
  const data = pick(def, req.body || {}, { partial: true });
  const cols = Object.keys(data);
  if (!cols.length) throw badRequest('Tidak ada kolom yang diubah.');

  const [r] = await db.cq(
    `UPDATE ${nama} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${def.pk} = ?`,
    [...cols.map((c) => data[c]), req.params.id]
  );
  if (r.affectedRows === 0) throw new ApiError(404, 'NOT_FOUND', 'Baris tidak ditemukan.');

  config.invalidate();
  ok(res, { diubah: r.affectedRows, data }, await metaFor(rangeQuery(req), { tabel: nama }));
}));

// ---------- hapus ----------
router.delete('/:table/:id', requireAdmin, asyncH(async (req, res) => {
  await assertReady();
  const nama = req.params.table.toLowerCase();
  const def = defTable(nama);
  const [r] = await db.cq(`DELETE FROM ${nama} WHERE ${def.pk} = ?`, [req.params.id]);
  if (r.affectedRows === 0) throw new ApiError(404, 'NOT_FOUND', 'Baris tidak ditemukan.');
  config.invalidate();
  ok(res, { dihapus: r.affectedRows }, await metaFor(rangeQuery(req), { tabel: nama }));
}));

module.exports = router;
