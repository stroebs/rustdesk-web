import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decodeConfigString, encodeConfigString } from '../src/serverconfig.js';
import { ADMIN, startApp } from './helpers.js';

describe('admin API', () => {
  let t;
  let admin;
  before(async () => {
    t = await startApp();
    admin = await t.adminSession();
  });
  after(() => t.stop());

  it('requires a session', async () => {
    assert.equal((await t.request('GET', '/api/admin/stats')).status, 401);
  });

  it('requires the CSRF header on mutating requests', async () => {
    const res = await t.request('POST', '/api/admin/users', { body: {}, headers: { Cookie: admin.cookie } });
    assert.equal(res.status, 403);
  });

  it('sets a hardened session cookie', async () => {
    const res = await t.request('POST', '/api/admin/login', { body: ADMIN, headers: { 'X-Requested-With': 'rustdesk-web' } });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('serves security headers and the UI', async () => {
    const res = await t.request('GET', '/', { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.data, /<div id="app">/);
    assert.equal((await t.request('GET', '/../package.json')).status, 404);
  });

  it('creates, updates and deletes users', async () => {
    const created = await admin.post('/api/admin/users', { username: 'alice', password: 'alice-password', email: 'alice@example.com' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.user.id;
    assert.equal(created.data.user.is_admin, false);

    assert.equal((await admin.post('/api/admin/users', { username: 'ALICE', password: 'whatever123' })).status, 409);
    assert.equal((await admin.post('/api/admin/users', { username: 'bad name', password: 'whatever123' })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { username: 'short', password: 'x' })).status, 400);

    // Alice can sign in with the RustDesk client but not the admin UI.
    const client = await t.clientSession('alice', 'alice-password');
    assert.equal(client.login.user.is_admin, false);
    const web = await t.request('POST', '/api/admin/login', { body: { username: 'alice', password: 'alice-password' }, headers: { 'X-Requested-With': 'rustdesk-web' } });
    assert.equal(web.status, 403);

    // Resetting the password revokes her client tokens.
    const updated = await admin.patch(`/api/admin/users/${id}`, { display_name: 'Alice A.', password: 'new-password-1' });
    assert.equal(updated.data.user.display_name, 'Alice A.');
    assert.equal((await client.post('/api/currentUser', {})).status, 401);

    const list = await admin.get('/api/admin/users?q=ali');
    assert.equal(list.data.total, 1);

    assert.equal((await admin.del(`/api/admin/users/${id}`)).status, 200);
    assert.equal((await admin.get(`/api/admin/users/${id}/sessions`)).status, 404);
  });

  it('protects the last administrator', async () => {
    const me = (await admin.get('/api/admin/me')).data.user;
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { is_admin: false })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { status: 0 })).status, 400);
    assert.equal((await admin.del(`/api/admin/users/${me.id}`)).status, 400);
  });

  it('lists and edits devices', async () => {
    await t.request('POST', '/api/sysinfo', { body: { id: '424242424', hostname: 'lab-pc', os: 'linux', version: '1.3.2' } });
    await t.request('POST', '/api/heartbeat', { body: { id: '424242424', conns: [] } });
    await t.request('POST', '/api/sysinfo', { body: { id: '999000999', hostname: 'old-pc', os: 'windows' } });
    t.app.store.run('UPDATE devices SET last_seen_at = 1 WHERE id = ?', '999000999');

    const online = await admin.get('/api/admin/devices?status=online');
    assert.deepEqual(online.data.items.map((d) => d.id), ['424242424']);
    const offline = await admin.get('/api/admin/devices?status=offline&q=old');
    assert.deepEqual(offline.data.items.map((d) => d.id), ['999000999']);

    const me = (await admin.get('/api/admin/me')).data.user;
    const patched = await admin.patch('/api/admin/devices/424242424', { note: 'Lab bench', owner_id: me.id });
    assert.equal(patched.data.device.note, 'Lab bench');
    assert.equal(patched.data.device.owner_username, 'admin');

    const detail = await admin.get('/api/admin/devices/424242424');
    assert.equal(detail.data.device.sysinfo.hostname, 'lab-pc');

    assert.equal((await admin.del('/api/admin/devices/999000999')).status, 200);
    assert.equal((await admin.get('/api/admin/devices/999000999')).status, 404);
  });

  it('edits address books without losing client-only fields', async () => {
    const me = (await admin.get('/api/admin/me')).data.user;
    const client = await t.clientSession(ADMIN.username, ADMIN.password);
    await client.post('/api/ab', {
      data: JSON.stringify({ tags: ['a'], peers: [{ id: '1', alias: 'one', tags: ['a'], hash: 'pw-hash', rdpPort: '3389' }], tag_colors: '{}' }),
    });

    const ab = await admin.get(`/api/admin/address-books/${me.id}`);
    assert.equal(ab.data.peers[0].hash, undefined, 'password hash must be redacted');

    const put = await admin.put(`/api/admin/address-books/${me.id}`, {
      tags: ['a', 'b'],
      tag_colors: { b: 0xff00ff00, ghost: 1 },
      peers: [{ id: '1', alias: 'uno', tags: ['a', 'missing'] }, { id: '2', alias: 'two', tags: ['b'] }],
    });
    assert.equal(put.status, 200);

    const pulled = JSON.parse((await client.get('/api/ab')).data.data);
    assert.deepEqual(pulled.tags, ['a', 'b']);
    assert.deepEqual(JSON.parse(pulled.tag_colors), { b: 0xff00ff00 });
    assert.equal(pulled.peers[0].alias, 'uno');
    assert.equal(pulled.peers[0].hash, 'pw-hash');
    assert.equal(pulled.peers[0].rdpPort, '3389');
    assert.deepEqual(pulled.peers[0].tags, ['a']);
    assert.equal(pulled.peers[1].id, '2');
  });

  it('saves settings and builds an importable config string', async () => {
    const res = await admin.put('/api/admin/settings', {
      id_server: 'rd.example.com',
      relay_server: '',
      api_server: 'https://rd.example.com/',
      key: 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.api_server, 'https://rd.example.com');
    assert.deepEqual(decodeConfigString(res.data.config_string), {
      id_server: 'rd.example.com', relay_server: '', api_server: 'https://rd.example.com', key: 'OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=',
    });
    assert.equal((await admin.put('/api/admin/settings', { api_server: 'ftp://nope' })).status, 400);
  });

  it('encodes config strings the way RustDesk does', () => {
    // Reversed, padded base64url of {"host":"a","relay":"","api":"","key":""}
    const s = encodeConfigString({ id_server: 'a', relay_server: '', api_server: '', key: '' });
    const b64 = [...s].reverse().join('');
    assert.equal(Buffer.from(b64, 'base64url').toString(), '{"host":"a","relay":"","api":"","key":""}');
    assert.equal(b64.length % 4, 0);
  });

  it('exposes stats and logs', async () => {
    const stats = await admin.get('/api/admin/stats');
    assert.ok(stats.data.devices >= 1);
    assert.ok(stats.data.online >= 1);
    const activity = await admin.get('/api/admin/activity?q=user_create');
    assert.ok(activity.data.total >= 1);
    assert.equal((await admin.get('/api/admin/audit/connections')).status, 200);
    assert.equal((await admin.get('/api/admin/audit/files')).status, 200);
  });

  it('changes own password and signs out other sessions', async () => {
    const other = await t.adminSession();
    const res = await admin.post('/api/admin/me/password', { current_password: ADMIN.password, new_password: 'brand-new-password' });
    assert.equal(res.status, 200);
    assert.equal((await other.get('/api/admin/me')).status, 401);
    assert.equal((await admin.get('/api/admin/me')).status, 200);
  });

  it('logout clears the session', async () => {
    await admin.post('/api/admin/logout', {});
    assert.equal((await admin.get('/api/admin/me')).status, 401);
  });
});
