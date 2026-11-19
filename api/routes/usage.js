'use strict';

// routes/usage.js — deret waktu pemakaian.
//   GET /api/usage/timeseries?range=24h&bucket=auto|hour|day
//   GET /api/usage/hourly?range=today        (jam sibuk)
//   GET /api/usage/monthly?year=2026&format=json|csv
//
// Pilihan tabel sumber mengikuti DOKUMENTASI-UI.md §5.2 dan §12:
//   today/24h -> traffic_1m (per 10 menit; akurat, tidak tergantung rollup)
//   7d        -> traffic_1h
//   30d/month -> traffic_daily
//   year      -> traffic_monthly

const express = require('express');
const db = require('../db');
const { asyncH, ok, rangeQuery, metaFor, intParam, isoWib, badRequest } = require('../lib/util');

const router = express.Router();

// ------------------------------------------------------------
//  GET /api/usage/timeseries
// ------------------------------------------------------------
router.get('/timeseries', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const bucketReq = String(req.query.bucket || 'auto').toLowerCase();
  if (!['auto', 'hour', 'day', '10m'].includes(bucketReq)) {
    throw badRequest('bucket harus salah satu dari: auto, 10m, hour, day');
  }

  let rows;
  let bucket;
  let sumber;

  if (range.range === 'today' || range.range === '24h') {
    sumber = 'traffic_1m';
    const step = bucketReq === 'hour' ? 3600 : bucketReq === 'day' ? 86400 : 600;
    bucket = step === 600 ? '10m' : step === 3600 ? 'hour' : 'day';
    [rows] = await db.q(`
      SELECT FLOOR(ts / ?) * ? AS bucket_epoch,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM traffic_1m
       WHERE ts >= ?
       GROUP BY bucket_epoch
       ORDER BY bucket_epoch`, [step, step, range.fromTs]);
  } else if (range.range === '7d') {
    sumber = 'traffic_1h';
    const step = bucketReq === 'day' ? 86400 : 3600;
    bucket = step === 86400 ? 'day' : 'hour';
    [rows] = await db.q(`
      SELECT FLOOR(ts_hour / ?) * ? AS bucket_epoch,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM traffic_1h
       WHERE ts_hour >= ?
       GROUP BY bucket_epoch
       ORDER BY bucket_epoch`, [step, step, range.fromTs]);
  } else {
    sumber = 'traffic_daily';
    bucket = 'day';
    [rows] = await db.q(`
      SELECT day,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
        FROM traffic_daily
       WHERE day >= ?
       GROUP BY day
       ORDER BY day`, [range.fromDay]);
  }

  // Format seragam: setiap titik punya waktu ISO (+07:00), epoch, dan byte.
  // Bucket dihitung sebagai epoch di SQL (bukan FROM_UNIXTIME) supaya tidak
  // bergantung time_zone sesi MySQL.
  const data = rows.map((r) => {
    const epoch = r.bucket_epoch !== undefined && r.bucket_epoch !== null
      ? Number(r.bucket_epoch)
      : Math.floor(Date.parse(`${r.day}T00:00:00+07:00`) / 1000);
    return {
      t: isoWib(epoch),
      ts: epoch,
      label: r.day || isoWib(epoch).slice(0, 16).replace('T', ' '),
      down_bytes: Number(r.down_bytes || 0),
      up_bytes: Number(r.up_bytes || 0),
      total_bytes: Number(r.down_bytes || 0) + Number(r.up_bytes || 0),
    };
  });

  ok(res, data, await metaFor(range, { bucket, sumber, jumlah_titik: data.length }));
}));

// ------------------------------------------------------------
//  GET /api/usage/hourly — jam sibuk (selalu per jam)
// ------------------------------------------------------------
router.get('/hourly', asyncH(async (req, res) => {
  const range = rangeQuery(req);

  // Rentang panjang tidak punya traffic_1h selama 2 tahun; untuk > 30 hari
  // pakai traffic_daily (per hari) dan beri tahu lewat meta.
  const pakaiJam = ['today', '24h', '7d', '30d', 'month'].includes(range.range);

  let rows;
  if (pakaiJam) {
    // Jam WIB dihitung dari epoch secara aritmetika (UTC+7), bukan lewat
    // FROM_UNIXTIME/HOUR supaya tidak bergantung time_zone sesi MySQL.
    [rows] = await db.q(`
      SELECT MOD(FLOOR(ts_hour / 3600) + 7, 24)                  AS jam,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes,
             COUNT(DISTINCT local_ip)                          AS ip
        FROM traffic_1h
       WHERE ts_hour >= ?
       GROUP BY jam
       ORDER BY jam`, [range.fromTs]);
  } else {
    [rows] = await db.q(`
      SELECT MONTH(day) - 1 AS jam,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes,
             COUNT(DISTINCT local_ip)                          AS ip
        FROM traffic_daily
       WHERE day >= ?
       GROUP BY jam
       ORDER BY jam`, [range.fromDay]);
  }

  const data = rows.map((r) => ({
    jam: Number(r.jam),
    label: pakaiJam ? `${String(r.jam).padStart(2, '0')}:00` : `bulan ke-${Number(r.jam) + 1}`,
    down_bytes: Number(r.down_bytes || 0),
    up_bytes: Number(r.up_bytes || 0),
    total_bytes: Number(r.down_bytes || 0) + Number(r.up_bytes || 0),
    ip: Number(r.ip || 0),
  }));

  const puncak = data.reduce(
    (best, d) => (best === null || d.total_bytes > best.total_bytes ? d : best), null
  );

  ok(res, data, await metaFor(range, {
    sumber: pakaiJam ? 'traffic_1h' : 'traffic_daily',
    satuan: pakaiJam ? 'jam (0-23 WIB)' : 'bulan',
    jam_sibuk: puncak ? { label: puncak.label, total_bytes: puncak.total_bytes } : null,
  }));
}));

// ------------------------------------------------------------
//  GET /api/usage/monthly?year=2026&format=json|csv
// ------------------------------------------------------------
router.get('/monthly', asyncH(async (req, res) => {
  const tahun = intParam(req.query.year, new Date(Date.now() + 7 * 3600 * 1000).getUTCFullYear(), 2000, 2100);
  const format = String(req.query.format || 'json').toLowerCase();
  if (!['json', 'csv'].includes(format)) throw badRequest('format harus json atau csv');

  const [rows] = await db.q(`
    SELECT DATE_FORMAT(month, '%Y-%m')                              AS bulan,
           ROUND(SUM(CASE WHEN dir = 'down' THEN bytes END) / 1073741824, 3) AS gb_down,
           ROUND(SUM(CASE WHEN dir = 'up'   THEN bytes END) / 1073741824, 3) AS gb_up,
           COUNT(DISTINCT local_ip)                                 AS ip_count
      FROM traffic_monthly
     WHERE month >= ? AND month < ?
     GROUP BY bulan
     ORDER BY bulan`, [`${tahun}-01-01`, `${tahun + 1}-01-01`]);

  if (format === 'csv') {
    const head = 'bulan,gb_down,gb_up,total_gb,ip\n';
    const body = rows.map((r) => [
      r.bulan,
      r.gb_down ?? 0,
      r.gb_up ?? 0,
      Number(((Number(r.gb_down) || 0) + (Number(r.gb_up) || 0)).toFixed(3)),
      r.ip_count,
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pemakaian-bulanan-${tahun}.csv"`);
    return res.send(head + body + '\n');
  }

  const data = rows.map((r) => ({
    bulan: r.bulan,
    gb_down: Number(r.gb_down || 0),
    gb_up: Number(r.gb_up || 0),
    total_gb: Number(((Number(r.gb_down) || 0) + (Number(r.gb_up) || 0)).toFixed(3)),
    ip: Number(r.ip_count || 0),
  }));

  return ok(res, data, await metaFor(rangeQuery(req), {
    tahun,
    sumber: 'traffic_monthly',
    catatan: 'traffic_monthly.PK memuat (month, local_ip, dir, wan_if); agregasi per bulan aman.',
  }));
}));

module.exports = router;
