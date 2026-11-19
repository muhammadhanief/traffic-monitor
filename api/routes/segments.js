'use strict';

// routes/segments.js — GET /api/segments?range=today
// Pemakaian per segmen /24, dengan nama ramah dari tabel `segment` bila ada.

const express = require('express');
const db = require('../db');
const { asyncH, ok, rangeQuery, metaFor, cached, cacheTtl } = require('../lib/util');
const config = require('../lib/config');

const router = express.Router();

router.get('/', asyncH(async (req, res) => {
  const range = rangeQuery(req);

  const data = await cached(`segments:${range.fromDay}`, cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT CONCAT(SUBSTRING_INDEX(local_ip, '.', 3), '.0/24') AS cidr,
             ROUND(SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) / 1048576) AS mb_down,
             ROUND(SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) / 1048576) AS mb_up,
             COUNT(DISTINCT local_ip)                                AS ip_count
        FROM traffic_daily
       WHERE day >= ?
       GROUP BY cidr
       ORDER BY mb_down DESC`, [range.fromDay]);

    const cfg = await config.loadConfig();
    return rows.map((r) => ({
      cidr: r.cidr,
      nama: config.segmentNameFor(cfg, r.cidr),
      mb_down: Number(r.mb_down || 0),
      mb_up: Number(r.mb_up || 0),
      total_mb: Number(r.mb_down || 0) + Number(r.mb_up || 0),
      ip_count: Number(r.ip_count || 0),
    }));
  });

  ok(res, data, await metaFor(range, {
    sumber: 'traffic_daily',
    catatan: 'Segmen dihitung dari /24 alamat IP lokal.',
  }));
}));

module.exports = router;
