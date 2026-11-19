// report.js — cek cepat isi database tanpa perlu dashboard.
// Pemakaian: node report.js [menit]    (default 10 menit terakhir)
// Bisa dijalankan dari PC ini maupun PC lain (atur DB_HOST di .env).

import mysql from 'mysql2/promise';
import { DB, target } from './db.js';

const minutes = Number(process.argv[2] || 10);
const since = Math.floor(Date.now() / 1000) - minutes * 60;
const secs = minutes * 60;

const mbps = (bytes) => +((Number(bytes) * 8) / secs / 1e6).toFixed(2);
const mb = (bytes) => +(Number(bytes) / 1e6).toFixed(1);

const db = await mysql.createConnection(DB);

console.log(`\n=== Top perangkat lokal, ${minutes} menit terakhir (${target()}) ===`);
const [talkers] = await db.query(`
  SELECT local_ip,
         SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down,
         SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up
  FROM traffic_1m WHERE ts >= ?
  GROUP BY local_ip ORDER BY down + up DESC LIMIT 10
`, [since]);
console.table(talkers.map((r) => ({
  IP: r.local_ip, 'Down (MB)': mb(r.down), 'Up (MB)': mb(r.up),
  'Down (Mbps rata2)': mbps(r.down), 'Up (Mbps rata2)': mbps(r.up),
})));

console.log('=== Total per interface WAN (ifIndex) ===');
const [wans] = await db.query(`
  SELECT wan_if,
         SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down,
         SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up
  FROM traffic_1m WHERE ts >= ? GROUP BY wan_if ORDER BY down + up DESC
`, [since]);
console.table(wans.map((r) => ({
  'ifIndex': r.wan_if, 'Down (Mbps rata2)': mbps(r.down), 'Up (Mbps rata2)': mbps(r.up),
})));

console.log('=== Top layanan (port tujuan) ===');
const [svc] = await db.query(`
  SELECT svc_port, proto, SUM(bytes) AS bytes
  FROM flows_5m WHERE ts >= ?
  GROUP BY svc_port, proto ORDER BY bytes DESC LIMIT 10
`, [since - 300]); // bucket 5 menit, ambil satu bucket lebih awal
console.table(svc.map((r) => ({ Port: r.svc_port, Proto: r.proto, 'Total (MB)': mb(r.bytes) })));

await db.end();