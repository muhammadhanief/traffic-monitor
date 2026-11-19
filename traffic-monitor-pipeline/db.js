// db.js — konfigurasi koneksi MySQL, dipakai ingest.js, report.js, dan
// migrate-to-mysql.js. Nilai diambil dari environment variable (lihat .env),
// dengan default untuk pemakaian lokal.

import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'netflow',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'netflow_monitor',
  // byte di kolom BIGINT tetap aman dibaca sebagai number (maks 2^53)
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true, // SUM(bigint) mengembalikan DECIMAL; jadikan number
  charset: 'utf8mb4',
  // DATETIME (devices.last_seen, ingest_status.*) dipertukarkan dalam waktu
  // lokal server (WIB), sama seperti NOW() dan FROM_UNIXTIME() di MySQL.
  // Sebelumnya 'Z' membuat last_seen tersimpan 7 jam lebih awal daripada NOW().
  timezone: 'local',
};

export function createPool(extra = {}) {
  return mysql.createPool({
    ...DB,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL || 4),
    ...extra,
  });
}

export const target = () => `${DB.user}@${DB.host}:${DB.port}/${DB.database}`;

// Buat semua tabel dari schema.sql kalau belum ada.
// Dipakai ingest.js, rollup.js, sync-mikrotik.js, dan sync-router.js, jadi tidak
// ada tabel yang ketinggalan.
//
// schema.sql memakai CREATE TABLE IF NOT EXISTS, sehingga tabel yang SUDAH ada
// tidak ikut berubah saat kolom baru ditambahkan. Perubahan seperti itu
// ditangani ensureColumns() di bawah.
export async function ensureSchema(executor) {
  const schema = fs
    .readFileSync(path.join(here, 'schema.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '');
  for (const stmt of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await executor.query(stmt);
  }
  await ensureColumns(executor);
}

// Migrasi kecil & idempoten untuk database yang sudah berjalan.
const COLUMN_MIGRATIONS = [
  {
    label: 'devices.last_seen_ts',
    sql: `ALTER TABLE devices
            ADD COLUMN last_seen_ts BIGINT UNSIGNED NULL
            COMMENT 'epoch detik terakhir terlihat' AFTER last_seen`,
    check: `SELECT COUNT(*) n FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
               AND COLUMN_NAME = 'last_seen_ts'`,
  },
  {
    label: 'devices.idx_seen_ts',
    sql: 'ALTER TABLE devices ADD KEY idx_seen_ts (aktif, last_seen_ts)',
    check: `SELECT COUNT(*) n FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
               AND INDEX_NAME = 'idx_seen_ts'`,
  },
];

export async function ensureColumns(executor) {
  for (const m of COLUMN_MIGRATIONS) {
    const [[r]] = await executor.query(m.check);
    if (Number(r.n) > 0) continue;
    await executor.query(m.sql);
    console.log(`[db] migrasi: ${m.label} ditambahkan`);
  }
}