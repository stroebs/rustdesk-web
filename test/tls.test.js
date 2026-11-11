import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers.js';

let haveOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  haveOpenssl = false;
}

function request(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: pathname, method, rejectUnauthorized: false, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('built-in HTTPS', { skip: !haveOpenssl && 'openssl not installed' }, () => {
  let t;
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-web-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    t = await startApp({ tlsCertFile: path.join(dir, 'cert.pem'), tlsKeyFile: path.join(dir, 'key.pem') });
  });
  after(async () => {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the API over TLS', async () => {
    assert.equal(t.app.protocol, 'https');
    const port = t.app.server.address().port;
    const res = await request(port, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  it('marks the session cookie Secure', async () => {
    const port = t.app.server.address().port;
    const res = await request(port, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rustdesk-web' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['set-cookie'][0], /; Secure/);
  });
});
