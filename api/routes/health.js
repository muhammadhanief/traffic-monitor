'use strict';

// routes/health.js — GET /api/health
// Lag ingest, cakupan rollup, detak ingest_status, dan status task (disimpulkan
// dari kesegaran data — Scheduled Task Windows tidak bisa dibaca dari DB).

const express = require('express');
const db = require('../db');
const { asyncH, ok, baseMeta, isoWib, cached, metaTtl, rangeQuery, metaFor } = require('../lib/util');
const auth = require('../lib/auth');

const router = express.Router();

router.get('/', asyncH(async (req, res) => {
  const meta = await baseMeta();

  const detail = await cached('health:detail', metaTtl(), async () => {
    const row = await db.q1(`
      SELECT
        (SELECT MIN(ts) FROM traffic_1m)                                   AS data_since_ts,
        (SELECT MAX(ts) FROM traffic_1m)                                   AS data_last_ts,
        (SELECT MAX(ts_hour) FROM traffic_1h)                              AS last_rollup_hour,
        (SELECT MAX(day)     FROM traffic_daily)                           AS last_rollup_day,
        (SELECT MAX(month)   FROM traffic_monthly)                         AS last_rollup_month,
        (SELECT MAX(ts)      FROM router_stat)                             AS last_router_stat,
        (SELECT MAX(last_seen) FROM router_session)                        AS last_router_session,
        (SELECT COUNT(*) FROM devices)                                     AS devices_total,
        (SELECT COUNT(*) FROM devices WHERE aktif = 1
           AND last_seen_ts >= UNIX_TIMESTAMP() - 1800)                    AS devices_online,
        (SELECT COUNT(*) FROM devices
          WHERE COALESCE(NULLIF(nama,''), NULLIF(hostname,'')) IS NOT NULL) AS devices_named,
        (SELECT COUNT(*) FROM port_map)                                    AS port_map_rows
    `);

    const ingest = await db.q1(
      `SELECT host, last_flow_ts, last_flush_at, rows_last_flush, flows_last_flush,
              total_rows, updated_at FROM ingest_status WHERE id = 1`
    ).catch(() => null);

    const now = Math.floor(Date.now() / 1000);
    return { ...row, ingest, now };
  });

  const now = detail.now;
  const tasks = [
    { nama: 'ingest', hidup: meta.dataLagSeconds !== null && meta.dataLagSeconds < 300, keterangan: 'traffic_1m bertambah' },
    { nama: 'rollup:1h', hidup: detail.last_rollup_hour ? now - Number(detail.last_rollup_hour) < 3 * 3600 : false, keterangan: 'traffic_1h segar' },
    { nama: 'rollup:daily', hidup: detail.last_rollup_day ? now - Math.floor(Date.parse(`${detail.last_rollup_day}T00:00:00+07:00`) / 1000) < 36 * 3600 : false, keterangan: 'traffic_daily segar' },
    { nama: 'sync-router', hidup: detail.last_router_stat ? now - Number(detail.last_router_stat) < 600 : false, keterangan: 'router_stat segar' },
  ];

  ok(res, {
    dataLagSeconds: meta.dataLagSeconds,    rollupCoverage: meta.rollupCoverage,
    dataSince: meta.dataSince,
    dataLast: meta.dataLast,
    lastRollupHour: detail.last_rollup_hour ? isoWib(detail.last_rollup_hour) : null,
    lastRollupDay: detail.last_rollup_day || null,
    lastRollupMonth: detail.last_rollup_month || null,
    devices: {
      total: Number(detail.devices_total || 0),
      online: Number(detail.devices_online || 0),
      bernama: Number(detail.devices_named || 0),
    },
    portMapRows: Number(detail.port_map_rows || 0),
    ingest: detail.ingest ? {
      host: detail.ingest.host,
      lastFlowTs: detail.ingest.last_flow_ts ? isoWib(detail.ingest.last_flow_ts) : null,
      lagSeconds: detail.ingest.last_flow_ts ? now - Number(detail.ingest.last_flow_ts) : null,
      lastFlushAt: detail.ingest.last_flush_at,
      rowsLastFlush: detail.ingest.rows_last_flush,
      flowsLastFlush: detail.ingest.flows_last_flush,
      totalRows: detail.ingest.total_rows,
      updatedAt: detail.ingest.updated_at,
    } : null,
    tugas: tasks,
    peringatan: meta.warnings,
  }, await metaFor(rangeQuery(req), {
    auth: auth.info.authEnabled ? 'aktif' : 'nonaktif (pengembangan)',
  }));
}));

module.exports = router;
