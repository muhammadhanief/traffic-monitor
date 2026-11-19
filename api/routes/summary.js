'use strict';

// routes/summary.js — GET /api/summary?range=today
// Kartu total up/down, jumlah IP aktif, ringkasan perangkat, dan top 5.

const express = require('express');
const db = require('../db');
const { asyncH, ok, intParam, rangeQuery, metaFor, cached, cacheTtl } = require('../lib/util');
const lookup = require('../lib/lookup');

const router = express.Router();

const topDestinations = async (fromDay, limit) => {
  const [rows] = await db.q(`
    SELECT COALESCE(n.name, f.remote_ip) AS kunci,
           SUM(f.bytes)                  AS bytes
      FROM flows_daily_ip f
      LEFT JOIN (SELECT ip, MIN(name) AS name FROM dns_map GROUP BY ip) n
             ON n.ip = f.remote_ip
     WHERE f.day >= ? AND f.dir = 'down' AND f.remote_ip <> '(lainnya)'
     GROUP BY kunci
     ORDER BY bytes DESC
     LIMIT ?`, [fromDay, limit]);
  return rows;
};

router.get('/', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const topLimit = intParam(req.query.topLimit, 5, 1, 20);

  const payload = await cached(`summary:${range.fromDay}:${topLimit}`, cacheTtl(), async () => {
    // Perhatikan: db.q() mengembalikan [rows, fields], jadi tiap elemen
    // Promise.all harus dibongkar lagi ([totals] dsb).
    const [[totals], [usage], devices, [topIp], topDest] = await Promise.all([
      db.q(`SELECT dir, COALESCE(SUM(bytes),0) bytes, COALESCE(SUM(packets),0) packets
              FROM traffic_daily WHERE day >= ? GROUP BY dir`, [range.fromDay]),
      db.q(`SELECT local_ip, SUM(bytes) bytes
              FROM traffic_daily
             WHERE day >= ? AND dir = 'down'
             GROUP BY local_ip
             ORDER BY bytes DESC
             LIMIT ?`, [range.fromDay, topLimit]),
      db.q1(`SELECT COUNT(*) total,
                    SUM(aktif = 1 AND last_seen_ts >= UNIX_TIMESTAMP() - 1800) online,
                    SUM(COALESCE(NULLIF(nama,''), NULLIF(hostname,'')) IS NOT NULL) bernama
               FROM devices`),
      db.q(`SELECT COUNT(DISTINCT local_ip) ips FROM traffic_daily WHERE day >= ?`, [range.fromDay]),
      topDestinations(range.fromDay, topLimit),
    ]);

    const deviceMap = await lookup.ipToDevice(usage.map((u) => u.local_ip));

    const byDir = { up: 0, down: 0, packetsUp: 0, packetsDown: 0 };
    for (const t of totals) {
      if (t.dir === 'up') { byDir.up = Number(t.bytes); byDir.packetsUp = Number(t.packets); }
      if (t.dir === 'down') { byDir.down = Number(t.bytes); byDir.packetsDown = Number(t.packets); }
    }

    return {
      up_bytes: byDir.up,
      down_bytes: byDir.down,
      up_packets: byDir.packetsUp,
      down_packets: byDir.packetsDown,
      total_bytes: byDir.up + byDir.down,
      active_ips: Number(topIp?.[0]?.ips || 0),
      devices_total: Number(devices?.total || 0),
      devices_online: Number(devices?.online || 0),
      devices_named: Number(devices?.bernama || 0),
      top: usage.map((u) => {
        const d = deviceMap.get(u.local_ip);
        return {
          mac: d?.mac || null,
          label: d?.label || u.local_ip,
          local_ip: u.local_ip,
          down_bytes: Number(u.bytes),
        };
      }),
      top_destinations: topDest.map((d) => ({ key: d.kunci, bytes: Number(d.bytes) })),
    };
  });

  ok(res, payload, await metaFor(range, {
    sumber: 'traffic_daily + flows_daily_ip',
    catatan: 'Total dari traffic_daily. Top tujuan hanya yang >= 20 MB/hari.',
  }));
}));

module.exports = router;
