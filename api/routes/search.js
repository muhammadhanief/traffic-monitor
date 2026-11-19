'use strict';

// routes/search.js — layar Penelusuran (flows_5m).
//
// ATURAN KERAS (DOKUMENTASI-UI.md §12):
//   flows_5m melompat dari 182 ms (3 jam) ke 12 detik (6 jam) karena MySQL
//   beralih ke tabel sementara di disk. Karena itu jendela DIBATASI
//   SEARCH_MAX_HOURS (bawaan 3). Permintaan lebih lebar DITOLAK, bukan
//   diperlambat.
//
// Kolom remote_ip dan svc_port tidak punya index, jadi penyaringan keduanya
// hanya masuk akal di dalam jendela pendek.
//
// GET /api/search?from=<iso|epoch>&to=<iso|epoch>&local_ip=&remote_ip=&svc_port=&proto=&dir=&limit=
// Bila from/to tidak diisi -> SEARCH_MAX_HOURS jam terakhir.

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, badRequest, intParam, enumParam, rangeQuery, metaFor, isoWib,
} = require('../lib/util');
const config = require('../lib/config');
const lookup = require('../lib/lookup');

const router = express.Router();

const MAX_HOURS = () => intParam(process.env.SEARCH_MAX_HOURS, 3, 1, 24);

/** Terima epoch detik atau ISO 8601. Mengembalikan epoch detik, atau null. */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{9,}$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

router.get('/', asyncH(async (req, res) => {
  const maxHours = MAX_HOURS();
  const now = Math.floor(Date.now() / 1000);

  let to = parseTime(req.query.to);
  let from = parseTime(req.query.from);

  if (Number.isNaN(to) || Number.isNaN(from)) {
    throw badRequest('from/to harus epoch detik atau ISO 8601 (mis. 2026-11-19T14:00:00+07:00).');
  }
  if (to === null) to = now;
  if (from === null) from = to - maxHours * 3600;

  if (to <= from) throw badRequest('from harus lebih awal daripada to.');

  const jam = (to - from) / 3600;
  if (jam > maxHours) {
    throw badRequest(
      `Jendela penelusuran maksimal ${maxHours} jam (diminta ${jam.toFixed(2)} jam).`,
      { diminta_jam: Number(jam.toFixed(2)), maksimal_jam: maxHours,
        saran: 'Untuk rentang lebih panjang gunakan /api/top/destinations (agregat harian).' }
    );
  }
  if (to > now + 300) throw badRequest('to tidak boleh di masa depan.');

  const localIp = String(req.query.local_ip || '').trim();
  const remoteIp = String(req.query.remote_ip || '').trim();
  const svcPort = req.query.svc_port !== undefined && req.query.svc_port !== ''
    ? intParam(req.query.svc_port, -1, 0, 65535) : null;
  const proto = String(req.query.proto || '').trim().toUpperCase().slice(0, 8);
  const dir = String(req.query.dir || '').toLowerCase();
  const limit = intParam(req.query.limit, 100, 1, 1000);
  const group = ['1', 'true'].includes(String(req.query.group || '').toLowerCase());

  const where = ['ts >= ?', 'ts < ?'];
  const params = [from, to];
  if (localIp) { where.push('local_ip = ?'); params.push(localIp); }
  if (remoteIp) { where.push('remote_ip = ?'); params.push(remoteIp); }
  if (svcPort !== null) { where.push('svc_port = ?'); params.push(svcPort); }
  if (proto) { where.push('proto = ?'); params.push(proto); }
  if (dir === 'up' || dir === 'down') { where.push('dir = ?'); params.push(dir); }
  const whereSql = where.join(' AND ');

  let data;
  if (group) {
    const [rows] = await db.q(`
      SELECT ts, local_ip, remote_ip, svc_port, proto, dir, wan_if,
             SUM(bytes)   AS bytes,
             SUM(packets) AS packets
        FROM flows_5m
       WHERE ${whereSql}
       GROUP BY ts, local_ip, remote_ip, svc_port, proto, dir, wan_if
       ORDER BY bytes DESC
       LIMIT ?`, [...params, limit]);
    data = rows;
  } else {
    const [rows] = await db.q(`
      SELECT ts, local_ip, remote_ip, svc_port, proto, dir, wan_if, bytes, packets
        FROM flows_5m
       WHERE ${whereSql}
       ORDER BY ts DESC, bytes DESC
       LIMIT ?`, [...params, limit]);
    data = rows;
  }

  const deviceMap = await lookup.ipToDevice(data.map((r) => r.local_ip));
  const cfg = await config.loadConfig();

  const hasil = data.map((r) => {
    const d = deviceMap.get(r.local_ip);
    const svc = cfg.services.get(config.defaultServiceKey(r.svc_port, r.proto));
    return {
      ts: isoWib(r.ts),
      epoch: Number(r.ts),
      local_ip: r.local_ip,
      mac: d?.mac || null,
      label: d?.label || r.local_ip,
      remote_ip: r.remote_ip,
      svc_port: Number(r.svc_port),
      proto: r.proto,
      dir: r.dir,
      wan_if: Number(r.wan_if),
      layanan: svc ? svc.nama : `port ${r.svc_port}`,
      bytes: Number(r.bytes || 0),
      packets: Number(r.packets || 0),
    };
  });

  const base = await metaFor(rangeQuery(req));
  ok(res, hasil, {
    ...base,
    range: { from: isoWib(from), to: isoWib(to), jam: Number(jam.toFixed(3)) },
    maksimal_jam: maxHours,
    jumlah: hasil.length,
    limit,
    group,
    filter: { local_ip: localIp || null, remote_ip: remoteIp || null, svc_port: svcPort, proto: proto || null, dir: dir || null },
    sumber: 'flows_5m (retensi 3 hari)',
    warnings: [
      ...base.warnings,
      `flows_5m hanya menyimpan 3 hari terakhir.`,
      `Jendela dibatasi ${maxHours} jam; di atas itu MySQL memakai tabel sementara di disk (12 detik).`,
    ],
  });
}));

module.exports = router;
