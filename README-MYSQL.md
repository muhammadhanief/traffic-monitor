# Netflow Monitor — versi MySQL

Database sudah dipindah dari SQLite (`data/flows.db`) ke **MySQL 8.0.30**
(Laragon) di PC ini. Dashboard/dashboard Next.js atau PC lain sekarang bisa
membaca database langsung lewat jaringan.

> **Struktur repo (sejak pemisahan pipeline & aplikasi web):**
> seluruh kode pipeline (collector, rollup, sync, wrapper Windows, `tools/`)
> sekarang berada di subfolder **`traffic-monitor-pipeline/`**. Aplikasi web
> (backend API + frontend) akan berada di root repo dan punya `package.json`
> sendiri. Semua perintah `npm run ...`, `node --env-file...`, dan Scheduled
> Task di dokumen ini dijalankan **dari dalam folder `traffic-monitor-pipeline/`**
> (kecuali disebut lain). Contoh path di bawah memakai
> `C:\netflow-monitor\traffic-monitor-pipeline` — sesuaikan dengan lokasi repo
> Anda.

## Yang berubah

| File | Keterangan |
|---|---|
| `db.js` | **Baru.** Konfigurasi + pool koneksi MySQL + `ensureSchema()` (buat tabel dari `schema.sql`). Dibaca dari `.env`. |
| `schema.sql` | **Baru.** DDL MySQL: `traffic_1m`, `flows_5m`, 7 tabel rollup, `devices`/`device_ip_history`/`dns_map`, + 8 tabel operasional (`ingest_status`, `router_stat`, `port_map`, `router_session`, `router_log`, `isp_map`, `app_user`, `app_session`). Dibuat otomatis saat ingest/rollup/sync start. |
| `migrate-to-mysql.js` | **Baru.** Penyalin data SQLite → MySQL. |
| `rollup.js` | **Baru.** Merangkum data ke tabel per jam/hari/bulan, IP tujuan jangka panjang, dan layanan (`svc_hourly`/`svc_daily`), sekaligus membersihkan data kedaluwarsa. |
| `sync-mikrotik.js` | **Baru.** Menarik identitas perangkat (DHCP lease/ARP) & nama tujuan (cache DNS) dari router lewat REST API. |
| `sync-router.js` | **Baru.** Snapshot kesehatan router (CPU/suhu/RAM/PSU/fan/NTP), peta MAC↔port, sesi login, dan salinan log ke `router_stat`/`port_map`/`router_session`/`router_log`. Ada mode `--dry-run`. |
| `mt-rest.js` | **Baru.** Klien REST RouterOS bersama (hanya GET) untuk kedua script sync. |
| `DOKUMENTASI-API-MIKROTIK.md` | **Baru.** Inventaris ±175 endpoint REST router (hasil probing), field penting, perintah POST, dan jebakan. Referensi untuk developer/AI. |
| `DOKUMENTASI-UI.md` | **Baru.** Kontrak data untuk dashboard web (dibangun di repo terpisah): kesiapan data, gerbang kualitas, DDL tabel baru, kontrak API, rancangan 7 layar + query terverifikasi. |
| `tools/probe-mikrotik-api.mjs` | **Baru.** Alat baca-saja untuk memprobe endpoint & mencetak tabel Markdown (sumber data dokumen di atas). |
| `tools/cek-kesehatan.mjs` | **Baru.** Pemeriksaan baca-saja: lag ingest, cakupan rollup, kesegaran `devices`/`router_stat`/`port_map`/`router_log`, proporsi `(lainnya)`. |
| `EVALUASI-PRD.md` | **Baru.** Evaluasi implementasi + selisih tabel DB terhadap PRD aplikasi web. |
| `ingest.js` | Tulis ke MySQL, bukan SQLite. Flush per menit, batch 1000 baris per `INSERT`, dalam transaksi. |
| `report.js` | Baca dari MySQL. |
| `RANCANGAN-RETENSI.md` | **Baru.** Rancangan lengkap penyimpanan jangka panjang + contoh query. |
| `run-ingest.cmd`, `run-rollup.cmd`, `run-sync.cmd`, `run-sync-router.cmd` | Pembungkus untuk Scheduled Task (log + rotasi + bersihkan proses yatim). |
| `package.json` | Tambah `mysql2` + script `rollup*`; `better-sqlite3` pindah ke devDependencies (hanya untuk migrasi). |
| `data/flows.db` | **Tidak diubah.** Simpan sebagai cadangan. Boleh dihapus setelah yakin. |

Perbedaan tipe penting: `bytes`/`packets` di MySQL memakai `BIGINT UNSIGNED`
(SQLite `INTEGER` 64-bit), `dir` memakai `ENUM('up','down')`, dan
`WITHOUT ROWID` diganti primary key InnoDB biasa.

## Konfigurasi

Edit `.env` (sudah dibuat):

```ini
DB_HOST=127.0.0.1        # ganti 10.33.6.11 kalau script jalan dari PC lain
DB_PORT=3306
DB_USER=netflow
DB_PASSWORD=<lihat file .env>
DB_NAME=netflow_monitor
```

Database `netflow_monitor` dan user `netflow`@`%` sudah dibuat. User ini hanya
punya hak akses ke database `netflow_monitor`, bukan seluruh server MySQL.

## Menjalankan

```powershell
npm run ingest            # tulis ke MySQL (jalankan di PC ini)
npm run report 30         # laporan 30 menit terakhir
npm run rollup            # rangkum + bersihkan (manual; biasanya lewat Task)
npm run rollup:hourly     # hanya bagian per jam
npm run rollup:daily      # hanya bagian per hari (IP tujuan)
npm run rollup:svc        # isi/perbaiki tabel layanan (svc_hourly, svc_daily) dari flows_5m
npm run sync              # tarik identitas perangkat + nama tujuan dari MikroTik
npm run sync:router       # snapshot kesehatan/port/sesi/log router
npm run sync:router -- --dry-run   # lihat hasil tanpa menulis DB
npm run backfill          # rollup jendela lebar (sekarang: 30 hari) untuk isi ulang
npm run migrate:mysql     # salin ulang data lama (hentikan ingest dulu)
node --env-file-if-exists=.env tools\cek-kesehatan.mjs   # cek seluruh pipeline
```

## Retensi & rollup jangka panjang

Detail lengkap + contoh query ada di `RANCANGAN-RETENSI.md`. Ringkasnya:

| Tabel | Granularitas | Retensi |
|---|---|---|
| `flows_5m` | perangkat + IP tujuan + port, 5 menit | 3 hari |
| `traffic_1m` | perangkat + arah + WAN, per menit | 30 hari |
| `traffic_1h` | idem, per jam | 2 tahun |
| `traffic_daily` | idem, per hari | 10 tahun |
| `traffic_monthly` | idem, per bulan | selamanya |
| `flows_daily_ip` | perangkat + IP tujuan, per hari | 5 tahun |
| `flows_monthly_ip` | perangkat + IP tujuan, per bulan | 10 tahun |
| `svc_hourly` | port + protokol + arah, per jam | 90 hari |
| `svc_daily` | idem, per hari | 2 tahun |

Semua rollup **dihitung ulang lalu ditimpa**, jadi aman dijalankan berulang.
`flows_5m`/`flows_daily_ip` juga menyimpan baris `remote_ip='(lainnya)'` untuk
traffic di bawah ambang, supaya totalnya selalu cocok dengan `traffic_daily`.

Dua task yang perlu didaftarkan (PowerShell **Run as Administrator**):

```powershell
$base = @{ Execute = "C:\netflow-monitor\traffic-monitor-pipeline\run-rollup.cmd"; WorkingDirectory = "C:\netflow-monitor\traffic-monitor-pipeline" }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)

# tiap jam
# JANGAN pakai -RepetitionDuration ([TimeSpan]::MaxValue): Windows menolaknya
# ("duration P99999999DT23H59M59S out of range"). Tanpa parameter itu, repetisi
# berjalan tanpa batas waktu.
$triggerHourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "NetflowRollupHourly" `
  -Action (New-ScheduledTaskAction @base -Argument "--hourly") `
  -Trigger $triggerHourly -Settings $settings -User "SYSTEM" -RunLevel Highest

# tiap hari 00:15
Register-ScheduledTask -TaskName "NetflowRollupDaily" `
  -Action (New-ScheduledTaskAction @base -Argument "--daily") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "00:15") `
  -Settings $settings -User "SYSTEM" -RunLevel Highest
```

Jalankan manual kalau perlu: `Start-ScheduledTask NetflowRollupDaily`, log di
`C:\netflow-monitor\traffic-monitor-pipeline\logs\rollup.log`.

**Setelah task terdaftar, jalankan backfill sekali** (butuh PowerShell biasa, tidak
perlu admin):

```powershell
npm run backfill   # rollup.js --backfill: hitung ulang seluruh 30 hari detail
```

Tanpa backfill, jam-jam sebelum task berjalan tetap kosong walaupun
`traffic_1m` masih menyimpannya. Backfill aman diulang dan hasilnya idempoten.
Cek kesehatan datanya:

```sql
SELECT ROUND(
  (SELECT SUM(bytes) FROM traffic_1h WHERE ts_hour >= UNIX_TIMESTAMP(CURDATE()))
  / (SELECT SUM(bytes) FROM traffic_1m WHERE ts  >= UNIX_TIMESTAMP(CURDATE()))
  * 100, 1) AS persen_tercakup;   -- sehat bila ~100 (jam berjalan boleh < 100)
```

## Identitas perangkat & nama tujuan (`sync-mikrotik.js`)

NetFlow hanya membawa IP perangkat (MAC yang ikut terkirim adalah MAC interface
router, bukan MAC klien), jadi **nama tidak ada di data**. `sync-mikrotik.js`
mengambil nama dari router lewat REST API dan mengisi 3 tabel: `devices`,
`device_ip_history`, `dns_map`.

Sumber di router: `/ip dhcp-server/lease` (host-name, mac, comment), `/ip arp`,
dan `/ip dns cache`.

### Prasyarat di router (sekali saja)

Pilih salah satu jalur:

**A. HTTP polos (port 80) — tanpa sertifikat, paling mudah**

```
/ip service set www disabled=no
/ip service set www address=<IP-server>/32
```

**B. HTTPS (port 443) — butuh sertifikat**

```
/ip service set www-ssl disabled=no
/ip service set www-ssl available-from=<IP-server>/32
/ip service set www-ssl certificate=<nama-sertifikat>
```

Kalau `www-ssl` aktif tapi belum diberi sertifikat, koneksi gagal dengan
`SSL alert number 40 (handshake failure)` — bukan salah password.

Grup user `collector` harus punya policy `read,api,rest-api`. Tes dari server:

```
curl -u collector:PASSWORD http://10.33.0.254/rest/ip/dhcp-server/lease
curl -k -u collector:PASSWORD https://10.33.0.254/rest/ip/dhcp-server/lease
```

> `www` dan `www-ssl` adalah service yang sama dengan WebFig. Kalau
> `address`/`available-from` diset ke IP server, WebFig dari IP lain tidak bisa
> dibuka (Winbox/SSH tidak terpengaruh).

### Konfigurasi `.env`

```ini
MIKROTIK_HOST=10.33.0.254
MIKROTIK_PORT=80          # 80 = HTTP, 443 = HTTPS (butuh sertifikat)
MIKROTIK_USER=collector
MIKROTIK_PASSWORD=<password collector>
MIKROTIK_TLS_VERIFY=0     # 1 kalau router pakai sertifikat resmi
```

Skema ditentukan otomatis dari port (80 → `http`, 443 → `https`). Bisa dipaksa
lewat `MIKROTIK_SCHEME=http|https`.

### Menjalankan

```powershell
npm run sync                                                  # sekali jalan
node --env-file-if-exists=.env sync-mikrotik.js --selftest    # uji tanpa router
```

Uji tanpa router memakai data contoh dan **membatalkan** semua perubahan
(rollback), jadi database tidak ternoda.

### Task terjadwal (tiap 10 menit)

```powershell
Register-ScheduledTask -TaskName "NetflowSyncMikrotik" `
  -Action (New-ScheduledTaskAction -Execute "C:\netflow-monitor\traffic-monitor-pipeline\run-sync.cmd" -WorkingDirectory "C:\netflow-monitor\traffic-monitor-pipeline") `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10)) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)) `
  -User "SYSTEM" -RunLevel Highest
```

Log di `C:\netflow-monitor\traffic-monitor-pipeline\logs\sync.log`.

## Kesehatan, port, sesi & log router (`sync-router.js`)

`sync-mikrotik.js` menjawab "perangkat ini siapa". `sync-router.js` menjawab
"router-nya sehat atau tidak, siapa yang login, dan perangkat nyolok di port
mana". Semua lewat GET baca-saja:

| Endpoint | Ditulis ke | Isi |
|---|---|---|
| `/system/resource` | `router_stat` | CPU, RAM bebas/total, uptime, versi |
| `/system/health` | `router_stat` | suhu CPU & board, fan, status PSU |
| `/system/ntp/client` | `router_stat` | NTP aktif/sinkron (jam meleset = timestamp NetFlow meleset) |
| `/system/package/update` | `router_stat` | versi terpasang, channel |
| `/interface/bridge/host` | `port_map` | MAC ↔ port (mis. `ether6`) |
| `/user/active` | `router_session` | sesi Winbox/Web/API yang sedang aktif |
| `/log` | `router_log` | 1.000 baris terakhir, duplikat dibuang lewat hash |

```powershell
npm run sync:router                    # sekali jalan
npm run sync:router -- --dry-run       # tampilkan hasil, tanpa menulis DB
```

Catatan dari router saat ini: **NTP client disabled** (`status=stopped`), jadi
`ntp_synced=0`. Jam router masih benar karena timezone `Asia/Jakarta`, tetapi
sebaiknya `/system/ntp/client set enabled=yes servers=id.pool.ntp.org`.

`/system/package/update` di RouterOS 7.25.1 tidak menyediakan
`latest-version`, jadi "update tersedia" **tidak bisa** disimpulkan dari situ.

### Task terjadwal (tiap 1 menit)

```powershell
Register-ScheduledTask -TaskName "NetflowSyncRouter" `
  -Action (New-ScheduledTaskAction -Execute "C:\netflow-monitor\traffic-monitor-pipeline\run-sync-router.cmd" -WorkingDirectory "C:\netflow-monitor\traffic-monitor-pipeline") `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1)) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)) `
  -User "SYSTEM" -RunLevel Highest
```

Log di `C:\netflow-monitor\traffic-monitor-pipeline\logs\sync-router.log`. Retensi: `LOG_KEEP_DAYS`
(default 30) dan `SESSION_KEEP_DAYS` (default 180).

## Daftar lengkap Scheduled Task (untuk membangun ulang server)

Kalau PC ini diganti/diinstal ulang, empat perintah di bawah cukup untuk
mengembalikan seluruh pipeline 24/7. Semua idempoten (`-Force`), jalankan di
**PowerShell Run as Administrator**.

```powershell
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero)
$dir = "C:\netflow-monitor\traffic-monitor-pipeline"
```

Bentuk trigger tiap task berbeda, jadi didaftarkan satu per satu:

```powershell
# 1. ingest — sekali jalan, hidup terus (script-nya loop; jangan diberi repetisi)
Register-ScheduledTask -TaskName "NetflowIngest" -Force `
  -Action (New-ScheduledTaskAction -Execute "$dir\run-ingest.cmd" -WorkingDirectory $dir) `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Settings $settings -User "SYSTEM" -RunLevel Highest

# 2. rollup per jam
Register-ScheduledTask -TaskName "NetflowRollupHourly" -Force `
  -Action (New-ScheduledTaskAction -Execute "$dir\run-rollup.cmd" -Argument "--hourly" -WorkingDirectory $dir) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)) `
  -Settings $settings -User "SYSTEM" -RunLevel Highest

# 3. rollup per hari (IP tujuan), 00:15
Register-ScheduledTask -TaskName "NetflowRollupDaily" -Force `
  -Action (New-ScheduledTaskAction -Execute "$dir\run-rollup.cmd" -Argument "--daily" -WorkingDirectory $dir) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At "00:15") `
  -Settings $settings -User "SYSTEM" -RunLevel Highest

# 4. identitas perangkat + DNS, tiap 10 menit
Register-ScheduledTask -TaskName "NetflowSyncMikrotik" -Force `
  -Action (New-ScheduledTaskAction -Execute "$dir\run-sync.cmd" -WorkingDirectory $dir) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10)) `
  -Settings $settings -User "SYSTEM" -RunLevel Highest

# 5. kesehatan/port/sesi/log router, tiap 1 menit
Register-ScheduledTask -TaskName "NetflowSyncRouter" -Force `
  -Action (New-ScheduledTaskAction -Execute "$dir\run-sync-router.cmd" -WorkingDirectory $dir) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1)) `
  -Settings $settings -User "SYSTEM" -RunLevel Highest
```

Verifikasi (PowerShell biasa sudah cukup untuk membaca log):

```powershell
Get-ChildItem C:\netflow-monitor\traffic-monitor-pipeline\logs | Select-Object Name,Length,LastWriteTime
node --env-file-if-exists=.env tools\cek-kesehatan.mjs    # target: semua LULUS
```

Catatan yang sudah terbukti menggigit:

- `-RepetitionDuration ([TimeSpan]::MaxValue)` **ditolak** build Windows ini
  (`duration P99999999DT23H59M59S` out of range). Hilangkan parameternya; tanpa
  duration repetisi memang tak berujung.
- Task ber-`-User SYSTEM` **tidak bisa dibaca** (`Get-ScheduledTask`,
  `Get-ScheduledTaskInfo`) dari PowerShell non-admin — itu normal, bukan tanda
  task hilang. Pakai log file untuk memantau.
- `run-ingest.cmd` membunuh `goflow2` yatim sebelum start; kalau ingest
  di-restart manual saat MySQL mati, UDP 2055 bisa tertahan dan start
  berikutnya gagal — log akan menulis `[goflow2] ... address already in use`.

## Akses dari PC lain

MySQL sudah listen di `0.0.0.0:3306` dan user `netflow` boleh connect dari host
mana pun (`%`). Dari PC lain:

```powershell
# tes koneksi (butuh mysql client)
mysql -h 10.33.6.11 -P 3306 -u netflow -p netflow_monitor -e "SELECT COUNT(*) FROM traffic_1m;"

# atau dari Node/Next.js, salin folder ini dan set DB_HOST=10.33.6.11 di .env
npm run report 60
```

Untuk aplikasi web, **jangan pakai user `netflow`** (itu user tulis milik ingest).
Sudah dibuat user khusus:

| User | Host | Hak |
|---|---|---|
| `netflow_app` | `localhost`, `10.33.%` | `SELECT` seluruh `netflow_monitor` + `UPDATE (nama,pemilik,grup)` di `devices` |

Kredensialnya ada di `.env` (`APP_DB_USER` / `APP_DB_PASSWORD`). Sudah diuji:
`SELECT` jalan, `INSERT`/`DELETE` ditolak (`ER_TABLEACCESS_DENIED_ERROR`).
Kalau aplikasi berjalan di luar `10.33.x.x`, buat user tambahan dengan pola host
yang sesuai — jangan melebarkan ke `%` tanpa perlu.

### 1. Buka firewall (perlu PowerShell **Run as Administrator**)

Saat migrasi ini dijalankan, sesi tidak punya hak admin, jadi aturan firewall
belum ditambahkan. Tanpa ini koneksi dari PC lain akan timeout:

```powershell
New-NetFirewallRule -DisplayName "MySQL 3306 (LAN)" -Direction Inbound `
  -Protocol TCP -LocalPort 3306 -Action Allow -Profile Private
```

Kalau jaringanmu terdeteksi "Public", ganti `-Profile Private` jadi
`-Profile Any`, atau ubah jaringan ke Private di Windows.

### 2. Batasi ke subnet kantor (opsional, disarankan)

```sql
GRANT ALL PRIVILEGES ON netflow_monitor.* TO 'netflow'@'10.33.%' IDENTIFIED BY '<password>';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'netflow'@'%';
DROP USER 'netflow'@'%';
```

## Catatan operasional

- **MySQL di sini bukan Windows Service.** `mysqld` dijalankan manual oleh
  Laragon, jadi setelah PC reboot jalankan Laragon → Start All, atau install
  sebagai service permanen:
  `C:\laragon\bin\mysql\mysql-8.0.30-winx64\bin\mysqld --install MySQL80`
  (perlu admin, lalu `Start-Service MySQL80`).
- Retensi diatur di `.env`: `KEEP_DETAIL_DAYS=3`, `KEEP_MINUTE_DAYS=30`,
  `KEEP_HOUR_DAYS=730`, `KEEP_DAILY_IP_DAYS=1825`. Tabel harian/bulanan
  disimpan selamanya. Ambang IP tujuan: `IP_DAILY_MIN_BYTES` (20 MB/hari) dan
  `IP_MONTHLY_MIN_BYTES` (50 MB/bulan).
- Pembersihan data lama dilakukan `rollup.js` (semua tingkat) dan `ingest.js`
  (khusus `flows_5m` + `traffic_1m`, sebagai jaring pengaman kalau task rollup
  belum terdaftar). Dua-duanya idempoten, tidak masalah berjalan bersamaan.
- Retensi `KEEP_MINUTE_DAYS` dibaca **hanya saat ingest start**; perubahan angka
  di `.env` baru berlaku setelah task `NetflowIngest` di-restart.
- **Zona waktu sudah diperbaiki.** `db.js` memakai `timezone: 'local'`, jadi
  `devices.last_seen` (DATETIME) sekarang sama dengan `NOW()` WIB, bukan 7 jam
  lebih awal. Kolom baru `devices.last_seen_ts` (epoch) dipakai untuk semua query
  "online" agar bebas zona waktu: `WHERE last_seen_ts >= UNIX_TIMESTAMP() - 1800`.
  Migrasi kolom dijalankan otomatis oleh `ensureSchema()` saat script start.
- **`ingest_status`** diisi `ingest.js` tiap flush (1 menit). Isinya `last_flow_ts`,
  `last_flush_at`, jumlah baris/flow terakhir, dan total baris sejak start.
  Dashboard cukup membaca satu baris (`id=1`) untuk tahu data masih segar.
  Heartbeat baru aktif setelah `NetflowIngest` di-restart.
- Tabel operasional lain (`router_stat`, `port_map`, `router_session`,
  `router_log`, `isp_map`) hanya terisi kalau `sync-router.js` dijadwalkan.
- Ingest sekarang **60 detik terakhir data bisa hilang** kalau proses dibunuh
  paksa (`Stop-Process`), karena agregasi masih di memori. Ctrl+C tetap
  menyimpan semuanya.
- Skema tidak butuh `fs.mkdirSync` lagi; folder `data/` hanya berisi cadangan
  SQLite.

## Kalau mau balik ke SQLite

Data lama masih utuh di `data/flows.db`. Kode versi SQLite bisa dibuatkan lagi
kalau diperlukan — cukup minta, `better-sqlite3` masih terpasang sebagai
devDependency.