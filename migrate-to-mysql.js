// migrate-to-mysql.js — memindahkan isi data/flows.db (SQLite) ke MySQL.
//
// Pemakaian:
//   node --env-file-if-exists=.env migrate-to-mysql.js
//   node --env-file-if-exists=.env migrate-to-mysql.js --truncate
//
// Hentikan dulu `node ingest.js` sebelum menjalankan ini, supaya SQLite tidak
// berubah di tengah proses. Script aman dijalankan ulang: baris yang sudah ada
// ditimpa (bukan dijumlah lagi), jadi tidak terjadi hitungan ganda.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { DB, target } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlitePath = process.env.SQLITE_PATH || path.join(here, 'data', 'flows.db');
const truncate = process.argv.includes('--truncate');
const BATCH = 2000;

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const SQL_SUMMARY = `INSERT INTO traffic_1m (ts, local_ip, dir, wan_if, bytes, packets) VALUES ?
  ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), packets = VALUES(packets)`;
const SQL_DETAIL = `INSERT INTO flows_5m (ts, local_ip, remote_ip, svc_port, proto, dir, wan_if, bytes, packets) VALUES ?
  ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), packets = VALUES(packets)`;

if (!fs.existsSync(sqlitePath)) {
  console.error(`File SQLite tidak ditemukan: ${sqlitePath}`);
  process.exit(1);
}

console.log(`Sumber : ${sqlitePath}`);
console.log(`Tujuan : ${target()}`);

// 1. Pastikan database ada (koneksi tanpa memilih database dulu).
const root = await mysql.createConnection({ ...DB, database: undefined });
await root.query(
  `CREATE DATABASE IF NOT EXISTS \`${DB.database}\` CHARACTER SET utf8mb4`
);
await root.changeUser({ database: DB.database });
await root.end();

const conn = await mysql.createConnection({ ...DB, multipleStatements: true });
console.log('Database & koneksi siap.');

// 2. Buat tabel dari schema.sql.
const schema = fs
  .readFileSync(path.join(here, 'schema.sql'), 'utf8')
  .replace(/^\s*--.*$/gm, '');
await conn.query(schema);
console.log('Tabel traffic_1m & flows_5m siap.');

if (truncate) {
  await conn.query('TRUNCATE TABLE flows_5m');
  await conn.query('TRUNCATE TABLE traffic_1m');
  console.log('--truncate: tabel MySQL dikosongkan dulu.');
}

// 3. Salin data dari SQLite.
const src = new Database(sqlitePath, { readonly: true });
src.pragma('busy_timeout = 5000');

const tables = [
  {
    name: 'traffic_1m',
    sql: SQL_SUMMARY,
    rows: (r) => [r.ts, r.local_ip, r.dir, r.wan_if, r.bytes, r.packets],
  },
  {
    name: 'flows_5m',
    sql: SQL_DETAIL,
    rows: (r) => [
      r.ts, r.local_ip, r.remote_ip, r.svc_port, r.proto, r.dir, r.wan_if,
      r.bytes, r.packets,
    ],
  },
];

for (const t of tables) {
  const total = src.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c;
  if (!total) {
    console.log(`${t.name}: kosong, dilewati.`);
    continue;
  }

  const stmt = src.prepare(`SELECT * FROM ${t.name}`);
  stmt.raw(false);
  let done = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    await conn.query(t.sql, [batch]);
    done += batch.length;
    batch = [];
    process.stdout.write(`\r${t.name}: ${done}/${total} baris`);
  };

  for (const row of stmt.iterate()) {
    batch.push(t.rows(row));
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  console.log(`\n${t.name}: ${done} baris dipindahkan.`);
}

src.close();
await conn.end();

// 4. Verifikasi.
const check = await mysql.createConnection(DB);
const [s] = await check.query('SELECT COUNT(*) c FROM traffic_1m');
const [d] = await check.query('SELECT COUNT(*) c FROM flows_5m');
await check.end();

console.log(`\nSelesai. MySQL sekarang berisi:`);
console.log(`  traffic_1m : ${s[0].c} baris`);
console.log(`  flows_5m   : ${d[0].c} baris`);
console.log('\nLangkah berikutnya: jalankan `npm run ingest` (tulis ke MySQL).');
console.log('File data/flows.db tidak diubah dan bisa dipakai sebagai cadangan.');