'use strict';

// util.js — pembantu bersama: rentang waktu WIB, pembungkus respons,
// cache 60 detik, pembatas laju, dan penanganan galat.

const db = require('../db');

// ============================================================
//  Waktu — WIB (UTC+7) yang tidak bergantung zona waktu server
// ============================================================

const WIB_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400 * 1000;

/** Tanggal WIB (YYYY-MM-DD) untuk sebuah epoch milidetik. */
const wibDate = (ms) => new Date(ms + WIB_OFFSET_MS).toISOString().slice(0, 10);

/** Epoch detik untuk pukul 00:00 WIB pada tanggal YYYY-MM-DD. */
const wibStartTs = (ymd) => Math.floor(Date.parse(`${ymd}T00:00:00+07:00`) / 1000);

/** Konversi epoch detik -> string ISO dengan offset +07:00. */
const isoWib = (sec) => {
  if (sec === null || sec === undefined) return null;
  const d = new Date(Number(sec) * 1000 + WIB_OFFSET_MS);
  return d.toISOString().replace('Z', '+07:00');
};

const RANGES = ['today', '24h', '7d', '30d', 'month', 'year'];

/**
 * Ubah nama rentang menjadi batas konkret.
 * Mengembalikan { range, fromTs, toTs, fromDay, fromMonth, days }
 */
function rangeBounds(range = 'today') {
  const name = RANGES.includes(range) ? range : 'today';
  const nowMs = Date.now();
  const toTs = Math.floor(nowMs / 1000);
  const today = wibDate(nowMs);

  const out = (fromTs) => {
    const fromDay = wibDate(fromTs * 1000);
    return {
      range: name,
      fromTs,
      toTs,
      fromDay,
      fromMonth: `${fromDay.slice(0, 7)}-01`,
      days: Math.max(1, Math.round((toTs - fromTs) / 86400)),
    };
  };

  switch (name) {
    case '24h':
      return out(toTs - 86400);
    case '7d':
      return out(wibStartTs(today) - 6 * 86400);
    case '30d':
      return out(wibStartTs(today) - 29 * 86400);
    case 'month':
      return out(wibStartTs(`${today.slice(0, 7)}-01`));
    case 'year':
      return out(wibStartTs(`${today.slice(0, 4)}-01-01`));
    case 'today':
    default:
      return out(wibStartTs(today));
  }
}

// ============================================================
//  Galat & pembungkus respons
// ============================================================

class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const badRequest = (msg, detail) => new ApiError(400, 'BAD_REQUEST', msg, detail);
const forbidden = (msg) => new ApiError(403, 'FORBIDDEN', msg);

/** Pembungkus handler async agar galat diteruskan ke middleware galat. */
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Respons sukses dengan pembungkus { data, meta }. */
function ok(res, data, meta) {
  res.json({ data, meta: { generatedAt: isoWib(Math.floor(Date.now() / 1000)), ...(meta || {}) } });
}

/** Ambil parameter integer dengan batas. */
function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function strParam(value, maxLen = 200) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, maxLen);
}

/** Satu-satunya nilai yang boleh masuk SQL sebagai potongan literal. */
function enumParam(value, allowed, fallback) {
  const v = String(value ?? '').toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/** Rentang dari query string (?range=today|24h|7d|30d|month|year). */
const rangeQuery = (req) => rangeBounds(enumParam(req.query.range, RANGES, 'today'));

// ============================================================
//  Cache dalam memori (per lambda Vercel)
// ============================================================

const store = new Map();

/**
 * Jalankan fn() dan simpan hasilnya selama ttl detik dengan kunci tertentu.
 * Nilai yang sedang dihitung tidak dihitung ulang (menghindari thundering herd
 * pada satu lambda).
 */
async function cached(key, ttlSeconds, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value;
  if (hit && hit.pending) return hit.pending;

  const pending = Promise.resolve()
    .then(fn)
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      return value;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });

  store.set(key, { pending, expires: now + ttlSeconds * 1000 });
  return pending;
}

const cacheTtl = () => intParam(process.env.CACHE_TTL_SECONDS, 60, 0, 3600);
const metaTtl = () => intParam(process.env.META_TTL_SECONDS, 30, 0, 600);

/** Buang satu entri cache (dipakai setelah menulis konfigurasi). */
const __cacheDelete = (key) => store.delete(key);

// ============================================================
//  Metadata respons (lag, cakupan rollup, peringatan)
// ============================================================

/**
 * Di-cache pendek karena dipanggil di hampir semua endpoint.
 * Semua batas waktu dihitung di JS (WIB), tidak memakai CURDATE()/FROM_UNIXTIME
 * supaya hasilnya tidak bergantung time_zone sesi MySQL.
 */
async function baseMeta() {
  return cached('meta:base', metaTtl(), async () => {
    const todayStart = wibStartTs(wibDate(Date.now()));

    const row = await db.q1(`
      SELECT
        (SELECT UNIX_TIMESTAMP() - MAX(ts) FROM traffic_1m)      AS lag_seconds,
        (SELECT MIN(ts) FROM traffic_1m)                         AS data_since_ts,
        (SELECT MAX(ts) FROM traffic_1m)                         AS data_last_ts,
        (SELECT MAX(ts_hour) FROM traffic_1h)                    AS last_rollup_hour,
        (SELECT MAX(day)     FROM traffic_daily)                 AS last_rollup_day
    `);

    const lag = row?.lag_seconds === null || row?.lag_seconds === undefined
      ? null
      : Number(row.lag_seconds);
    const sinceTs = row?.data_since_ts === null || row?.data_since_ts === undefined
      ? null : Number(row.data_since_ts);
    const lastHour = row?.last_rollup_hour === null || row?.last_rollup_hour === undefined
      ? null : Number(row.last_rollup_hour);

    // Cakupan rollup HANYA dihitung pada jam yang sudah ditutup.
    // traffic_1h selalu tertinggal satu jam lebih dari traffic_1m (rollup
    // berjalan tiap jam), sehingga bila jam berjalan ikut dihitung cakupan
    // akan selalu ~0,98 dan tampak seperti masalah padahal normal.
    let coverage = null;
    if (lastHour !== null) {
      const kutip = lastHour + 3600; // awal jam setelah jam terakhir yang ditutup
      const sum = await db.q1(`
        SELECT
          (SELECT SUM(bytes) FROM traffic_1h WHERE ts_hour >= ? AND ts_hour < ?) AS h,
          (SELECT SUM(bytes) FROM traffic_1m WHERE ts      >= ? AND ts      < ?) AS m
      `, [todayStart, kutip, todayStart, kutip]);
      const mBytes = Number(sum?.m || 0);
      coverage = mBytes > 0 ? Number((Number(sum?.h || 0) / mBytes).toFixed(4)) : null;
    }

    // Rollup berjalan tiap jam; toleransi 3 jam.
    const now = Math.floor(Date.now() / 1000);
    const rollupStale = lastHour !== null ? now - lastHour > 3 * 3600 : true;

    const warnings = [];
    if (lag !== null && lag > 300) {
      warnings.push(`Ingest berhenti: data terakhir ${lag} detik lalu.`);
    }
    if (rollupStale) {
      warnings.push('Rollup per jam belum berjalan (task NetflowRollupHourly?).');
    }
    if (coverage !== null && coverage < 0.99) {
      warnings.push(`Cakupan rollup per jam ${(coverage * 100).toFixed(1)}% — traffic_1h belum lengkap.`);
    }

    return {
      dataLagSeconds: lag,
      rollupCoverage: coverage,
      dataSinceTs: sinceTs,
      dataSince: isoWib(sinceTs),
      dataLast: isoWib(row?.data_last_ts),
      lastRollupHour: lastHour !== null ? isoWib(lastHour) : null,
      lastRollupDay: row?.last_rollup_day || null,
      warnings,
    };
  });
}

/** Meta lengkap untuk sebuah rentang. */
async function metaFor(range, extra = {}) {
  const base = await baseMeta();

  // partial = data yang diminta TIDAK lengkap. Dua sebabnya:
  //   1. rentang mulai sebelum riwayat kita ada (data baru mulai <dataSince>);
  //   2. rollup per jam kurang lengkap untuk jam yang sudah ditutup.
  const riwayatKurang = base.dataSinceTs !== null && range.fromTs < base.dataSinceTs;
  const rollupKurang = base.rollupCoverage !== null && base.rollupCoverage < 0.99;
  const partial = riwayatKurang || rollupKurang;

  const warnings = [...base.warnings];
  if (riwayatKurang && base.dataSince) {
    warnings.push(`Riwayat data baru mulai ${base.dataSince}; rentang ${range.range} tidak sepenuhnya tercakup.`);
  }

  return {
    range: {
      from: isoWib(range.fromTs),
      to: isoWib(range.toTs),
      label: range.range,
    },
    dataLagSeconds: base.dataLagSeconds,
    rollupCoverage: base.rollupCoverage,
    dataSince: base.dataSince,
    dataLast: base.dataLast,
    partial,
    partialReason: riwayatKurang ? 'riwayat' : rollupKurang ? 'rollup' : null,
    warnings,
    ...extra,
  };
}

// ============================================================
//  Pembatas laju sederhana (per IP, per lambda)
// ============================================================

const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown';
    const now = Date.now();
    const b = buckets.get(ip);
    if (!b || b.reset < now) {
      buckets.set(ip, { count: 1, reset: now + windowMs });
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `Terlalu banyak permintaan. Batas ${max}/menit.` },
      });
    }
    // Sesekali bersihkan agar peta tidak tumbuh terus.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }
    return next();
  };
}

module.exports = {
  WIB_OFFSET_MS,
  RANGES,
  rangeBounds,
  wibDate,
  wibStartTs,
  isoWib,
  ApiError,
  badRequest,
  forbidden,
  asyncH,
  ok,
  intParam,
  strParam,
  enumParam,
  rangeQuery,
  cached,
  cacheTtl,
  metaTtl,
  __cacheDelete,
  baseMeta,
  metaFor,
  rateLimit,
};
