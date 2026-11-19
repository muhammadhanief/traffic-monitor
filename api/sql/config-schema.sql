-- ============================================================================
--  config-schema.sql — skema KONFIGURASI aplikasi (netflow_config).
--
--  Skema ini SEPENUHNYA TERPISAH dari netflow_monitor (yang tetap read-only).
--  Isinya kecil (ratusan baris) dan boleh ditulis API.
--
--  Cara pakai:
--    node --env-file-if-exists=.env tools/init-config.js
--  atau jalankan isi berkas ini manual dengan user yang punya hak tulis.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS netflow_config
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE netflow_config;

-- ---------------------------------------------------------------------------
--  segment — memberi nama ramah pada blok /24
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS segment (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cidr        VARCHAR(32)  NOT NULL COMMENT 'mis. 10.33.10.0/24',
  nama        VARCHAR(64)  NOT NULL COMMENT 'mis. Bidang Statistik Produksi',
  keterangan  VARCHAR(255) NULL,
  aktif       TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_cidr (cidr)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
--  service_map — nama & kategori layanan dari port+protokol
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_map (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  port     INT UNSIGNED NOT NULL,
  proto    VARCHAR(8)   NOT NULL DEFAULT '*',
  nama     VARCHAR(64)  NOT NULL,
  kategori VARCHAR(32)  NULL DEFAULT 'Lainnya',
  aktif    TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_port_proto (port, proto)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Isi awal: port yang paling sering muncul di kantor.
INSERT IGNORE INTO service_map (port, proto, nama, kategori) VALUES
  (53,   'UDP', 'DNS',              'Infrastruktur'),
  (123,  'UDP', 'NTP',              'Infrastruktur'),
  (67,   'UDP', 'DHCP',             'Infrastruktur'),
  (80,   'TCP', 'HTTP',             'Web'),
  (443,  'TCP', 'HTTPS',            'Web'),
  (443,  'UDP', 'QUIC (HTTP/3)',    'Web'),
  (8080, 'TCP', 'HTTP Alternatif',  'Web'),
  (445,  'TCP', 'SMB (berbagi berkas)','Berkas lokal'),
  (139,  'TCP', 'NetBIOS',          'Berkas lokal'),
  (3389, 'TCP', 'RDP',              'Administrasi'),
  (22,   'TCP', 'SSH',              'Administrasi'),
  (8291, 'TCP', 'Winbox',           'Administrasi'),
  (25,   'TCP', 'SMTP',             'Surel'),
  (587,  'TCP', 'SMTP Submission',  'Surel'),
  (993,  'TCP', 'IMAPS',            'Surel'),
  (3478, 'UDP', 'STUN/TURN',        'Konferensi'),
  (1194, 'UDP', 'OpenVPN',          'VPN'),
  (0,    '*',   'IP-protokol langsung','Lainnya');

-- ---------------------------------------------------------------------------
--  device_alias — nama/pemilik/grup yang diisi manual per MAC
--  (dipisah dari netflow_monitor.devices yang 100% read-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_alias (
  mac        CHAR(17)     NOT NULL PRIMARY KEY COMMENT 'huruf kecil',
  nama       VARCHAR(100) NULL,
  pemilik    VARCHAR(100) NULL,
  grup       VARCHAR(50)  NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
--  alert_rule & alert_event — peringatan
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rule (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kode     VARCHAR(32)  NOT NULL,
  nama     VARCHAR(100) NOT NULL,
  tipe     VARCHAR(32)  NOT NULL COMMENT 'suhu | ingest_lag | perangkat_boros | ram | ntp',
  target   VARCHAR(64)  NULL COMMENT 'MAC / IP / port / nama layanan',
  operator VARCHAR(4)   NOT NULL DEFAULT '>',
  ambang   DECIMAL(12,2) NULL,
  satuan   VARCHAR(16)  NULL,
  aktif    TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_kode (kode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alert_event (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id INT UNSIGNED NULL,
  ts      BIGINT UNSIGNED NOT NULL,
  nilai   DECIMAL(12,2) NULL,
  pesan   VARCHAR(255) NOT NULL,
  diakui  TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_ts (ts),
  KEY idx_rule (rule_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO alert_rule (kode, nama, tipe, operator, ambang, satuan) VALUES
  ('SUHU_CPU',        'Suhu CPU terlalu tinggi',   'suhu',            '>', 65,  '°C'),
  ('INGEST_LAG',      'Ingest berhenti',           'ingest_lag',      '>', 300, 'detik'),
  ('RAM_TIPIS',       'RAM router hampir penuh',   'ram',             '<', 10,  '%'),
  ('PERANGKAT_BOROS', 'Perangkat boros bandwidth', 'perangkat_boros', '>', 5,   'GB/hari');

-- ---------------------------------------------------------------------------
--  setting — setelan bebas (kunci/nilai)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setting (
  kunci      VARCHAR(64)  NOT NULL PRIMARY KEY,
  nilai      VARCHAR(255) NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO setting (kunci, nilai) VALUES
  ('ambang_perangkat_gb', '5'),
  ('nama_aplikasi',       'NetFlow Monitor BPS Jateng'),
  ('ethernet_ports',      'ether1,ether2,ether3,ether4,ether5,ether6,ether7,ether8,sfp-sfpplus1');
