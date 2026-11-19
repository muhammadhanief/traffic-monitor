'use strict';

// routes/top.js — pemakai dan tujuan terbesar.
//   GET /api/top/devices?range=today&dir=down&limit=10
//   GET /api/top/destinations?range=today&dir=down&limit=20&groupBy=ip|domain
//   GET /api/destinations/:ip?range=today     (siapa saja yang menghubungi IP ini)

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, badRequest, intParam, enumParam, rangeQuery, metaFor, cached, cacheTtl,
} = require('../lib/util');
const lookup = require('../lib/lookup');

const router = express.Router();

const DIRS = ['down', 'up', 'total'];
const orderColumn = (dir) => (dir === 'up' ? 'up_bytes' : dir === 'total' ? 'total_bytes' : 'down_bytes');

// ------------------------------------------------------------
//  Top perangkat
// ------------------------------------------------------------
router.get('/devices', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const dir = enumParam(req.query.dir, DIRS, 'down');
  const limit = intParam(req.query.limit, 10, 1, 200);

  const data = await cached(`topdev:${range.fromDay}:${dir}:${limit}`, cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT local_ip,
             SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
             SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes,
             SUM(CASE WHEN dir = 'down' THEN packets ELSE 0 END) AS down_packets,
             SUM(CASE WHEN dir = 'up'   THEN packets ELSE 0 END) AS up_packets
        FROM traffic_daily
       WHERE day >= ?
       GROUP BY local_ip`, [range.fromDay]);

    const deviceMap = await lookup.ipToDevice(rows.map((r) => r.local_ip));

    return rows
      .map((r) => {
        const d = deviceMap.get(r.local_ip);
        const down = Number(r.down_bytes || 0);
        const up = Number(r.up_bytes || 0);
        return {
          local_ip: r.local_ip,
          mac: d?.mac || null,
          label: d?.label || r.local_ip,
          pemilik: d?.pemilik || null,
          grup: d?.grup || null,
          online: d?.aktif === 1 && d?.last_seen_ts ? Date.now() / 1000 - d.last_seen_ts <= 1800 : null,
          down_bytes: down,
          up_bytes: up,
          total_bytes: down + up,
          down_packets: Number(r.down_packets || 0),
          up_packets: Number(r.up_packets || 0),
        };
      })
      .sort((a, b) => b[orderColumn(dir)] - a[orderColumn(dir)])
      .slice(0, limit);
  });

  ok(res, data, await metaFor(range, { dir, limit, sumber: 'traffic_daily' }));
}));

// ------------------------------------------------------------
//  Top tujuan (IP atau domain)
// ------------------------------------------------------------
router.get('/destinations', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const dir = enumParam(req.query.dir, ['down', 'up'], 'down');
  const groupBy = enumParam(req.query.groupBy, ['ip', 'domain'], 'ip');
  const limit = intParam(req.query.limit, 20, 1, 200);
  const includeOther = ['1', 'true'].includes(String(req.query.includeLainnya || '').toLowerCase());

  // > 30 hari: pakai agregat bulanan. Baris '(lainnya)' tidak lengkap di sana,
  // jadi selalu dikecualikan untuk rentang panjang.
  const pakaiBulanan = ['year'].includes(range.range);
  const tabel = pakaiBulanan ? 'flows_monthly_ip' : 'flows_daily_ip';
  const kolomWaktu = pakaiBulanan ? 'month' : 'day';
  const batas = pakaiBulanan ? range.fromMonth : range.fromDay;

  const data = await cached(`topdst:${tabel}:${batas}:${dir}:${groupBy}:${limit}:${includeOther}`, cacheTtl(), async () => {
    const filterLainnya = includeOther ? '' : "AND f.remote_ip <> '(lainnya)'";

    if (groupBy === 'domain') {
      const [rows] = await db.q(`
        SELECT COALESCE(n.name, f.remote_ip) AS kunci,
               SUM(f.bytes)                  AS bytes,
               SUM(f.packets)                AS packets,
               COUNT(DISTINCT f.local_ip)    AS ip_count
          FROM ${tabel} f
          LEFT JOIN (SELECT ip, MIN(name) AS name FROM dns_map GROUP BY ip) n
                 ON n.ip = f.remote_ip
         WHERE f.${kolomWaktu} >= ? AND f.dir = ? ${filterLainnya}
         GROUP BY kunci
         ORDER BY bytes DESC
         LIMIT ?`, [batas, dir, limit]);
      return rows.map((r) => ({
        key: r.kunci,
        bytes: Number(r.bytes || 0),
        packets: Number(r.packets || 0),
        ip_count: Number(r.ip_count || 0),
        jenis: 'domain',
      }));
    }

    const [rows] = await db.q(`
      SELECT f.remote_ip,
             SUM(f.bytes)               AS bytes,
             SUM(f.packets)             AS packets,
             COUNT(DISTINCT f.local_ip) AS ip_count
        FROM ${tabel} f
       WHERE f.${kolomWaktu} >= ? AND f.dir = ? ${filterLainnya}
       GROUP BY f.remote_ip
       ORDER BY bytes DESC
       LIMIT ?`, [batas, dir, limit]);
    return rows.map((r) => ({
      key: r.remote_ip,
      bytes: Number(r.bytes || 0),
      packets: Number(r.packets || 0),
      ip_count: Number(r.ip_count || 0),
      jenis: 'ip',
    }));
  });

  ok(res, data, await metaFor(range, {
    dir,
    groupBy,
    sumber: tabel,
    excluded: includeOther ? null : "remote_ip='(lainnya)'",
    catatan: pakaiBulanan
      ? 'Rentang panjang memakai agregat bulanan (flows_monthly_ip).'
      : 'Hanya tujuan >= 20 MB/hari; sisanya digabung ke (lainnya).',
  }));
}));

// ------------------------------------------------------------
//  Detail satu tujuan: siapa saja yang menghubunginya
// ------------------------------------------------------------
router.get('/:ip', asyncH(async (req, res) => {
  const ip = String(req.params.ip || '').trim();
  if (!/^[0-9a-zA-Z:._%\-]{1,45}$/.test(ip)) throw badRequest('Alamat tujuan tidak sah.');

  const range = rangeQuery(req);
  const [rows] = await db.q(`
    SELECT local_ip,
           SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down_bytes,
           SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up_bytes
      FROM flows_daily_ip
     WHERE remote_ip = ? AND day >= ?
     GROUP BY local_ip
     ORDER BY down_bytes DESC
     LIMIT ?`, [ip, range.fromDay, intParam(req.query.limit, 50, 1, 200)]);

  const deviceMap = await lookup.ipToDevice(rows.map((r) => r.local_ip));

  const [nama] = await db.q(
    'SELECT name, last_seen FROM dns_map WHERE ip = ? ORDER BY last_seen DESC LIMIT 10', [ip]
  ).catch(() => [[]]);

  ok(res, {
    remote_ip: ip,
    nama_dns: nama.map((n) => n.name),
    pemakai: rows.map((r) => {
      const d = deviceMap.get(r.local_ip);
      return {
        local_ip: r.local_ip,
        mac: d?.mac || null,
        label: d?.label || r.local_ip,
        down_bytes: Number(r.down_bytes || 0),
        up_bytes: Number(r.up_bytes || 0),
      };
    }),
  }, await metaFor(range, {
    sumber: 'flows_daily_ip + dns_map',
    catatan: "Baris '(lainnya)' tidak bisa dibuka per IP.",
  }));
}));

module.exports = router;
