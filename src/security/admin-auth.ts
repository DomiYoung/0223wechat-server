import crypto from 'crypto';
import { appLogger } from '../logger.js';

type AdminTokenPayloadV1 = {
  v: 1;
  sub: number;
  username: string;
  role: string;
  displayName: string;
  iat: number; // seconds
  exp: number; // seconds
};

let warnedAboutMissingSecret = false;
let ephemeralSecret: string | null = null;
const log = appLogger.child({ module: 'admin-auth' });

function getTokenSecret(): string {
  const fromEnv = process.env.ADMIN_TOKEN_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    log.warn('ADMIN_TOKEN_SECRET is not set; admin tokens will become invalid after process restart');
  }

  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(32).toString('hex');
  return ephemeralSecret;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecodeToBuffer(b64url: string): Buffer {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hmacSha256(data: string, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(data).digest();
}

export function issueAdminToken(input: {
  id: number;
  username: string;
  role: string;
  displayName: string;
  ttlSeconds?: number;
}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, input.ttlSeconds ?? 7 * 24 * 60 * 60);

  const payload: AdminTokenPayloadV1 = {
    v: 1,
    sub: input.id,
    username: input.username,
    role: input.role,
    displayName: input.displayName,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };

  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = hmacSha256(payloadB64, getTokenSecret());
  const sigB64 = base64urlEncode(sig);

  // Keep the historical "admin-token-" prefix so clients don't need to change header logic.
  return `admin-token-v1.${payloadB64}.${sigB64}`;
}

export function verifyAdminToken(token: string): AdminTokenPayloadV1 | null {
  const trimmed = token.trim();

  // New format: admin-token-v1.<payloadB64>.<sigB64>
  if (trimmed.startsWith('admin-token-v1.')) {
    const parts = trimmed.split('.');
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1];
    const sigB64 = parts[2];

    let payloadJson = '';
    try {
      payloadJson = base64urlDecodeToBuffer(payloadB64).toString('utf8');
    } catch {
      return null;
    }

    let payload: AdminTokenPayloadV1;
    try {
      payload = JSON.parse(payloadJson) as AdminTokenPayloadV1;
    } catch {
      return null;
    }

    if (!payload || payload.v !== 1) return null;
    if (!Number.isFinite(payload.sub) || payload.sub <= 0) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= 0) return null;

    const expectedSig = hmacSha256(payloadB64, getTokenSecret());
    let givenSig: Buffer;
    try {
      givenSig = base64urlDecodeToBuffer(sigB64);
    } catch {
      return null;
    }
    if (!constantTimeEqual(expectedSig, givenSig)) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp <= nowSec) return null;

    return payload;
  }

  // Legacy format is insecure (predictable); only allow explicitly.
  // admin-token-<id>
  const m = /^admin-token-(\d+)$/.exec(trimmed);
  if (m && process.env.ALLOW_LEGACY_ADMIN_TOKEN === '1') {
    const id = Number.parseInt(m[1], 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      sub: id,
      username: '',
      role: 'legacy',
      displayName: '',
      iat: nowSec,
      exp: nowSec + 10 * 60, // short window; still insecure by design
    };
  }

  return null;
}

// ============================================================
// Password hashing (scrypt) with transparent legacy migration
// ============================================================

const SCRYPT_KEYLEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function encodeScryptHash(params: { n: number; r: number; p: number; salt: Buffer; dk: Buffer }): string {
  return [
    'scrypt',
    String(params.n),
    String(params.r),
    String(params.p),
    base64urlEncode(params.salt),
    base64urlEncode(params.dk),
  ].join('$');
}

function parseScryptHash(stored: string): { n: number; r: number; p: number; salt: Buffer; dk: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  if (parts[0] !== 'scrypt') return null;
  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  try {
    const salt = base64urlDecodeToBuffer(parts[4]);
    const dk = base64urlDecodeToBuffer(parts[5]);
    if (dk.length !== SCRYPT_KEYLEN) return null;
    return { n, r, p, salt, dk };
  } catch {
    return null;
  }
}

async function scryptDeriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: n, r, p, maxmem: 128 * 1024 * 1024 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = await scryptDeriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return encodeScryptHash({ n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt, dk });
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<{ ok: boolean; needsUpgrade: boolean }> {
  if (!storedHash) return { ok: false, needsUpgrade: false };

  const parsed = parseScryptHash(storedHash);
  if (parsed) {
    const dk = await scryptDeriveKey(password, parsed.salt, parsed.n, parsed.r, parsed.p);
    return { ok: constantTimeEqual(dk, parsed.dk), needsUpgrade: false };
  }

  // Legacy: plaintext stored in password_hash.
  // Only used to let us migrate existing DB safely; on first successful login we will upgrade.
  if (storedHash === password) return { ok: true, needsUpgrade: true };
  return { ok: false, needsUpgrade: false };
}
