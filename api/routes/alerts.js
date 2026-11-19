'use strict';

// routes/alerts.js — GET /api/alerts
//
// Peringatan dihitung dari kondisi nyata (bukan tabel denyut), karena:
//   - Vercel tidak bisa membaca Scheduled Task Windows;
//   - tabel alert_event belum tentu ada.
// Aturan tambahan bisa diisi di tabel `alert_rule` (di dalam netflow_monitor);
// bila tabelnya ada, hasil evaluasi ikut disimpan ke `alert_event`.

const express = require('express');
const db = require('../db');
const { asyncH, ok, intParam, isoWib, cached, metaTtl, rangeQuery, metaFor } = require('../lib/util');
const config = require('../lib/config');

const router = express.Router();

/** Evaluasi seluruh aturan yang bisa dihitung dari data yang tersedia. */
async function evaluasi(range) {
  const now = Math.floor(Date.now() / 1000);
  const peringatan = [];

  const push = (w) => peringatan.push(w);

  // ---- 1. pipeline ----
  const pipe = await db.q1(`
    SELECT (SELECT UNIX_TIMESTAMP() - MAX(ts) FROM traffic_1m) AS lag_detik,
           (SELECT MAX(ts_hour) FROM traffic_1h)              AS last_hour,
           (SELECT MAX(ts)      FROM router_stat)             AS last_router`);

  const lag = pipe?.lag_detik === null || pipe?.lag_detik === undefined ? null : Number(pipe.lag_detik);
  if (lag === null) {
    push({ kode: 'TANPA_DATA', tingkat: 'merah', pesan: 'Belum ada data NetFlow sama sekali.' });
  } else if (lag > 300) {
    push({ kode: 'INGEST_MATI', tingkat: 'merah', pesan: `Ingest berhenti: data terakhir ${lag} detik lalu.`, nilai: lag, satuan: 'detik' });
  }

  if (!pipe?.last_hour || now - Number(pipe.last_hour) > 3 * 3600) {
    push({ kode: 'ROLLUP_MATI', tingkat: 'kuning', pesan: 'Rollup per jam belum berjalan (task NetflowRollupHourly?).',
      nilai: pipe?.last_hour ? now - Number(pipe.last_hour) : null, satuan: 'detik' });
  }
  if (!pipe?.last_router || now - Number(pipe.last_router) > 600) {
    push({ kode: 'SYNC_ROUTER_MATI', tingkat: 'kuning', pesan: 'Sinkronisasi router belum berjalan (task NetflowSyncRouter?).',
      nilai: pipe?.last_router ? now - Number(pipe.last_router) : null, satuan: 'detik' });
  }

  // ---- 2. router ----
  const rt = await db.q1(`
    SELECT ts, cpu_load, cpu_temp_c, free_memory, total_memory,
           psu1_state, psu2_state, fan_state, ntp_synced
      FROM router_stat ORDER BY ts DESC LIMIT 1`);

  if (rt) {
    if (Number(rt.cpu_temp_c) > 65) {
      push({ kode: 'SUHU_CPU', tingkat: 'merah', pesan: `Suhu CPU ${rt.cpu_temp_c} °C (> 65 °C).`, nilai: Number(rt.cpu_temp_c), satuan: '°C' });
    }
    const bebas = rt.total_memory ? (Number(rt.free_memory) / Number(rt.total_memory)) * 100 : null;
    if (bebas !== null && bebas < 10) {
      push({ kode: 'RAM_TIPIS', tingkat: 'kuning', pesan: `RAM bebas ${bebas.toFixed(1)}% (< 10%).`, nilai: Number(bebas.toFixed(1)), satuan: '%' });
    }
    if (Number(rt.ntp_synced) === 0) {
      push({ kode: 'NTP_TIDAK_SINKRON', tingkat: 'merah', pesan: 'NTP router tidak sinkron; stempel waktu NetFlow bisa meleset.' });
    }
    for (const [kolom, label] of [['psu1_state', 'PSU1'], ['psu2_state', 'PSU2']]) {
      const v = String(rt[kolom] || '').toLowerCase();
      if (v && v !== 'ok') push({ kode: `PSU_${label}`, tingkat: 'merah', pesan: `${label} berstatus "${rt[kolom]}".` });
    }
    if (rt.fan_state && String(rt.fan_state).toLowerCase() !== 'ok') {
      push({ kode: 'FAN', tingkat: 'kuning', pesan: `Status kipas "${rt.fan_state}".` });
    }
  }

  // ---- 3. perangkat boros (ambang dari setting, bawaan 5 GB/hari) ----
  const cfg = await config.loadConfig();
  const ambangGb = Number(cfg.settings.get('ambang_perangkat_gb') || 5);
  const [boros] = await db.q(`
    SELECT local_ip, SUM(bytes) AS bytes
      FROM traffic_daily
     WHERE day = ? AND dir = 'down'
     GROUP BY local_ip
    HAVING bytes > ?
     ORDER BY bytes DESC
     LIMIT 10`, [range.fromDay, ambangGb * 1073741824]);

  if (boros.length) {
    const { ipToDevice } = require('../lib/lookup');
    const map = await ipToDevice(boros.map((b) => b.local_ip));
    for (const b of boros) {
      const d = map.get(b.local_ip);
      const gb = Number((Number(b.bytes) / 1073741824).toFixed(2));
      push({
        kode: 'PERANGKAT_BOROS',
        tingkat: 'kuning',
        pesan: `${d?.label || b.local_ip} mengunduh ${gb} GB hari ini (> ambang ${ambangGb} GB).`,
        subjek: d?.mac || null,
        nilai: gb,
        satuan: 'GB',
      });
    }
  }

  // ---- 4. aturan dari tabel alert_rule (bila ada) ----
  for (const rule of cfg.alertRules) {
    if (Number(rule.aktif) === 0) continue;
    // tipe yang belum punya evaluator khusus ditandai agar tidak diam-diam diabaikan.
    const ditangani = ['suhu', 'ingest_lag', 'perangkat_boros', 'ram', 'ntp'];
    if (!ditangani.includes(String(rule.tipe))) {
      push({
        kode: `RULE_${rule.kode}`,
        tingkat: 'info',
        pesan: `Aturan "${rule.nama}" (tipe ${rule.tipe}) belum dievaluasi otomatis oleh API.`,
        nilai: rule.ambang === null ? null : Number(rule.ambang),
        satuan: rule.satuan,
      });
    }
  }

  return { peringatan, terakhir: rt ? { ts: isoWib(rt.ts), epoch: Number(rt.ts) } : null };
}

router.get('/', asyncH(async (req, res) => {
  const range = rangeQuery(req);

  if (!config.alertsEnabled()) {
    return ok(res, { jumlah: 0, merah: 0, kuning: 0, info: 0, peringatan: [], dimatikan: true },
      await metaFor(range, { sumber: null, catatan: 'Peringatan dimatikan (ALERTS_ENABLED=0).' }));
  }

  const hasil = await cached('alerts', metaTtl(), () => evaluasi(range));

  const urut = { merah: 0, kuning: 1, info: 2 };
  const peringatan = hasil.peringatan.sort((a, b) => (urut[a.tingkat] ?? 9) - (urut[b.tingkat] ?? 9));

  ok(res, {
    jumlah: peringatan.length,
    merah: peringatan.filter((p) => p.tingkat === 'merah').length,
    kuning: peringatan.filter((p) => p.tingkat === 'kuning').length,
    info: peringatan.filter((p) => p.tingkat === 'info').length,
    peringatan,
    sumber_data_router: hasil.terakhir,
  }, await metaFor(range, {
    sumber: 'dihitung dari traffic_1m, traffic_1h, traffic_daily, router_stat',
    catatan: 'Aturan dari tabel alert_rule ikut dibaca bila skema konfigurasi tersedia.',
  }));
}));

module.exports = router;
module.exports.evaluasi = evaluasi;
