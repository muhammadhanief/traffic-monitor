# Dokumentasi UI — Dashboard NetFlow Monitor

Dokumen kontrak untuk tim yang membangun antarmuka web **di repository terpisah**.
Repo ini hanya menyediakan data (MySQL) dan sinkronisasi dari router; **tidak ada
kode aplikasi web di sini**.

| | |
|---|---|
| Database | `netflow_monitor` @ `127.0.0.1:3306` (MySQL 8.0.30) |
| Zona waktu laporan | **WIB (UTC+7)** — semua bucket harian/bulanan memakai waktu lokal MySQL |
| Snapshot data | 19 November 2026, 13:50 WIB |
| Dokumen terkait | `DOKUMENTASI-API-MIKROTIK.md` (endpoint router), `RANCANGAN-RETENSI.md`, `EVALUASI-PRD.md` |
| Status | Lapisan data siap dipakai; **baca bagian 3 sebelum menulis kode** |

---

## 0. Cara memakai dokumen ini

1. Baca **bagian 3 (gerbang kualitas data)** — dua dari tiga jebakan sudah
   diperbaiki, tetapi aturan pemakaiannya tetap berlaku.
2. Tabel (bagian 6) **sudah dibuat** — tim UI tidak perlu menjalankan DDL.
3. Ikuti kontrak API di **bagian 7**; frontend tidak perlu tahu nama tabel.
4. Query per widget ada di **bagian 8** — semuanya **sudah dijalankan** dan
   hasilnya tercantum.
5. Jangan query `flows_5m` tanpa filter `ts` (1,8 juta baris/hari).

---

## 1. Arsitektur & alur data

```
                    ┌──────────────┐   NetFlow (UDP 2055)   ┌─────────────────┐
   Router MikroTik ─┤  goflow2     ├───────────────────────►│  ingest.js      │
   10.33.0.254      └──────────────┘                        │  (task SYSTEM)  │
        │                                                   └────────┬────────┘
        │ REST (port 80)                                             │ traffic_1m
        ▼                                                            ▼ flows_5m
   ┌──────────────┐   tiap 10 menit    ┌──────────────┐        ┌──────────────┐
   │ sync-mikrotik├───────────────────►│   MySQL      │◄───────┤  rollup.js   │
   │ devices/dns  │                    │ netflow_     │  tiap  │  (per jam &  │
   └──────────────┘                    │ monitor      │  jam   │   per hari)  │
                                       └──────┬───────┘        └──────────────┘
                                              │ SELECT (read-only)
                                              ▼
                                       ┌──────────────┐        ┌──────────────┐
                                       │ API backend  │◄──────►│ UI (repo     │
                                       │ (tim UI)     │  HTTP  │  terpisah)   │
                                       └──────────────┘        └──────────────┘
```

Aturan keras:

- **Browser tidak boleh memanggil router.** Router tidak mengirim header CORS dan
  menolak `OPTIONS` (503). Semua data router harus lewat backend.
- **UI tidak boleh menulis ke tabel data.** Hanya baca, kecuali kolom manual
  (`devices.nama`, `devices.pemilik`, `devices.grup`).
- **Backend aplikasi memakai user MySQL read-only** (lihat bagian 11), bukan
  `netflow` yang dipakai ingest.

---

## 2. Snapshot kesiapan data

Diukur 19 November 2026 14:03 WIB. Angka berubah tiap menit — anggap sebagai
potret, bukan konstanta.

| Tabel | Baris | Rentang | Catatan |
|---|---:|---|---|
| `traffic_1m` | 74.355 | 10:12 – 14:03 | 389 IP aktif, 63,13 GB down / 9,83 GB up |
| `flows_5m` | 1.962.815 | 10:10 – 14:00 | detail tujuan, retensi 3 hari |
| `traffic_1h` | 2.828 | 5 jam | **tercakup 98,8%** (jam berjalan belum ditutup) — lihat 3.1 |
| `traffic_daily` | 1.077 | 1 hari | sudah lengkap |
| `traffic_monthly` | 1.077 | 1 bulan (72,10 GB) | sudah lengkap |
| `flows_daily_ip` | 1.259 | 1 hari | 23,7% down masuk `(lainnya)` |
| `flows_monthly_ip` | 1.003 | 1 bulan | — |
| `devices` | 556 | — | 214 bernama, 0 punya vendor |
| `device_ip_history` | 564 | — | semua terbuka (`to_ts IS NULL`) |
| `dns_map` | 3.136 | — | semua terlihat < 24 jam |
| `router_stat` | 1 | sekarang | terisi setelah `sync-router.js` dijalankan |
| `port_map` | 213 | sekarang | 212 MAC di `ether6` + 1 MAC router |
| `router_session` | 5 | sekarang | 4 sesi admin + 1 collector |
| `router_log` | 996 | 1.000 baris terakhir | info/account/error |
| `ingest_status` | 1 | — | **kosong sampai `NetflowIngest` di-restart** |

Kesiapan per layar:

| Layar | Bisa dibangun sekarang? | Syarat |
|---|---|---|
| Ringkasan | ✅ ya | pakai `traffic_1m` untuk tren; badge 3.1 opsional |
| Perangkat | ✅ ya | fallback nama (3.4) |
| Pemakaian (bulanan/tahunan) | ✅ ya, riwayat masih tipis | menunggu data menumpuk; empty state 3.5 |
| Tujuan | ✅ ya | tampilkan label `(lainnya)` |
| Kesehatan Router | ✅ ya | `sync-router.js` dijadwalkan tiap menit |
| Peta Port | ✅ ya | idem |
| Audit | ✅ ya | idem |

---

## 3. Gerbang kualitas data

### 3.1 Rollup sudah di-backfill — cakupan 98,8% (sisa = jam berjalan)

Dulu `traffic_1h` hanya berisi 2 jam karena `rollup.js` merangkum jendela 26 jam
dan seluruh jam sebelumnya terlewat. Sekarang **sudah di-backfill** dengan
`npm run backfill` (`rollup.js --backfill`, jendela 30 hari). Hasilnya:

```
traffic_1h  : up 9,83 GB  down 63,13 GB
traffic_1m  : up 9,83 GB  down 63,13 GB   ← cocok
cakupan     : 98,8%   (jam 14:00 belum ditutup saat diukur)
```

**Yang tetap wajib:** daftarkan `NetflowRollupHourly` + `NetflowRollupDaily`
sebagai Scheduled Task. Tanpa itu cakupan akan turun lagi mulai besok.

Query cek cakupan (verified):

```sql
SELECT ROUND(
  (SELECT SUM(bytes) FROM traffic_1h WHERE ts_hour >= UNIX_TIMESTAMP(CURDATE()))
  / (SELECT SUM(bytes) FROM traffic_1m WHERE ts  >= UNIX_TIMESTAMP(CURDATE()))
  * 100, 1) AS persen_tercakup;
-- 98.8 saat diukur; sehat bila ~100. Nilai < 95 = task rollup mati.
```

Tampilkan badge peringatan hanya bila angka < 95.

### 3.2 Zona waktu `devices.last_seen` — sudah diperbaiki

Dulu `db.js` memakai `timezone: 'Z'`, sehingga `last_seen` tersimpan 7 jam lebih
awal daripada `NOW()` (452 menit). Sekarang:

- `db.js` memakai `timezone: 'local'` → DATETIME ditulis/dibaca dalam WIB.
- Kolom baru **`devices.last_seen_ts BIGINT UNSIGNED`** (epoch) diisi setiap
  sync — semua query "online" sebaiknya memakai kolom ini.
- Migrasi kolom dijalankan otomatis (`ensureSchema()`), tidak perlu SQL manual.

```sql
-- BENAR, dan tidak tergantung zona waktu:
SELECT COUNT(*) AS online
  FROM devices
 WHERE aktif = 1 AND last_seen_ts >= UNIX_TIMESTAMP() - 1800;
-- hasil saat ini: 556 (sync terakhir < 1 menit)
```

`last_seen` (DATETIME) tetap ada untuk ditampilkan; nilainya kini sama dengan
`NOW()`. Jangan lagi memakai `UTC_TIMESTAMP()`.

### 3.3 `(lainnya)` menelan 23,7% trafik unduh

`flows_daily_ip` hanya menyimpan tujuan ≥ 20 MB/hari per perangkat; sisanya
digabung ke `remote_ip = '(lainnya)'`. Terukur setelah backfill penuh:

| Arah | Porsi `(lainnya)` |
|---|---|
| down | **23,7%** |
| up | **40,8%** |

Artinya: grafik "top tujuan" **tidak boleh** menjumlahkan ke 100% total, dan
jangan menghitung "total pemakaian" dari tabel itu. Definisikan di UI:

- Total pemakaian → `traffic_daily` / `traffic_monthly`
- Top tujuan → `flows_daily_ip` **tanpa** baris `(lainnya)`, dengan label
  "menampilkan tujuan ≥ 20 MB/hari".

### 3.4 Nama perangkat baru 214 dari 556

- 192 perangkat punya DHCP lease, sebagian besar mengirim `host-name`.
- 591 entri ARP; perangkat yang hanya terlihat di ARP (IP statis / MAC acak)
  **tanpa nama**. Lease RouterOS 7.25.1 tidak punya field `comment`.
- Kolom `nama`, `pemilik`, `grup` **tidak pernah ditimpa** sync → aman diisi manual.

UI harus punya fallback berlapis:

```
COALESCE(NULLIF(nama,''), NULLIF(hostname,''), CONCAT('Perangkat ', mac), local_ip)
```

Dan sediakan fitur **"beri nama"** untuk perangkat `(tanpa nama)` — ini yang akan
membuat dashboard terasa berguna.

### 3.5 Riwayat masih dangkal

Detail 4 jam, harian 1 hari, bulanan 1 bulan. Grafik tren 7/30 hari akan terlihat
kosong. Sediakan empty-state jujur: *"Data terkumpul sejak 19 Nov 2026 10:12"*
(baca dari `MIN(ts)`), jangan tampilkan garis datar 0.

### 3.6 `wan_if` sudah punya tabel nama

Nilai yang muncul di data: **2** (utama, ±63 GB down), **8**, **3**.
Router menyimpan komentar interface (`ISP1 UTAMA - Nexa / GMEDIA`), tetapi REST
tidak mengekspos `ifIndex`, jadi pemetaan tidak bisa otomatis.

Tabel **`isp_map` sudah dibuat dan diisi awal** (2 = ISP1 Utama / Nexa-GMEDIA,
3 dan 8 = "Jalur 3"/"Jalur 8"). Lengkapi manual bila nama sebenarnya diketahui.
UI menampilkan `wan_if` sebagai "Jalur N" bila belum dipetakan.

### 3.7 Ringkasan dampak ke widget

| Widget | Terdampak | Tindakan |
|---|---|---|
| Total hari ini / bulan ini | 3.1 | `traffic_daily`; badge hanya bila cakupan < 95 |
| Tren per jam | — | `traffic_1m` per 10–60 menit (akurat, 30 hari) |
| Top perangkat | 3.4 | fallback nama |
| Top tujuan | 3.3 | kecualikan `(lainnya)`, beri label |
| Online/offline | — | `last_seen_ts >= UNIX_TIMESTAMP() - 1800` |
| Grafik 7/30 hari | 3.5 | empty state |

---

## 4. Definisi metrik

| Istilah | Definisi | Kolom |
|---|---|---|
| **down / unduh** | byte dari WAN ke perangkat | `dir='down'` |
| **up / unggah** | byte dari perangkat ke WAN | `dir='up'` |
| GB di dokumen ini | 1 GB = 1024³ byte (GiB) | `bytes/1073741824` |
| "hari ini" | 00:00–23:59 **WIB** | `DATE(FROM_UNIXTIME(ts))` |
| pemakai terbesar | `SUM(bytes)` terbesar pada rentang & arah | — |
| perangkat aktif | punya baris trafik pada rentang | `COUNT(DISTINCT local_ip)` |
| lag data | `UNIX_TIMESTAMP() - MAX(traffic_1m.ts)`, dalam detik | saat ini **±76 detik** |

Catatan: satu perangkat bisa muncul sebagai beberapa `local_ip` dalam sehari bila
DHCP memindahkannya. Agregasi **per perangkat** harus lewat `mac`, bukan IP.

---

## 5. Katalog tabel

### 5.1 Skema ringkas

| Tabel | Kunci utama | Isi | Retensi |
|---|---|---|---|
| `traffic_1m` | `(ts, local_ip, dir, wan_if)` | byte per menit per IP | 30 hari |
| `flows_5m` | `(ts, local_ip, remote_ip, svc_port, proto, dir, wan_if)` | detail tujuan | 3 hari |
| `traffic_1h` | `(ts_hour, local_ip, dir, wan_if)` | per jam | 2 tahun |
| `traffic_daily` | `(day, local_ip, dir, wan_if)` | per hari | 10 tahun |
| `traffic_monthly` | `(month, local_ip, dir, wan_if)` | per bulan | selamanya |
| `flows_daily_ip` | `(day, local_ip, remote_ip, dir)` | tujuan harian ≥ 20 MB | 5 tahun |
| `flows_monthly_ip` | `(month, local_ip, remote_ip, dir)` | tujuan bulanan ≥ 50 MB | 10 tahun |
| `devices` | `mac` | identitas perangkat | permanen |
| `device_ip_history` | `(ip, from_ts)` | riwayat IP↔MAC | permanen |
| `dns_map` | `(ip, name)` | nama domain → IP | 5 tahun |
| `ingest_status` | `id` (selalu 1) | detak ingest | 1 baris |
| `router_stat` | `ts` | CPU/suhu/RAM/PSU/NTP | 90 hari (disarankan) |
| `port_map` | `mac` | MAC ↔ port bridge | 1 baris/MAC |
| `router_session` | `id` | sesi login router | 180 hari |
| `router_log` | `id` | salinan log router | 30 hari |
| `isp_map` | `wan_if` | nama jalur WAN | manual |

`ts`, `ts_hour`, `from_ts`, `first_seen`, `last_seen` (dns_map) = **epoch detik**.
`day`, `month` = `DATE`. Hanya `devices.last_seen` yang berbentuk DATETIME → lihat 3.2.

### 5.2 Indeks yang tersedia

```
traffic_1m        PK (ts, local_ip, dir, wan_if)          ← TIDAK ada index local_ip
flows_5m          PK (ts, local_ip, remote_ip, svc_port, proto, dir, wan_if)
                  KEY idx_svc (ts, svc_port, proto, bytes)
traffic_1h        KEY idx_local (local_ip, ts_hour)
traffic_daily     KEY idx_local (local_ip, day)
flows_daily_ip    KEY idx_ip (remote_ip, day)
devices           KEY idx_last_ip, KEY idx_aktif (aktif, last_seen),
                  KEY idx_seen_ts (aktif, last_seen_ts)
device_ip_history KEY idx_mac (mac, from_ts), KEY idx_open (to_ts)
dns_map           KEY idx_name (name), KEY idx_seen (last_seen)
port_map          KEY idx_port (port, last_seen)
router_log        UNIQUE uq_hash, KEY idx_ts (ts)
router_session    UNIQUE uq (username,address,via,started_at), KEY idx_seen
```

Konsekuensi: **jangan** agregasi "top perangkat" dari `traffic_1m` (full scan).
Pakai `traffic_daily` / `traffic_1h`. `traffic_1m` hanya untuk rentang pendek
(≤ 24 jam) yang dimulai dari `ts` terbaru.

### 5.3 Menghubungkan IP ke perangkat

`device_ip_history` menyimpan `(ip, mac, from_ts, to_ts)`. Baris dengan
`to_ts IS NULL` = pemetaan terakhir. Hari ini tidak ada IP dengan >1 baris
terbuka (sudah diverifikasi), tapi UI **tetap** harus aman:

```sql
-- versi aman: ambil satu baris terbuka terbaru per IP
LEFT JOIN (
  SELECT ip, mac FROM device_ip_history h1
   WHERE to_ts IS NULL
     AND from_ts = (SELECT MAX(from_ts) FROM device_ip_history h2
                     WHERE h2.ip = h1.ip AND h2.to_ts IS NULL)
) h ON h.ip = d.local_ip
```

Untuk laporan historis yang akurat, join berbasis waktu:

```sql
JOIN device_ip_history h
  ON h.ip = t.local_ip
 AND t.ts >= h.from_ts
 AND (h.to_ts IS NULL OR t.ts < h.to_ts)
```

---

## 6. Tabel operasional (sudah dibuat)

Semua tabel di bawah **sudah ada** di database — dibuat otomatis dari
`schema.sql` oleh `ensureSchema()` saat ingest/rollup/sync start. DDL disertakan
sebagai rujukan; tim UI tidak perlu menjalankannya.

### 6.1 `ingest_status` — kesehatan pipeline

```sql
CREATE TABLE IF NOT EXISTS ingest_status (
  id               TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  host             VARCHAR(64)  NULL,
  last_flow_ts     BIGINT UNSIGNED NULL COMMENT 'epoch flow terakhir diterima',
  last_flush_at    DATETIME     NULL,
  rows_last_flush  INT UNSIGNED NULL,
  flows_last_flush INT UNSIGNED NULL,
  total_rows       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Widget "data terakhir N detik lalu" memakai `last_flow_ts`; kalau basi > 5 menit,
tampilkan peringatan merah. **Tabel ini baru terisi setelah `NetflowIngest`
di-restart** (kode lama belum menulis heartbeat).

### 6.2 `router_stat` — riwayat kesehatan router

```sql
CREATE TABLE IF NOT EXISTS router_stat (
  ts             BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'epoch detik',
  cpu_load       TINYINT UNSIGNED NULL,
  free_memory    BIGINT UNSIGNED NULL,
  total_memory   BIGINT UNSIGNED NULL,
  uptime_sec     BIGINT UNSIGNED NULL,
  cpu_temp_c     DECIMAL(4,1) NULL,
  board_temp1_c  DECIMAL(4,1) NULL,
  board_temp2_c  DECIMAL(4,1) NULL,
  fan1_rpm       INT UNSIGNED NULL,
  fan2_rpm       INT UNSIGNED NULL,
  psu1_state     VARCHAR(8) NULL COMMENT 'ok / fail',
  psu2_state     VARCHAR(8) NULL,
  fan_state      VARCHAR(8) NULL,
  ntp_enabled    TINYINT(1) NULL,
  ntp_synced     TINYINT(1) NULL,
  ros_version    VARCHAR(32) NULL,
  update_channel VARCHAR(16) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Tidak ada tegangan PSU.** `/system/health` pada CCR2004 hanya memberi
`psu1-state`/`psu2-state` (`ok`/`fail`), bukan voltase. Tidak ada juga
`latest-version` di `/system/package/update`, jadi "update tersedia" tidak bisa
ditampilkan. Simpan 1 menit sekali.

### 6.3 `port_map` — MAC di port mana

```sql
CREATE TABLE IF NOT EXISTS port_map (
  mac         CHAR(17) NOT NULL PRIMARY KEY,
  bridge      VARCHAR(64) NULL,
  port        VARCHAR(64) NULL COMMENT 'on-interface, mis. ether7',
  is_uplink   TINYINT(1) NOT NULL DEFAULT 0,
  is_local    TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'true = MAC router sendiri',
  first_seen  BIGINT UNSIGNED NOT NULL,
  last_seen   BIGINT UNSIGNED NOT NULL,
  KEY idx_port (port, last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`is_uplink` diisi dari env `UPLINK_PORTS` (mis. `ether1,ether7`), karena bridge
tidak memberi tahu mana port uplink.

### 6.4 `router_session` — siapa login ke router

```sql
CREATE TABLE IF NOT EXISTS router_session (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(64) NOT NULL,
  address    VARCHAR(45) CHARACTER SET ascii NOT NULL,
  via        VARCHAR(16) NOT NULL COMMENT 'winbox/ssh/api/web',
  grup       VARCHAR(32) NULL,
  started_at BIGINT UNSIGNED NOT NULL,
  last_seen  BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq (username, address, via, started_at),
  KEY idx_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 6.5 `router_log` — audit log router

```sql
CREATE TABLE IF NOT EXISTS router_log (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts       BIGINT UNSIGNED NOT NULL,
  topics   VARCHAR(128) NULL,
  severity VARCHAR(16)  NULL COMMENT 'bagian setelah koma pada topics',
  message  VARCHAR(512) NOT NULL,
  extra    VARCHAR(255) NULL COMMENT 'extra-info',
  hash     CHAR(40) NOT NULL COMMENT 'sha1(ts+topics+message+extra)',
  UNIQUE KEY uq_hash (hash),
  KEY idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 6.6 `isp_map` — nama jalur WAN

```sql
CREATE TABLE IF NOT EXISTS isp_map (
  wan_if         INT UNSIGNED NOT NULL PRIMARY KEY,
  nama           VARCHAR(64) NOT NULL,
  provider       VARCHAR(64) NULL,
  kapasitas_mbps INT UNSIGNED NULL,
  aktif          TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- isi awal (sesuaikan dengan /interface comment di router)
INSERT IGNORE INTO isp_map (wan_if, nama, provider) VALUES
  (2, 'ISP1 Utama', 'Nexa / GMEDIA'),
  (8, 'Jalur 8', NULL),
  (3, 'Jalur 3', NULL);
```

### 6.7 `app_user` & `app_session` — login dashboard

```sql
CREATE TABLE IF NOT EXISTS app_user (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(64) NOT NULL UNIQUE,
  pass_hash  VARCHAR(255) NOT NULL COMMENT 'argon2id / bcrypt',
  role       ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
  aktif      TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_session (
  token_hash CHAR(64) NOT NULL PRIMARY KEY COMMENT 'sha256(token)',
  user_id    INT UNSIGNED NOT NULL,
  ip         VARCHAR(45) CHARACTER SET ascii NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  KEY idx_user (user_id),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES app_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 7. Kontrak API backend

Frontend **tidak** mengakses MySQL. Backend menyediakan endpoint berikut.

### 7.1 Konvensi

- Base: `/api`
- Auth: cookie `sid` (httpOnly, SameSite=Lax) hasil `POST /api/auth/login`.
- Semua respons dibungkus:

```json
{
  "data": [ ... ],
  "meta": {
    "range": { "from": "2026-11-19T00:00:00+07:00", "to": "2026-11-19T13:50:00+07:00" },
    "generatedAt": "2026-11-19T13:50:12+07:00",
    "dataLagSeconds": 76,
    "rollupCoverage": 0.318,
    "partial": true
  }
}
```

- Error: `{ "error": { "code": "UNAUTHORIZED", "message": "..." } }`
- `range` yang didukung: `today`, `24h`, `7d`, `30d`, `month`, `year`.

### 7.2 Daftar endpoint

| Method | Path | Parameter | Isi |
|---|---|---|---|
| POST | `/api/auth/login` | `{username,password}` | set cookie sesi |
| POST | `/api/auth/logout` | — | hapus sesi |
| GET | `/api/me` | — | user aktif |
| GET | `/api/health` | — | lag data, cakupan rollup, status task |
| GET | `/api/summary` | `range` | total up/down, jumlah IP, top 5 perangkat |
| GET | `/api/usage/timeseries` | `range`, `bucket` (`hour`/`day`) | deret waktu up/down |
| GET | `/api/usage/monthly` | `year` | per bulan |
| GET | `/api/segments` | `range` | per /24 |
| GET | `/api/devices` | `q`, `segment`, `online`, `sort`, `page`, `perPage` | daftar perangkat |
| GET | `/api/devices/{mac}` | `range` | detail + pemakaian + IP |
| PATCH | `/api/devices/{mac}` | `{nama,pemilik,grup}` | isi nama manual |
| GET | `/api/top/devices` | `range`, `dir`, `limit` | pemakai terbesar |
| GET | `/api/top/destinations` | `range`, `dir`, `limit`, `groupBy=ip\|domain` | tujuan terbesar |
| GET | `/api/router/health` | `range` | riwayat CPU/suhu/RAM |
| GET | `/api/router/ports` | — | peta port + perangkat |
| GET | `/api/router/sessions` | `limit` | sesi login router |
| GET | `/api/audit/log` | `q`, `topics`, `limit` | log router |

### 7.3 Contoh respons

`GET /api/summary?range=today`

```json
{
  "data": {
    "up_bytes": 3670016000,
    "down_bytes": 19770000000,
    "active_ips": 389,
    "devices_named": 214,
    "devices_total": 556,
    "top": [
      { "mac": "aa:bb:cc:00:00:01", "label": "DESKTOP-9K2645U", "local_ip": "10.33.10.159", "down_bytes": 435000000 }
    ]
  },
  "meta": { "dataLagSeconds": 76, "partial": true, "rollupCoverage": 0.318 }
}
```

`GET /api/top/destinations?range=today&dir=down&groupBy=domain&limit=5`

```json
{
  "data": [
    { "key": "instagram.fjog1-1.fna.fbcdn.net", "bytes": 3529500000 },
    { "key": "scontent.fjog1-1.fna.fbcdn.net", "bytes": 2608000000 },
    { "key": "rr2.sn-bhxqp5-ngbl.googlevideo.com", "bytes": 1355000000 }
  ],
  "meta": { "excluded": "remote_ip='(lainnya)'", "note": "hanya tujuan >= 20 MB/hari" }
}
```

---

## 8. Layar & widget

### 8.1 Ringkasan (beranda)

**Layout**

```
┌──────────────────────────────────────────────────────────────┐
│ [logo]  Ringkasan      Hari ini ▾        ● data 76 dtk lalu   │
├───────────┬───────────┬───────────┬──────────────────────────┤
│ Unduh     │ Unggah    │ Perangkat │ Cakupan data             │
│ 18,4 GB   │ 3,4 GB    │ 245 aktif │ ▓▓▓░░░░░ 31% (peringatan)│
├───────────┴───────────┴───────────┴──────────────────────────┤
│ Tren 24 jam (area: unduh / unggah)                           │
├──────────────────────────────────────────────────────────────┤
│ Top 10 perangkat        │ Top 10 tujuan (domain)              │
└──────────────────────────────────────────────────────────────┘
```

**Data**

- Kartu total: `traffic_daily` hari ini (atau `traffic_1m` bila < 24 jam).
- Tren: `traffic_1m` per 10 menit (akurat, tidak tergantung rollup).
- Top perangkat: `traffic_1h` hari ini, join nama.
- Top tujuan: `flows_daily_ip` + `dns_map`.

**SQL tren (verified)**

```sql
SELECT FROM_UNIXTIME(FLOOR(ts / 600) * 600) AS bucket,
       SUM(CASE WHEN dir = 'down' THEN bytes ELSE 0 END) AS down,
       SUM(CASE WHEN dir = 'up'   THEN bytes ELSE 0 END) AS up
  FROM traffic_1m
 WHERE ts >= UNIX_TIMESTAMP(NOW()) - 86400
 GROUP BY bucket
 ORDER BY bucket;
```

**Badge cakupan** (wajib): query di 3.1. Bila < 0,99 tampilkan
"data harian belum lengkap".

**Empty state:** bila `MAX(ts)` tidak ada → "Belum ada data NetFlow".
**Error state:** bila lag > 300 detik → pita merah "ingest berhenti sejak …".

### 8.2 Perangkat

**Kolom tabel:** Nama · IP · Segmen · Status · Unduh hari ini · Unggah hari ini ·
MAC · Aksi (beri nama).

**SQL daftar (verified, dengan fallback nama)**

```sql
SELECT v.mac,
       COALESCE(NULLIF(v.nama,''), NULLIF(v.hostname,''), CONCAT('Perangkat ', v.mac)) AS label,
       v.last_ip,
       CONCAT(SUBSTRING_INDEX(v.last_ip,'.',3),'.0/24') AS segmen,
       v.last_seen,
       v.sumber
  FROM devices v
 WHERE (? = '' OR v.mac LIKE ? OR v.last_ip LIKE ? OR v.hostname LIKE ?)
 ORDER BY v.last_seen DESC
 LIMIT ? OFFSET ?;
```

**SQL pemakaian hari ini (verified, join aman)**

```sql
SELECT h.ip AS local_ip,
       COALESCE(NULLIF(v.nama,''), NULLIF(v.hostname,''), '(tanpa nama)') AS label,
       ROUND(SUM(d.bytes)/1048576) AS mb
  FROM traffic_daily d
  LEFT JOIN (
        SELECT ip, mac FROM device_ip_history h1
         WHERE to_ts IS NULL
           AND from_ts = (SELECT MAX(from_ts) FROM device_ip_history h2
                           WHERE h2.ip = h1.ip AND h2.to_ts IS NULL)
       ) h ON h.ip = d.local_ip
  LEFT JOIN devices v ON v.mac = h.mac
 WHERE d.day = CURDATE() AND d.dir = 'down'
 GROUP BY h.ip, label
 ORDER BY mb DESC
 LIMIT 10;
```

Hasil nyata:

```
10.33.10.174  (tanpa nama)              767 MB
10.33.11.18   (tanpa nama)              756 MB
10.33.10.134  3300--3100102002-819      641 MB
10.33.11.105  OPPO-A6-Pro               507 MB
```

**Status online:** pakai `devices.aktif = 1 AND devices.last_seen_ts >= UNIX_TIMESTAMP() - 1800`
(sudah zona waktu-aman). Perangkat yang hanya terlihat di ARP jangan ditandai offline.

**Aksi "beri nama":** `PATCH /api/devices/{mac}` mengisi `nama`/`pemilik`/`grup`.
Sync tidak akan menimpanya.

### 8.3 Pemakaian (bulanan/tahunan)

**Isi:** grafik batang per bulan, tabel per segmen, ekspor CSV.

```sql
-- per bulan
SELECT DATE_FORMAT(month, '%Y-%m') AS bulan,
       ROUND(SUM(CASE WHEN dir='down' THEN bytes END)/1073741824, 2) AS gb_down,
       ROUND(SUM(CASE WHEN dir='up'   THEN bytes END)/1073741824, 2) AS gb_up
  FROM traffic_monthly
 GROUP BY month
 ORDER BY month DESC
 LIMIT 24;
```

```sql
-- per segmen /24 (verified)
SELECT CONCAT(SUBSTRING_INDEX(local_ip,'.',3),'.0/24') AS seg,
       ROUND(SUM(bytes)/1048576) AS mb,
       COUNT(DISTINCT local_ip) AS ip
  FROM traffic_daily
 WHERE day = CURDATE() AND dir = 'down'
 GROUP BY seg
 ORDER BY mb DESC;
```

Hasil nyata (hari ini): `10.33.10.0/24` 9.493 MB (105 IP), `10.33.11.0/24`
5.105 MB (68 IP), `10.33.13.0/24` 980 MB.

**Ekspor CSV:** sediakan `GET /api/usage/monthly?format=csv`, jangan mengandalkan
fitur browser.

### 8.4 Tujuan

**Isi:** top IP dan top domain, dengan pemilih `ip | domain`.

```sql
-- top IP (verified)
SELECT remote_ip, ROUND(SUM(bytes)/1048576) AS mb
  FROM flows_daily_ip
 WHERE day = CURDATE() AND dir = 'down' AND remote_ip <> '(lainnya)'
 GROUP BY remote_ip
 ORDER BY mb DESC
 LIMIT 20;
```

```sql
-- top domain: satu nama per IP, lalu agregasi (verified)
SELECT COALESCE(n.name, f.remote_ip) AS domain,
       ROUND(SUM(f.bytes)/1048576) AS mb
  FROM flows_daily_ip f
  LEFT JOIN (SELECT ip, MIN(name) AS name FROM dns_map GROUP BY ip) n
         ON n.ip = f.remote_ip
 WHERE f.day = CURDATE() AND f.dir = 'down' AND f.remote_ip <> '(lainnya)'
 GROUP BY domain
 ORDER BY mb DESC
 LIMIT 20;
```

Hasil nyata:

```
instagram.fjog1-1.fna.fbcdn.net   3.366 MB
scontent.fjog1-1.fna.fbcdn.net    2.487 MB
rr2.sn-bhxqp5-ngbl.googlevideo.com 1.292 MB
rr1.sn-bhxqp5-ngbl.googlevideo.com   504 MB
170.114.166.138 (tanpa nama DNS)     465 MB
```

**Catatan penting:** nama domain adalah hostname CDN, bukan "situs". Untuk
tampilan yang ramah, kelompokkan berdasarkan sufiks (Fase 2):

| Sufiks | Label |
|---|---|
| `fbcdn.net`, `facebook.com` | Facebook |
| `googlevideo.com`, `ytimg.com` | YouTube |
| `googlesyndication.com`, `doubleclick.net` | Iklan Google |

**Wajib tampil:** baris keterangan *"Tujuan < 20 MB/hari digabung; 23,7% trafik
unduh tidak dirinci."*

### 8.5 Kesehatan Router (tabel & sync sudah ada)

**Kartu:** CPU %, RAM terpakai, uptime, suhu CPU/board, status PSU1/PSU2, fan,
versi RouterOS, status NTP. (Tegangan PSU dan "update tersedia" **tidak
tersedia** dari router ini — lihat 6.2.)

**Sumber:** `/system/resource`, `/system/health`, `/system/ntp/client`,
`/system/package/update` → `router_stat`, diisi `sync-router.js` tiap menit.

**Layout:** grafik garis CPU & suhu 24 jam, kartu nilai terakhir, daftar peringatan:

| Ambang | Peringatan |
|---|---|
| suhu > 65 °C | merah |
| CPU > 90% selama 5 menit | kuning |
| RAM bebas < 10% | kuning |
| NTP tidak sinkron | merah (timestamp NetFlow bisa meleset) |
| `psu1_state`/`psu2_state` = `fail` | merah |
| `fan_state` != `ok` | kuning |

### 8.6 Peta Port (tabel & sync sudah ada)

**Isi:** daftar port switch (dari `/interface/ethernet`) dan perangkat yang
menancap (dari `/interface/bridge/host`), digabung dengan nama perangkat.

**Tampilan yang disarankan:** grid port, warna = ada perangkat / kosong / uplink;
klik port → daftar MAC + nama + sejak kapan.

Data hari ini: **204 entri bridge/host**, 18 port ethernet.

```sql
SELECT pm.port,
       pm.mac,
       COALESCE(NULLIF(v.nama,''), NULLIF(v.hostname,''), CONCAT('Perangkat ', pm.mac)) AS label,
       pm.last_seen
  FROM port_map pm
  LEFT JOIN devices v ON v.mac = pm.mac
 ORDER BY pm.port, pm.last_seen DESC;
```

**Nilai tambah:** deteksi perangkat tak dikenal di port tertentu — berguna saat
ada keluhan "internet di ruang X lambat".

### 8.7 Audit (tabel & sync sudah ada)

Tiga panel:

1. **Sesi login router** — `router_session` yang `last_seen` < 5 menit.
2. **Layanan terbuka** — snapshot `/ip/service` (winbox/ssh/api/www), tandai
   merah bila `available-from` kosong.
3. **Log router** — `router_log`, filter topik `system,error` dan
   `account,info` (login sukses/gagal).

```sql
SELECT ts, topics, message FROM router_log
 WHERE topics LIKE '%account%' OR topics LIKE '%error%'
 ORDER BY ts DESC LIMIT 100;
```

**Jangan** tampilkan seluruh 1.000 baris log tanpa filter — tidak berguna dan
membebani.

### 8.8 Refresh per layar

| Layar | Interval | Metode |
|---|---|---|
| Ringkasan (kartu total) | 60 s | polling |
| Ringkasan (tren) | 60 s | polling |
| Perangkat | 60 s | polling |
| Kesehatan router | 60 s | polling |
| Peta port | 5 menit | polling |
| Audit/log | 60 s | polling |
| Status pipeline | 30 s | polling |

WebSocket/SSE opsional; data sumbernya hanya berubah tiap menit, jadi polling
sudah cukup. Jangan memakai `/ip/firewall/connection` untuk "realtime".

---

## 9. Data yang perlu ditarik dari MikroTik

Detail lengkap ada di `DOKUMENTASI-API-MIKROTIK.md`. **Status: baris 1–4 dan 6–9
sudah diimplementasikan** (`sync-mikrotik.js` dan `sync-router.js`); tinggal
dijadwalkan.

| Data | Endpoint | Biaya terukur | Interval | Tabel |
|---|---|---|---|---|
| Nama perangkat | `/ip/dhcp-server/lease` | 13 ms, 190 baris | 5–10 menit | `devices` |
| IP↔MAC | `/ip/arp` | 42 ms, 572 baris | 5–10 menit | `devices`, `device_ip_history` |
| Nama domain | `/ip/dns/cache` | 247 ms, 3.325 baris | 10 menit | `dns_map` |
| Kesehatan | `/system/resource`, `/system/health` | 2 ms | 1 menit | `router_stat` |
| NTP + update | `/system/ntp/client`, `/system/package/update` | 6 ms | 1 jam | `router_stat` |
| Port↔MAC | `/interface/bridge/host`, `/interface/ethernet` | 13 ms / 3 ms | 1 menit | `port_map` |
| Sesi login | `/user/active` | 2 ms | 30 detik | `router_session` |
| Layanan | `/ip/service` | 17 ms | 1 jam | snapshot |
| Log | `/log` | 82 ms (1.000 baris) | 1 menit | `router_log` |
| Status ISP | `/ip/route` | 3 ms | 1 menit | (opsional) |

**Jangan** menarik `/ip/firewall/connection`: 4,1–4,6 MB, 2–9,7 detik, dan
pernah gagal di tengah jalan. Untuk volume, NetFlow sudah benar.

---

## 10. Realtime (opsional, Fase 3)

Bila ingin grafik "detik ini juga", ambil laju dari router, bukan volume:

```
POST /rest/interface/monitor-traffic
{ "interface": "bridge", "once": "true" }
→ rx-bits-per-second, tx-bits-per-second
```

Biaya 1 ms. Simpan di cache backend 5 detik; jangan simpan ke MySQL. Tampilkan
sebagai angka besar di header, bukan grafik historis (riwayatnya sudah ada dari
NetFlow per menit).

---

## 11. Keamanan

1. **User MySQL khusus aplikasi, read-only — sudah dibuat:**

```sql
-- sudah dijalankan; host mengikuti kebutuhan
CREATE USER 'netflow_app'@'localhost' IDENTIFIED BY '<lihat .env: APP_DB_PASSWORD>';
CREATE USER 'netflow_app'@'10.33.%' IDENTIFIED BY '<sama>';
GRANT SELECT ON netflow_monitor.* TO 'netflow_app'@'localhost';
GRANT SELECT ON netflow_monitor.* TO 'netflow_app'@'10.33.%';
-- kecuali kolom manual, yang perlu UPDATE terbatas:
GRANT UPDATE (nama, pemilik, grup) ON netflow_monitor.devices TO 'netflow_app'@'localhost';
GRANT UPDATE (nama, pemilik, grup) ON netflow_monitor.devices TO 'netflow_app'@'10.33.%';
```

Sudah diuji: `SELECT` jalan; `INSERT traffic_1m` dan `DELETE dns_map` ditolak
dengan `ER_TABLEACCESS_DENIED_ERROR`. Kredensial ada di `.env`
(`APP_DB_USER` / `APP_DB_PASSWORD`). Jangan memakai user `netflow` (user tulis
milik ingest) di aplikasi web.

2. **Jangan menaruh kredensial router di frontend.** Semua panggilan router dari
   backend.
3. **Login dashboard wajib** sebelum dashboard dibuka ke LAN. `viewer` hanya
   baca; `admin` boleh mengubah nama perangkat.
4. **Rate limit** endpoint agregasi (mis. 30 req/menit/IP) — query `traffic_1m`
   24 jam masih wajar (57 ms), tapi 10 pengguna serentak perlu dijaga.
5. **Jangan tampilkan password/secret** dari `/user`, `/ppp/secret`, `/ip/ipsec`.

---

## 12. Performa & batas query

Hasil ukur di server ini (dataset 4 jam):

| Query | Waktu |
|---|---|
| Tren 24 jam dari `traffic_1m` | 57 ms |
| Top perangkat dari `traffic_daily` | 4 ms |
| Top tujuan + join DNS | 2–4 ms |
| Per segmen | 3 ms |
| Cek lag ingest | 4 ms |
| Cek cakupan rollup | 25 ms |

Aturan:

- Selalu batasi `ts`/`day` lebih dulu; jangan `SELECT *`.
- `flows_5m` hanya untuk rentang ≤ 3 hari dan selalu dengan `ts >=`.
- Jangan `ORDER BY` kolom tanpa index pada tabel > 1 juta baris.
- Cache hasil agregat 60 detik di backend (key: endpoint + parameter + menit).

---

## 13. Roadmap & checklist handoff

### Fase 1 — bisa dikerjakan sekarang (data siap)

- [ ] API: `/auth/login`, `/health`, `/summary`, `/usage/timeseries`,
      `/usage/monthly`, `/segments`, `/devices`, `/top/devices`, `/top/destinations`
- [ ] UI: Ringkasan, Perangkat, Pemakaian, Tujuan
- [ ] Badge lag data + badge cakupan rollup
- [ ] Fitur "beri nama perangkat"
- [ ] Empty state jujur untuk riwayat pendek

### Fase 2 — tabel & sync sudah tersedia

- [x] `router_stat` + `sync-router.js` → tinggal layar Kesehatan Router
- [x] `port_map` + `sync-router.js` → tinggal layar Peta Port
- [x] `router_session`, `router_log` + `sync-router.js` → tinggal layar Audit
- [x] `isp_map` (+ isi awal) → tinggal label jalur WAN

### Fase 3

- [ ] Pengelompokan domain (Facebook/YouTube/Iklan)
- [ ] Alert (suhu, ingest mati, perangkat boros)
- [ ] Laporan PDF/Excel bulanan
- [ ] Realtime header (monitor-traffic)

### Status prasyarat di sisi repo data (bukan UI)

- [x] Perbaiki zona waktu + tambah `devices.last_seen_ts`
- [x] Buat 8 tabel operasional (bagian 6)
- [x] `sync-router.js` + `run-sync-router.cmd` (kesehatan/port/sesi/log)
- [x] Backfill rollup (`npm run backfill`) — cakupan 98,8%
- [x] User MySQL `netflow_app` read-only + uji hak akses
- [ ] **Daftarkan 4 Scheduled Task** (RollupHourly, RollupDaily, SyncMikrotik,
      SyncRouter) — butuh PowerShell Run as Administrator
- [ ] **Buka firewall 3306** — butuh admin
- [ ] **Restart `NetflowIngest`** agar heartbeat `ingest_status` aktif

---

## Lampiran A — query siap pakai (sudah diverifikasi)

```sql
-- 1. Lag ingest (detik)
SELECT TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(MAX(ts)), NOW()) AS lag_detik
  FROM traffic_1m;

-- 2. Cakupan rollup hari ini (0..100)
SELECT ROUND(
  (SELECT SUM(bytes) FROM traffic_1h WHERE ts_hour >= UNIX_TIMESTAMP(CURDATE()))
  / (SELECT SUM(bytes) FROM traffic_1m WHERE ts  >= UNIX_TIMESTAMP(CURDATE()))
  * 100, 1) AS persen;

-- 3. Rentang data tersedia
SELECT FROM_UNIXTIME(MIN(ts)) AS mulai, FROM_UNIXTIME(MAX(ts)) AS terakhir
  FROM traffic_1m;

-- 4. Total hari ini per arah
SELECT dir, ROUND(SUM(bytes)/1073741824, 2) AS gb
  FROM traffic_daily WHERE day = CURDATE() GROUP BY dir;

-- 5. Perangkat bernama dengan pemakaian terbesar hari ini
SELECT COALESCE(v.nama, v.hostname) AS perangkat,
       d.local_ip, ROUND(SUM(d.bytes)/1048576) AS mb
  FROM traffic_daily d
  JOIN device_ip_history h ON h.ip = d.local_ip AND h.to_ts IS NULL
  JOIN devices v ON v.mac = h.mac
 WHERE d.day = CURDATE() AND d.dir = 'down'
   AND COALESCE(v.nama, v.hostname) IS NOT NULL
 GROUP BY perangkat, d.local_ip
 ORDER BY mb DESC LIMIT 20;

-- 6. Proporsi '(lainnya)'
SELECT dir,
       ROUND(SUM(CASE WHEN remote_ip='(lainnya)' THEN bytes ELSE 0 END)
             / SUM(bytes) * 100, 1) AS persen_lainnya
  FROM flows_daily_ip WHERE day = CURDATE() GROUP BY dir;

-- 7. Perangkat online (zona waktu-aman)
SELECT COUNT(*) AS online FROM devices
 WHERE aktif = 1 AND last_seen_ts >= UNIX_TIMESTAMP() - 1800;

-- 8. Kesehatan pipeline (kosong sampai ingest di-restart)
SELECT host, FROM_UNIXTIME(last_flow_ts) AS flow_terakhir,
       last_flush_at, rows_last_flush, flows_last_flush, total_rows,
       TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(last_flow_ts), NOW()) AS lag_detik
  FROM ingest_status WHERE id = 1;
```

## Lampiran B — contoh JSON metadata

```json
{
  "generatedAt": "2026-11-19T14:05:00+07:00",
  "dataLagSeconds": 76,
  "rollupCoverage": 0.988,
  "partial": true,
  "dataSince": "2026-11-19T10:12:00+07:00",
  "warnings": [
    "Jam berjalan belum masuk rollup (normal)",
    "23,7% trafik unduh tidak dirinci (di bawah ambang 20 MB/hari)"
  ]
}
```