import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CloudflareAccess, normalizeTeamDomain, parseAudiences, parseProxyList } from '../src/cfaccess.js';
import { Store } from '../src/store.js';
import { startApp } from './helpers.js';

const TEAM = 'example-team.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'a'.repeat(64);
const OTHER_AUD = 'b'.repeat(64);
const CSRF = { 'X-Requested-With': 'rustdesk-web' };

const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEYS = { k1: rsa(), k2: rsa(), evil: rsa() };
const jwk = (kid) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', ...KEYS[kid].publicKey.export({ format: 'jwk' }) });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function sign(claims = {}, { kid = 'k1', key = KEYS[kid].privateKey, header = {} } = {}) {
  const h = b64({ alg: 'RS256', kid, typ: 'JWT', ...header });
  const p = b64({ iss: ISS, aud: [AUD], email: 'Alice@Example.com', sub: 'user-1', type: 'app', iat: now(), nbf: now(), exp: now() + 3600, ...claims });
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** Stand-in for https://<team>/cdn-cgi/access/certs. */
function fakeCerts(kids = ['k1']) {
  const f = async (url) => {
    f.calls.push(url);
    if (url !== `${ISS}/cdn-cgi/access/certs`) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ keys: f.kids.map(jwk) }) };
  };
  f.calls = [];
  f.kids = kids;
  return f;
}

function verifier({ settings = {}, config = {}, fetch = fakeCerts(), clock = Date.now } = {}) {
  const store = new Store(':memory:');
  const all = { cf_enabled: '1', cf_team_domain: TEAM, cf_audience: AUD, ...settings };
  for (const [k, v] of Object.entries(all)) store.setSetting(k, v);
  return new CloudflareAccess(store, config, { fetch, now: clock, logger: { error() {} } });
}

describe('Cloudflare Access JWT validation', () => {
  it('accepts a valid token and returns the lower-cased e-mail', async () => {
    const id = await verifier().verify(sign());
    assert.equal(id.email, 'alice@example.com');
    assert.equal(id.sub, 'user-1');
  });

  it('accepts a single-string aud and any of several configured audiences', async () => {
    const v = verifier({ settings: { cf_audience: `${OTHER_AUD},${AUD}` } });
    assert.equal((await v.verify(sign({ aud: AUD }))).email, 'alice@example.com');
  });

  const rejects = async (token, pattern, opts) => assert.rejects(verifier(opts).verify(token), pattern);

  it('rejects a signature from a key that is not the team\'s', () => rejects(sign({}, { kid: 'k1', key: KEYS.evil.privateKey }), /invalid token signature/));
  it('rejects a tampered payload', () => {
    const [h, , s] = sign().split('.');
    return rejects(`${h}.${b64({ iss: ISS, aud: [AUD], email: 'mallory@example.com', exp: now() + 3600 })}.${s}`, /invalid token signature/);
  });
  it('rejects alg "none"', () => {
    const t = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ iss: ISS, aud: [AUD], email: 'a@b.c', exp: now() + 60 })}.`;
    return rejects(t, /malformed token signature|unsupported token algorithm/);
  });
  it('rejects HS256 signed with the public key as the secret', () => {
    const h = b64({ alg: 'HS256', kid: 'k1' });
    const p = b64({ iss: ISS, aud: [AUD], email: 'a@b.c', exp: now() + 60 });
    const secret = KEYS.k1.publicKey.export({ type: 'spki', format: 'pem' });
    const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return rejects(`${h}.${p}.${sig}`, /unsupported token algorithm "HS256"/);
  });
  it('rejects critical headers', () => rejects(sign({}, { header: { crit: ['exp'] } }), /critical/));
  it('rejects a token without kid', () => rejects(sign({}, { header: { kid: undefined } }), /no key ID/));
  it('rejects another issuer', () => rejects(sign({ iss: 'https://other.cloudflareaccess.com' }), /issuer/));
  it('rejects another application\'s audience', () => rejects(sign({ aud: [OTHER_AUD] }), /audience mismatch/));
  it('rejects an expired token (beyond 60s skew)', () => rejects(sign({ exp: now() - 61 }), /expired/));
  it('tolerates small clock skew', async () => assert.ok(await verifier().verify(sign({ exp: now() - 30, nbf: now() + 30, iat: now() + 30 }))));
  it('rejects a token without exp', () => rejects(sign({ exp: undefined }), /no expiry/));
  it('rejects a token that is not valid yet', () => rejects(sign({ nbf: now() + 120 }), /not valid yet/));
  it('rejects a token issued in the future', () => rejects(sign({ iat: now() + 120 }), /future/));
  it('rejects service tokens (no e-mail)', () => rejects(sign({ email: undefined, common_name: 'svc.access' }), /does not identify a user/));
  it('rejects non-application tokens', () => rejects(sign({ type: 'org' }), /not an Access application token/));
  it('rejects malformed tokens', async () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c.d', '!!.@@.##', `${b64([1])}.${b64({})}.x`, 'x'.repeat(20000)]) {
      await assert.rejects(verifier().verify(t), /malformed/, t.slice(0, 20));
    }
  });
  it('refuses to verify when not configured', async () => {
    await assert.rejects(verifier({ settings: { cf_enabled: '0' } }).verify(sign()), /not configured/);
    await assert.rejects(verifier({ settings: { cf_audience: '' } }).verify(sign()), /not configured/);
  });

  it('caches the signing keys and refetches on an unknown kid (rotation), at most every 30s', async () => {
    let t = Date.now();
    const certs = fakeCerts(['k1']);
    const v = verifier({ fetch: certs, clock: () => t });
    await v.verify(sign());
    await v.verify(sign({ sub: 'again' }));
    assert.equal(certs.calls.length, 1);

    certs.kids = ['k1', 'k2'];
    t += 31_000;
    assert.equal((await v.verify(sign({}, { kid: 'k2' }))).email, 'alice@example.com');
    assert.equal(certs.calls.length, 2);

    // Unknown kid again right away: no new fetch, rejected.
    await assert.rejects(v.verify(sign({}, { kid: 'evil' })), /not signed by a key of this Cloudflare team/);
    assert.equal(certs.calls.length, 2);
  });

  it('reports an unreachable key endpoint', async () => {
    const v = verifier({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await assert.rejects(v.verify(sign()), /cannot fetch the Access signing keys/);
  });

  it('ignores weak or non-RSA keys in the key set', async () => {
    const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ keys: [
      { kid: 'k1', kty: 'RSA', ...weak.publicKey.export({ format: 'jwk' }) },
      { kid: 'ec', kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    ] }) });
    await assert.rejects(verifier({ fetch }).verify(sign({}, { key: weak.privateKey })), /cannot fetch/);
  });

  it('finds the token in the header, else the CF_Authorization cookie', () => {
    assert.equal(CloudflareAccess.tokenOf({ 'cf-access-jwt-assertion': 'h', cookie: 'CF_Authorization=c' }), 'h');
    assert.equal(CloudflareAccess.tokenOf({ cookie: 'a=1; CF_Authorization=c; b=2' }), 'c');
    assert.equal(CloudflareAccess.tokenOf({}), '');
  });
});

describe('Cloudflare settings parsing', () => {
  it('normalizes team domains', () => {
    assert.equal(normalizeTeamDomain('MyTeam'), 'myteam.cloudflareaccess.com');
    assert.equal(normalizeTeamDomain('https://myteam.cloudflareaccess.com/'), 'myteam.cloudflareaccess.com');
    assert.equal(normalizeTeamDomain(''), '');
    assert.throws(() => normalizeTeamDomain('http://myteam.cloudflareaccess.com'), /Team domain/);
    assert.throws(() => normalizeTeamDomain('team.example.com/path'), /Team domain/);
  });
  it('validates AUD tags', () => {
    assert.deepEqual(parseAudiences(` ${AUD.toUpperCase()}, ${OTHER_AUD}\n${AUD}`), [AUD, OTHER_AUD]);
    assert.throws(() => parseAudiences('not-a-tag'), /Application Audience/);
  });
  it('parses trusted proxy lists', () => {
    const list = parseProxyList('10.0.0.5, 172.16.0.0/12 2001:db8::/32');
    assert.ok(list.check('10.0.0.5', 'ipv4'));
    assert.ok(list.check('172.20.1.1', 'ipv4'));
    assert.ok(list.check('2001:db8::1', 'ipv6'));
    assert.ok(!list.check('10.0.0.6', 'ipv4'));
    assert.equal(parseProxyList(''), null);
    for (const bad of ['10.0.0.300', '10.0.0.0/33', '10.0.0.0/', 'host.example', '1.2.3.4/8/9']) assert.throws(() => parseProxyList(bad), /not an IP/, bad);
  });
  it('lets saved settings override the environment, per field', () => {
    const store = new Store(':memory:');
    const config = { cfTeamDomain: 'envteam', cfAudience: AUD, cfAutoLogin: 'false' };
    const cf = new CloudflareAccess(store, config);
    let s = cf.settings();
    assert.equal(s.enabled, true, 'on when the environment sets team and AUD');
    assert.equal(s.team_domain, 'envteam.cloudflareaccess.com');
    assert.equal(s.auto_login, false);
    assert.deepEqual(s.sources, { enabled: '', team_domain: 'env', audience: 'env', auto_login: 'env', client_ip: '', trusted_proxies: '' });
    store.setSetting('cf_enabled', '0');
    store.setSetting('cf_auto_login', '1');
    cf.invalidate();
    s = cf.settings();
    assert.equal(s.enabled, false);
    assert.equal(s.auto_login, true);
    assert.equal(s.sources.enabled, 'settings');
  });
});

describe('CF-Connecting-IP', () => {
  const req = (peer, ip) => ({ socket: { remoteAddress: peer }, headers: ip === undefined ? {} : { 'cf-connecting-ip': ip } });
  it('is ignored unless turned on', () => {
    assert.equal(verifier().connectingIp(req('10.0.0.5', '203.0.113.9')), null);
  });
  it('is used from any peer when no proxy list is set', () => {
    const v = verifier({ settings: { cf_client_ip: '1' } });
    assert.equal(v.connectingIp(req('::ffff:10.0.0.5', '203.0.113.9')), '203.0.113.9');
    assert.equal(v.connectingIp(req('10.0.0.5', '2001:db8::7')), '2001:db8::7');
    assert.equal(v.connectingIp(req('10.0.0.5', 'not-an-ip')), null);
    assert.equal(v.connectingIp(req('10.0.0.5')), null);
  });
  it('is only believed from trusted proxies when a list is set', () => {
    const v = verifier({ settings: { cf_client_ip: '1', cf_trusted_proxies: '10.0.0.5, 192.168.0.0/16' } });
    assert.equal(v.connectingIp(req('::ffff:10.0.0.5', '203.0.113.9')), '203.0.113.9');
    assert.equal(v.connectingIp(req('192.168.4.4', '203.0.113.9')), '203.0.113.9');
    assert.equal(v.connectingIp(req('10.0.0.6', '203.0.113.9')), null);
  });
});

describe('Cloudflare Access sign-in (API)', () => {
  let t;
  let admin;
  let certs;
  const cfHeaders = (token = sign()) => ({ ...CSRF, 'Cf-Access-Jwt-Assertion': token });

  before(async () => {
    t = await startApp();
    certs = fakeCerts(['k1']);
    t.app.cloudflare.fetch = certs;
    admin = await t.adminSession();
  });
  after(() => t.stop());
  beforeEach(() => t.app.store.run("UPDATE users SET cf_email = ''"));

  const enable = (extra = {}) => admin.put('/api/admin/settings', { cloudflare: { enabled: true, team_domain: 'example-team', audience: AUD, ...extra } });

  it('validates and saves settings', async () => {
    assert.equal((await admin.put('/api/admin/settings', { cloudflare: { audience: 'nope' } })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { cloudflare: { team_domain: 'bad domain' } })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { cloudflare: { trusted_proxies: '10.0.0.0/99' } })).status, 400);
    assert.equal((await admin.put('/api/admin/settings', { cloudflare: { enabled: 'maybe' } })).status, 400);
    const res = await enable();
    assert.equal(res.status, 200);
    assert.equal(res.data.cloudflare.ready, true);
    assert.equal(res.data.cloudflare.issuer, ISS);
    assert.deepEqual(res.data.cloudflare.audiences, [AUD]);
    assert.equal(res.data.cloudflare.saved.team_domain, TEAM);
  });

  it('offers the identity on the sign-in page, and refuses an unlinked one', async () => {
    await enable();
    const opts = await t.request('GET', '/api/admin/login-options', { headers: cfHeaders() });
    assert.deepEqual(opts.data.cloudflare, { enabled: true, auto_login: true, email: 'alice@example.com', linked: false });
    assert.equal((await t.request('GET', '/api/admin/login-options')).data.cloudflare.email, null);

    const res = await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders() });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /No account is linked to alice@example.com/);
    assert.equal((await t.request('POST', '/api/admin/login/cloudflare', { headers: CSRF })).status, 401);
    assert.equal((await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders(sign({ aud: [OTHER_AUD] })) })).status, 401);
    assert.equal((await t.request('POST', '/api/admin/login/cloudflare', { headers: { 'Cf-Access-Jwt-Assertion': sign() } })).status, 403, 'CSRF header required');
  });

  it('links the identity on the request and signs in with it', async () => {
    await enable();
    const call = (method, url, token, cookie = admin.cookie) =>
      t.request(method, url, { headers: { ...CSRF, Cookie: cookie, ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}) } });

    const status = await call('GET', '/api/admin/me/cloudflare', sign());
    assert.deepEqual(status.data.identity, { email: 'alice@example.com' });
    assert.equal(status.data.linked_email, '');
    assert.equal((await call('POST', '/api/admin/me/cloudflare')).status, 400, 'linking needs a token on the request');
    const linked = await call('POST', '/api/admin/me/cloudflare', sign());
    assert.equal(linked.status, 200);
    assert.equal(linked.data.linked_email, 'alice@example.com');

    assert.equal((await t.request('GET', '/api/admin/login-options', { headers: cfHeaders() })).data.cloudflare.linked, true);
    const login = await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders(sign({ email: 'ALICE@example.com' })) });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.username, 'admin');
    const cookie = login.headers.get('set-cookie').split(';')[0];

    // The session lives only as long as Access vouches for the same person.
    const me = await call('GET', '/api/admin/me', sign(), cookie);
    assert.equal(me.status, 200);
    assert.equal(me.data.auth_method, 'cloudflare');
    assert.equal((await call('GET', '/api/admin/me', '', cookie)).status, 401, 'no Access token');
    assert.equal((await call('GET', '/api/admin/me', sign({ email: 'bob@example.com' }), cookie)).status, 401, 'different identity');
    assert.equal((await call('GET', '/api/admin/me', sign({ exp: now() - 120 }), cookie)).status, 401, 'expired');
    assert.equal((await call('GET', '/api/admin/me', '', admin.cookie)).status, 200, 'password sessions do not need Access');

    assert.equal((await call('DELETE', '/api/admin/me/cloudflare', sign(), cookie)).status, 400, 'cannot unlink from a session that depends on it');
    const unlinked = await call('DELETE', '/api/admin/me/cloudflare');
    assert.equal(unlinked.data.linked_email, '');
    assert.equal((await call('GET', '/api/admin/me', sign(), cookie)).status, 401, 'unlinking ends Access sessions');

    const activity = t.app.store.all("SELECT action, detail FROM activity WHERE action LIKE 'cloudflare%' OR detail LIKE 'cloudflare%'").map((a) => a.action);
    assert.ok(activity.includes('cloudflare_link') && activity.includes('cloudflare_unlink') && activity.includes('login'));
  });

  it('disabling the integration ends Access sessions', async () => {
    await enable();
    t.app.store.run("UPDATE users SET cf_email = 'alice@example.com' WHERE username = 'admin'");
    const login = await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders() });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await admin.put('/api/admin/settings', { cloudflare: { enabled: false } });
    assert.equal((await t.request('GET', '/api/admin/me', { headers: { Cookie: cookie, 'Cf-Access-Jwt-Assertion': sign() } })).status, 401);
    assert.equal((await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders() })).status, 404);
  });

  it('lets administrators set the link, one account per identity', async () => {
    await enable();
    const created = await admin.post('/api/admin/users', { username: 'bob', password: 'bob-password-1', is_admin: true, cloudflare_email: 'Bob@Example.com' });
    assert.equal(created.status, 200);
    assert.equal(created.data.user.cloudflare_email, 'bob@example.com');
    const clash = await admin.post('/api/admin/users', { username: 'bob2', password: 'bob-password-1', cloudflare_email: 'bob@example.com' });
    assert.equal(clash.status, 409);
    const me = (await admin.get('/api/admin/me')).data.user;
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { cloudflare_email: 'bob@example.com' })).status, 409);
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { cloudflare_email: 'not an email' })).status, 400);

    const login = await t.request('POST', '/api/admin/login/cloudflare', { headers: cfHeaders(sign({ email: 'bob@example.com' })) });
    assert.equal(login.data.user.username, 'bob');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await admin.patch(`/api/admin/users/${created.data.user.id}`, { cloudflare_email: '' });
    assert.equal((await t.request('GET', '/api/admin/me', { headers: { Cookie: cookie, 'Cf-Access-Jwt-Assertion': sign({ email: 'bob@example.com' }) } })).status, 401);
  });

  it('records the CF-Connecting-IP address only when turned on', async () => {
    await enable({ client_ip: '' });
    const ipOf = async () => {
      await t.request('POST', '/api/admin/login', { body: { username: 'nobody', password: 'x' }, headers: { ...CSRF, 'CF-Connecting-IP': '203.0.113.9' } });
      return t.app.store.get("SELECT ip FROM activity WHERE action = 'login_failed' ORDER BY id DESC LIMIT 1").ip;
    };
    assert.equal(await ipOf(), '127.0.0.1');
    await enable({ client_ip: true });
    assert.equal(await ipOf(), '203.0.113.9');
    await enable({ client_ip: true, trusted_proxies: '10.9.9.9' });
    assert.equal(await ipOf(), '127.0.0.1', 'not from a trusted proxy');
    await enable({ client_ip: true, trusted_proxies: '127.0.0.1' });
    assert.equal(await ipOf(), '203.0.113.9');
    await enable({ client_ip: '', trusted_proxies: '' });
  });
});
