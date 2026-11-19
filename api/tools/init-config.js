'use strict';

// tools/init-config.js — membuat skema `netflow_config` beserta isi awalnya.
//
//   node --env-file-if-exists=.env tools/init-config.js
//
// Membutuhkan user MySQL dengan hak tulis (CREATE DATABASE/CREATE TABLE).
// Pakai variabel CFG_DB_* bila diisi; kalau kosong, memakai DB_*.
// Kredensial read-only (netflow_app) PASTI GAGAL di sini — itu memang benar.

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const str = (v, d = '') => (v === undefined || v === null || v === '' ? d : String(v));

const host = str(process.env.CFG_DB_HOST, str(process.env.DB_HOST, '127.0.0.1'));
const port = int(process.env.CFG_DB_PORT, int(process.env.DB_PORT, 3306));
const user = str(process.env.CFG_DB_USER, str(process.env.DB_USER));
const password = str(process.env.CFG_DB_PASSWORD, str(process.env.DB_PASSWORD));

const sqlFile = path.join(__dirname, '..', 'sql', 'config-schema.sql');

(async () => {
  if (!user) {
    console.error('DB_USER / CFG_DB_USER belum diisi. Salin .env.example menjadi .env dulu.');
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlFile, 'utf8');
  console.log(`Menyiapkan skema konfigurasi di ${host}:${port} sebagai "${user}" ...`);

  const conn = await mysql.createConnection({
    host, port, user, password,
    multipleStatements: true,
    connectTimeout: 15000,
  });

  try {
    await conn.query(sql);
    console.log('Selesai. Isi skema netflow_config:');

    const [tables] = await conn.query(
      `SELECT table_name AS t, table_rows AS r
         FROM information_schema.tables
        WHERE table_schema = 'netflow_config'
        ORDER BY table_name`
    );
    for (const t of tables) console.log(`  - ${t.t} (~${t.r} baris)`);
    console.log('\nLangkah berikutnya: isi CFG_DB_USER/CFG_DB_PASSWORD di .env API, lalu restart.');
  } finally {
    await conn.end();
  }
})().catch((err) => {
  console.error('\nGAGAL:', err.message);
  if (err.code === 'ER_DBACCESS_DENIED_ERROR' || err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Hak akses kurang. Perlu user dengan CREATE DATABASE/CREATE TABLE, mis.:');
    console.error("  CREATE USER 'netflow_cfg'@'%' IDENTIFIED BY '<sandi-kuat>';");
    console.error("  GRANT ALL PRIVILEGES ON netflow_config.* TO 'netflow_cfg'@'%';");
    console.error('  FLUSH PRIVILEGES;');
  }
  process.exit(1);
});
