# Rancangan Penyimpanan Netflow Jangka Panjang

Target:
1. **Tahunan/bulanan** — berapa pemakaian internet tiap perangkat per bulan dan per tahun.
2. **Harian/mingguan** — tabulasi siapa pemakai terbesar hari ini / minggu ini.
3. **IP tujuan** — total pemakaian ke tiap IP tujuan, disimpan panjang.

Dasar angka (diukur dari data nyata 19 Nov 2026):

| Fakta | Nilai |
|---|---|
| Perangkat (local_ip) | 244 |
| Detail 5 menit di jam sibuk | ~45.000 baris/bucket → **13 juta baris/hari** (~1,4 GB/hari) |
| Ringkasan per menit | 358 baris/menit → 515 ribu baris/hari (~48 MB/hari) |
| Pasangan (perangkat → IP tujuan) per jam | **411.293** unik |
| Byte yang disumbang 1.308 IP teratas (≥1 MB/jam) | **90,6%** |
| Byte dari 256 IP (≥10 MB/jam) | 74,5% |

Kesimpulan: detail tujuan mentah tidak mungkin disimpan bertahun-tahun
(±440 GB/tahun). Yang disimpan panjang adalah **rollup + IP di atas ambang**.

---

## 1. Tingkatan data

| Tabel | Granularitas | Retensi | Perkiraan ukuran |
|---|---|---|---:|
| `flows_5m` | perangkat + IP tujuan + port + proto, 5 menit | 3 hari | 4,3 GB (rolling) |
| `traffic_1m` | perangkat + arah + WAN, per menit | 30 hari | 1,4 GB (rolling) |
| `traffic_1h` | idem, per jam | 2 tahun | ~0,6 GB |
| `traffic_daily` | idem, per hari | 10 tahun | ~0,15 GB |
| `traffic_monthly` | idem, per bulan | selamanya | ~5 MB |
| `flows_daily_ip` | perangkat + IP tujuan, per hari | 5 tahun | ~0,5 GB |
| `flows_monthly_ip` | perangkat + IP tujuan, per bulan | 10 tahun | ~0,5 GB |
| `svc_hourly` | port + protokol + arah, per jam | 90 hari | ~0,3 GB |
| `svc_daily` | idem, per hari | 2 tahun | ~0,3 GB |

Total stabil: **±8–11 GB** — tidak tumbuh walau berjalan bertahun-tahun,
karena yang besar (`flows_5m`, `traffic_1m`) berputar.

Zona waktu: hari/bulan dihitung **WIB** (server `Asia/Jakarta`, sudah dicek).
Malam hari jadi batas: 00:00–23:59 WIB.

---

## 2. Skema tambahan (`schema.sql`)

```sql
-- Ringkasan per jam (2 tahun)
CREATE TABLE IF NOT EXISTS traffic_1h (
  ts_hour  BIGINT UNSIGNED NOT NULL COMMENT 'epoch detik, awal jam',
  local_ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  wan_if   INT UNSIGNED NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (ts_hour, local_ip, dir, wan_if),
  KEY idx_local (local_ip, ts_hour)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan per hari (10 tahun)
CREATE TABLE IF NOT EXISTS traffic_daily (
  day      DATE NOT NULL,
  local_ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  wan_if   INT UNSIGNED NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (day, local_ip, dir, wan_if),
  KEY idx_local (local_ip, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan per bulan (selamanya, selalu tanggal 1)
CREATE TABLE IF NOT EXISTS traffic_monthly (
  month    DATE NOT NULL,
  local_ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  wan_if   INT UNSIGNED NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (month, local_ip, dir, wan_if),
  KEY idx_local (local_ip, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Detail IP tujuan per hari (>= ambang, plus baris '(lainnya)')
CREATE TABLE IF NOT EXISTS flows_daily_ip (
  day        DATE NOT NULL,
  local_ip   VARCHAR(45) CHARACTER SET ascii NOT NULL,
  remote_ip  VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir        ENUM('up','down') NOT NULL,
  bytes      BIGINT UNSIGNED NOT NULL,
  packets    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (day, local_ip, remote_ip, dir),
  KEY idx_ip (remote_ip, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Detail IP tujuan per bulan (diturunkan dari flows_daily_ip)
CREATE TABLE IF NOT EXISTS flows_monthly_ip (
  month      DATE NOT NULL,
  local_ip   VARCHAR(45) CHARACTER SET ascii NOT NULL,
  remote_ip  VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir        ENUM('up','down') NOT NULL,
  bytes      BIGINT UNSIGNED NOT NULL,
  packets    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (month, local_ip, remote_ip, dir),
  KEY idx_ip (remote_ip, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan layanan (port tujuan + protokol) per jam (90 hari)
CREATE TABLE IF NOT EXISTS svc_hourly (
  ts_hour  BIGINT UNSIGNED NOT NULL,
  svc_port INT UNSIGNED NOT NULL,
  proto    VARCHAR(8) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  flows    INT UNSIGNED NOT NULL,
  PRIMARY KEY (ts_hour, svc_port, proto, dir),
  KEY idx_svc (svc_port, proto, ts_hour)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan layanan per hari (2 tahun)
CREATE TABLE IF NOT EXISTS svc_daily (
  day      DATE NOT NULL,
  svc_port INT UNSIGNED NOT NULL,
  proto    VARCHAR(8) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  flows    INT UNSIGNED NOT NULL,
  PRIMARY KEY (day, svc_port, proto, dir),
  KEY idx_svc (svc_port, proto, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Kenapa ada baris `'(lainnya)'`

`flows_daily_ip` hanya menyimpan IP yang totalnya ≥ ambang (default **20 MB/hari**
per perangkat). Sisa traffic digabung jadi satu baris `remote_ip='(lainnya)'`
per perangkat+arah. Dengan begitu:

- jumlah `flows_daily_ip` per hari = jumlah pemakaian di `traffic_daily`
  (tidak ada byte yang hilang),
- ukuran tabel tetap kecil,
- IP "penting" tetap terlacak harian dan bulanan.

`flows_monthly_ip` diturunkan dari `flows_daily_ip` (bukan dari data mentah),
jadi konsisten dan idempoten. Ambang bulanan opsional (default 50 MB/bulan);
baris di bawah ambang digabung ke `'(lainnya)'` bulanan.

---

## 3. Pekerjaan rollup (idempoten)

Semua query memakai pola **hitung ulang lalu timpa** (`ON DUPLICATE KEY UPDATE
bytes=VALUES(bytes)`), bukan menambah. Jadi aman dijalankan berulang, aman
setelah server mati, dan tidak pernah menghitung ganda.

| Jalan | Isi | Sumber |
|---|---|---|
| tiap jam (menit ke-5) | `traffic_1h` 2 jam terakhir | `traffic_1m` |
| tiap jam (menit ke-5) | `traffic_daily` hari ini & kemarin | `traffic_1h` |
| tiap jam (menit ke-5) | `traffic_monthly` bulan ini | `traffic_daily` |
| tiap jam (menit ke-5) | `svc_hourly` 3 jam terakhir | `flows_5m` |
| tiap jam (menit ke-5) | `svc_daily` hari ini & kemarin | `svc_hourly` |
| tiap jam | cleanup `traffic_1m`, `traffic_1h`, `svc_hourly`, `svc_daily` | — |
| 00:15 tiap hari | `flows_daily_ip` kemarin (+ hari ini opsional) | `flows_5m` |
| 00:15 tiap hari | `flows_monthly_ip` bulan ini & bulan lalu | `flows_daily_ip` |
| 00:15 tiap hari | cleanup `flows_5m`, `flows_daily_ip` | — |

`flows_daily_ip` hanya dihitung malam karena `flows_5m` disimpan 3 hari, jadi
masih aman kalau job sempat gagal sehari (bisa diulang).

Contoh SQL inti:

```sql
-- 1 jam terakhir -> traffic_1h
INSERT INTO traffic_1h (ts_hour, local_ip, dir, wan_if, bytes, packets)
SELECT ts - MOD(ts, 3600), local_ip, dir, wan_if, SUM(bytes), SUM(packets)
FROM traffic_1m
WHERE ts >= ? AND ts < ?
GROUP BY ts - MOD(ts, 3600), local_ip, dir, wan_if
ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), packets = VALUES(packets);
```

```sql
-- kemarin -> flows_daily_ip (baris di atas ambang)
INSERT INTO flows_daily_ip (day, local_ip, remote_ip, dir, bytes, packets)
SELECT DATE(FROM_UNIXTIME(ts)), local_ip, remote_ip, dir, SUM(bytes), SUM(packets)
FROM flows_5m
WHERE ts >= ? AND ts < ?
GROUP BY DATE(FROM_UNIXTIME(ts)), local_ip, remote_ip, dir
HAVING SUM(bytes) >= ?
ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), packets = VALUES(packets);
-- lalu satu INSERT lagi untuk baris '(lainnya)':
--   total per perangkat/arah dikurangi jumlah baris IP di atas ambang
```

---

## 4. Contoh query untuk kebutuhan kamu

**Pemakaian bulanan per perangkat**

```sql
SELECT month, local_ip,
       SUM(CASE WHEN dir='down' THEN bytes ELSE 0 END)/1e9 AS down_gb,
       SUM(CASE WHEN dir='up'   THEN bytes ELSE 0 END)/1e9 AS up_gb
FROM traffic_monthly
WHERE month >= '2026-01-01'
GROUP BY month, local_ip
ORDER BY month DESC, down_gb DESC;
```

**Total setahun per perangkat**

```sql
SELECT local_ip, SUM(bytes)/1e9 AS total_gb
FROM traffic_monthly
WHERE month >= MAKEDATE(YEAR(CURDATE()), 1)
GROUP BY local_ip ORDER BY total_gb DESC;
```

**Tabulasi pemakai terbesar hari ini / minggu ini**

```sql
-- hari ini
SELECT local_ip,
       SUM(CASE WHEN dir='down' THEN bytes ELSE 0 END)/1e9 AS down_gb,
       SUM(CASE WHEN dir='up'   THEN bytes ELSE 0 END)/1e9 AS up_gb
FROM traffic_daily
WHERE day = CURDATE()
GROUP BY local_ip ORDER BY down_gb + up_gb DESC LIMIT 20;

-- minggu ini
SELECT local_ip, SUM(bytes)/1e9 AS total_gb
FROM traffic_daily
WHERE day >= CURDATE() - INTERVAL 6 DAY
GROUP BY local_ip ORDER BY total_gb DESC LIMIT 20;
```

**Top IP tujuan per perangkat (bulanan)**

```sql
SELECT remote_ip, SUM(bytes)/1e9 AS gb
FROM flows_monthly_ip
WHERE month = '2026-11-01' AND local_ip = '10.33.11.105' AND dir = 'down'
GROUP BY remote_ip ORDER BY gb DESC LIMIT 20;
```

**IP tujuan tertentu, tren per bulan (bertahun-tahun)**

```sql
SELECT month, SUM(bytes)/1e9 AS gb
FROM flows_monthly_ip
WHERE remote_ip = '8.8.8.8' AND dir = 'down'
GROUP BY month ORDER BY month;
```

**Top IP tujuan keseluruhan bulan ini**

```sql
SELECT remote_ip, SUM(bytes)/1e9 AS gb
FROM flows_monthly_ip
WHERE month = '2026-11-01' AND dir = 'down' AND remote_ip <> '(lainnya)'
GROUP BY remote_ip ORDER BY gb DESC LIMIT 30;
```

---

## 5. Konfigurasi retensi (`.env`)

```ini
KEEP_DETAIL_DAYS=3        # flows_5m
KEEP_MINUTE_DAYS=30       # traffic_1m
KEEP_HOUR_DAYS=730        # traffic_1h (2 tahun)
KEEP_DAILY_IP_DAYS=1825   # flows_daily_ip (5 tahun)
KEEP_SVC_HOUR_DAYS=90     # svc_hourly
KEEP_SVC_DAILY_DAYS=730   # svc_daily (2 tahun)
# traffic_daily & traffic_monthly & flows_monthly_ip: disimpan selamanya

IP_DAILY_MIN_BYTES=20971520    # 20 MB/hari per perangkat per IP
IP_MONTHLY_MIN_BYTES=52428800  # 50 MB/bulan
```

Kalau nanti ukuran `flows_daily_ip` terasa besar, naikkan ambangnya ke 50 MB
dan/atau turunkan retensi ke 3 tahun. Data lama yang sudah terlanjur masuk
tetap ada; hanya baris baru yang lebih ringkas.

---

## 6. Disk & arsip

- Live database: **±8–10 GB** (mayoritas `flows_5m` yang berputar).
- Disk C: saat ini sisa 24,9 GB — cukup untuk sekarang, tapi dipakai bersama
  `pointse` (8,7 GB) dan project lain.
- Rolls tabel kecil (harian/bulanan) cocok untuk **backup malam** ke
  `D:\netflow-archive\` (`mysqldump` + gzip, ukurannya ± puluhan MB).
- Detail mentah **tidak perlu diarsipkan** (1,4 GB/hari → ±400 MB/hari
  terkompresi). Kalau suatu saat butuh forensik, export `flows_5m` yang
  hampir kedaluwarsa saja, dan hanya untuk hari yang penting.

---

## 7. Catatan desain

- **Kenapa `traffic_monthly` terpisah** padahal bisa di-SUM dari `traffic_daily`:
  agar laporan tahunan tidak bergantung pada retensi `traffic_daily`, dan
  query tahunan cukup membaca ±950 baris/bulan.
- **Kenapa `dir` dan `wan_if` ikut di semua ringkasan**: kamu punya 2 WAN
  (ifIndex 2 dan 8); tanpa ini tidak bisa memisahkan pemakaian per ISP.
- **`local_ip = 'tidak-diketahui'`** tetap dipertahankan seperti sekarang
  (flow download yang pasangan NAT-nya tidak ketemu). Di UI sebaiknya
  ditampilkan sebagai kategori terpisah, bukan perangkat.
- **IP `(lainnya)` dan `tidak-diketahui`** sengaja bukan IP valid, jadi tidak
  akan bentrok dengan data asli.
- **Partisi** baru diperlukan kalau `flows_5m` diperpanjang > 7 hari atau
  `DELETE` cleanup mulai lambat; saat itu pakai partisi harian dan
  `DROP PARTITION`. Untuk desain sekarang, DELETE per jam sudah ringan
  (±550 ribu baris/jam di steady state).
- **Idempoten**: semua rollup menimpa hasil, bukan menambah. Satu-satunya
  pengecualian ada di perhitungan `'(lainnya)'` yang harus menghitung ulang
  dari sumber setiap kali — jangan pernah `bytes = bytes + VALUES(bytes)`.

---

## 8. Rencana implementasi

1. Tambah 5 tabel di `schema.sql` (otomatis dibuat saat ingest start).
2. Buat `rollup.js` dengan dua mode: `--hourly` dan `--daily`.
3. Daftarkan 2 scheduled task (SYSTEM), log ke `logs\rollup.log`,
   pola sama seperti `NetflowIngest`:
   - `NetflowRollupHourly` — tiap jam, menit ke-5;
   - `NetflowRollupDaily` — tiap hari 00:15.
4. Backfill: `traffic_1h`/`traffic_daily` bisa diisi dari `traffic_1m` yang
   sekarang ada (±1 jam). `flows_daily_ip` mulai dari nol (detail 3 hari
   masih cukup untuk 2–3 hari pertama).
5. Update `README-MYSQL.md` + contoh query.