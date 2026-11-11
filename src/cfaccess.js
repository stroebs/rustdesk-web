// Cloudflare Zero Trust (Access) integration.
//
// When the console sits behind a Cloudflare Access application, every request
// Cloudflare forwards carries a JWT (the Cf-Access-Jwt-Assertion header, and the
// CF_Authorization cookie) signed by the team's Access keys. An administrator can
// link the e-mail address in that token to their account and then be signed in
// automatically.
//
// The token is accepted only if all of these hold (Cloudflare's own checklist,
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/):
//   - RS256 signature by a key from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
//     (looked up by `kid`; the algorithm is fixed, never taken from the token)
//   - iss is exactly https://<team>.cloudflareaccess.com
//   - aud contains one of the configured Application Audience (AUD) tags
//   - exp is in the future and nbf/iat are not, allowing 60s of clock skew
//   - it identifies a user (an `email` claim): service-token JWTs are refused
//
// It also decides whether the CF-Connecting-IP header can be believed.

import crypto from 'node:crypto';
import net from 'node:net';

export const CF_HEADER = 'cf-access-jwt-assertion';
export const CF_COOKIE = 'CF_Authorization';
export const CF_IP_HEADER = 'cf-connecting-ip';

const SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 16 * 1024;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;
const VERIFIED_CACHE_SIZE = 500;
const B64URL = /^[A-Za-z0-9_-]+$/;
const AUD_RE = /^[0-9a-f]{64}$/i;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export class AccessError extends Error {}

/** "team", "team.cloudflareaccess.com" or "https://team.cloudflareaccess.com/" -> host name. */
export function normalizeTeamDomain(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (!s.includes('.')) s += '.cloudflareaccess.com';
  if (!HOST_RE.test(s)) throw new AccessError('Team domain must look like "myteam" or "myteam.cloudflareaccess.com"');
  return s;
}

/** Comma/whitespace separated AUD tags -> array (each 64 hex characters). */
export function parseAudiences(value) {
  const list = String(value ?? '').split(/[\s,]+/).filter(Boolean);
  for (const aud of list) {
    if (!AUD_RE.test(aud)) throw new AccessError(`"${aud.slice(0, 80)}" is not an Application Audience (AUD) tag: expected 64 hexadecimal characters`);
  }
  return [...new Set(list.map((a) => a.toLowerCase()))];
}

/** Comma/whitespace separated IP addresses and CIDR ranges -> net.BlockList (null when empty). */
export function parseProxyList(value) {
  const list = String(value ?? '').split(/[\s,]+/).filter(Boolean);
  if (!list.length) return null;
  const block = new net.BlockList();
  for (const entry of list) {
    const [addr, bits, extra] = entry.split('/');
    const family = net.isIP(addr);
    const prefix = Number(bits);
    const max = family === 6 ? 128 : 32;
    if (!family || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits) || prefix > max))) {
      throw new AccessError(`"${entry.slice(0, 80)}" is not an IP address or CIDR range`);
    }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) block.addAddress(addr, type);
    else block.addSubnet(addr, prefix, type);
  }
  return block;
}

function blockListHas(block, ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return block.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const bool = (v) => (v === '1' || v === '0' ? v === '1' : /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : null);

function decodePart(part, what) {
  if (!B64URL.test(part)) throw new AccessError(`malformed token ${what}`);
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new AccessError(`malformed token ${what}`);
}

export class CloudflareAccess {
  #settings = null;
  #keys = new Map();
  #keysFor = '';
  #keysFetchedAt = 0;
  #keysLastAttempt = 0;
  #keysPending = null;
  #verified = new Map();

  constructor(store, config, { fetch = globalThis.fetch, now = Date.now, logger = console } = {}) {
    this.store = store;
    this.config = config;
    this.fetch = fetch;
    this.now = now;
    this.logger = logger;
  }

  /** Forget cached settings (and keys/tokens that depended on them) after a change. */
  invalidate() {
    this.#settings = null;
    this.#verified.clear();
  }

  /**
   * Effective settings. Each value saved in Settings overrides its environment
   * variable; anything left unset falls back to the environment.
   */
  settings() {
    if (this.#settings) return this.#settings;
    const { config, store } = this;
    const saved = (key) => store.getSetting(key);
    const pick = (key, envValue) => {
      const v = saved(key);
      return v ? { value: v, source: 'settings' } : envValue ? { value: envValue, source: 'env' } : { value: '', source: '' };
    };
    const pickBool = (key, envValue, fallback) => {
      const s = bool(saved(key));
      if (s !== null) return { value: s, source: 'settings' };
      const e = bool(envValue ?? '');
      return e !== null ? { value: e, source: 'env' } : { value: fallback, source: '' };
    };

    const problems = [];
    const safe = (fn, fallback) => {
      try {
        return fn();
      } catch (err) {
        problems.push(err.message);
        return fallback;
      }
    };
    const team = pick('cf_team_domain', config.cfTeamDomain);
    const aud = pick('cf_audience', config.cfAudience);
    const proxies = pick('cf_trusted_proxies', config.cfTrustedProxies);
    const teamDomain = safe(() => normalizeTeamDomain(team.value), '');
    const audiences = safe(() => parseAudiences(aud.value), []);
    const proxyList = safe(() => parseProxyList(proxies.value), null);
    // Off unless asked for; set both env values to turn it on from the environment.
    const enabled = pickBool('cf_enabled', config.cfEnabled, Boolean(config.cfTeamDomain && config.cfAudience));
    const autoLogin = pickBool('cf_auto_login', config.cfAutoLogin, true);
    const clientIp = pickBool('cf_client_ip', config.cfClientIp, false);
    if (enabled.value && !teamDomain) problems.push('Set the team domain.');
    if (enabled.value && !audiences.length) problems.push('Set the Application Audience (AUD) tag.');
    if (clientIp.value && proxies.value && !proxyList) problems.push('The trusted proxy list is not valid, so CF-Connecting-IP is ignored.');

    this.#settings = {
      enabled: enabled.value,
      ready: Boolean(enabled.value && teamDomain && audiences.length),
      team_domain: teamDomain,
      issuer: teamDomain ? `https://${teamDomain}` : '',
      certs_url: teamDomain ? `https://${teamDomain}/cdn-cgi/access/certs` : '',
      audiences,
      auto_login: autoLogin.value,
      client_ip: clientIp.value,
      trusted_proxies: proxies.value,
      proxy_list: proxyList,
      proxy_list_invalid: Boolean(proxies.value && !proxyList),
      problems,
      sources: {
        enabled: enabled.source,
        team_domain: team.source,
        audience: aud.source,
        auto_login: autoLogin.source,
        client_ip: clientIp.source,
        trusted_proxies: proxies.source,
      },
    };
    return this.#settings;
  }

  /**
   * The CF-Connecting-IP address, when the setting is on, the header holds an IP
   * address and the request came from a trusted proxy (any, if no list is set).
   */
  connectingIp(req) {
    const s = this.settings();
    if (!s.client_ip || s.proxy_list_invalid) return null;
    const raw = req.headers[CF_IP_HEADER];
    const value = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
    if (!net.isIP(value)) return null;
    const peer = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (s.proxy_list && !blockListHas(s.proxy_list, peer)) return null;
    return value.replace(/^::ffff:/, '');
  }

  /** The Access JWT on a request: the header Cloudflare adds, else the cookie. */
  static tokenOf(headers) {
    const h = headers[CF_HEADER];
    const header = String(Array.isArray(h) ? h[0] : h ?? '').trim();
    if (header) return header;
    for (const part of String(headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === CF_COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  /**
   * The verified identity on a request: { identity: {email, sub, exp} } when a
   * valid token is present, { error } when one is present but rejected, {} when none.
   */
  async identify(headers) {
    if (!this.settings().ready) return {};
    const token = CloudflareAccess.tokenOf(headers);
    if (!token) return {};
    try {
      return { identity: await this.verify(token) };
    } catch (err) {
      if (!(err instanceof AccessError)) throw err;
      return { error: err.message };
    }
  }

  /** Verify an Access JWT; resolves with {email, sub, exp} or throws AccessError. */
  async verify(token) {
    const s = this.settings();
    if (!s.ready) throw new AccessError('Cloudflare Access sign-in is not configured');
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw new AccessError('malformed token');

    const nowSec = Math.floor(this.now() / 1000);
    const cacheKey = crypto.createHash('sha256').update(token).digest('hex');
    const cached = this.#verified.get(cacheKey);
    if (cached) {
      if (cached.exp + SKEW_SECONDS > nowSec) return cached;
      this.#verified.delete(cacheKey);
    }

    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('malformed token');
    const [h, p, sig] = parts;
    const header = decodePart(h, 'header');
    const claims = decodePart(p, 'payload');
    if (!B64URL.test(sig)) throw new AccessError('malformed token signature');

    // Never let the token pick the algorithm ("none", HS256 with the public key...).
    if (header.alg !== 'RS256') throw new AccessError(`unsupported token algorithm ${JSON.stringify(header.alg)}`);
    if (header.crit !== undefined) throw new AccessError('unsupported critical token header');
    if (typeof header.kid !== 'string' || !header.kid) throw new AccessError('token has no key ID');

    const key = await this.#key(header.kid);
    if (!key) throw new AccessError('token is not signed by a key of this Cloudflare team');
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(sig, 'base64url'));
    if (!valid) throw new AccessError('invalid token signature');

    if (claims.iss !== s.issuer) throw new AccessError(`token issuer ${JSON.stringify(String(claims.iss).slice(0, 100))} is not ${s.issuer}`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === 'string' && s.audiences.includes(a.toLowerCase()))) {
      throw new AccessError('token is for a different Access application (audience mismatch)');
    }
    if (!Number.isFinite(claims.exp)) throw new AccessError('token has no expiry');
    if (claims.exp + SKEW_SECONDS <= nowSec) throw new AccessError('token has expired');
    if (claims.nbf !== undefined && !(Number.isFinite(claims.nbf) && claims.nbf - SKEW_SECONDS <= nowSec)) throw new AccessError('token is not valid yet');
    if (claims.iat !== undefined && !(Number.isFinite(claims.iat) && claims.iat - SKEW_SECONDS <= nowSec)) throw new AccessError('token was issued in the future');
    if (claims.type !== undefined && claims.type !== 'app') throw new AccessError('not an Access application token');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) throw new AccessError('token does not identify a user (service tokens cannot sign in)');

    const identity = { email, sub: typeof claims.sub === 'string' ? claims.sub : '', exp: claims.exp };
    if (this.#verified.size >= VERIFIED_CACHE_SIZE) this.#verified.delete(this.#verified.keys().next().value);
    this.#verified.set(cacheKey, identity);
    return identity;
  }

  async #key(kid) {
    const { certs_url: url } = this.settings();
    if (this.#keysFor !== url) {
      this.#keys = new Map();
      this.#keysFor = url;
      this.#keysFetchedAt = 0;
      this.#keysLastAttempt = 0;
    }
    const now = this.now();
    const stale = now - this.#keysFetchedAt > JWKS_TTL_MS;
    // Keys rotate: refetch on an unknown kid, but not more than every 30s.
    if (stale || (!this.#keys.has(kid) && now - this.#keysLastAttempt > JWKS_MIN_REFRESH_MS)) {
      try {
        await this.#refreshKeys(url);
      } catch (err) {
        this.logger.error(`cloudflare access: fetching ${url} failed: ${err.message}`);
        if (!this.#keys.size) throw new AccessError(`cannot fetch the Access signing keys from ${url}`);
      }
    }
    return this.#keys.get(kid) ?? null;
  }

  #refreshKeys(url) {
    this.#keysPending ??= (async () => {
      this.#keysLastAttempt = this.now();
      const res = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > JWKS_MAX_BYTES) throw new Error('response too large');
      const body = JSON.parse(text);
      const keys = new Map();
      for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
        if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        if (jwk.use !== undefined && jwk.use !== 'sig') continue;
        if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
        try {
          const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
          if (key.asymmetricKeyDetails.modulusLength >= 2048) keys.set(jwk.kid, key);
        } catch {
          /* skip unusable keys */
        }
      }
      if (!keys.size) throw new Error('no usable RS256 keys in the response');
      if (url === this.#keysFor) {
        this.#keys = keys;
        this.#keysFetchedAt = this.now();
      }
    })().finally(() => {
      this.#keysPending = null;
    });
    return this.#keysPending;
  }
}
