import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const ADMIN = { username: 'admin', password: 'correct-horse-battery' };

export async function startApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-web-test-'));
  const config = loadConfig({}, {
    dbPath: path.join(dir, 'test.sqlite3'),
    adminUsername: ADMIN.username,
    adminPassword: ADMIN.password,
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  });
  const silent = { error() {}, log() {} };
  const app = createApp(config, { logger: silent });
  await app.bootstrap();
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  async function request(method, url, { body, headers = {}, raw = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    if (!raw && text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return { status: res.status, headers: res.headers, data };
  }

  /** A signed-in admin browser session. */
  async function adminSession(credentials = ADMIN) {
    const res = await request('POST', '/api/admin/login', {
      body: credentials,
      headers: { 'X-Requested-With': 'rustdesk-web' },
    });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.data)}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = (method) => (url, body) =>
      request(method, url, { body, headers: { Cookie: cookie, 'X-Requested-With': 'rustdesk-web' } });
    return { cookie, get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), del: call('DELETE') };
  }

  /** Log in like the RustDesk client does and return a bearer-authenticated caller. */
  async function clientSession(username, password, deviceId = '123456789') {
    const res = await request('POST', '/api/login', {
      body: { username, password, id: deviceId, uuid: 'dXVpZA==', autoLogin: true, type: 'account', deviceInfo: { os: 'linux', type: 'client', name: 'test-pc' } },
    });
    if (!res.data.access_token) throw new Error(`client login failed: ${JSON.stringify(res.data)}`);
    const auth = { Authorization: `Bearer ${res.data.access_token}` };
    const call = (method) => (url, body) => request(method, url, { body, headers: auth });
    return { token: res.data.access_token, login: res.data, get: call('GET'), post: call('POST') };
  }

  return {
    app,
    base,
    request,
    adminSession,
    clientSession,
    async stop() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
