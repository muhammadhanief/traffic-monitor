'use strict';

// index.js — API dashboard NetFlow Monitor.
// Express 5 + mysql2, dirancang untuk Vercel (serverless) maupun lokal.
//
// Basis URL: /api
// Pembungkus sukses: { data, meta }
// Pembungkus galat  : { error: { code, message, detail? } }

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./db');
const util = require('./lib/util');
const auth = require('./lib/auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ---------- CORS ----------
// Yang memanggil API ini adalah browser di jaringan BPS, bukan server cPanel.
const origins = (process.env.CORS_ORIGINS || 'https://traffic-monitor.web.bps.go.id,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);              // curl / health check
    if (origins.includes('*') || origins.includes(origin)) return cb(null, true);
    return cb(new util.ApiError(403, 'ORIGIN_DITOLAK', `Origin tidak diizinkan: ${origin}`));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  maxAge: 600,
}));

app.use(express.json({ limit: '256kb' }));

// ---------- pembatas laju ----------
app.use('/api', util.rateLimit({
  max: util.intParam(process.env.RATE_LIMIT_PER_MINUTE, 60, 5, 600),
  windowMs: 60000,
}));

// ---------- autentikasi (Bearer SSO) ----------
app.get('/', (_req, res) => {
  res.json({
    nama: 'api-traffic-monitor',
    status: 'jalan',
    basis: '/api',
    autentikasi: auth.info.authEnabled ? 'Bearer token SSO BPS' : 'NONAKTIF (mode pengembangan)',
    database: { data: db.info.dataDb, tulisan: db.info.configDb },
    endpoint: {
      kesehatan: '/api/health',
      ringkasan: '/api/summary',
      pemakaian: ['/api/usage/timeseries', '/api/usage/hourly', '/api/usage/monthly'],
      segmen: '/api/segments',
      jalur_wan: '/api/isp',
      perangkat: ['/api/devices', '/api/devices/:mac (GET, PATCH)', '/api/top/devices'],
      tujuan: ['/api/top/destinations', '/api/destinations/:ip'],
      layanan: ['/api/services', '/api/services/:port'],
      penelusuran: '/api/search',
      router: ['/api/router/health', '/api/router/ports', '/api/router/sessions'],
      audit: '/api/audit/log',
      peringatan: '/api/alerts',
      konfigurasi: '/api/config',
      pengguna: '/api/me',
    },
  });
});

app.get('/api/me', auth.authenticate, (req, res) => util.ok(res, req.user));

app.use('/api/health', auth.authenticate, require('./routes/health'));
app.use('/api/summary', auth.authenticate, require('./routes/summary'));
app.use('/api/usage', auth.authenticate, require('./routes/usage'));
app.use('/api/segments', auth.authenticate, require('./routes/segments'));
app.use('/api/isp', auth.authenticate, require('./routes/isp'));
app.use('/api/devices', auth.authenticate, require('./routes/devices'));
app.use('/api/services', auth.authenticate, require('./routes/services'));
app.use('/api/search', auth.authenticate, require('./routes/search'));
app.use('/api/router', auth.authenticate, require('./routes/router'));
app.use('/api/audit', auth.authenticate, require('./routes/audit'));
app.use('/api/alerts', auth.authenticate, require('./routes/alerts'));
app.use('/api/config', auth.authenticate, require('./routes/config'));

// Router yang sama melayani dua awalan berbeda:
//   /api/top/devices, /api/top/destinations, /api/destinations/:ip
const topRouter = require('./routes/top');
app.use('/api/top', auth.authenticate, topRouter);
app.use('/api/destinations', auth.authenticate, topRouter);

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Rute tidak ditemukan: ${req.method} ${req.path}` },
  });
});

// ---------- penanganan galat ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  let status = err instanceof util.ApiError ? err.status : 500;
  let code = err instanceof util.ApiError ? err.code : 'INTERNAL_ERROR';

  // Galat hak akses MySQL hampir selalu berarti CFG_DB_USER belum diisi
  // (pool tulis memakai user read-only). Beri pesan yang bisa ditindaklanjuti,
  // jangan 500 "Terjadi galat di server".
  if (err && (err.code === 'ER_TABLEACCESS_DENIED_ERROR' || err.code === 'ER_DBACCESS_DENIED_ERROR')) {
    status = 503;
    code = 'CONFIG_READONLY';
    err.message = 'User database tidak punya hak yang dibutuhkan. Bila ini terjadi saat '
      + 'menyimpan, isi CFG_DB_USER/CFG_DB_PASSWORD dengan user sempit (api/README.md bagian 3).';
  }
  // Tabel konfigurasi yang belum dibuat -> pesan yang memberi jalan keluar.
  if (err && err.code === 'ER_NO_SUCH_TABLE') {
    const m = /Table '[^']*\.([A-Za-z0-9_]+)' doesn't exist/.exec(err.sqlMessage || '');
    if (m && ['segment', 'service_map', 'alert_rule', 'alert_event', 'setting'].includes(m[1].toLowerCase())) {
      status = 503;
      code = 'CONFIG_UNAVAILABLE';
      err.message = 'Tabel konfigurasi belum dibuat. Jalankan: npm run db:config';
    }
  }
  // Pelanggaran UNIQUE (mis. port+proto ganda) adalah kesalahan pemanggil,
  // bukan galat server.
  if (err && err.code === 'ER_DUP_ENTRY') {
    status = 409;
    code = 'DUPLIKAT';
    err.message = 'Baris dengan kunci yang sama sudah ada.';
  }
  // Foreign key: baris induk tidak ada / masih dipakai.
  if (err && (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2')) {
    status = 409;
    code = 'TERKAIT_BARIS_LAIN';
    err.message = 'Baris terkait tabel lain; periksa referensinya.';
  }

  if (status >= 500) {
    console.error(`[galat] ${req.method} ${req.originalUrl}:`, err.message, err.code || '');
  }

  res.status(status).json({
    error: {
      code,
      message: status >= 500 && process.env.NODE_ENV === 'production'
        ? 'Terjadi galat di server.'
        : err.message,
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.code && status >= 500 ? { mysql: err.code } : {}),
    },
  });
});

// ---------- jalankan lokal ----------
if (require.main === module) {
  const port = util.intParam(process.env.PORT, 3001, 1, 65535);
  app.listen(port, async () => {
    console.log(`API jalan di http://localhost:${port}`);
    console.log(`  data   : ${db.info.dataHost}/${db.info.dataDb} sebagai "${db.info.dataUser}" (pool ${db.info.poolSize})`);
    console.log(`  tulis  : ${db.info.configHost}/${db.info.configDb} sebagai "${db.info.configUser}"`);
    console.log(`  auth   : ${auth.info.authEnabled ? 'Bearer SSO aktif' : 'NONAKTIF'}`);
    try {
      const info = await db.ping();
      console.log(`  MySQL  : ${info.v} | time_zone ${info.tz} | sekarang ${info.now_wib}`);
      const siap = await db.configReady();
      const { error } = db.configStatus();
      console.log(`  tabel konfigurasi: ${siap ? 'siap' : `belum bisa dibaca (${error})`}`);
    } catch (err) {
      console.error(`  MySQL  : GAGAL terhubung — ${err.message}`);
    }
  });
}

module.exports = app;
