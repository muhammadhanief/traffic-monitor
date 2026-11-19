'use strict';

// auth.js — verifikasi Bearer token dari SSO BPS (accounts.bps.go.id).
//
// Pembagian tugas:
//   - Frontend Next.js di cPanel BPS yang menjalankan alur OIDC
//     (Authorization Code + client secret), lalu menaruh access token
//     di cookie/sessionStorage.
//   - Browser memanggil API ini dengan header: Authorization: Bearer <token>
//   - API hanya MEMVERIFIKASI tanda tangan + issuer + audience. Tidak ada
//     login, tidak ada cookie, tidak ada database sesi.
//
// Selama SSO_ISSUER/JWKS belum diisi (atau AUTH_DISABLED=1) API berjalan
// tanpa autentikasi — khusus untuk pengembangan lokal.

const { createRemoteJWKSet, jwtVerify } = require('jose');
const { ApiError } = require('./util');

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

const AUTH_DISABLED = truthy(process.env.AUTH_DISABLED);
const ISSUER = (process.env.SSO_ISSUER || '').trim();
const AUDIENCE = (process.env.SSO_AUDIENCE || '').trim();
const JWKS_URI = (process.env.SSO_JWKS_URI || '').trim();
const ADMIN_ROLES = (process.env.SSO_ADMIN_ROLES || 'admin,superadmin')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Autentikasi dianggap aktif hanya bila seluruh konfigurasi tersedia.
const AUTH_ENABLED = !AUTH_DISABLED && !!ISSUER && !!JWKS_URI;

let jwks = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URI), {
      cacheMaxAge: 10 * 60 * 1000,
      timeoutDuration: 8000,
    });
  }
  return jwks;
}

/** Ubah klaim token menjadi objek user ringkas. */
function userFromClaims(payload) {
  const realmRoles = payload?.realm_access?.roles || [];
  const resourceRoles = Object.values(payload?.resource_access || {})
    .flatMap((r) => r?.roles || []);
  const direct = Array.isArray(payload?.roles) ? payload.roles : [];
  const roles = [...new Set([...realmRoles, ...resourceRoles, ...direct])].map((r) => String(r).toLowerCase());

  return {
    sub: payload?.sub || null,
    username: payload?.preferred_username || payload?.username || null,
    name: payload?.name || null,
    email: payload?.email || null,
    roles,
    isAdmin: roles.some((r) => ADMIN_ROLES.includes(r)),
  };
}

/**
 * Middleware: isi req.user.
 * - Bila autentikasi mati  -> req.user = user "pengembangan".
 * - Bila hidup tanpa token -> 401.
 */
async function authenticate(req, _res, next) {
  if (!AUTH_ENABLED) {
    req.user = { sub: 'dev', username: 'dev', name: 'Mode pengembangan', roles: ['admin'], isAdmin: true, authDisabled: true };
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Token tidak ada. Kirim header Authorization: Bearer <token>.'));
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: ISSUER || undefined,
      audience: AUDIENCE || undefined,
      clockTolerance: 30,
    });
    req.user = userFromClaims(payload);
    return next();
  } catch (err) {
    const msg = err?.code === 'ERR_JWT_EXPIRED'
      ? 'Token kedaluwarsa, silakan login ulang.'
      : 'Token tidak sah.';
    return next(new ApiError(401, 'UNAUTHORIZED', msg, err?.code));
  }
}

/** Middleware: hanya untuk endpoint yang mengubah konfigurasi. */
function requireAdmin(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHORIZED', 'Belum diautentikasi.'));
  if (!req.user.isAdmin) {
    return next(new ApiError(403, 'FORBIDDEN', 'Peran Anda tidak boleh mengubah konfigurasi.'));
  }
  return next();
}

module.exports = {
  authenticate,
  requireAdmin,
  AUTH_ENABLED,
  AUTH_DISABLED,
  info: { authEnabled: AUTH_ENABLED, issuer: ISSUER || null, audience: AUDIENCE || null, adminRoles: ADMIN_ROLES },
};
