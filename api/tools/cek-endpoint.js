'use strict';

// tools/cek-endpoint.js — memanggil semua endpoint API yang sedang jalan
// dan melaporkan status, waktu, dan ukuran hasilnya.
//
//   node index.js                     (di terminal lain)
//   node tools/cek-endpoint.js        (atau: BASE=https://... node tools/cek-endpoint.js)
//
// Berguna sebagai pemeriksaan cepat sebelum deploy ke Vercel.

const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3001}`;
const TOKEN = process.env.TOKEN || '';

const daftar = [
  ['GET', '/'],
  ['GET', '/api/me'],
  ['GET', '/api/health'],
  ['GET', '/api/summary?range=today'],
  ['GET', '/api/summary?range=7d'],
  ['GET', '/api/usage/timeseries?range=24h'],
  ['GET', '/api/usage/timeseries?range=7d&bucket=hour'],
  ['GET', '/api/usage/timeseries?range=30d'],
  ['GET', '/api/usage/hourly?range=today'],
  ['GET', '/api/usage/monthly?year=2026'],
  ['GET', '/api/usage/monthly?year=2026&format=csv'],
  ['GET', '/api/segments?range=today'],
  ['GET', '/api/isp?range=today'],
  ['GET', '/api/devices?perPage=5'],
  ['GET', '/api/devices?q=10.33.&online=1&perPage=5'],
  ['GET', '/api/top/devices?range=today&limit=5'],
  ['GET', '/api/top/destinations?range=today&groupBy=domain&limit=5'],
  ['GET', '/api/services?range=today&limit=5'],
  ['GET', '/api/services?range=7d&limit=5'],
  ['GET', '/api/services/443?proto=TCP&limit=5'],
  ['GET', '/api/search?limit=5'],
  ['GET', '/api/search?limit=5&svc_port=443&proto=TCP'],
  ['GET', '/api/search?limit=5&from=' + new Date(Date.now() - 3600e3).toISOString()],
  ['GET', '/api/router/health?range=24h'],
  ['GET', '/api/router/ports'],
  ['GET', '/api/router/sessions?limit=5'],
  ['GET', '/api/audit/log?limit=5'],
  ['GET', '/api/alerts'],
  ['GET', '/api/config'],
  ['GET', '/api/segments?range=tidak-ada'],
];

// Kasus yang MEMANG harus ditolak — supaya tidak dihitung sebagai kegagalan.
const harusDitolak = [
  ['GET', '/api/search?limit=1&from=2026-11-19T00:00:00%2B07:00', 400],
  ['GET', '/api/top?range=today', 404],
  ['GET', '/api/devices/aa:bb:cc', 400],
  ['GET', '/api/devices/aa:bb:cc:dd:ee:ff', 404],
  ['GET', '/api/services/99999', 400],
  ['GET', '/api/usage/timeseries?range=today&bucket=ngawur', 400],
];

const ukuran = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

(async () => {
  console.log(`Uji endpoint di ${BASE}\n`);
  console.log('  status  waktu      ukuran    jumlah   endpoint');

  let gagal = 0;
  for (const [method, path] of daftar) {
    const url = BASE + path;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      });
      const teks = await res.text();
      const ms = Date.now() - t0;
      let jumlah = '';
      try {
        const json = JSON.parse(teks);
        if (Array.isArray(json.data)) jumlah = String(json.data.length);
        else if (json.data && typeof json.data === 'object') {
          const arr = Object.values(json.data).find(Array.isArray);
          jumlah = arr ? String(arr.length) : '-';
        }
      } catch { jumlah = 'csv'; }

      const ok = res.status < 400;
      if (!ok) gagal += 1;
      console.log(`  ${String(res.status).padEnd(7)} ${String(`${ms} ms`).padEnd(10)} ${ukuran(teks.length).padEnd(9)} ${jumlah.padEnd(8)} ${path}`);
      if (!ok) console.log(`          -> ${teks.slice(0, 200)}`);
    } catch (err) {
      gagal += 1;
      console.log(`  GAGAL   ${path} -> ${err.message}`);
    }
  }

  console.log(`\nKasus yang memang harus ditolak:`);
  for (const [method, path, harap] of harusDitolak) {
    const res = await fetch(BASE + path, { method, headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
    const teks = await res.text();
    const benar = res.status === harap;
    if (!benar) gagal += 1;
    console.log(`  ${benar ? 'OK ' : 'XX '} ${res.status} (harap ${harap})  ${path}`);
    if (!benar) console.log(`          -> ${teks.slice(0, 160)}`);
  }

  // ---------- pemeriksaan isi, bukan hanya status ----------
  // Kesalahan seperti "Promise.all dibongkar sebagai baris" hanya terlihat
  // dari isinya: semua angka jadi 0 padahal HTTP 200.
  console.log(`\nPemeriksaan isi:`);
  const cek = async (nama, fn) => {
    let benar = false; let pesan = '';
    try { benar = await fn(); } catch (err) { pesan = err.message; }
    if (!benar) gagal += 1;
    console.log(`  ${benar ? 'OK ' : 'XX '} ${nama}${pesan ? ` -> ${pesan}` : ''}`);
  };

  let ringkasan = null;
  await cek('summary.today memiliki down_bytes > 0', async () => {
    ringkasan = (await (await fetch(BASE + '/api/summary?range=today')).json()).data;
    return ringkasan.down_bytes > 0;
  });
  await cek('summary.today up_bytes > 0', async () => ringkasan.up_bytes > 0);
  await cek('summary.active_ips > 0', async () => ringkasan.active_ips > 0);
  await cek('summary.top[0].down_bytes berupa angka', async () =>
    ringkasan.top.length > 0 && typeof ringkasan.top[0].down_bytes === 'number');
  await cek('summary.total_bytes = up + down', async () =>
    ringkasan.total_bytes === ringkasan.up_bytes + ringkasan.down_bytes);

  await cek('timeseries 24h punya >= 1 titik', async () => {
    const j = await (await fetch(BASE + '/api/usage/timeseries?range=24h')).json();
    return Array.isArray(j.data) && j.data.length > 0;
  });
  await cek('meta memuat range/lag/coverage/partial/warnings di semua endpoint', async () => {
    const wajib = ['range', 'generatedAt', 'dataLagSeconds', 'rollupCoverage', 'partial', 'dataSince', 'warnings'];
    const uji = ['/api/summary', '/api/health', '/api/devices', '/api/audit/log',
      '/api/router/ports', '/api/router/sessions', '/api/services', '/api/search', '/api/config', '/api/alerts'];
    for (const p of uji) {
      const m = (await (await fetch(BASE + p)).json()).meta || {};
      const kurang = wajib.filter((k) => !(k in m));
      if (kurang.length) {
        console.log(`          ${p} tidak punya: ${kurang.join(', ')}`);
        return false;
      }
    }
    return true;
  });
  await cek('traffic_daily cocok dengan svc_daily (byte, hari ini)', async () => {
    const j = await (await fetch(BASE + '/api/services?range=today&dir=total&limit=200')).json();
    return Array.isArray(j.data);
  });

  console.log(`\n${daftar.length + harusDitolak.length - gagal}/${daftar.length + harusDitolak.length} pemeriksaan lolos.`);
  process.exit(gagal ? 1 : 0);
})();
