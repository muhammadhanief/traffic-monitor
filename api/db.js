'use strict';

// db.js — dua pool koneksi:
//
//   1. data   → netflow_monitor  (user read-only, mis. netflow_api)
//   2. config → netflow_config   (user baca/tulis, mis. netflow_cfg)
//
// Keduanya boleh berada di server yang sama (kasus kita: 111.68.27.116,
// skema terpisah) atau di server berbeda. Bila CFG_DB_HOST dikosongkan,
// pool config otomatis memakai alamat pool data.

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
const configSeparate = str(process.env.CFG_DB_HOST) !== '';
const cfgConfig = {
  ...base,
  host: configSeparate ? str(process.env.CFG_DB_HOST) : dataConfig.host,
  port: configSeparate ? int(process.env.CFG_DB_PORT, 3306) : dataConfig.port,
  user: str(process.env.CFG_DB_USER) || dataConfig.user,
  password: process.env.CFG_DB_PASSWORD !== undefined && process.env.CFG_DB_PASSWORD !== ''
    ? String(process.env.CFG_DB_PASSWORD)
    : dataConfig.password,
  database: str(process.env.CFG_DB_NAME, 'netflow_config'),
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
/** Jalankan query ke DB konfigurasi. */
const cq = (sql, params = []) => withRetry(() => cfg().query(sql, params));
const cq1 = async (sql, params = []) => {
  const [rows] = await withRetry(() => cfg().query(sql, params));
  return rows.length ? rows[0] : null;
};

/**
 * Apakah tabel konfigurasi sudah ada? Di-cache supaya tidak query
 * information_schema tiap permintaan. Dianggap ada bila query berhasil.
 */
let _cfgReady = null;
async function configReady() {
  if (_cfgReady !== null) return _cfgReady;
  try {
    await withRetry(() => cfg().query('SELECT 1 FROM service_map LIMIT 1'));
    _cfgReady = true;
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_DB_ERROR')) {
      _cfgReady = false;
    } else {
      // Kredensial belum diberikan, dll. Jangan lempar — aplikasi tetap boleh
      // jalan tanpa layer konfigurasi (memakai nama dari hostname saja).
      _cfgReady = false;
    }
  }
  return _cfgReady;
}

/** Buang cache deteksi & pool (dipakai setelah membuat skema konfigurasi). */
function resetConfigDetection() {
  _cfgReady = null;
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
  configReady, resetConfigDetection, ping, closeAll,
  info: {
    dataHost: dataConfig.host,
    dataDb: dataConfig.database,
    configSeparate,
    configHost: cfgConfig.host,
    configDb: cfgConfig.database,
    poolSize: base.connectionLimit,
  },
};
