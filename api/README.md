# API — Dashboard NetFlow Monitor (BPS Jateng)

Express 5 + mysql2, dibungkus sebagai satu fungsi serverless untuk **Vercel**.

| | |
|---|---|
| Basis | `/api` |
| Data | `netflow_monitor` di `111.68.27.116` — **hanya baca** |
| Konfigurasi | `netflow_config` (skema terpisah di host yang sama) — baca/tulis |
| Frontend | Next.js di cPanel BPS, memanggil API ini **dari browser** |
| Pusat dokumen | `../DOKUMENTASI-UI.md` (kontrak), `../PRD ... .pdf` |

## 1. Struktur

```
api/
├─ index.js              aplikasi Express + pemasangan rute + penanganan galat
├─ db.js                 dua pool: data (baca) & konfigurasi (tulis)
├─ vercel.json           konfigurasi Vercel (semua rute -> index.js)
├─ sql/config-schema.sql DDL skema netflow_config + isi awal
├─ lib/
│  ├─ util.js            rentang WIB, pembungkus respons, cache, pembatas laju
│  ├─ auth.js            verifikasi Bearer token SSO BPS (JWKS)
│  ├─ config.js          baca service_map/segment/device_alias/alert_rule/setting
│  └─ lookup.js          IP -> MAC -> label perangkat
├─ routes/               19 berkas rute (lihat bagian 4)
└─ tools/
   ├─ init-config.js     buat skema netflow_config
   └─ cek-endpoint.js    panggil semua endpoint dan laporkan waktu/ukuran
```

## 2. Menjalankan lokal

```powershell
cd api
copy .env.example .env      # isi kredensial
npm install
npm start                   # http://localhost:3001
npm run cek                 # terminal lain: uji semua endpoint (keluar 1 bila ada yang gagal)
```

Isi `.env` minimal:

```dotenv
DB_HOST=111.68.27.116
DB_USER=netflow_app
DB_PASSWORD=<sandi read-only>
DB_NAME=netflow_monitor
CFG_DB_NAME=netflow_config
AUTH_DISABLED=1          # matikan verifikasi token saat uji lokal
CORS_ORIGINS=*           # hanya untuk uji lokal
```

> **Jangan** pakai user `netflow` (user tulis milik ingest) di API.

### Menghadapi koneksi yang tidak stabil

Koneksi ke MySQL melewati internet, jadi pembukaan koneksi bisa gagal sesaat.
Variabel berikut mengaturnya (lihat `db.js`):

| Variabel | Bawaan | Arti |
|---|---|---|
| `DB_CONNECT_RETRIES` | `2` | Jumlah percobaan membuka koneksi |
| `DB_CONNECT_TIMEOUT_MS` | `6000` | Batas waktu tiap percobaan |

Waktu tunggu terburuk ≈ `DB_CONNECT_TIMEOUT_MS × DB_CONNECT_RETRIES` (≈ 12 s),
aman di bawah `maxDuration` 30 s Vercel. Yang **diulang hanya kegagalan
membuka koneksi** (`ETIMEDOUT`, `ECONNREFUSED`, …): perintahnya belum sampai
ke server sehingga tidak ada risiko tulis ganda. Galat di tengah query
(`PROTOCOL_CONNECTION_LOST`, `ECONNRESET`) **tidak** diulang.

## 3. Dua database

| | `netflow_monitor` | `netflow_config` |
|---|---|---|
| Sumber | pipeline (`ingest.js`, `rollup.js`, `sync-*.js`) | aplikasi web |
| Hak API | `SELECT` saja | `SELECT, INSERT, UPDATE, DELETE` |
| Isi | trafik, perangkat, dns, kesehatan router | `segment`, `service_map`, `device_alias`, `alert_rule`, `alert_event`, `setting` |
| Bila kosong | — | API tetap jalan, memakai nama bawaan (hostname / daftar port bawaan) |

Membuat skema konfigurasi (butuh user dengan hak tulis):

```powershell
npm run db:config
```

Isi `CFG_DB_USER`/`CFG_DB_PASSWORD` di `.env` (atau di Vercel) setelahnya.
Bila `CFG_DB_HOST` dikosongkan, API memakai alamat `DB_HOST` dengan skema berbeda —
itu memang rancangan kita (A2).

## 4. Daftar endpoint

Semua respons sukses:
`{ "data": ..., "meta": { "range", "generatedAt", "dataLagSeconds", "rollupCoverage", "dataSince", "dataLast", "partial", "partialReason", "warnings", ... } }`

Semua galat: `{ "error": { "code", "message", "detail?" } }`

Arti `meta`:

| Bidang | Arti |
|---|---|
| `range` | `{ from, to, label }` — rentang nyata yang dipakai, dalam WIB (`+07:00`) |
| `generatedAt` | Waktu respons dibuat |
| `dataLagSeconds` | Selisih sekarang dengan data `traffic_1m` terakhir. > 300 berarti ingest berhenti |
| `rollupCoverage` | Byte `traffic_1h` ÷ byte `traffic_1m` **untuk jam yang sudah ditutup**. Normalnya ≈ 1 |
| `dataSince` / `dataLast` | Riwayat paling awal / paling akhir yang ada |
| `partial` | `true` bila data rentang ini belum lengkap (lihat `partialReason`) |
| `partialReason` | `"riwayat"` (rentang lebih tua daripada `dataSince`) atau `"rollup"` |
| `warnings` | Kalimat siap tampil untuk operator |

> `partial` **bukan** tanda galat. Selama riwayat masih dangkal (data baru mulai
> 19 Nov 2026), `range=7d`/`30d`/`month`/`year` selalu `partial: true` dengan
> `partialReason: "riwayat"` — itu memang benar.

| Method | Path | Parameter utama |
|---|---|---|
| GET | `/` | — (peta endpoint) |
| GET | `/api/me` | — |
| GET | `/api/health` | — |
| GET | `/api/summary` | `range`, `topLimit` |
| GET | `/api/usage/timeseries` | `range`, `bucket=auto\|10m\|hour\|day` |
| GET | `/api/usage/hourly` | `range` |
| GET | `/api/usage/monthly` | `year`, `format=json\|csv` |
| GET | `/api/segments` | `range` |
| GET | `/api/isp` | `range` |
| GET | `/api/devices` | `q`, `segment`, `online`, `sort`, `page`, `perPage` |
| GET | `/api/devices/:mac` | `range`, `limit` |
| PATCH | `/api/devices/:mac` | `{ nama, pemilik, grup }` (admin) |
| GET | `/api/top/devices` | `range`, `dir=down\|up\|total`, `limit` |
| GET | `/api/top/destinations` | `range`, `dir`, `limit`, `groupBy=ip\|domain` |
| GET | `/api/destinations/:ip` | `range`, `limit` |
| GET | `/api/services` | `range`, `dir`, `limit`, `kategori` |
| GET | `/api/services/:port` | `range`, `proto`, `dir`, `limit` |
| GET | `/api/search` | `from`, `to`, `local_ip`, `remote_ip`, `svc_port`, `proto`, `dir`, `limit`, `group` |
| GET | `/api/router/health` | `range` |
| GET | `/api/router/ports` | — |
| GET | `/api/router/sessions` | `limit`, `activeOnly` |
| GET | `/api/audit/log` | `kategori`, `q`, `limit`, `from`, `to` |
| GET | `/api/alerts` | `range` |
| GET | `/api/config` | — |
| GET/POST/PATCH/DELETE | `/api/config/:table[/:id]` | `segment`, `service_map`, `device_alias`, `alert_rule`, `alert_event`, `setting` (tulis: admin) |

`range` = `today` \| `24h` \| `7d` \| `30d` \| `month` \| `year`.

## 5. Aturan yang harus dijaga

Diambil dari pengukuran nyata (`../DOKUMENTASI-UI.md` §3 dan §12):

1. **`/api/search` maksimal 3 jam.** `flows_5m` melompat dari 182 ms (3 jam) ke
   **12 detik** (6 jam) karena MySQL beralih ke tabel sementara di disk.
   Permintaan lebih lebar **ditolak** (HTTP 400), bukan diperlambat.
2. **Jangan baca `traffic_1m` untuk agregasi per perangkat** — tidak ada indeks
   `local_ip`. Perangkat ≤ 24 jam memakai `traffic_1h` (punya `idx_local`),
   di atas itu `traffic_daily`.
3. **`flows_daily_ip` tidak boleh dijumlahkan jadi total** — 22,7% byte unduh
   ada di baris `(lainnya)`. Total selalu dari `traffic_daily`/`traffic_monthly`.
4. **Semua batas waktu dihitung di JS dengan offset +07:00**, bukan `CURDATE()`,
   supaya hasilnya tidak bergantung `time_zone` sesi MySQL (Vercel jalan di UTC).
5. Cache agregat 60 detik (`CACHE_TTL_SECONDS`) dan metadata 30 detik
   (`META_TTL_SECONDS`). Cache bersifat per-lambda; itu sudah cukup karena data
   sumbernya hanya berubah tiap menit.
6. **`rollupCoverage` hanya dihitung untuk jam yang sudah ditutup.** `traffic_1h`
   selalu tertinggal satu jam dari `traffic_1m`; bila jam berjalan ikut dihitung
   cakupannya selalu ≈ 0,98 dan tampak seperti gangguan padahal normal.
   `partial` yang muncul dari situ dilaporkan sebagai `partialReason: "riwayat"`.
7. **Jangan bongkar `db.q()` sebagai baris.** `db.q()` mengembalikan
   `[rows, fields]`. Menuliskan `const [rows, x] = await Promise.all([db.q(...), ...])`
   akan menghasilkan `rows` berisi `[rows, fields]`, bukan barisnya — semuanya
   jadi `0`/`null` padahal HTTP 200. `npm run cek` memeriksa hal ini.

## 6. Autentikasi

- Frontend Next.js di cPanel menjalankan alur OIDC ke `accounts.bps.go.id`,
  lalu browser memanggil API ini dengan `Authorization: Bearer <access_token>`.
- API **hanya memverifikasi** tanda tangan/issuer/audience lewat JWKS
  (`jose`). Tidak ada cookie, tidak ada tabel sesi.
- Endpoint tulis (`PATCH /api/devices/:mac`, `/api/config`) butuh peran di
  `SSO_ADMIN_ROLES`.
- Untuk uji lokal: `AUTH_DISABLED=1`.

## 7. Deploy ke Vercel

1. Impor repo, **Root Directory = `api`**.
2. Isi Environment Variables (sama dengan `.env`, kecuali `PORT`).
   - `AUTH_DISABLED` **jangan** diisi/`0` di produksi.
   - `CORS_ORIGINS=https://traffic-monitor.web.bps.go.id`
3. Deploy. `vercel.json` mengarahkan semua rute ke `index.js`.

Catatan penting:

- **Region.** Hobby tidak bisa memilih region (default `iad1` → +200 ms ke
  Indonesia). Setelah upgrade ke Pro, set `sin1` di *Settings → Functions*,
  atau tambahkan `"regions": ["sin1"]` di `vercel.json`.
- **Koneksi MySQL.** Tiap lambda punya pool sendiri. `DB_POOL_SIZE=3` dan
  `max_connections` MySQL (bawaan 151) — pantau bila lalu lintas naik.
- **IP statis.** Vercel tidak punya IP keluar tetap kecuali berlangganan
  *Static IPs* ($100/bln). Jadi grant MySQL tetap `@'%'` + TLS. Bila ingin
  allowlist ketat, letakkan API di server sendiri (`alma.jateng.pro`).

## 8. Yang belum bisa dilayani (dan alasannya)

| Fitur dokumen | Kendala |
|---|---|
| Panel "Layanan terbuka" (`/ip/service`) | router ada di LAN `10.33.0.254`; perlu tabel + sync baru |
| Grid 18 port ethernet lengkap | `port_map` hanya berisi MAC yang terlihat; perlu sync `/interface/ethernet` |
| Realtime `monitor-traffic` (Fase 3) | hanya bisa dari LAN, bukan dari Vercel |
| Status ISP dari `/ip/route` | belum ada tabelnya |
| "Status task" di `/api/health` | Scheduled Task Windows tidak ada di DB — disimpulkan dari kesegaran data |

`/api/router/ports` sudah menyiapkan `daftar_port` dari `setting.ethernet_ports`
supaya grid bisa digambar walau port kosong; lengkapnya menunggu sync ethernet.
