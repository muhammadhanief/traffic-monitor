# Evaluasi — sync MikroTik & kesesuaian DB terhadap PRD

Tanggal: 19 November 2026
Lingkup: implementasi `sync-mikrotik.js` + pemeriksaan apakah tabel database
sudah cukup untuk kebutuhan UI di `PRD — NetFlow Monitor (Dashboard Traffic
Jaringan Kantor).pdf`.

---

## A. Evaluasi implementasi `sync-mikrotik.js`

### Yang dibuat

| Berkas | Isi |
|---|---|
| `schema.sql` | +3 tabel: `devices`, `device_ip_history`, `dns_map` |
| `sync-mikrotik.js` | Tarik DHCP lease + ARP + cache DNS lewat REST API, tulis ke 3 tabel |
| `run-sync.cmd` | Pembungkus untuk Scheduled Task (log + rotasi) |
| `.env` / `.env.example` | `MIKROTIK_*`, `DNS_KEEP_DAYS` |
| `package.json` | script `npm run sync` |

### Cara kerja

- **`devices`** — kunci **MAC** (bukan IP), karena IP DHCP bisa berpindah.
  `hostname` diambil dari DHCP option 12, `comment` DHCP dipakai sebagai `nama`
  awal. Field manual (`nama`, `pemilik`, `grup`, `vendor`) tidak pernah ditimpa.
- **`device_ip_history`** — riwayat IP→perangkat. Baris lama ditutup (`to_ts`)
  bila IP berpindah ke MAC lain **atau** perangkat pindah IP.
- **`dns_map`** — nama domain→IP dari cache DNS router. Entri CNAME/MX/PTR/TXT
  dan data yang bukan alamat IP dibuang.

### Hasil uji

`node sync-mikrotik.js --selftest` (data contoh, semua perubahan di-rollback):

```
putaran 1: perangkat 3, riwayat baru 3, dns 3
  devices 3 · riwayat terbuka 3 · dns_map 3 · CNAME dibuang: ya
putaran 2 (perangkat pindah 10.33.11.40 -> 10.33.11.99):
  riwayat baru 2, ditutup 1 · IP lama ditutup & IP baru dibuka: ya
HASIL SELFTEST: LULUS
```

Artinya logika upsert, penutupan riwayat, dan penyaringan DNS terbukti benar.

### Yang BELUM teruji: koneksi ke router

Uji port ke gateway (`10.33.0.254`, terkonfirmasi sebagai Default Gateway):

| Port | Service | Status |
|---|---|---|
| 443 | `www-ssl` (**REST**) | **tertutup** |
| 8728 | `api` | terbuka |
| 8729 | `api-ssl` | terbuka |
| 8291 | `winbox` | terbuka |

`sync-mikrotik.js` memakai **REST lewat `www-ssl` (443)**, dan port itu masih
**tertutup** — jadi sinkron belum bisa jalan sampai diaktifkan di router:

```
/ip service set www-ssl disabled=no
```

Setelah itu isi `MIKROTIK_PASSWORD` di `.env`, lalu `npm run sync`.
Jika tetap gagal: cek bahwa grup `collector` punya policy `read,api,rest-api`
(REST balas 403 bila kurang), dan password benar (401 bila salah).

### Catatan / risiko

- **Password belum diisi** di `.env` (saya tidak menyimpannya). Wajib diisi.
- `www-ssl` = service yang sama dengan WebFig; membatasinya ke IP server akan
  memblokir WebFig HTTPS dari IP lain (Winbox/SSH tidak terpengaruh).
- `dns_map` bersifat **perkiraan**: klien yang pakai DoH/DoT atau DNS langsung
  ke 8.8.8.8 tidak lewat cache router, dan satu IP CDN bisa punya banyak nama.
- MAC di flow NetFlow = MAC interface router, **bukan** MAC klien. Karena itu
  identitas perangkat murni dari lease/ARP, bukan dari flow.

---

## B. Pemeriksaan DB terhadap PRD

### Tabel yang sudah ada (10)

`traffic_1m`, `flows_5m`, `traffic_1h`, `traffic_daily`, `traffic_monthly`,
`flows_daily_ip`, `flows_monthly_ip`, `devices`, `device_ip_history`, `dns_map`.

### Tabel yang PRD minta tapi belum ada

| Tabel (PRD §10) | Untuk halaman | Status |
|---|---|---|
| `ingest_status` (denyut + statistik) | Status Sistem, Beranda (persen "tidak-diketahui") | ❌ belum |
| `isp_map` | ISP & Failover, Pengaturan, Traffic per ISP | ❌ belum |
| `segment` | Segmen, filter segmen di Perangkat | ❌ belum |
| `service_map` | Layanan (nama & kategori dari port) | ❌ belum |
| `alert_rule`, `alert_event` | Peringatan | ❌ belum |
| `setting` | Pengaturan | ❌ belum |
| `user` | akun & peran (Fase 3) | ❌ belum |
| `device_alias` (PRD) | Perangkat | ⚠️ **digantikan** `devices` + `device_ip_history` (lebih benar) |

### Peta kebutuhan per halaman PRD

| Halaman (fase) | Sumber data | Status |
|---|---|---|
| Beranda (1) | `traffic_1m`, `traffic_1h`, top perangkat/layanan | ✅ data ada; `ingest_status` ❌ |
| Traffic (1) | `traffic_1m`, `traffic_1h`, `traffic_daily` | ✅ |
| Perangkat (1) | `traffic_*` + `devices` + `device_ip_history` | ✅ (nama perangkat baru tersedia) |
| Layanan (1) | `flows_5m.svc_port` | ⚠️ port ada, **nama/kategori** perlu `service_map` |
| Tujuan (2) | `flows_daily_ip`, `flows_monthly_ip` + `dns_map` | ✅ lebih baik dari PRD (kini ada nama domain) |
| Segmen (2) | perlu `segment` + rentang CIDR | ❌ belum |
| ISP & Failover (2) | `wan_if` ada; perlu `isp_map` + kapasitas | ⚠️ sebagian |
| Penelusuran (2) | `flows_5m` (detail) | ✅ |
| Peringatan (3) | perlu `alert_rule` + `alert_event` + denyut | ❌ belum |
| Laporan (3) | rollup harian/bulanan | ✅ |
| Status Sistem (1) | perlu `ingest_status`, ukuran DB, celah data | ❌ belum |
| Pengaturan (1–3) | `isp_map`, `service_map`, alias, `segment`, `setting`, `user` | ❌ belum |

### Beda dengan asumsi PRD (perlu keputusan / revisi PRD)

1. **Database bukan SQLite.** PRD menulis "aplikasi hanya membaca `flows.db`
   (readonly)" dan "konfigurasi di `app.db` terpisah". Kenyataannya sudah
   **MySQL**. Untuk MySQL, alasan memisah `app.db` (locking SQLite) tidak
   berlaku — tabel konfigurasi bisa dibuat di database yang sama
   (`netflow_monitor`) atau di schema `netflow_app` terpisah. **Perlu dipilih.**
2. **Retensi `traffic_1m`: PRD 90 hari, kenyataan `.env` 30 hari.** PRD bilang
   "disimpan 90 hari", kita set 30 (`KEEP_MINUTE_DAYS=30`). **Perlu disamakan.**
3. **PRD menyatakan "tidak ada nama host atau domain"** (§3 non-tujuan, §5).
   Sekarang **sudah ada**: `devices.hostname` (dari DHCP) dan `dns_map`
   (dari cache DNS). Ini mengubah dua non-tujuan PRD → PRD perlu direvisi.
4. **PRD belum menyebut rollup `traffic_daily`/`traffic_monthly`/**`flows_daily_ip`/
   `flows_monthly_ip`**.** Sudah ditambahkan demi laporan jangka panjang —
   PRD perlu ditambah agar tidak dianggap tabel asing.
5. **Pemetaan identitas.** PRD: `device_alias` manual per IP. Kenyataan:
   `devices` per MAC + nama otomatis dari DHCP, dengan override manual. Ini
   lebih tahan perpindahan IP — tapi artinya "Pengaturan > Alias perangkat"
   di PRD harus ikut berubah (kunci MAC, bukan IP).

### Kesimpulan

- **Lapisan data untuk Fase 1: ±80% siap.** Yang wajib ditambah sebelum UI
  Fase 1: `ingest_status` (denyut + statistik + atribusi "tidak-diketahui") dan
  `service_map` (nama/kategori layanan). Sisanya (`isp_map`) sudah bisa
  di-hardcode sementara.
- **Fase 2**: perlu `segment`; `dns_map` sudah menutup kebutuhan nama tujuan.
- **Fase 3**: perlu `alert_rule`, `alert_event`, `user`, `setting`.
- **Aplikasi web-nya belum dibangun** (belum ada kode Next.js) — ini pekerjaan
  terpisah, belum dimulai.

### Usulan langkah berikutnya

1. Aktifkan `www-ssl` di router, isi `MIKROTIK_PASSWORD`, jalankan `npm run sync`
   (saya belum bisa karena port 443 tertutup & password belum ada).
2. Putuskan: database konfigurasi di `netflow_monitor` atau schema `netflow_app`.
3. Putuskan: retensi `traffic_1m` 30 atau 90 hari.
4. Revisi PRD untuk poin 1–5 di atas.
5. Tambah `ingest_status` + denyut di `ingest.js`, dan `service_map`/`isp_map`.
6. Baru mulai aplikasi web (Fase 1).
