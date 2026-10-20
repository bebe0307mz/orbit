// Operator auth (docs 4-data-api.md 4.5): scrypt password, stateless HMAC cookie, sliding-window rate limits.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'orbit_session';

/** Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64> (32-byte key). */
export function hashPassword(password: string, N = 16384, r = 8, p = 1): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash!, 'base64');
  let got: Buffer;
  try {
    got = scryptSync(password, Buffer.from(salt!, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** orbit_session = base64url(sid.exp_ms) . HMAC-SHA256(secret, sid.exp_ms) */
export function issueSession(secret: string, ttlMs: number, now: number): { value: string; sid: string; exp: number } {
  const sid = randomBytes(16).toString('hex');
  const exp = now + ttlMs;
  const payload = `${sid}.${exp}`;
  return { value: `${b64u(payload)}.${b64u(createHmac('sha256', secret).update(payload).digest())}`, sid, exp };
}

export function verifySession(secret: string, value: string | undefined, now: number): { sid: string; exp: number } | null {
  if (!value) return null;
  const [p, mac] = value.split('.');
  if (!p || !mac) return null;
  const payload = Buffer.from(p, 'base64url').toString('utf8');
  const want = createHmac('sha256', secret).update(payload).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const m = payload.match(/^([0-9a-f]{32})\.(\d+)$/);
  if (!m) return null;
  const exp = Number(m[2]);
  if (!(exp > now)) return null;
  return { sid: m[1]!, exp };
}

export function cookieHeader(value: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${value}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Path=/v1; Max-Age=${maxAgeS}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Sliding-window limiter: at most `max` events per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  /** Seconds until the key may try again, or 0 when allowed now (without recording). */
  retryAfter(key: string, now: number): number {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, h);
    return h.length < this.max ? 0 : Math.ceil((h[0]! + this.windowMs - now) / 1000);
  }
  hit(key: string, now: number): void {
    const h = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    h.push(now);
    this.hits.set(key, h);
  }
}
