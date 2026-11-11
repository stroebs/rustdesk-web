import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const randomPassword = () => crypto.randomBytes(15).toString('base64url');

/** Fixed-window limiter for failed logins, keyed per IP and per IP+username. */
export class LoginLimiter {
  #entries = new Map();

  constructor({ maxPerUser = 10, maxPerIp = 50, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxPerUser = maxPerUser;
    this.maxPerIp = maxPerIp;
    this.windowMs = windowMs;
  }

  #keys(ip, username) {
    return [
      [`ip:${ip}`, this.maxPerIp],
      [`user:${ip}:${String(username).toLowerCase()}`, this.maxPerUser],
    ];
  }

  check(ip, username) {
    const now = Date.now();
    for (const [key, max] of this.#keys(ip, username)) {
      const entry = this.#entries.get(key);
      if (entry && entry.resetAt > now && entry.count >= max) {
        return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
      }
    }
    return { ok: true };
  }

  fail(ip, username) {
    const now = Date.now();
    for (const [key] of this.#keys(ip, username)) {
      const entry = this.#entries.get(key);
      if (!entry || entry.resetAt <= now) this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      else entry.count++;
    }
  }

  reset(ip, username) {
    this.#entries.delete(this.#keys(ip, username)[1][0]);
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.resetAt <= now) this.#entries.delete(key);
  }
}

export class Auth {
  #dummyHash = null;

  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.limiter = new LoginLimiter();
  }

  ttl(kind) {
    return kind === 'web'
      ? this.config.sessionTtlHours * 3600 * 1000
      : this.config.clientTokenTtlDays * 86400 * 1000;
  }

  /** Returns the user row when the credentials are valid, otherwise null. */
  async authenticate(username, password) {
    const user = username ? this.store.get('SELECT * FROM users WHERE username = ?', username) : undefined;
    if (!user) {
      // Spend comparable time so response timing does not reveal valid usernames.
      this.#dummyHash ??= await hashPassword(newToken());
      await verifyPassword(String(password), this.#dummyHash);
      return null;
    }
    return (await verifyPassword(String(password), user.password_hash)) ? user : null;
  }

  createToken(userId, kind, { deviceId = '', deviceUuid = '', deviceInfo = '', ip = '', userAgent = '' } = {}) {
    const token = newToken();
    const now = Date.now();
    this.store.run(
      `INSERT INTO tokens (token_hash, user_id, kind, device_id, device_uuid, device_info, ip, user_agent, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hashToken(token), userId, kind, deviceId, deviceUuid, deviceInfo, ip, userAgent.slice(0, 300), now, now, now + this.ttl(kind),
    );
    return token;
  }

  /** Resolve a token to its (active) user, extending its expiry on use. */
  lookup(token, kind) {
    if (!token) return null;
    const now = Date.now();
    const row = this.store.get(
      `SELECT t.id AS token_id, t.last_used_at AS token_last_used_at, u.*
       FROM tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.kind = ? AND t.expires_at > ?`,
      hashToken(token), kind, now,
    );
    if (!row || row.status !== 1) return null;
    if (now - row.token_last_used_at > 60 * 1000) {
      this.store.run('UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE id = ?', now, now + this.ttl(kind), row.token_id);
    }
    return row;
  }

  revoke(token) {
    if (token) this.store.run('DELETE FROM tokens WHERE token_hash = ?', hashToken(token));
  }
}
