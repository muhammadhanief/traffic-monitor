-- schema.sql — skema MySQL untuk netflow-monitor.
-- Dipakai oleh ingest.js (saat start) dan migrate-to-mysql.js.
-- Database-nya sendiri dibuat terpisah (lihat README-MYSQL.md).

-- Ringkasan per menit per perangkat lokal (disimpan lama)
CREATE TABLE IF NOT EXISTS traffic_1m (
  ts       BIGINT UNSIGNED NOT NULL COMMENT 'epoch detik, awal menit',
  local_ip VARCHAR(45) CHARACTER SET ascii NOT NULL COMMENT 'IP perangkat, atau tidak-diketahui',
  dir      ENUM('up','down') NOT NULL COMMENT 'up = keluar ke WAN, down = masuk dari WAN',
  wan_if   INT UNSIGNED NOT NULL COMMENT 'ifIndex sisi WAN (petakan ke ISP di UI)',
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (ts, local_ip, dir, wan_if)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Detail tujuan per 5 menit (disimpan singkat, cepat membengkak)
CREATE TABLE IF NOT EXISTS flows_5m (
  ts        BIGINT UNSIGNED NOT NULL COMMENT 'epoch detik, awal bucket 5 menit',
  local_ip  VARCHAR(45) CHARACTER SET ascii NOT NULL,
  remote_ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  svc_port  INT UNSIGNED NOT NULL COMMENT 'port layanan di sisi remote',
  proto     VARCHAR(8) CHARACTER SET ascii NOT NULL,
  dir       ENUM('up','down') NOT NULL,
  wan_if    INT UNSIGNED NOT NULL,
  bytes     BIGINT UNSIGNED NOT NULL,
  packets   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (ts, local_ip, remote_ip, svc_port, proto, dir, wan_if),
  -- mempercepat laporan "top layanan" (filter ts, group by port)
  KEY idx_svc (ts, svc_port, proto, bytes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
--  Tabel rollup jangka panjang (diisi oleh rollup.js)
--  Aturan: semua rollup MENIMPA hasil (bukan menambah), supaya
--  idempoten dan aman dijalankan ulang.
-- ============================================================

-- Ringkasan per jam per perangkat (retensi 2 tahun)
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

-- Ringkasan per hari per perangkat (retensi 10 tahun)
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

-- Ringkasan per bulan per perangkat (disimpan selamanya)
CREATE TABLE IF NOT EXISTS traffic_monthly (
  month    DATE NOT NULL COMMENT 'selalu tanggal 1',
  local_ip VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  wan_if   INT UNSIGNED NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (month, local_ip, dir, wan_if),
  KEY idx_local (local_ip, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Detail IP tujuan per hari, hanya yang >= ambang (retensi 5 tahun).
-- Sisa traffic di bawah ambang digabung jadi baris remote_ip='(lainnya)'
-- per perangkat+arah, supaya totalnya tetap sama dengan traffic_daily.
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

-- Detail IP tujuan per bulan, diturunkan dari flows_daily_ip
-- (retensi 10 tahun). Baris di bawah ambang bulanan -> '(lainnya)'.
CREATE TABLE IF NOT EXISTS flows_monthly_ip (
  month      DATE NOT NULL COMMENT 'selalu tanggal 1',
  local_ip   VARCHAR(45) CHARACTER SET ascii NOT NULL,
  remote_ip  VARCHAR(45) CHARACTER SET ascii NOT NULL,
  dir        ENUM('up','down') NOT NULL,
  bytes      BIGINT UNSIGNED NOT NULL,
  packets    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (month, local_ip, remote_ip, dir),
  KEY idx_ip (remote_ip, month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan layanan (port tujuan + protokol) per jam, diturunkan dari
-- flows_5m. Tanpa tabel ini laporan "top layanan" harus memindai jutaan
-- baris detail tiap kali halaman dibuka (12 detik untuk 24 jam).
-- Retensi 90 hari: cukup untuk tren layanan triwulanan.
CREATE TABLE IF NOT EXISTS svc_hourly (
  ts_hour  BIGINT UNSIGNED NOT NULL COMMENT 'epoch detik, awal jam',
  svc_port INT UNSIGNED NOT NULL COMMENT 'port layanan di sisi remote',
  proto    VARCHAR(8) CHARACTER SET ascii NOT NULL,
  dir      ENUM('up','down') NOT NULL,
  bytes    BIGINT UNSIGNED NOT NULL,
  packets  BIGINT UNSIGNED NOT NULL,
  flows    INT UNSIGNED NOT NULL COMMENT 'jumlah baris flow_5m penyusun baris ini',
  PRIMARY KEY (ts_hour, svc_port, proto, dir),
  KEY idx_svc (svc_port, proto, ts_hour)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ringkasan layanan per hari, diturunkan dari svc_hourly (retensi 2 tahun).
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

-- ============================================================
--  Identitas perangkat & nama tujuan (diisi sync-mikrotik.js)
--  Sumber: DHCP lease + ARP + cache DNS router MikroTik.
--
--  Catatan penting: MAC yang ada di record NetFlow adalah MAC
--  interface ROUTER, bukan MAC perangkat klien. Jadi identitas
--  perangkat TIDAK bisa diambil dari flow, melainkan dari lease/ARP.
--  Karena IP DHCP bisa berpindah, perangkat dikunci dengan MAC.
-- ============================================================

-- Satu baris per perangkat fisik (kunci = MAC).
CREATE TABLE IF NOT EXISTS devices (
  mac       CHAR(17) NOT NULL PRIMARY KEY COMMENT 'aa:bb:cc:dd:ee:ff huruf kecil',
  hostname  VARCHAR(100) NULL COMMENT 'dari DHCP option 12 (host-name)',
  nama      VARCHAR(100) NULL COMMENT 'nama ramah, diisi manual',
  pemilik   VARCHAR(100) NULL COMMENT 'diisi manual',
  grup      VARCHAR(50)  NULL COMMENT 'bidang / ruangan',
  vendor    VARCHAR(64)  NULL COMMENT 'nama vendor dari OUI',
  last_ip   VARCHAR(45) CHARACTER SET ascii NULL COMMENT 'IP terakhir terlihat',
  -- last_seen  : waktu lokal WIB (untuk dibaca manusia)
  -- last_seen_ts: epoch detik, dipakai semua query "online" agar bebas zona waktu
  last_seen DATETIME     NULL,
  last_seen_ts BIGINT UNSIGNED NULL COMMENT 'epoch detik terakhir terlihat',
  sumber    ENUM('dhcp','arp','manual') NOT NULL DEFAULT 'dhcp',
  aktif     TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_last_ip (last_ip),
  KEY idx_aktif (aktif, last_seen),
  KEY idx_seen_ts (aktif, last_seen_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Riwayat pasangan IP -> perangkat. from_ts epoch detik.
-- to_ts NULL = pemetaan terakhir yang diketahui untuk IP itu
-- (bukan berarti perangkat sedang online).
CREATE TABLE IF NOT EXISTS device_ip_history (
  ip      VARCHAR(45) CHARACTER SET ascii NOT NULL,
  mac     CHAR(17) NOT NULL,
  from_ts BIGINT UNSIGNED NOT NULL,
  to_ts   BIGINT UNSIGNED NULL,
  PRIMARY KEY (ip, from_ts),
  KEY idx_mac (mac, from_ts),
  KEY idx_open (to_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Nama domain -> IP, snapshot dari cache DNS router.
-- Relasi banyak ke banyak: satu IP bisa punya banyak nama (CDN),
-- satu nama bisa punya banyak IP. Sifatnya perkiraan, bukan pasti.
CREATE TABLE IF NOT EXISTS dns_map (
  ip         VARCHAR(45) CHARACTER SET ascii NOT NULL,
  name       VARCHAR(255) CHARACTER SET ascii NOT NULL,
  first_seen BIGINT UNSIGNED NOT NULL,
  last_seen  BIGINT UNSIGNED NOT NULL,
  sumber     ENUM('router-cache','ad','ptr','manual') NOT NULL DEFAULT 'router-cache',
  PRIMARY KEY (ip, name),
  KEY idx_name (name),
  KEY idx_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
--  Kesehatan pipeline & router (diisi ingest.js dan sync-router.js)
--  Semua stempel waktu berupa epoch detik kecuali *_at DATETIME.
-- ============================================================

-- Satu baris (id=1): detak terakhir ingest.js. Dipakai dashboard untuk
-- memperingatkan kalau data berhenti masuk.
CREATE TABLE IF NOT EXISTS ingest_status (
  id               TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  host             VARCHAR(64)  NULL,
  last_flow_ts     BIGINT UNSIGNED NULL COMMENT 'epoch flow terakhir yang diterima',
  last_flush_at    DATETIME     NULL,
  rows_last_flush  INT UNSIGNED NULL,
  flows_last_flush INT UNSIGNED NULL,
  total_rows       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO ingest_status (id) VALUES (1);

-- Riwayat kesehatan router, satu baris per putaran sync-router.js.
-- Nama kolom mengikuti field asli RouterOS (lihat DOKUMENTASI-API-MIKROTIK.md).
CREATE TABLE IF NOT EXISTS router_stat (
  ts             BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT 'epoch detik',
  cpu_load       TINYINT UNSIGNED NULL COMMENT 'cpu-load, persen',
  free_memory    BIGINT UNSIGNED NULL,
  total_memory   BIGINT UNSIGNED NULL,
  uptime_sec     BIGINT UNSIGNED NULL,
  cpu_temp_c     DECIMAL(4,1) NULL COMMENT 'cpu-temperature',
  board_temp1_c  DECIMAL(4,1) NULL COMMENT 'board-temperature1',
  board_temp2_c  DECIMAL(4,1) NULL COMMENT 'board-temperature2',
  fan1_rpm       INT UNSIGNED NULL,
  fan2_rpm       INT UNSIGNED NULL,
  psu1_state     VARCHAR(8) NULL COMMENT 'ok / fail',
  psu2_state     VARCHAR(8) NULL,
  fan_state      VARCHAR(8) NULL,
  ntp_enabled    TINYINT(1) NULL,
  ntp_synced     TINYINT(1) NULL,
  ros_version    VARCHAR(32) NULL,
  update_channel VARCHAR(16) NULL,
  KEY idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MAC terlihat di bridge dan port asalnya (dari /interface/bridge/host).
CREATE TABLE IF NOT EXISTS port_map (
  mac          CHAR(17) NOT NULL PRIMARY KEY COMMENT 'huruf kecil',
  bridge       VARCHAR(64) NULL,
  port         VARCHAR(64) NULL COMMENT 'on-interface, mis. ether7',
  is_uplink    TINYINT(1) NOT NULL DEFAULT 0,
  is_local     TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'true = MAC router sendiri',
  first_seen   BIGINT UNSIGNED NOT NULL,
  last_seen    BIGINT UNSIGNED NOT NULL,
  KEY idx_port (port, last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sesi login yang sedang aktif di router (dari /user/active).
CREATE TABLE IF NOT EXISTS router_session (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username   VARCHAR(64) NOT NULL,
  address    VARCHAR(45) CHARACTER SET ascii NOT NULL,
  via        VARCHAR(16) NOT NULL COMMENT 'winbox/ssh/api/web...',
  grup       VARCHAR(32) NULL,
  started_at BIGINT UNSIGNED NOT NULL,
  last_seen  BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq (username, address, via, started_at),
  KEY idx_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Salinan log router (dari /log). hash mencegah duplikat antar putaran.
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

-- Nama jalur WAN. wan_if = ifIndex (2 = jalur utama pada data saat ini).
CREATE TABLE IF NOT EXISTS isp_map (
  wan_if         INT UNSIGNED NOT NULL PRIMARY KEY,
  nama           VARCHAR(64) NOT NULL,
  provider       VARCHAR(64) NULL,
  kapasitas_mbps INT UNSIGNED NULL,
  aktif          TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO isp_map (wan_if, nama, provider) VALUES
  (2, 'ISP1 Utama', 'Nexa / GMEDIA'),
  (3, 'Jalur 3', NULL),
  (8, 'Jalur 8', NULL);

-- ============================================================
--  Login aplikasi web (dibuat di sini, dipakai backend UI)
-- ============================================================
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