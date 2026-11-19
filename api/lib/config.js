'use strict';

// config.js — lapisan konfigurasi aplikasi.
//
// Tabel konfigurasi (segment, service_map, alert_rule, alert_event, setting)
// hidup di dalam skema netflow_monitor, sama seperti app_user/app_session.
// Semuanya KECIL (ratusan baris), jadi dibaca sekaligus dan di-cache 60 detik.
//
// Prinsip: kalau tabel konfigurasi belum ada, API tetap jalan memakai nilai
// bawaan (nama dari hostname, port tanpa nama layanan). Tidak ada endpoint yang
// boleh gagal hanya karena konfigurasi kosong.
//
// Nama perangkat TIDAK melalui tabel terpisah — PATCH /api/devices/{mac}
// menulis ke devices.nama/pemilik/grup langsung (lihat routes/devices.js).

const db = require('../db');
const { cached, cacheTtl, intParam, __cacheDelete } = require('./util');

// ------------------------------------------------------------
//  Bawaan bila service_map belum diisi.
//  Hanya untuk tampilan; jangan dianggap otoritatif. Port di luar daftar
//  ini ditampilkan sebagai "port N".
// ------------------------------------------------------------
const DEFAULT_SERVICES = [
  [53, 'UDP', 'DNS', 'Infrastruktur'],
  [53, 'TCP', 'DNS', 'Infrastruktur'],
  [67, 'UDP', 'DHCP', 'Infrastruktur'],
  [123, 'UDP', 'NTP', 'Infrastruktur'],
  [137, 'UDP', 'NetBIOS', 'Berkas lokal'],
  [139, 'TCP', 'NetBIOS', 'Berkas lokal'],
  [443, 'TCP', 'HTTPS', 'Web'],
  [443, 'UDP', 'QUIC (HTTP/3)', 'Web'],
  [80, 'TCP', 'HTTP', 'Web'],
  [445, 'TCP', 'SMB (berbagi berkas)', 'Berkas lokal'],
  [25, 'TCP', 'SMTP', 'Surel'],
  [110, 'TCP', 'POP3', 'Surel'],
  [143, 'TCP', 'IMAP', 'Surel'],
  [993, 'TCP', 'IMAPS', 'Surel'],
  [587, 'TCP', 'SMTP Submission', 'Surel'],
  [22, 'TCP', 'SSH', 'Administrasi'],
  [23, 'TCP', 'Telnet', 'Administrasi'],
  [3389, 'TCP', 'RDP', 'Administrasi'],
  [8291, 'TCP', 'Winbox', 'Administrasi'],
  [3306, 'TCP', 'MySQL', 'Basis data'],
  [5432, 'TCP', 'PostgreSQL', 'Basis data'],
  [8080, 'TCP', 'HTTP Alternatif', 'Web'],
  [3478, 'UDP', 'STUN/TURN', 'Konferensi'],
  [3478, 'TCP', 'STUN/TURN', 'Konferensi'],
  [1194, 'UDP', 'OpenVPN', 'VPN'],
  [1701, 'UDP', 'L2TP', 'VPN'],
  [500, 'UDP', 'IKE', 'VPN'],
  [4500, 'UDP', 'IPSec NAT-T', 'VPN'],
  [1935, 'TCP', 'RTMP', 'Media'],
  [0, '*', 'IP-protokol langsung', 'Lainnya'],
];

const defaultServiceKey = (port, proto) => `${Number(port)}/${String(proto || '*').toUpperCase()}`;

/**
 * Muat seluruh konfigurasi sekaligus. Satu dump untuk semua tabel, di-cache.
 */
async function loadConfig() {
  return cached('cfg:all', cacheTtl(), async () => {
    const out = {
      available: false,
      segments: [],
      services: new Map(),
      serviceList: [],
      alertRules: [],
      settings: new Map(),
    };

    if (!(await db.configReady())) {
      for (const [port, proto, nama, kategori] of DEFAULT_SERVICES) {
        out.services.set(defaultServiceKey(port, proto), { port, proto, nama, kategori, sumber: 'bawaan' });
      }
      out.serviceList = [...out.services.values()];
      return out;
    }

    out.available = true;

    const safeAll = async (sql) => {
      try {
        const [rows] = await db.cq(sql);
        return rows;
      } catch (err) {
        // Tabel opsional yang belum dibuat tidak boleh menjatuhkan endpoint.
        if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')) return [];
        throw err;
      }
    };

    const [segments, services, rules, settings] = await Promise.all([
      safeAll('SELECT id, cidr, nama, keterangan, aktif FROM segment ORDER BY cidr'),
      safeAll('SELECT id, port, proto, nama, kategori, aktif FROM service_map ORDER BY port'),
      safeAll('SELECT id, kode, nama, tipe, target, operator, ambang, satuan, aktif FROM alert_rule ORDER BY id'),
      safeAll('SELECT kunci, nilai FROM setting'),
    ]);

    out.segments = segments.filter((s) => Number(s.aktif) !== 0);
    out.serviceList = services.filter((s) => Number(s.aktif) !== 0);
    for (const s of out.serviceList) {
      out.services.set(defaultServiceKey(s.port, s.proto), {
        port: Number(s.port),
        proto: s.proto,
        nama: s.nama,
        kategori: s.kategori || 'Lainnya',
        sumber: 'service_map',
      });
    }
    // Lengkapi dengan bawaan yang belum dipetakan.
    for (const [port, proto, nama, kategori] of DEFAULT_SERVICES) {
      const key = defaultServiceKey(port, proto);
      if (!out.services.has(key)) out.services.set(key, { port, proto, nama, kategori, sumber: 'bawaan' });
    }

    out.alertRules = rules;
    for (const s of settings) out.settings.set(s.kunci, s.nilai);

    return out;
  });
}

/** Buang cache konfigurasi (dipanggil setelah menulis). */
function invalidate() {
  __cacheDelete('cfg:all');
}

/** Nama layanan untuk sebuah port/protokol. */
async function serviceName(port, proto) {
  const cfg = await loadConfig();
  return cfg.services.get(defaultServiceKey(port, proto))
    || { port: Number(port), proto, nama: `port ${port}`, kategori: 'Lainnya', sumber: 'tidak diketahui' };
}

/** Nama segmen untuk sebuah IP, bila /24-nya ada di tabel segment. */
function segmentNameFor(cfg, ip) {
  if (!ip) return null;
  const prefix = ip.split('.').slice(0, 3).join('.');
  for (const s of cfg.segments) {
    const cidr = String(s.cidr || '');
    if (cidr.startsWith(prefix + '.')) return s.nama;
  }
  return null;
}

/**
 * Label perangkat. Urutannya sama dengan DOKUMENTASI-UI.md §8.2:
 *   devices.nama  →  devices.hostname  →  'Perangkat <mac>'
 * `devices.nama` diisi manual oleh PATCH /api/devices/{mac} dan, untuk pertama
 * kali, dari komentar DHCP saat sync. sync-mikrotik.js memakai
 * `nama = COALESCE(devices.nama, v.nama)` sehingga nama manual tidak tertimpa.
 */
function deviceLabel(dev) {
  const bersih = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const mac = dev && dev.mac ? dev.mac : null;
  return bersih(dev && dev.nama)
    || bersih(dev && dev.hostname)
    || (mac ? `Perangkat ${mac}` : '(tanpa nama)');
}

const alertsEnabled = () => intParam(process.env.ALERTS_ENABLED, 1, 0, 1) === 1;

module.exports = {
  loadConfig,
  invalidate,
  serviceName,
  segmentNameFor,
  deviceLabel,
  defaultServiceKey,
  DEFAULT_SERVICES,
  alertsEnabled,
};
