// tools/probe-mikrotik-api.mjs
//
// Memeriksa endpoint REST RouterOS yang dipakai/dipertimbangkan aplikasi ini,
// lalu mencetak tabel Markdown siap tempel ke DOKUMENTASI-API-MIKROTIK.md.
//
// Pemakaian:
//   node --env-file-if-exists=.env tools/probe-mikrotik-api.mjs
//   node --env-file-if-exists=.env tools/probe-mikrotik-api.mjs --json > hasil.json
//
// Membaca MIKROTIK_HOST / MIKROTIK_PORT / MIKROTIK_USER / MIKROTIK_PASSWORD
// dari environment. Hanya GET (baca-saja), tidak mengubah apa pun di router.
//
// Catatan: jumlah baris & waktu respons berubah-ubah; jalankan ulang untuk
// memperbarui angka di dokumen.

import http from 'node:http';

const CFG = {
  host: process.env.MIKROTIK_HOST || '10.33.0.254',
  port: Number(process.env.MIKROTIK_PORT || 80),
  user: process.env.MIKROTIK_USER || '',
  password: process.env.MIKROTIK_PASSWORD || '',
};

const AUTH = 'Basic ' + Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');

// ===== daftar endpoint yang diperiksa =====
const ENDPOINTS = [
  // system
  'system/resource', 'system/identity', 'system/clock', 'system/routerboard', 'system/health',
  'system/package', 'system/package/update', 'system/license', 'system/note', 'system/watchdog',
  'system/ntp/client', 'system/ntp/server', 'system/logging', 'system/logging/action',
  'system/scheduler', 'system/script', 'system/script/environment', 'system/console',
  'system/device-mode', 'system/leds', 'system/reboot', 'system/shutdown', 'system/backup',
  'system/snmp',
  // interface
  'interface', 'interface/ethernet', 'interface/ethernet/switch', 'interface/ethernet/poe',
  'interface/bridge', 'interface/bridge/port', 'interface/bridge/host', 'interface/bridge/vlan',
  'interface/bridge/settings', 'interface/list', 'interface/list/member', 'interface/vlan',
  'interface/wireguard', 'interface/wireguard/peers', 'interface/pppoe-client', 'interface/lte',
  'interface/wifi', 'interface/wifi/registration-table', 'interface/l2tp-server',
  'interface/ovpn-server', 'interface/sstp-server', 'interface/pptp-server',
  // ip
  'ip/address', 'ip/arp', 'ip/route', 'ip/service', 'ip/neighbor', 'ip/pool', 'ip/settings',
  'ip/cloud', 'ip/cloud/ddns-update', 'ip/vrf', 'ip/socks', 'ip/socksify', 'ip/smb',
  'ip/proxy', 'ip/upnp', 'ip/tftp', 'ip/ssh', 'ip/traffic-flow', 'ip/nat-pmp', 'ip/media',
  'ip/packing', 'ip/kid-control', 'ip/reverse-proxy',
  // dhcp
  'ip/dhcp-server', 'ip/dhcp-server/lease', 'ip/dhcp-server/network', 'ip/dhcp-server/config',
  'ip/dhcp-server/option', 'ip/dhcp-server/option-set', 'ip/dhcp-server/alert', 'ip/dhcp-client',
  'ip/dhcp-relay',
  // dns
  'ip/dns', 'ip/dns/cache', 'ip/dns/static', 'ip/dns/forwarders',
  // firewall
  'ip/firewall/filter', 'ip/firewall/nat', 'ip/firewall/mangle', 'ip/firewall/raw',
  'ip/firewall/address-list', 'ip/firewall/service-port', 'ip/firewall/connection',
  'ip/firewall/connection/tracking',
  // hotspot, ipsec
  'ip/hotspot', 'ip/hotspot/active', 'ip/hotspot/host', 'ip/hotspot/user',
  'ip/hotspot/user/profile', 'ip/hotspot/profile', 'ip/hotspot/walled-garden',
  'ip/ipsec/active-peers', 'ip/ipsec/peer', 'ip/ipsec/policy', 'ip/ipsec/profile',
  'ip/ipsec/identity', 'ip/ipsec/proposal', 'ip/ipsec/key',
  // ipv6
  'ipv6/address', 'ipv6/route', 'ipv6/neighbor', 'ipv6/dhcp-client', 'ipv6/pool',
  'ipv6/firewall/filter', 'ipv6/firewall/nat', 'ipv6/settings',
  // queue, ppp
  'queue/simple', 'queue/tree', 'queue/type', 'queue/interface',
  'ppp/active', 'ppp/secret', 'ppp/profile', 'ppp/aaa', 'ppp/l2tp-secret',
  // routing
  'routing/table', 'routing/route', 'routing/rule', 'routing/nexthop', 'routing/id',
  'routing/bfd', 'routing/bgp/connection', 'routing/bgp/session', 'routing/ospf/instance',
  'routing/ospf/area', 'routing/filter/rule', 'routing/filter/select-rule', 'routing/stats',
  // tool
  'tool/netwatch', 'tool/sniffer', 'tool/graphing', 'tool/graphing/interface',
  'tool/bandwidth-server', 'tool/sms', 'tool/romon', 'tool/mac-server', 'tool/traffic-monitor',
  'tool/traffic-generator', 'tool/profile', 'tool/ping', 'tool/torch', 'tool/traceroute',
  // user, auth
  'user', 'user/group', 'user/active', 'user/aaa', 'user/settings', 'radius', 'radius/incoming',
  // lain
  'log', 'file', 'certificate', 'certificate/settings', 'certificate/crl', 'disk', 'partitions',
  'port', 'port/remote-access', 'snmp', 'snmp/community', 'mpls/ldp', 'mpls/interface',
  'console', 'console/settings', 'task', 'terminal', 'environment', 'special-login', 'safe-mode',
];

// ===== kategori untuk pengelompokan tabel =====
const KATEGORI = [
  ['SISTEM', (p) => p.startsWith('system/')],
  ['INTERFACE', (p) => p === 'interface' || p.startsWith('interface/')],
  ['IP — DASAR', (p) => /^ip\/(address|arp|route|service|neighbor|pool|settings|cloud|vrf|socks|socksify|smb|proxy|upnp|tftp|ssh|traffic-flow|nat-pmp|media|packing|kid-control|reverse-proxy)/.test(p)],
  ['DHCP', (p) => p.startsWith('ip/dhcp-')],
  ['DNS', (p) => p.startsWith('ip/dns')],
  ['FIREWALL', (p) => p.startsWith('ip/firewall')],
  ['HOTSPOT & IPSEC', (p) => p.startsWith('ip/hotspot') || p.startsWith('ip/ipsec')],
  ['IPV6', (p) => p.startsWith('ipv6/')],
  ['QUEUE & PPP', (p) => p.startsWith('queue/') || p.startsWith('ppp/')],
  ['ROUTING', (p) => p.startsWith('routing/')],
  ['TOOLS', (p) => p.startsWith('tool/')],
  ['USER & AUTENTIKASI', (p) => p === 'user' || p.startsWith('user/') || p.startsWith('radius')],
  ['LOG, FILE & LAIN-LAIN', () => true],
];

function kategoriUntuk(path) {
  for (const [nama, cocok] of KATEGORI) if (cocok(path)) return nama;
  return 'LAIN-LAIN';
}

// ===== HTTP =====
function ambil(path) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request(
      {
        host: CFG.host,
        port: CFG.port,
        path: `/rest/${path}`,
        method: 'GET',
        headers: { Authorization: AUTH, Accept: 'application/json' },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, json, ms: Date.now() - t0 });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, json: null, ms: Date.now() - t0 }));
    req.end();
  });
}

const hasil = [];
// endpoint yang responsnya memang besar; ukur apa adanya (jangan dipotong proplist)
const TANPA_PROPLIST = new Set(['ip/firewall/connection']);

for (const path of ENDPOINTS) {
  // .proplist=.id membuat respons kecil; kalau ditolak, ambil apa adanya.
  // Endpoint "objek" (bukan tabel) tidak boleh dipotong proplist, karena
  // hasilnya jadi objek kosong — ambil penuh.
  let r = TANPA_PROPLIST.has(path)
    ? await ambil(path)
    : await ambil(`${path}?.proplist=.id`);
  if (!TANPA_PROPLIST.has(path) && (r.status !== 200 || (!Array.isArray(r.json) && !r.json?.error))) {
    r = await ambil(path);
  }

  let jenis = 'gagal';
  let isi = '-';
  let jumlah = 0;
  if (Array.isArray(r.json)) {
    jenis = 'tabel';
    jumlah = r.json.length;
    isi = `${jumlah} baris`;
  } else if (r.json && r.json.error) {
    jenis = 'tidak tersedia';
  } else if (r.json) {
    jenis = 'objek';
    jumlah = Object.keys(r.json).length;
    isi = `${jumlah} field`;
  }
  hasil.push({ path: '/' + path, jenis, isi, jumlah, ms: r.ms });
}

// ===== keluaran =====
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(hasil, null, 1));
  process.exit(0);
}

const baris = [];
const tulis = (s = '') => baris.push(s);

tulis(`Diprobes dari ${CFG.host}:${CFG.port} memakai user "${CFG.user}" pada ` +
      `${new Date().toLocaleString('id-ID')}.`);
tulis();

for (const [nama] of KATEGORI) {
  const isi = hasil.filter((h) => kategoriUntuk(h.path.slice(1)) === nama);
  if (!isi.length) continue;
  tulis(`### ${nama}`);
  tulis();
  tulis('| Endpoint | Jenis | Isi saat diprobe | ms |');
  tulis('|---|---|---|---|');
  for (const h of isi) {
    tulis(`| \`${h.path}\` | ${h.jenis} | ${h.isi} | ${h.jenis === 'tidak tersedia' ? '—' : h.ms} |`);
  }
  tulis();
}

const teks = baris.join('\n') + '\n';

// --out <file>: tulis UTF-8 langsung (menghindari redirect PowerShell yang
// bisa menghasilkan UTF-16 dan merusak file).
const iOut = process.argv.indexOf('--out');
if (iOut !== -1 && process.argv[iOut + 1]) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.argv[iOut + 1], teks, 'utf8');
  console.error(`tabel ditulis ke ${process.argv[iOut + 1]}`);
} else {
  process.stdout.write(teks);
}