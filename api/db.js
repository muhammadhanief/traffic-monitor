'use strict';

// db.js — dua pool koneksi ke skema yang SAMA (netflow_monitor), beda kredensial:
//
//   1. data → user read-only (mis. netflow_app). Semua pembacaan trafik.
//   2. cfg  → user tulis sempit (mis. netflow_cfg). Hanya dipakai untuk
//             tabel konfigurasi + kolom manual devices.nama/pemilik/grup.
//
// Pemisahan pool TIDAK memisahkan skema: tabel konfigurasi (segment,
// service_map, alert_rule, alert_event, setting) hidup di dalam
// netflow_monitor, sama seperti app_user/app_session/isp_map. Yang dipisah
// adalah HAK AKSES, supaya kredensial Vercel yang dipakai membaca trafik
// tidak memegang hak tulis.
//
// Bila CFG_DB_USER kosong, pool cfg memakai kredensial data (mode uji lokal).
// CFG_DB_NAME hanya perlu diisi bila Anda memang memakai skema lain.

require('dotenv').config();
const mysql = require('mysql2/promise');

const int = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const str = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v));

const base = {
  waitForConnections: true,
  queueLimit: 0,
  // Menjaga waktu tunggu terburuk tetap di bawah batas Vercel (maxDuration 30 s):
  // (timeout × percobaan) + jeda ≈ 6 s × 2 + 0,15 s ≈ 12 s.
  connectTimeout: int(process.env.DB_CONNECT_TIMEOUT_MS, 6000),
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4_unicode_ci',
  // Waktu disimpan sebagai epoch detik. Yang berbentuk DATETIME (devices.last_seen,
  // ingest_status.*_at) dibaca apa adanya sebagai string WIB — jangan diubah JS.
  timezone: 'local',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  multipleStatements: false,
  connectionLimit: int(process.env.DB_POOL_SIZE, 3),
};

const dataConfig = {
  ...base,
  host: str(process.env.DB_HOST, '127.0.0.1'),
  port: int(process.env.DB_PORT, 3306),
  user: str(process.env.DB_USER),
  password: str(process.env.DB_PASSWORD),
  database: str(process.env.DB_NAME, 'netflow_monitor'),
};

// ---------- pool data ----------
let _data = null;
function data() {
  if (!_data) _data = mysql.createPool(dataConfig);
  return _data;
}

// ---------- pool config ----------
// Skema bawaan = skema data (netflow_monitor). Host/port boleh beda bila
// tabel konfigurasi ditaruh di server lain, tetapi biasanya tidak.
const configSeparate = str(process.env.CFG_DB_HOST) !== '';
const cfgConfig = {
  ...base,
  host: configSeparate ? str(process.env.CFG_DB_HOST) : dataConfig.host,
  port: configSeparate ? int(process.env.CFG_DB_PORT, 3306) : dataConfig.port,
  user: str(process.env.CFG_DB_USER) || dataConfig.user,
  password: process.env.CFG_DB_PASSWORD !== undefined && process.env.CFG_DB_PASSWORD !== ''
    ? String(process.env.CFG_DB_PASSWORD)
    : dataConfig.password,
  database: str(process.env.CFG_DB_NAME, dataConfig.database),
};

let _cfg = null;
function cfg() {
  if (!_cfg) _cfg = mysql.createPool(cfgConfig);
  return _cfg;
}

// ---------- ulang-sambung ----------
// Link ke MySQL melewati internet (dan di Vercel, tiap lambda membuka pool
// sendiri). Kegagalan MEMBUKA koneksi sifatnya sementara dan aman diulang:
// statement belum pernah sampai ke server, jadi tidak ada risiko tulis ganda.
// Galat di tengah query (PROTOCOL_CONNECTION_LOST, ECONNRESET) TIDAK diulang,
// sebab perintahnya mungkin sudah dijalankan.
const CONNECT_ERRORS = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'ER_GET_CONNECTION_TIMEOUT', 'ER_CON_COUNT_ERROR',
]);

const RETRIES = Math.max(1, Math.min(4, Number(process.env.DB_CONNECT_RETRIES) || 2));

async function withRetry(fn) {
  let last;
  for (let i = 0; i < RETRIES; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i + 1 >= RETRIES || !CONNECT_ERRORS.has(err && err.code)) throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}

// ---------- pembantu ----------
/** Jalankan query ke DB data. -> [rows, fields] */
const q = (sql, params = []) => withRetry(() => data().query(sql, params));
/** Jalankan query ke DB data, ambil baris pertama (atau null). */
const q1 = async (sql, params = []) => {
  const [rows] = await withRetry(() => data().query(sql, params));
  return rows.length ? rows[0] : null;
};
/** Jalankan query lewat pool tulis (CFG_DB_USER). */
const cq = (sql, params = []) => withRetry(() => cfg().query(sql, params));
const cq1 = async (sql, params = []) => {
  const [rows] = await withRetry(() => cfg().query(sql, params));
  return rows.length ? rows[0] : null;
};

/**
 * Apakah tabel konfigurasi bisa dibaca? Di-cache supaya tidak query tiap
 * permintaan.
 *
 * Hanya galat yang "pasti" (tabel/skema tidak ada, kredensial ditolak) yang
 * di-cache sebagai false. Galat jaringan (ETIMEDOUT, ...) TIDAK di-cache,
 * supaya satu gangguan sesaat tidak mematikan lapisan konfigurasi sampai
 * lambda didaur ulang.
 *
 * "Siap" berarti user cfg bisa MEMBACA service_map; hak tulis diperiksa
 * terpisah saat menulis (galat -> CONFIG_READONLY).
 */
const CONFIG_DEFINITIVE = new Set([
  'ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR', 'ER_BAD_FIELD_ERROR',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR',
]);

let _cfgReady = null;
let _cfgError = null;
async function configReady() {
  if (_cfgReady !== null) return _cfgReady;
  try {
    await withRetry(() => cfg().query('SELECT 1 FROM service_map LIMIT 1'));
    _cfgReady = true;
    _cfgError = null;
  } catch (err) {
    _cfgError = (err && err.code) || 'UNKNOWN';
    _cfgReady = CONFIG_DEFINITIVE.has(_cfgError) ? false : null;
  }
  return _cfgReady === true;
}

/** Alasan bila configReady() false; untuk pesan yang bisa ditindaklanjuti. */
function configStatus() {
  return { ready: _cfgReady === true, error: _cfgError };
}

/** Buang cache deteksi & pool (dipakai setelah membuat skema konfigurasi). */
function resetConfigDetection() {
  _cfgReady = null;
  _cfgError = null;
}

async function ping() {
  const [rows] = await data().query(
    'SELECT VERSION() v, DATABASE() db, @@time_zone tz, @@system_time_zone sys_tz, NOW() now_wib'
  );
  return rows[0];
}

async function closeAll() {
  if (_data) await _data.end().catch(() => {});
  if (_cfg) await _cfg.end().catch(() => {});
  _data = _cfg = null;
}

module.exports = {
  data, cfg, q, q1, cq, cq1,
  configReady, configStatus, resetConfigDetection, ping, closeAll,
  info: {
    dataHost: dataConfig.host,
    dataDb: dataConfig.database,
    dataUser: dataConfig.user,
    configSeparate,
    configHost: cfgConfig.host,
    configDb: cfgConfig.database,
    configUser: cfgConfig.user,
    poolSize: base.connectionLimit,
  },
};
