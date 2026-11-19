'use strict';

// routes/isp.js — GET /api/isp?range=today
// Pemakaian per jalur WAN (wan_if), dilengkapi nama dari tabel isp_map.

const express = require('express');
const db = require('../db');
const { asyncH, ok, rangeQuery, metaFor, cached, cacheTtl } = require('../lib/util');

const router = express.Router();

router.get('/', asyncH(async (req, res) => {
  const range = rangeQuery(req);

  const data = await cached(`isp:${range.fromDay}`, cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT t.wan_if,
             SUM(CASE WHEN t.dir = 'down' THEN t.bytes ELSE 0 END)   AS down_bytes,
             SUM(CASE WHEN t.dir = 'up'   THEN t.bytes ELSE 0 END)   AS up_bytes,
             SUM(CASE WHEN t.dir = 'down' THEN t.packets ELSE 0 END) AS down_packets,
             SUM(CASE WHEN t.dir = 'up'   THEN t.packets ELSE 0 END) AS up_packets
        FROM traffic_daily t
       WHERE t.day >= ?
       GROUP BY t.wan_if
       ORDER BY down_bytes DESC`, [range.fromDay]);

    const [maps] = await db.q(
      'SELECT wan_if, nama, provider, kapasitas_mbps, aktif FROM isp_map'
    ).catch(() => [[]]);
    const byIf = new Map(maps.map((m) => [Number(m.wan_if), m]));

    const total = rows.reduce((s, r) => s + Number(r.down_bytes) + Number(r.up_bytes), 0);

    return rows.map((r) => {
      const m = byIf.get(Number(r.wan_if)) || null;
      const totalBytes = Number(r.down_bytes) + Number(r.up_bytes);
      return {
        wan_if: Number(r.wan_if),
        nama: m?.nama || `Jalur ${r.wan_if}`,
        provider: m?.provider || null,
        kapasitas_mbps: m?.kapasitas_mbps ?? null,
        aktif: m ? Number(m.aktif) === 1 : null,
        down_bytes: Number(r.down_bytes),
        up_bytes: Number(r.up_bytes),
        total_bytes: totalBytes,
        down_packets: Number(r.down_packets),
        up_packets: Number(r.up_packets),
        porsi: total > 0 ? Number((totalBytes / total).toFixed(4)) : 0,
      };
    });
  });

  ok(res, data, await metaFor(range, {
    sumber: 'traffic_daily + isp_map',
    catatan: 'Nama jalur diisi manual di tabel isp_map; bila kosong ditampilkan "Jalur N".',
  }));
}));

module.exports = router;
