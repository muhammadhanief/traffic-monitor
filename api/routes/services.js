'use strict';

// routes/services.js — layar Layanan.
//   GET /api/services?range=today&dir=down&limit=20&kategori=
//   GET /api/services/:port?range=24h&proto=TCP&dir=down&limit=50
//
// Sumber agregat: svc_daily (>= 1 hari) atau svc_hourly (hari ini / 24 jam).
// Keduanya diturunkan dari flows_5m oleh rollup.js, jadi halaman ini tidak
// pernah memindai jutaan baris detail.
//
// Untuk daftar PERANGKAT pemakai sebuah port, mau tidak mau memakai flows_5m
// (kolom local_ip tidak ada di svc_*). Karena itu dibatasi SEARCH_MAX_HOURS.

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, badRequest, intParam, enumParam, rangeQuery, metaFor, cached, cacheTtl, isoWib,
} = require('../lib/util');
const config = require('../lib/config');
const lookup = require('../lib/lookup');

const router = express.Router();

const MAX_HOURS = () => intParam(process.env.SEARCH_MAX_HOURS, 3, 1, 24);

// ------------------------------------------------------------
//  Daftar layanan terbesar
// ------------------------------------------------------------
router.get('/', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const dir = enumParam(req.query.dir, ['down', 'up', 'total'], 'down');
  const limit = intParam(req.query.limit, 20, 1, 200);
  const kategori = String(req.query.kategori || '').trim().toLowerCase();

  const pakaiJam = ['today', '24h'].includes(range.range);
  const tabel = pakaiJam ? 'svc_hourly' : 'svc_daily';
  const kolomWaktu = pakaiJam ? 'ts_hour' : 'day';
  const batas = pakaiJam ? range.fromTs : range.fromDay;
  const filterDir = dir === 'total' ? '' : 'AND dir = ?';
  const params = dir === 'total' ? [batas] : [batas, dir];

  const data = await cached(`svc:${tabel}:${batas}:${dir}:${limit}:${kategori}`, cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT svc_port,
             proto,
             SUM(bytes)   AS bytes,
             SUM(packets) AS packets,
             SUM(flows)   AS flows
        FROM ${tabel}
       WHERE ${kolomWaktu} >= ? ${filterDir}
       GROUP BY svc_port, proto
       ORDER BY bytes DESC
       LIMIT ?`, [...params, limit * 3]); // ambil lebih, untuk disaring kategori

    const cfg = await config.loadConfig();
    const total = rows.reduce((s, r) => s + Number(r.bytes || 0), 0);

    return rows
      .map((r) => {
        const svc = cfg.services.get(config.defaultServiceKey(r.svc_port, r.proto))
          || { nama: `port ${r.svc_port}`, kategori: 'Lainnya', sumber: 'tidak diketahui' };
        return {
          svc_port: Number(r.svc_port),
          proto: r.proto,
          kunci: `${r.svc_port}/${r.proto}`,
          nama: svc.nama,
          kategori: svc.kategori,
          sumber_nama: svc.sumber,
          bytes: Number(r.bytes || 0),
          packets: Number(r.packets || 0),
          flows: Number(r.flows || 0),
          porsi: total > 0 ? Number((Number(r.bytes || 0) / total).toFixed(4)) : 0,
        };
      })
      .filter((r) => !kategori || String(r.kategori).toLowerCase() === kategori)
      .slice(0, limit);
  });

  ok(res, data, await metaFor(range, {
    dir,
    limit,
    sumber: tabel,
    retensi: pakaiJam ? 'svc_hourly (90 hari)' : 'svc_daily (2 tahun)',
    catatan: pakaiJam
      ? 'Hari ini/24 jam dipilih dari svc_hourly.'
      : 'Nama layanan dari service_map; bila belum diisi memakai daftar bawaan.',
  }));
}));

// ------------------------------------------------------------
//  Detail satu layanan: perangkat pemakainya
// ------------------------------------------------------------
router.get('/:port', asyncH(async (req, res) => {
  // Nilai mentah diperiksa — intParam() akan memotong 99999 menjadi 65535,
  // sehingga port di luar batas akan tampak sah.
  const port = Number(req.params.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw badRequest('Port harus bilangan bulat 0..65535.');
  }
  const proto = enumParam(req.query.proto, ['tcp', 'udp', 'icmp', '*'], 'tcp').toUpperCase();
  const dir = enumParam(req.query.dir, ['down', 'up'], 'down');
  const limit = intParam(req.query.limit, 50, 1, 200);

  const range = rangeQuery(req);
  const maxHours = MAX_HOURS();
  const dari = Math.max(range.fromTs, Math.floor(Date.now() / 1000) - maxHours * 3600);

  const [rows] = await db.q(`
    SELECT local_ip,
           SUM(bytes)   AS bytes,
           SUM(packets) AS packets,
           COUNT(*)     AS baris
      FROM flows_5m
     WHERE svc_port = ? AND proto = ? AND dir = ? AND ts >= ?
     GROUP BY local_ip
     ORDER BY bytes DESC
     LIMIT ?`, [port, proto, dir, dari, limit]);

  const deviceMap = await lookup.ipToDevice(rows.map((r) => r.local_ip));
  const svc = await config.serviceName(port, proto);
  const total = rows.reduce((s, r) => s + Number(r.bytes || 0), 0);

  ok(res, {
    svc_port: port,
    proto,
    dir,
    nama: svc.nama,
    kategori: svc.kategori,
    total_bytes: total,
    jendela: {
      dari: isoWib(dari),
      maksimal_jam: maxHours,
      catatan: `Detail per perangkat diambil dari flows_5m, dibatasi ${maxHours} jam terakhir.`,
    },
    perangkat: rows.map((r) => {
      const d = deviceMap.get(r.local_ip);
      return {
        local_ip: r.local_ip,
        mac: d?.mac || null,
        label: d?.label || r.local_ip,
        bytes: Number(r.bytes || 0),
        packets: Number(r.packets || 0),
        baris_flow: Number(r.baris || 0),
        porsi: total > 0 ? Number((Number(r.bytes || 0) / total).toFixed(4)) : 0,
      };
    }),
  }, await metaFor({ ...range, fromTs: dari }, {
    sumber: 'flows_5m',
    jendela_jam: maxHours,
    catatan: `Meski range=${range.range}, jendela nyata dibatasi ${maxHours} jam (lihat meta.range.from).`,
  }));
}));

module.exports = router;
