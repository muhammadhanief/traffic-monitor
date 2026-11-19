'use strict';

// routes/audit.js — GET /api/audit/log
// Salinan log router (router_log). Default hanya menampilkan yang penting
// (account / error), sesuai DOKUMENTASI-UI.md §8.7 — jangan tampilkan
// seluruh isi log tanpa filter.

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, intParam, enumParam, strParam, isoWib, rangeQuery, metaFor,
} = require('../lib/util');

const router = express.Router();

const KATEGORI = {
  penting: "(topics LIKE '%account%' OR topics LIKE '%error%')",
  akun: "topics LIKE '%account%'",
  error: "(topics LIKE '%error%' OR severity = 'error')",
  sistem: "(topics LIKE '%system%' OR severity IN ('warning','error','critical'))",
  semua: '1 = 1',
};

router.get('/log', asyncH(async (req, res) => {
  const kategori = enumParam(req.query.kategori, Object.keys(KATEGORI), 'penting');
  const q = strParam(req.query.q, 100).trim();
  const limit = intParam(req.query.limit, 100, 1, 1000);
  const fromTs = req.query.from ? Number(req.query.from) : null;
  const toTs = req.query.to ? Number(req.query.to) : null;

  const where = [KATEGORI[kategori]];
  const params = [];
  if (q) { where.push('(message LIKE ? OR topics LIKE ? OR extra LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (Number.isFinite(fromTs)) { where.push('ts >= ?'); params.push(fromTs); }
  if (Number.isFinite(toTs)) { where.push('ts <= ?'); params.push(toTs); }

  const [rows] = await db.q(`
    SELECT id, ts, topics, severity, message, extra
      FROM router_log
     WHERE ${where.join(' AND ')}
     ORDER BY ts DESC
     LIMIT ?`, [...params, limit]);

  const [ringkas] = await db.q(`
    SELECT COALESCE(severity, 'info') AS tingkat, COUNT(*) AS jumlah
      FROM router_log
     WHERE ts >= UNIX_TIMESTAMP() - 86400
     GROUP BY tingkat
     ORDER BY jumlah DESC`);

  ok(res, {
    log: rows.map((r) => ({
      id: Number(r.id),
      ts: isoWib(r.ts),
      epoch: Number(r.ts),
      topics: r.topics,
      severity: r.severity,
      message: r.message,
      extra: r.extra,
    })),
    ringkasan_24jam: ringkas.map((r) => ({ tingkat: r.tingkat, jumlah: Number(r.jumlah) })),
  }, await metaFor(rangeQuery(req), {
    kategori,
    filter: { q: q || null, from: fromTs, to: toTs, limit },
    sumber: 'router_log (retensi 30 hari)',
    catatan: 'Default kategori=penting (account/error) supaya tidak membanjiri tampilan.',
  }));
}));

module.exports = router;
