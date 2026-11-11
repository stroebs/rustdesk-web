import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers.js';

describe('static UI serving', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.stop());

  it('serves index.html uncached, pointing at build-versioned assets', async () => {
    const res = await t.request('GET', '/', { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(t.app.buildId, /^[0-9a-f]{12}$/);
    assert.ok(res.data.includes(`src="/v/${t.app.buildId}/assets/app.js"`));
    assert.ok(res.data.includes(`href="/v/${t.app.buildId}/assets/app.css"`));
    assert.ok(!res.data.includes('"/assets/'));
  });

  it('caches current-build assets forever', async () => {
    const res = await t.request('GET', `/v/${t.app.buildId}/assets/client/session.js`, { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(res.headers.get('content-type'), /javascript/);
  });

  it('still serves an older build URL, uncached', async () => {
    const res = await t.request('GET', '/v/0123456789ab/assets/app.js', { raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('keeps unversioned asset paths working', async () => {
    assert.equal((await t.request('GET', '/assets/favicon.svg', { raw: true })).status, 200);
  });

  it('does not escape public/ through the versioned prefix', async () => {
    for (const p of [`/v/${t.app.buildId}/../../package.json`, `/v/${t.app.buildId}/%2e%2e/%2e%2e/package.json`]) {
      assert.equal((await t.request('GET', p, { raw: true })).status, 404, p);
    }
  });
});
