import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sha256 } from '../public/assets/client/sha256.js';
import { startApp } from './helpers.js';

const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
// What the browser computes after a password login (and what RustDesk clients store).
const stored = (password, salt) => sha256(utf8(password), utf8(salt));

describe('saved device passwords', () => {
  let t;
  let admin;
  let other;
  const url = '/api/admin/remote/passwords/123456789';

  before(async () => {
    t = await startApp();
    admin = await t.adminSession();
    await admin.post('/api/admin/users', { username: 'second', password: 'second-admin-pw', is_admin: true });
    other = await t.adminSession({ username: 'second', password: 'second-admin-pw' });
  });
  after(() => t.stop());

  it('validates what is saved', async () => {
    const hash = b64(stored('pw', 'salt'));
    assert.equal((await admin.put(url, { salt: '', hash })).status, 400);
    assert.equal((await admin.put(url, { salt: 'salt', hash: 'short' })).status, 400);
    assert.equal((await admin.put(url, { salt: 'salt', hash: b64(new Uint8Array(31)) })).status, 400);
    assert.equal((await admin.put('/api/admin/remote/passwords/bad%20id', { salt: 'salt', hash })).status, 400);
    assert.equal((await admin.get(url)).data.saved, false);
  });

  it('answers the device\'s challenge exactly like a password login would', async () => {
    assert.equal((await admin.put(url, { salt: 'device-salt', hash: b64(stored('secret pw ✓', 'device-salt')) })).status, 200);
    assert.equal((await admin.get(url)).data.saved, true);
    const res = await admin.post(`${url}/answer`, { salt: 'device-salt', challenge: 'chal-123' });
    assert.equal(res.status, 200);
    assert.equal(res.data.answer, b64(sha256(stored('secret pw ✓', 'device-salt'), utf8('chal-123'))));
    const list = (await admin.get('/api/admin/remote/passwords')).data.items;
    assert.deepEqual(list.map((p) => p.peer_id), ['123456789']);
    assert.ok(list[0].last_used_at);
    assert.equal(JSON.stringify(list).includes('device-salt'), false, 'salt and hash are never listed');
  });

  it('is per administrator', async () => {
    assert.equal((await other.get(url)).data.saved, false);
    assert.equal((await other.post(`${url}/answer`, { salt: 'device-salt', challenge: 'x' })).status, 404);
    assert.deepEqual((await other.get('/api/admin/remote/passwords')).data.items, []);
  });

  it('drops a saved password once the device\'s salt changes', async () => {
    const res = await admin.post(`${url}/answer`, { salt: 'new-salt', challenge: 'x' });
    assert.equal(res.status, 409);
    assert.equal((await admin.get(url)).data.saved, false);
  });

  it('forgets on request, and requires an admin session', async () => {
    await admin.put(url, { salt: 's', hash: b64(stored('pw', 's')) });
    assert.equal((await t.request('GET', url)).status, 401);
    assert.equal((await t.request('POST', `${url}/answer`, { body: { salt: 's', challenge: 'x' }, headers: { 'X-Requested-With': 'rustdesk-web' } })).status, 401);
    assert.equal((await admin.del(url)).status, 200);
    assert.equal((await admin.post(`${url}/answer`, { salt: 's', challenge: 'x' })).status, 404);
    const actions = t.app.store.all("SELECT action FROM activity WHERE action LIKE 'remote_password%'").map((a) => a.action);
    assert.ok(actions.includes('remote_password_save') && actions.includes('remote_password_forget'));
  });
});
