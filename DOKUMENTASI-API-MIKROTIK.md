# Dokumentasi API MikroTik (REST) — hasil probing langsung

Dokumen referensi untuk developer **dan AI lain** yang akan menulis kode terhadap
router kantor ini. Semua angka dan nama field di sini berasal dari respons nyata
router, bukan dari contoh di dokumentasi MikroTik.

| | |
|---|---|
| Router | `10.33.0.254` — CCR2004-16G-2S+ |
| RouterOS | 7.25.1 |
| Service dipakai | HTTP port **80** (`www`). Port 443 (`www-ssl`) **belum punya sertifikat** |
| User API | `collector`, grup `api-ro` = `read,test,api,rest-api` (tanpa `write`) |
| Pembatas akses | `address=10.33.6.11/32` (hanya server monitoring) |
| Waktu probing | 19 November 2026 (timestamp per tabel ada di bagian 4) |
| Alat probing | `tools/probe-mikrotik-api.mjs` |

> **Untuk AI:** baca bagian [2](#2-cara-akses), [5](#5-field-penting-per-endpoint),
> dan [9](#9-jebakan-yang-sudah-terbukti) sebelum menulis kode. Jangan menebak nama
> field — semuanya ada di bagian 5.

---

## 1. Ringkasan

Dari ±175 endpoint yang diperiksa:

| Jenis | Jumlah | Arti |
|---|---|---|
| `tabel` | ±118 | Mengembalikan array objek (daftar) |
| `objek` | ±40 | Mengembalikan satu objek pengaturan |
| `tidak tersedia` | ±17 | Menu tidak ada di perangkat ini, atau hanya perintah (POST) |

Hanya **satu** endpoint yang memberi volume trafik per koneksi
(`/ip/firewall/connection`), dan justru itu yang paling mahal. Volume per
perangkat/tujuan tetap diambil dari **NetFlow**, bukan dari API. Detail di
bagian [8](#8-pemetaan-ke-kebutuhan-aplikasi).

---

## 2. Cara akses

### 2.1 Prasyarat di router

```
/ip service set www disabled=no
/ip service set www address=10.33.6.11/32

/ip service set www-ssl disabled=no
/ip service set www-ssl available-from=10.33.6.11/32
/ip service set www-ssl certificate=<nama-sertifikat>    # wajib untuk 443

/user group add name=api-ro policy=read,test,api,rest-api
/user add name=collector group=api-ro password=<password> address=10.33.6.11/32
```

### 2.2 Pola URL

```
http://<host>:<port>/rest/<menu>/<submenu>[/<id>]
```

| Contoh | Arti |
|---|---|
| `GET /rest/ip/dhcp-server/lease` | daftar semua lease |
| `GET /rest/ip/dhcp-server/lease/*41` | satu objek berdasarkan `.id` |
| `GET /rest/ip/arp?address=10.33.6.11` | filter (kecocokan persis) |
| `GET /rest/ip/dhcp-server/lease?status=bound` | filter status |
| `GET /rest/ip/arp?.proplist=address,mac-address` | batasi field yang dikirim |
| `POST /rest/tool/ping` | jalankan perintah |

Tanpa `/rest` → **404**. Menu yang hanya berupa perintah → **400**
`no such command`.

### 2.3 Autentikasi

```
Authorization: Basic base64("<user>:<password>")
```

| Kode | Arti | Biasanya karena |
|---|---|---|
| `200` | Sukses | — |
| `400` | Bad Request | nama menu salah, parameter tidak dikenal |
| `401` | Unauthorized | password/username salah |
| `403` | Forbidden | policy grup kurang (mis. coba `write`) |
| `404` | Not Found | URL tanpa `/rest` |

### 2.4 Parameter query yang **sudah diverifikasi**

| Sintaks | Hasil di router ini |
|---|---|
| `?<field>=<nilai>` | ✅ bekerja (`?status=bound` → 187 dari 188 lease) |
| `?.proplist=a,b,c` | ✅ bekerja, hanya field itu yang dikirim |
| `?.proplist=.id` | ✅ sangat hemat untuk menghitung baris |
| `?.sort-by=address` | ❌ **tidak didukung** — balas 0 baris. Urutkan di aplikasi |
| `.proplist` pada endpoint **objek** | ⚠️ menghasilkan objek kosong (jangan dipakai) |
| Pagination / `limit` | ❌ tidak ada. Ambil semua, atau pakai `.proplist` |

### 2.5 Bentuk respons

```jsonc
// tabel → array
[{ ".id": "*41", "address": "10.33.11.3", "host-name": "CCR2004", ... }]

// objek pengaturan → objek tunggal
{ "enabled": "true", "interfaces": "bridge", ... }

// error
{ "detail": "unknown parameter numbers", "error": 400, "message": "Bad Request" }
```

Catatan: semua nilai dikirim sebagai **string**, termasuk angka dan boolean
(`"true"`, `"1500"`).

---

## 3. Aturan penulisan

| Aksi | Metode | Keterangan |
|---|---|---|
| Baca | `GET` | aman, dipakai aplikasi ini |
| Tambah | `PUT` | user `collector` **tidak boleh** (tanpa policy `write`) |
| Ubah | `PATCH` | idem |
| Hapus | `DELETE` | idem |
| Perintah | `POST` | mis. `ping`, `monitor-traffic`, `reboot` |

Semua operasi tulis akan dibalas **403** dengan user `api-ro`. Itu memang
disengaja: server monitoring tidak boleh mengubah konfigurasi router.

---

## 4. Inventaris endpoint

Angka "Isi saat diprobe" adalah kondisi saat pengukuran dan **akan berubah**
seiring waktu. Jalankan ulang `tools/probe-mikrotik-api.mjs` untuk memperbarui.

Diprobes dari 10.33.0.254:80 memakai user "collector" pada 19/11/2026, 13.38.32.

### SISTEM

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/system/resource` | objek | 18 field | 3 |
| `/system/identity` | objek | 1 field | 2 |
| `/system/clock` | objek | 6 field | 2 |
| `/system/routerboard` | objek | 8 field | 4 |
| `/system/health` | tabel | 8 baris | 3 |
| `/system/package` | tabel | 1 baris | 2 |
| `/system/package/update` | objek | 5 field | 2 |
| `/system/license` | objek | 3 field | 4 |
| `/system/note` | objek | 3 field | 1 |
| `/system/watchdog` | objek | 6 field | 2 |
| `/system/ntp/client` | objek | 6 field | 216 |
| `/system/ntp/server` | objek | 9 field | 1 |
| `/system/logging` | tabel | 4 baris | 1 |
| `/system/logging/action` | tabel | 4 baris | 1 |
| `/system/scheduler` | tabel | 0 baris | 1 |
| `/system/script` | tabel | 0 baris | 1 |
| `/system/script/environment` | tidak tersedia | - | — |
| `/system/console` | tabel | 1 baris | 1 |
| `/system/device-mode` | objek | 24 field | 2 |
| `/system/leds` | tabel | 5 baris | 1 |
| `/system/reboot` | tidak tersedia | - | — |
| `/system/shutdown` | tidak tersedia | - | — |
| `/system/backup` | tidak tersedia | - | — |
| `/system/snmp` | tidak tersedia | - | — |

### INTERFACE

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/interface` | tabel | 20 baris | 161 |
| `/interface/ethernet` | tabel | 18 baris | 3 |
| `/interface/ethernet/switch` | tabel | 2 baris | 1 |
| `/interface/ethernet/poe` | tidak tersedia | - | — |
| `/interface/bridge` | tabel | 1 baris | 1 |
| `/interface/bridge/port` | tabel | 4 baris | 1 |
| `/interface/bridge/host` | tabel | 204 baris | 13 |
| `/interface/bridge/vlan` | tabel | 0 baris | 1 |
| `/interface/bridge/settings` | objek | 9 field | 1 |
| `/interface/list` | tabel | 6 baris | 1 |
| `/interface/list/member` | tabel | 4 baris | 1 |
| `/interface/vlan` | tabel | 0 baris | 1 |
| `/interface/wireguard` | tabel | 0 baris | 1 |
| `/interface/wireguard/peers` | tabel | 0 baris | 1 |
| `/interface/pppoe-client` | tabel | 0 baris | 1 |
| `/interface/lte` | tabel | 0 baris | 1 |
| `/interface/wifi` | tabel | 0 baris | 1 |
| `/interface/wifi/registration-table` | tabel | 0 baris | 1 |
| `/interface/l2tp-server` | tabel | 0 baris | 1 |
| `/interface/ovpn-server` | tabel | 0 baris | 1 |
| `/interface/sstp-server` | tabel | 0 baris | 1 |
| `/interface/pptp-server` | tabel | 0 baris | 2 |

### IP — DASAR

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ip/address` | tabel | 6 baris | 2 |
| `/ip/arp` | tabel | 572 baris | 42 |
| `/ip/route` | tabel | 11 baris | 3 |
| `/ip/service` | tabel | 53 baris | 17 |
| `/ip/neighbor` | tabel | 20 baris | 3 |
| `/ip/pool` | tabel | 1 baris | 1 |
| `/ip/settings` | objek | 23 field | 1 |
| `/ip/cloud` | objek | 5 field | 1 |
| `/ip/cloud/ddns-update` | tidak tersedia | - | — |
| `/ip/vrf` | tabel | 1 baris | 1 |
| `/ip/socks` | objek | 7 field | 2 |
| `/ip/socksify` | tabel | 0 baris | 5 |
| `/ip/smb` | objek | 5 field | 3 |
| `/ip/proxy` | objek | 17 field | 1 |
| `/ip/upnp` | objek | 3 field | 1 |
| `/ip/tftp` | tabel | 0 baris | 4 |
| `/ip/ssh` | objek | 10 field | 1 |
| `/ip/traffic-flow` | objek | 8 field | 2 |
| `/ip/nat-pmp` | objek | 1 field | 1 |
| `/ip/media` | tabel | 0 baris | 1 |
| `/ip/packing` | tabel | 0 baris | 1 |
| `/ip/kid-control` | tabel | 0 baris | 4 |
| `/ip/reverse-proxy` | tabel | 0 baris | 1 |

### DHCP

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ip/dhcp-server` | tabel | 1 baris | 1 |
| `/ip/dhcp-server/lease` | tabel | 190 baris | 13 |
| `/ip/dhcp-server/network` | tabel | 1 baris | 1 |
| `/ip/dhcp-server/config` | objek | 4 field | 1 |
| `/ip/dhcp-server/option` | tabel | 0 baris | 1 |
| `/ip/dhcp-server/option-set` | tidak tersedia | - | — |
| `/ip/dhcp-server/alert` | tabel | 0 baris | 1 |
| `/ip/dhcp-client` | tabel | 1 baris | 1 |
| `/ip/dhcp-relay` | tabel | 0 baris | 1 |

### DNS

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ip/dns` | objek | 19 field | 2 |
| `/ip/dns/cache` | tabel | 3325 baris | 247 |
| `/ip/dns/static` | tabel | 2 baris | 1 |
| `/ip/dns/forwarders` | tabel | 0 baris | 1 |

### FIREWALL

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ip/firewall/filter` | tabel | 28 baris | 2 |
| `/ip/firewall/nat` | tabel | 11 baris | 1 |
| `/ip/firewall/mangle` | tabel | 1 baris | 1 |
| `/ip/firewall/raw` | tabel | 0 baris | 1 |
| `/ip/firewall/address-list` | tabel | 0 baris | 1 |
| `/ip/firewall/service-port` | tabel | 10 baris | 1 |
| `/ip/firewall/connection` | tabel | 6790 baris | 2268 |
| `/ip/firewall/connection/tracking` | objek | 23 field | 8 |

### HOTSPOT & IPSEC

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ip/hotspot` | tabel | 0 baris | 1 |
| `/ip/hotspot/active` | tabel | 0 baris | 1 |
| `/ip/hotspot/host` | tabel | 0 baris | 1 |
| `/ip/hotspot/user` | tabel | 1 baris | 1 |
| `/ip/hotspot/user/profile` | tabel | 1 baris | 1 |
| `/ip/hotspot/profile` | tabel | 1 baris | 1 |
| `/ip/hotspot/walled-garden` | tabel | 0 baris | 1 |
| `/ip/ipsec/active-peers` | tabel | 0 baris | 121 |
| `/ip/ipsec/peer` | tabel | 0 baris | 2 |
| `/ip/ipsec/policy` | tabel | 1 baris | 1 |
| `/ip/ipsec/profile` | tabel | 1 baris | 2 |
| `/ip/ipsec/identity` | tabel | 0 baris | 1 |
| `/ip/ipsec/proposal` | tabel | 1 baris | 2 |
| `/ip/ipsec/key` | tidak tersedia | - | — |

### IPV6

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/ipv6/address` | tabel | 6 baris | 280 |
| `/ipv6/route` | tabel | 6 baris | 4 |
| `/ipv6/neighbor` | tabel | 476 baris | 673 |
| `/ipv6/dhcp-client` | tabel | 0 baris | 1 |
| `/ipv6/pool` | tabel | 0 baris | 5 |
| `/ipv6/firewall/filter` | tabel | 0 baris | 291 |
| `/ipv6/firewall/nat` | tabel | 0 baris | 353 |
| `/ipv6/settings` | objek | 19 field | 407 |

### QUEUE & PPP

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/queue/simple` | tabel | 0 baris | 203 |
| `/queue/tree` | tabel | 0 baris | 252 |
| `/queue/type` | tabel | 10 baris | 103 |
| `/queue/interface` | tabel | 20 baris | 198 |
| `/ppp/active` | tabel | 0 baris | 7 |
| `/ppp/secret` | tabel | 0 baris | 2 |
| `/ppp/profile` | tabel | 2 baris | 1 |
| `/ppp/aaa` | objek | 5 field | 3 |
| `/ppp/l2tp-secret` | tabel | 0 baris | 3 |

### ROUTING

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/routing/table` | tabel | 1 baris | 2 |
| `/routing/route` | tabel | 23 baris | 4 |
| `/routing/rule` | tabel | 0 baris | 2 |
| `/routing/nexthop` | tabel | 17 baris | 4 |
| `/routing/id` | tabel | 1 baris | 2 |
| `/routing/bfd` | tidak tersedia | - | — |
| `/routing/bgp/connection` | tabel | 0 baris | 2 |
| `/routing/bgp/session` | tabel | 0 baris | 2 |
| `/routing/ospf/instance` | tabel | 0 baris | 1 |
| `/routing/ospf/area` | tabel | 0 baris | 1 |
| `/routing/filter/rule` | tabel | 0 baris | 2 |
| `/routing/filter/select-rule` | tabel | 0 baris | 2 |
| `/routing/stats` | tidak tersedia | - | — |

### TOOLS

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/tool/netwatch` | tabel | 0 baris | 5 |
| `/tool/sniffer` | objek | 32 field | 2 |
| `/tool/graphing` | objek | 2 field | 2 |
| `/tool/graphing/interface` | tabel | 0 baris | 1 |
| `/tool/bandwidth-server` | objek | 6 field | 1 |
| `/tool/sms` | objek | 11 field | 280 |
| `/tool/romon` | objek | 3 field | 2 |
| `/tool/mac-server` | objek | 1 field | 1 |
| `/tool/traffic-monitor` | tabel | 0 baris | 289 |
| `/tool/traffic-generator` | objek | 7 field | 1 |
| `/tool/profile` | tidak tersedia | - | — |
| `/tool/ping` | tidak tersedia | - | — |
| `/tool/torch` | tidak tersedia | - | — |
| `/tool/traceroute` | tidak tersedia | - | — |

### USER & AUTENTIKASI

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/user` | tabel | 2 baris | 1 |
| `/user/group` | tabel | 4 baris | 1 |
| `/user/active` | tabel | 6 baris | 1 |
| `/user/aaa` | objek | 5 field | 1 |
| `/user/settings` | objek | 2 field | 1 |
| `/radius` | tabel | 0 baris | 7 |
| `/radius/incoming` | objek | 3 field | 1 |

### LOG, FILE & LAIN-LAIN

| Endpoint | Jenis | Isi saat diprobe | ms |
|---|---|---|---|
| `/log` | tabel | 1000 baris | 32 |
| `/file` | tabel | 6 baris | 4 |
| `/certificate` | tabel | 0 baris | 1 |
| `/certificate/settings` | objek | 5 field | 1 |
| `/certificate/crl` | tabel | 0 baris | 1 |
| `/disk` | tabel | 0 baris | 0 |
| `/partitions` | tabel | 1 baris | 0 |
| `/port` | tabel | 1 baris | 5 |
| `/port/remote-access` | tabel | 0 baris | 5 |
| `/snmp` | objek | 11 field | 2 |
| `/snmp/community` | tabel | 1 baris | 2 |
| `/mpls/ldp` | tabel | 0 baris | 1 |
| `/mpls/interface` | tabel | 0 baris | 3 |
| `/console` | tidak tersedia | - | — |
| `/console/settings` | objek | 3 field | 2 |
| `/task` | tabel | 0 baris | 2 |
| `/terminal` | tidak tersedia | - | — |
| `/environment` | tabel | 0 baris | 1 |
| `/special-login` | tabel | 0 baris | 1 |
| `/safe-mode` | objek | 2 field | 2 |

---

## 5. Field penting per endpoint

Hanya endpoint yang relevan untuk aplikasi ini. Nama field **persis** seperti
yang dikirim router (ingat: semua nilai string).

### `/ip/dhcp-server/lease` — sumber nama perangkat

| Field | Contoh | Arti |
|---|---|---|
| `address` | `10.33.11.3` | IP yang diberikan |
| `mac-address` | `D0:EA:11:BA:49:60` | MAC klien (huruf besar) |
| `host-name` | `CCR2004` | nama komputer (DHCP option 12) — bisa kosong |
| `status` | `bound`, `waiting` | hanya `bound` yang aktif |
| `expires-after` | `27m12s` | sisa waktu lease |
| `last-seen` | `2m48s` | terakhir terlihat |
| `age` | `17h32m49s` | umur lease |
| `server` | `dhcp-lan` | nama DHCP server |
| `dynamic` | `true` | lease dinamis / statis |
| `blocked` | `false` | diblokir admin |

> ⚠️ Di RouterOS 7.25.1 lease **tidak punya field `comment`**. Jangan andalkan
> komentar lease sebagai sumber nama.

### `/ip/arp` — IP ↔ MAC (termasuk perangkat IP statis)

| Field | Arti |
|---|---|
| `address` | IP |
| `mac-address` | MAC |
| `interface` | interface tempat terlihat |
| `dynamic` | `true` = hasil pembelajaran, `false` = statis |
| `dhcp` | `true` = IP dari DHCP |
| `complete`, `invalid`, `published`, `status`, `vrf` | status entri |

### `/ip/dns/cache` — sumber nama domain

| Field | Arti |
|---|---|
| `name` | nama domain (`gnar.grammarly.com`) |
| `data` | IP atau nama target (untuk CNAME) |
| `type` | `A`, `AAAA`, `CNAME`, … — **hanya `A`/`AAAA` yang berguna** |
| `ttl` | sisa TTL |
| `static` | `true` jika dari `/ip dns static` |

### `/interface` — counter trafik (kumulatif sejak boot)

| Field | Arti |
|---|---|
| `name`, `type`, `default-name` | identitas interface |
| `running` | link aktif |
| `rx-byte`, `tx-byte` | total byte (counter, bukan laju) |
| `rx-packet`, `tx-packet` | total paket |
| `fp-rx-byte`, `fp-tx-byte` | counter jalur fast-path |
| `last-link-up-time`, `link-downs` | riwayat link |

Laju per detik **tidak** ada di sini — pakai `POST /interface/monitor-traffic`.

### `/ip/service` — daftar layanan router

| Field | Arti |
|---|---|
| `name` | `www`, `www-ssl`, `ssh`, `winbox`, `api`, `api-ssl`, … |
| `port` | port listen |
| `disabled` | `true`/`false` |
| `available-from` | pembatas IP (⚠️ **bukan** `address`) |
| `proto` | `tcp` |

### `/user/active` — sesi login yang sedang berjalan

| Field | Arti |
|---|---|
| `name` | user |
| `address` | IP asal |
| `via` | `winbox`, `ssh`, `api`, `web` |
| `when` | kapan mulai |
| `group` | grup user |

### `/system/resource` — kesehatan router

`cpu-load`, `cpu-count`, `cpu-frequency`, `free-memory`, `total-memory`,
`free-hdd-space`, `total-hdd-space`, `uptime`, `version`, `board-name`,
`architecture-name`, `build-time`.

### `/ip/traffic-flow` — konfirmasi setelan NetFlow

`enabled`, `interfaces`, `cache-entries`, `active-flow-timeout`,
`inactive-flow-timeout`, `packet-sampling`, `sampling-interval`,
`sampling-space`.

Nilai di router ini: `enabled=true`, `interfaces=bridge`,
`inactive-flow-timeout=15s`, `packet-sampling=false` (tanpa sampling → akurat).

### `/ip/firewall/filter` — aturan + counter

`chain`, `action`, `bytes`, `packets`, `protocol`, `dst-address`, `dst-port`,
`comment`, `disabled`, `log`. Counter `bytes` kumulatif sejak reset/boot.

### `/ip/firewall/connection` — koneksi aktif (mahal)

| Field | Arti |
|---|---|
| `src-address`, `src-port` | sisi asal |
| `dst-address`, `dst-port` | sisi tujuan |
| `protocol` | `tcp` / `udp` / `icmp` |
| `orig-bytes`, `repl-bytes` | byte per arah, **kumulatif per koneksi** |
| `orig-packets`, `repl-packets` | paket per arah |
| `orig-rate`, `repl-rate` | laju saat ini |
| `tcp-state`, `timeout` | status & sisa umur entri |
| `connection-mark`, `dstnat`, `srcnat` | informasi NAT/mangle |
| `fasttrack` | `true` = lewat fast-path |
| `orig-fasttrack-bytes`, `repl-fasttrack-bytes` | counter fast-path |

Biaya nyata: **6.000–7.500 entri, 4,1–4,6 MB, 2–9,7 detik**. Jangan dipoll
rutin (lihat bagian 9).

### `/interface/bridge/host` — MAC per port bridge

`mac-address`, `interface` (interface logis), `on-interface` (port fisik),
`bridge`, `dynamic`, `local`, `external`. Berguna kalau ARP tidak lengkap.

### `/log` — 1.000 baris terakhir

`time`, `topics`, `message`, `extra-info`.

### `/system/health` — sensor

8 baris `{name, value, type}`: suhu CPU/board, tegangan PSU, kecepatan fan.

### `/ip/route` — tabel routing

`dst-address`, `gateway`, `distance`, `active`, `static`, `dynamic`,
`routing-table`, `scope`, `target-scope`, `immediate-gw`, `check-gateway`.

---

## 6. Perintah (POST) — sudah diuji

| Endpoint | Body | Hasil |
|---|---|---|
| `POST /tool/ping` | `{"address":"10.33.0.254","count":1}` | array per paket: `avg-rtt`, `min-rtt`, `max-rtt`, `packet-loss`, `sent`, `received`, `ttl` |
| `POST /interface/monitor-traffic` | `{"interface":"bridge","once":"true"}` | `rx-bits-per-second`, `tx-bits-per-second`, `rx-packets-per-second`, `rx-drops-per-second`, `fp-rx-bits-per-second` |
| `POST /interface/ethernet/monitor` | `{"numbers":"ether1","once":"true"}` | `status`, `rate` (`1Gbps`), `full-duplex`, `auto-negotiation`, `advertising` |
| `POST /interface/print` | `{}` | sama dengan `GET /interface` |
| `POST /tool/torch` | `{"interface":"bridge","duration":1}` | ❌ `500 not enough permissions` dengan user `api-ro` (butuh policy lebih) |

Perbedaan parameter yang mudah salah:

- `monitor-traffic` memakai **`interface`**, bukan `numbers` (kalau salah:
  `400 unknown parameter numbers`).
- `ethernet/monitor` justru memakai **`numbers`**.

Perintah berbahaya (`/system/reboot`, `/system/shutdown`) jangan pernah dipanggil
dari aplikasi monitoring.

---

## 7. Yang **tidak tersedia** di router ini

Terdeteksi `400 no such command or directory` saat diprobe:

```
/system/script/environment   /system/reboot        /system/shutdown
/system/backup               /system/snmp          /interface/ethernet/poe
/ip/cloud/ddns-update        /ip/dhcp-server/option-set   /ip/ipsec/key
/routing/bfd                 /routing/stats        /tool/profile
/tool/ping                   /tool/torch           /tool/traceroute
/console                     /terminal
```

Sebabnya berbeda-beda:

- `reboot`, `shutdown`, `ping`, `torch`, `traceroute`, `profile` = **perintah**,
  bukan tabel → harus `POST` (dan sebagian butuh policy lebih).
- `poe`, `backup`, `ipsec/key` = paket/fitur tidak terpasang di perangkat ini.
- **`/ip/accounting` tidak ada di RouterOS v7** — sudah dihapus. Tidak ada
  pengganti bawaan untuk akuntansi per-IP.

Selain itu, menu di bawah ini ada tetapi **kosong** (0 baris) di router ini:
`/queue/simple`, `/queue/tree`, `/ppp/active`, `/ppp/secret`,
`/ip/firewall/address-list`, `/ip/hotspot/active`, `/interface/wireguard/peers`,
`/radius`, `/tool/netwatch`, `/system/scheduler`, `/system/script`,
`/ip/hotspot`, `/ip/tftp`, `/ipv6/dhcp-client`, `/ipv6/firewall/filter`,
`/routing/bgp/connection`, `/routing/ospf/instance`, `/mpls/ldp`, `/disk`.

---

## 8. Pemetaan ke kebutuhan aplikasi

| Kebutuhan aplikasi | Endpoint | Biaya | Frekuensi disarankan |
|---|---|---|---|
| Nama perangkat / desktop | `/ip/dhcp-server/lease` | 13 ms, 193 baris | 2–10 menit |
| Nama domain tujuan | `/ip/dns/cache` | ±200 ms, ±3.200 baris | 5–10 menit |
| IP ↔ MAC (perangkat statis) | `/ip/arp` | ±500 ms, ±570 baris | 5–10 menit |
| Siapa online sekarang | `/ip/dhcp-server/lease?status=bound` | 13 ms | 30–60 detik |
| Sesi login admin | `/user/active` | 2 ms | 1 menit (audit) |
| Kesehatan router | `/system/resource`, `/system/health` | 2–13 ms | 1 menit |
| Laju interface saat ini | `POST /interface/monitor-traffic` | 1 ms | sesuai kebutuhan |
| Counter total interface | `/interface` | 443 ms | 5 menit |
| Statistik aturan firewall | `/ip/firewall/filter` | 7 ms | 5 menit |
| Log router | `/log` | 82 ms (1.000 baris) | 5 menit (opsional) |
| **Volume per perangkat** | ❌ tidak ada endpoint murah | — | **pakai NetFlow** |
| **Volume per IP tujuan** | ❌ tidak ada | — | **pakai NetFlow** |
| Top talker realtime | `/ip/firewall/connection` | 4 MB / 2–10 s | ❌ jangan |

**Kesimpulan arsitektur:** NetFlow = angka volume; API = identitas & status.
Jangan menggantikan NetFlow dengan polling API.

---

## 9. Jebakan yang sudah terbukti

1. **`www-ssl` tanpa sertifikat** → `SSL alert number 40 (handshake failure)`.
   Di router ini `/certificate` berisi **0 baris**. Gejalanya mirip password
   salah, tapi bukan. Pakai HTTP port 80 atau pasang sertifikat dulu.
2. **`?status=bound` mengembalikan 187 dari 188** — selalu cek `status`, jangan
   anggap semua lease aktif.
3. **`.proplist` pada endpoint objek** membuat respons jadi `{}` — kalau tool
   probe memakai `.proplist` untuk semua endpoint, angka "field" jadi 0 dan
   menyesatkan. Tool di repo ini sudah menanganinya.
4. **`.sort-by` tidak didukung** (balas 0 baris, bukan error). Urutkan di sisi
   aplikasi.
5. **Tidak ada pagination.** `/ip/dns/cache` ±3.200 baris, `/log` 1.000 baris.
   Gunakan `.proplist` dan filter.
6. **`/ip/firewall/connection` tidak stabil**: 2,1 s → 5,7 s → 9,7 s pada
   percobaan berbeda, dan pernah membalas body error (bukan array) sehingga
   pemroses gagal. Jika tetap dipakai, wajib: timeout ≥ 60 s, tangani body
   non-array, dan jangan paralel.
7. **Timeout conntrack lebih pendek dari interval polling**: `udp-timeout=30s`,
   `tcp-close-timeout=10s`, `generic-timeout=10m`. Koneksi yang buka-tutup di
   antara dua poll **hilang sama sekali** — bukan cuma telat, tapi tidak
   tercatat.
8. **`fasttrack`** melewati sebagian pencatatan; byte tercatat di field
   `*-fasttrack-bytes` yang terpisah.
9. **`/ip/accounting` tidak ada di v7.** Jangan menulis kode yang mengandalkannya.
10. **Semua nilai string.** `"true"`, `"1500"`, `"0"` — konversi eksplisit.
11. **`torch` butuh policy lebih.** Dengan `api-ro` hasilnya
    `500 not enough permissions`.
12. **User `collector` tanpa `write`.** Setiap `PUT`/`PATCH`/`DELETE` akan 403.
    Jangan menambahkan `write` hanya agar kode "jalan"; perbaiki kodenya.
13. **Angka di dokumen ini adalah snapshot.** Jumlah lease/ARP/DNS berubah tiap
    jam. Untuk laporan, hitung ulang, jangan hardcode.

---

## 10. Regenerasi & verifikasi

```powershell
cd C:\netflow-monitor\traffic-monitor-pipeline
node --env-file-if-exists=.env tools\probe-mikrotik-api.mjs --out inventaris.md
node --env-file-if-exists=.env tools\probe-mikrotik-api.mjs --json
```

Tool hanya melakukan `GET` (baca-saja). Untuk menambah endpoint yang diperiksa,
sunting array `ENDPOINTS` di file tersebut.

> ⚠️ Jangan memakai `>` untuk menangkap output di PowerShell 5.1: hasilnya
> **UTF-16**, dan kalau digabung ke Markdown akan menghasilkan ribuan byte NUL.
> Pakai `--out <file>` (ditulis UTF-8 oleh Node) atau `| Out-File -Encoding utf8`.

### Contoh kode minimal (Node.js)

```js
import http from 'node:http';

const auth = 'Basic ' + Buffer.from(
  `${process.env.MIKROTIK_USER}:${process.env.MIKROTIK_PASSWORD}`
).toString('base64');

function ambil(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: process.env.MIKROTIK_HOST,
      port: Number(process.env.MIKROTIK_PORT || 80),
      path: `/rest${path}`,
      headers: { Authorization: auth, Accept: 'application/json' },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('401 password salah'));
        if (res.statusCode === 403) return reject(new Error('403 policy kurang'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(JSON.parse(body));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const lease = await ambil('/ip/dhcp-server/lease?status=bound');
console.log(`${lease.length} perangkat online`);
```

---

## Lampiran — ringkasan menu tingkat atas

Dari `/console/inspect` (root): `certificate`, `console`, `disk`, `environment`,
`file`, `interface`, `ip`, `ipv6`, `log`, `mpls`, `partitions`, `port`, `ppp`,
`queue`, `radius`, `routing`, `safe-mode`, `snmp`, `special-login`, `system`,
`task`, `terminal`, `tool`, `user`.

`/console/inspect` bisa dipanggil lewat REST untuk menelusuri menu:

```js
POST /rest/console/inspect
{ "request": "child", "path": "ip" }
```

Balasannya `[{ "name": "address", "node-type": "dir", "type": "child" }, ...]`.
**Peringatan:** hasilnya tidak lengkap — sub-menu seperti `ip/firewall/filter`,
`ip/dhcp-server/lease`, dan `ip/dns/cache` tidak muncul. Gunakan hanya sebagai
petunjuk awal, lalu verifikasi dengan `GET`.
