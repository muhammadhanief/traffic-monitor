'use strict';

// routes/router.js — layar Kesehatan Router & Peta Port.
//   GET /api/router/health?range=24h
//   GET /api/router/ports
//   GET /api/router/sessions?limit=50&activeOnly=1

const express = require('express');
const db = require('../db');
const {
  asyncH, ok, intParam, rangeQuery, metaFor, cached, cacheTtl, isoWib,
} = require('../lib/util');
const config = require('../lib/config');

const router = express.Router();

// Ambang peringatan — DOKUMENTASI-UI.md §8.5
const AMBANG = {
  suhu_cpu: 65,      // °C, merah
  cpu_persen: 90,    // % selama 5 menit, kuning
  ram_bebas_persen: 10, // kuning
};

// ------------------------------------------------------------
//  Kesehatan router
// ------------------------------------------------------------
router.get('/health', asyncH(async (req, res) => {
  const range = rangeQuery(req);
  const maxRows = intParam(req.query.maxRows, 3000, 10, 10000);

  const payload = await cached(`router:health:${range.fromTs}:${maxRows}`, cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT ts, cpu_load, free_memory, total_memory, uptime_sec,
             cpu_temp_c, board_temp1_c, board_temp2_c,
             fan1_rpm, fan2_rpm, psu1_state, psu2_state, fan_state,
             ntp_enabled, ntp_synced, ros_version, update_channel
        FROM router_stat
       WHERE ts >= ?
       ORDER BY ts
       LIMIT ?`, [range.fromTs, maxRows]);

    if (!rows.length) {
      return { terakhir: null, seri: [], reboot: [], peringatan: [], ringkasan: null };
    }

    const terakhir = rows[rows.length - 1];

    // Deteksi reboot: uptime turun di antara dua titik berurutan.
    const reboot = [];
    for (let i = 1; i < rows.length; i += 1) {
      const a = Number(rows[i - 1].uptime_sec ?? 0);
      const b = Number(rows[i].uptime_sec ?? 0);
      if (b < a) {
        reboot.push({
          ts: isoWib(rows[i].ts),
          epoch: Number(rows[i].ts),
          uptime_sebelum: a,
          uptime_sesudah: b,
          catatan: 'Counter NetFlow ikut ter-reset; lonjakan/penurunan tajam di grafik trafik pada jam ini adalah artefak, bukan gangguan jaringan.',
        });
      }
    }

    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const bebasPersen = terakhir.total_memory
      ? (Number(terakhir.free_memory) / Number(terakhir.total_memory)) * 100
      : null;

    const peringatan = [];
    if (num(terakhir.cpu_temp_c) !== null && Number(terakhir.cpu_temp_c) > AMBANG.suhu_cpu) {
      peringatan.push({ tingkat: 'merah', kode: 'SUHU_CPU', pesan: `Suhu CPU ${terakhir.cpu_temp_c} °C melebihi ${AMBANG.suhu_cpu} °C.` });
    }
    if (bebasPersen !== null && bebasPersen < AMBANG.ram_bebas_persen) {
      peringatan.push({ tingkat: 'kuning', kode: 'RAM_TIPIS', pesan: `RAM bebas ${bebasPersen.toFixed(1)}% (< ${AMBANG.ram_bebas_persen}%).` });
    }
    if (num(terakhir.ntp_synced) === 0) {
      peringatan.push({ tingkat: 'merah', kode: 'NTP_TIDAK_SINKRON', pesan: 'NTP router tidak sinkron — stempel waktu NetFlow bisa meleset.' });
    }
    for (const psu of ['psu1_state', 'psu2_state']) {
      const v = String(terakhir[psu] || '').toLowerCase();
      if (v && v !== 'ok') peringatan.push({ tingkat: 'merah', kode: psu.toUpperCase(), pesan: `${psu} = ${terakhir[psu]}.` });
    }
    if (terakhir.fan_state && String(terakhir.fan_state).toLowerCase() !== 'ok') {
      peringatan.push({ tingkat: 'kuning', kode: 'FAN', pesan: `fan_state = ${terakhir.fan_state}.` });
    }
    const cpuTinggi = rows.slice(-5).filter((r) => Number(r.cpu_load) > AMBANG.cpu_persen);
    if (rows.length >= 5 && cpuTinggi.length === 5) {
      peringatan.push({ tingkat: 'kuning', kode: 'CPU_TINGGI', pesan: `CPU > ${AMBANG.cpu_persen}% pada 5 sampel terakhir.` });
    }

    const agg = (col) => {
      const v = rows.map((r) => num(r[col])).filter((x) => x !== null);
      if (!v.length) return null;
      return {
        min: Math.min(...v),
        max: Math.max(...v),
        rata: Number((v.reduce((s, x) => s + x, 0) / v.length).toFixed(2)),
      };
    };

    return {
      terakhir: {
        ts: isoWib(terakhir.ts),
        epoch: Number(terakhir.ts),
        cpu_load: num(terakhir.cpu_load),
        free_memory: num(terakhir.free_memory),
        total_memory: num(terakhir.total_memory),
        ram_bebas_persen: bebasPersen === null ? null : Number(bebasPersen.toFixed(2)),
        uptime_sec: num(terakhir.uptime_sec),
        uptime_hari: terakhir.uptime_sec ? Number((Number(terakhir.uptime_sec) / 86400).toFixed(2)) : null,
        cpu_temp_c: num(terakhir.cpu_temp_c),
        board_temp1_c: num(terakhir.board_temp1_c),
        board_temp2_c: num(terakhir.board_temp2_c),
        fan1_rpm: num(terakhir.fan1_rpm),
        fan2_rpm: num(terakhir.fan2_rpm),
        fan_state: terakhir.fan_state,
        psu1_state: terakhir.psu1_state,
        psu2_state: terakhir.psu2_state,
        ntp_enabled: num(terakhir.ntp_enabled),
        ntp_synced: num(terakhir.ntp_synced),
        ros_version: terakhir.ros_version,
        update_channel: terakhir.update_channel,
      },
      ringkasan: {
        titik: rows.length,
        cpu_load: agg('cpu_load'),
        cpu_temp_c: agg('cpu_temp_c'),
        board_temp1_c: agg('board_temp1_c'),
        board_temp2_c: agg('board_temp2_c'),
        free_memory: agg('free_memory'),
      },
      seri: rows.map((r) => ({
        ts: isoWib(r.ts),
        epoch: Number(r.ts),
        cpu_load: num(r.cpu_load),
        cpu_temp_c: num(r.cpu_temp_c),
        board_temp1_c: num(r.board_temp1_c),
        board_temp2_c: num(r.board_temp2_c),
        free_memory: num(r.free_memory),
        uptime_sec: num(r.uptime_sec),
      })),
      reboot,
      peringatan,
      ambang: AMBANG,
      catatan: 'Tegangan PSU dan "update tersedia" tidak tersedia dari router ini (CCR2004).',
    };
  });

  ok(res, payload, await metaFor(range, {
    sumber: 'router_stat (sync-router.js)',
    jumlah_titik: payload.seri.length,
  }));
}));

// ------------------------------------------------------------
//  Peta port
// ------------------------------------------------------------
router.get('/ports', asyncH(async (req, res) => {
  const payload = await cached('router:ports', cacheTtl(), async () => {
    const [rows] = await db.q(`
      SELECT pm.mac, pm.bridge, pm.port, pm.is_uplink, pm.is_local,
             pm.first_seen, pm.last_seen,
             v.hostname, v.nama, v.last_ip, v.aktif
        FROM port_map pm
        LEFT JOIN devices v ON v.mac = pm.mac
       ORDER BY pm.port, pm.last_seen DESC`);

    const cfg = await config.loadConfig();

    const perPort = new Map();
    for (const r of rows) {
      const port = r.port || '(tidak diketahui)';
      if (!perPort.has(port)) {
        perPort.set(port, {
          port,
          bridge: r.bridge || null,
          is_uplink: Number(r.is_uplink) === 1,
          jumlah_perangkat: 0,
          perangkat: [],
        });
      }
      const p = perPort.get(port);
      p.jumlah_perangkat += 1;
      p.perangkat.push({
        mac: r.mac,
        label: config.deviceLabel({ mac: r.mac, hostname: r.hostname, nama: r.nama }, cfg),
        last_ip: r.last_ip || null,
        is_local: Number(r.is_local) === 1,
        last_seen: isoWib(r.last_seen),
      });
    }

    // Daftar port yang seharusnya ada (disimpan di setting bila diketahui,
    // karena /interface/ethernet belum disinkronkan ke DB).
    // Dibaca lewat config.loadConfig() yang sudah meng-cache dan sudah tahu
    // apakah skema konfigurasi ada — JANGAN query cfg langsung di sini, sebab
    // saat netflow_config tidak tersedia setiap permintaan akan menunggu
    // connectTimeout (12 detik).
    const nilaiPort = cfg.settings.get('ethernet_ports') || '';
    const daftarPort = String(nilaiPort).trim()
      ? String(nilaiPort).split(',').map((s) => s.trim()).filter(Boolean)
      : [...perPort.keys()].filter((p) => p !== '(tidak diketahui)');

    return {
      port: [...perPort.values()].sort((a, b) => String(a.port).localeCompare(String(b.port))),
      daftar_port: daftarPort.map((p) => ({
        port: p,
        ada_perangkat: perPort.has(p) && perPort.get(p).jumlah_perangkat > 0,
        is_uplink: perPort.get(p)?.is_uplink || false,
      })),
      jumlah_baris: rows.length,
      catatan: 'Daftar port lengkap (termasuk yang kosong) perlu sinkronisasi /interface/ethernet. Sementara diisi dari setting "ethernet_ports".',
    };
  });

  ok(res, payload, await metaFor(rangeQuery(req), {
    sumber: 'port_map + devices',
    cacheDetik: cacheTtl(),
  }));
}));

// ------------------------------------------------------------
//  Sesi login router
// ------------------------------------------------------------
router.get('/sessions', asyncH(async (req, res) => {
  const limit = intParam(req.query.limit, 50, 1, 500);
  const aktiv = ['1', 'true'].includes(String(req.query.activeOnly || '').toLowerCase());

  const [rows] = await db.q(`
    SELECT id, username, address, via, grup, started_at, last_seen
      FROM router_session
     WHERE (? = 0 OR last_seen >= UNIX_TIMESTAMP() - 300)
     ORDER BY last_seen DESC
     LIMIT ?`, [aktiv ? 1 : 0, limit]);

  const now = Math.floor(Date.now() / 1000);
  ok(res, rows.map((r) => ({
    id: Number(r.id),
    username: r.username,
    address: r.address,
    via: r.via,
    grup: r.grup,
    started_at: isoWib(r.started_at),
    last_seen: isoWib(r.last_seen),
    aktif: now - Number(r.last_seen) <= 300,
    durasi_detik: Number(r.last_seen) - Number(r.started_at),
  })), await metaFor(rangeQuery(req), {
    aktivOnly: aktiv,
    catatan: 'Aktif = terlihat dalam 5 menit terakhir. Sumber: /user/active (sync-router.js).',
    sumber: 'router_session',
  }));
}));

module.exports = router;
