'use strict';

// tools/cek-config.js — uji lapisan konfigurasi + penamaan perangkat.
//
//   npm run cek:config        (API harus sudah jalan)
//
// Yang diperiksa:
//   - tabel konfigurasi terbaca dan berisi (service_map dsb.)
//   - /api/services memakai nama dari service_map (bukan "port N")
//   - /api/router/ports memakai setting.ethernet_ports
//   - CRUD /api/config berjalan (setting, segment, service_map)
//   - PATCH /api/devices/:mac benar-benar menulis ke devices, lalu DIKEMBALIKAN
//
// Skrip ini MENULIS lalu MEMBERSIHKAN. Jangan jalankan terhadap produksi saat
// jam kerja bila Anda tidak ingin ada perubahan sesaat pada nama perangkat.
// Baris uji memakai awalan "UJI-API" dan selalu dihapus di akhir.

const BASE = (process.env.API_BASE || 'http://localhost:3001').replace(/\/$/, '');

const req = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch { /* respons kosong */ }
  return { status: res.status, j };
};

let gagal = 0;
const cek = (ok, pesan, x = '') => {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${pesan}${x ? `  ${x}` : ''}`);
  if (!ok) gagal += 1;
};

async function ujiBaca() {
  console.log('=== konfigurasi terbaca ===');
  const c = await req('GET', '/api/config');
  cek(c.status === 200 && c.j?.data?.tersedia === true, 'GET /api/config', `tersedia=${c.j?.data?.tersedia}`);
  const tabel = c.j?.data?.tabel || {};
  for (const t of ['segment', 'service_map', 'alert_rule', 'alert_event', 'setting']) {
    cek(Array.isArray(tabel[t]), `tabel ${t}`, `${tabel[t]?.length ?? '-'} baris`);
  }
  cek(!('device_alias' in tabel), 'device_alias tidak dikelola lewat /api/config');

  const quic = (tabel.service_map || []).find((r) => Number(r.port) === 443 && r.proto === 'UDP');
  cek(!!quic, 'service_map memuat 443/UDP (QUIC)', quic?.nama || '');

  const rp = await req('GET', '/api/router/ports');
  cek(rp.status === 200, 'GET /api/router/ports', `daftar_port=${rp.j?.data?.daftar_port?.length ?? '-'}`);

  const sv = await req('GET', '/api/services?limit=5');
  const semuaBernama = Array.isArray(sv.j?.data) && sv.j.data.length > 0
    && sv.j.data.every((r) => typeof r.nama === 'string' && r.nama.length > 0);
  cek(semuaBernama, 'GET /api/services memakai nama dari service_map',
    (sv.j?.data || []).slice(0, 3).map((r) => `${r.kunci}=${r.nama}`).join(', '));
}

async function ujiCrud() {
  console.log('\n=== CRUD /api/config ===');

  const kunci = `uji_api_${Date.now()}`;
  const a = await req('POST', '/api/config/setting', { kunci, nilai: '1' });
  cek(a.status === 200, 'setting POST', a.j?.error?.message || '');

  const b = await req('GET', '/api/config/setting');
  cek(!!(b.j?.data || []).find((r) => r.kunci === kunci), 'setting muncul di daftar');

  const c = await req('PATCH', `/api/config/setting/${kunci}`, { nilai: '2' });
  cek(c.status === 200, 'setting PATCH', c.j?.error?.message || '');

  const d = await req('DELETE', `/api/config/setting/${kunci}`);
  cek(d.status === 200, 'setting DELETE', d.j?.error?.message || '');

  const e = await req('DELETE', `/api/config/setting/${kunci}`);
  cek(e.status === 404, 'setting DELETE kedua -> 404', String(e.status));

  const cidr = '10.99.99.0/24';
  const f = await req('POST', '/api/config/segment', { cidr, nama: 'UJI API' });
  cek(f.status === 200, 'segment POST', f.j?.error?.message || '');
  const id = f.j?.data?.id;
  if (id) {
    const g = await req('PATCH', `/api/config/segment/${id}`, { nama: 'UJI API 2' });
    cek(g.status === 200, 'segment PATCH', g.j?.error?.message || '');
    const h = await req('DELETE', `/api/config/segment/${id}`);
    cek(h.status === 200, 'segment DELETE', h.j?.error?.message || '');
  }

  const sm = await req('GET', '/api/config/service_map');
  const baris = (sm.j?.data || []).find((r) => Number(r.port) === 443 && r.proto === 'UDP');
  cek(typeof baris?.id === 'number', 'service_map punya id', baris ? `id=${baris.id}` : '');
  if (baris) {
    const dup = await req('POST', '/api/config/service_map', { port: 443, proto: 'UDP', nama: 'Duplikat' });
    cek(dup.status === 409, 'port/proto ganda -> 409', String(dup.status));
  }

  const jahat = await req('POST', '/api/config/devices', { mac: 'aa:bb:cc:dd:ee:ff' });
  cek(jahat.status === 400, 'tabel data ditolak daftar putih', String(jahat.status));
}

async function ujiNamaPerangkat() {
  console.log('\n=== PATCH /api/devices/:mac ===');
  const d = await req('GET', '/api/devices?perPage=1&sort=last_seen');
  const dev = d.j?.data?.[0];
  cek(!!dev, 'ada perangkat untuk diuji', dev?.mac || '');
  if (!dev) return;

  const asli = { nama: dev.nama, pemilik: dev.pemilik, grup: dev.grup };
  const tanda = `UJI-API-${Date.now()}`;

  const p1 = await req('PATCH', `/api/devices/${dev.mac}`, { pemilik: tanda });
  cek(p1.status === 200, 'PATCH 200', p1.j?.error?.message || '');
  cek(p1.j?.data?.pemilik === tanda, 'pemilik tersimpan', p1.j?.data?.pemilik);
  cek(p1.j?.data?.sumber === 'manual', "sumber = 'manual'", p1.j?.data?.sumber);

  const d2 = await req('GET', `/api/devices?q=${encodeURIComponent(dev.mac)}`);
  const lagi = (d2.j?.data || []).find((x) => x.mac === dev.mac);
  cek(lagi?.pemilik === tanda, 'terbaca ulang dari devices', lagi?.pemilik);
  cek(lagi?.manual === true, 'ditandai manual');

  const p2 = await req('PATCH', `/api/devices/${dev.mac}`, asli);
  cek(p2.status === 200 && p2.j?.data?.pemilik === asli.pemilik, 'dikembalikan seperti semula', String(p2.j?.data?.pemilik));

  const p3 = await req('PATCH', '/api/devices/aa:bb:cc:dd:ee:ff', { nama: 'x' });
  cek(p3.status === 404, 'MAC tidak ada -> 404', String(p3.status));
  const p4 = await req('PATCH', `/api/devices/${dev.mac}`, {});
  cek(p4.status === 400, 'body kosong -> 400', String(p4.status));
  const p5 = await req('PATCH', '/api/devices/zz:zz', { nama: 'x' });
  cek(p5.status === 400, 'MAC tidak sah -> 400', String(p5.status));
}

(async () => {
  console.log(`Uji lapisan konfigurasi di ${BASE}\n`);
  await ujiBaca();
  await ujiCrud();
  await ujiNamaPerangkat();
  console.log(`\n${gagal === 0 ? 'SEMUA LOLOS' : `${gagal} GAGAL`}`);
  if (gagal) process.exitCode = 1;
})().catch((err) => {
  console.error('\nGAGAL:', err.message);
  process.exit(1);
});
