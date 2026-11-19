// mt-rest.js — klien REST RouterOS bersama untuk sync-mikrotik.js &
// sync-router.js. Hanya GET (baca-saja); router tidak pernah diubah.
//
// Skema ditentukan dari port: 80 = HTTP polos (service 'www'), 443 = HTTPS
// (service 'www-ssl', wajib punya sertifikat). Bisa dipaksa MIKROTIK_SCHEME.
// Alasan detail: DOKUMENTASI-API-MIKROTIK.md bagian 2.

import http from 'node:http';
import https from 'node:https';

export const CFG = {
  host: process.env.MIKROTIK_HOST || '',
  port: Number(process.env.MIKROTIK_PORT || 443),
  user: process.env.MIKROTIK_USER || '',
  password: process.env.MIKROTIK_PASSWORD || '',
  // 1 = wajibkan sertifikat terpercaya, 0 = terima sertifikat self-signed
  verifyTls: String(process.env.MIKROTIK_TLS_VERIFY || '0') === '1',
  timeoutMs: Number(process.env.MIKROTIK_TIMEOUT_MS || 15000),
  scheme: (process.env.MIKROTIK_SCHEME || (Number(process.env.MIKROTIK_PORT || 443) === 80 ? 'http' : 'https')).toLowerCase(),
};

const agent =
  CFG.scheme === 'https'
    ? new https.Agent({ rejectUnauthorized: CFG.verifyTls, keepAlive: true })
    : new http.Agent({ keepAlive: true });
const transport = CFG.scheme === 'https' ? https : http;
const authHeader = 'Basic ' + Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');

export function mtGet(path) {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: CFG.host,
        port: CFG.port,
        path: `/rest${path}`,
        method: 'GET',
        headers: { Authorization: authHeader, Accept: 'application/json' },
        agent,
        timeout: CFG.timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 401)
            return reject(new Error('401 Unauthorized — cek MIKROTIK_USER / MIKROTIK_PASSWORD'));
          if (res.statusCode === 403)
            return reject(new Error('403 Forbidden — grup user kurang policy rest-api'));
          if (res.statusCode !== 200)
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('balasan bukan JSON: ' + body.slice(0, 200)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}