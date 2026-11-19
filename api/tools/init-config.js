'use strict';

// tools/init-config.js — membuat tabel konfigurasi beserta isi awalnya.
//
//   node --env-file-if-exists=.env tools/init-config.js
//
// Tabel konfigurasi hidup DI DALAM netflow_monitor (bukan skema terpisah),
// sama seperti app_user/app_session/isp_map. Skrip ini hanya CREATE TABLE
// IF NOT EXISTS + INSERT IGNORE; tidak pernah menyentuh tabel data.
//
// Pakai variabel CFG_DB_* bila diisi; kalau kosong, memakai DB_*.
// User read-only (netflow_app) PASTI GAGAL di sini — itu memang benar.

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
const database = str(process.env.CFG_DB_NAME, str(process.env.DB_NAME, 'netflow_monitor'));

const sqlFile = path.join(__dirname, '..', 'sql', 'config-schema.sql');

const KONFIG = ['segment', 'service_map', 'alert_rule', 'alert_event', 'setting'];

(async () => {
  if (!user) {
    console.error('DB_USER / CFG_DB_USER belum diisi. Salin .env.example menjadi .env dulu.');
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlFile, 'utf8');
  console.log(`Menyiapkan tabel konfigurasi di ${host}:${port}/${database} sebagai "${user}" ...`);

  const conn = await mysql.createConnection({
    host, port, user, password, database,
    multipleStatements: true,
    connectTimeout: 30000,
  });

  try {
    await conn.query(sql);
    console.log('Selesai. Tabel konfigurasi:');

    const [tables] = await conn.query(
      `SELECT table_name AS t, table_rows AS r
         FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN (?)
        ORDER BY table_name`,
      [database, KONFIG]
    );
    for (const t of tables) console.log(`  - ${t.t} (~${t.r} baris)`);

    console.log('\nLangkah berikutnya:');
    console.log('  1. Buat user tulis sempit (sekali saja, sebagai root):');
    console.log("       CREATE USER 'netflow_cfg'@'%' IDENTIFIED BY '<sandi-kuat>';");
    console.log(`       GRANT INSERT, UPDATE, DELETE, SELECT ON \`${database}\`.segment     TO 'netflow_cfg'@'%';`);
    console.log(`       GRANT INSERT, UPDATE, DELETE, SELECT ON \`${database}\`.service_map TO 'netflow_cfg'@'%';`);
    console.log(`       GRANT INSERT, UPDATE, DELETE, SELECT ON \`${database}\`.alert_rule  TO 'netflow_cfg'@'%';`);
    console.log(`       GRANT INSERT, UPDATE, DELETE, SELECT ON \`${database}\`.alert_event TO 'netflow_cfg'@'%';`);
    console.log(`       GRANT INSERT, UPDATE, DELETE, SELECT ON \`${database}\`.setting     TO 'netflow_cfg'@'%';`);
    console.log(`       GRANT UPDATE (nama, pemilik, grup, sumber) ON \`${database}\`.devices TO 'netflow_cfg'@'%';`);
    console.log('     (SELECT per tabel wajib: ON DUPLICATE KEY UPDATE dan pembacaan ulang butuh itu.)');
    console.log('  2. Isi CFG_DB_USER / CFG_DB_PASSWORD di .env, lalu restart API.');
  } finally {
    await conn.end();
  }
})().catch((err) => {
  console.error('\nGAGAL:', err.code || '', err.message);
  if (err.code === 'ER_DBACCESS_DENIED_ERROR' || err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Hak akses kurang. Jalankan sebagai user yang punya CREATE/ALTER pada skema ini.');
  }
  if (err.code === 'ER_TABLEACCESS_DENIED_ERROR') {
    console.error('User ini tidak boleh menulis ke tabel data. Skrip ini hanya butuh');
    console.error('CREATE TABLE + INSERT pada tabel konfigurasi.');
  }
  process.exit(1);
});
