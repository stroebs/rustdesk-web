// Drive a real session against the testbed peer (see testbed/compose.yml).
//   node test/e2e/testbed-session.mjs [password]
import { execFileSync } from 'node:child_process';
import { RemoteSession } from '../../public/assets/client/session.js';

const key = execFileSync('docker', ['compose', '-f', 'testbed/compose.yml', 'exec', '-T', 'peer', 'cat', '/keys/id_ed25519.pub']).toString().trim();
const urls = { id: process.env.HBBS_WS ?? 'ws://127.0.0.1:21181', relay: process.env.HBBR_WS ?? 'ws://127.0.0.1:21182' };
const session = new RemoteSession({ openSocket: (kind) => new WebSocket(urls[kind]), peerId: '123456789', key, myName: 'e2e test' });
session.addEventListener('status', (e) => console.log('status:', e.detail));
const t0 = Date.now();
const timer = setTimeout(() => { console.log('FAIL: no video within 20s'); process.exit(1); }, 20000);
try {
  const info = await session.connect(process.argv[2] ?? 'testbed-password');
  console.log(`logged in after ${Date.now() - t0}ms (kx_version ${session.kxVersion}):`, info.hostname, info.platform, info.version, 'displays:', info.displays.map((d) => `${d.width}x${d.height}@${d.x},${d.y}`).join(' '));
} catch (err) {
  console.log(`FAIL (${err.code}): ${err.message}`);
  process.exit(2);
}
let frames = 0;
let keyframes = 0;
session.addEventListener('video', (e) => {
  frames += e.detail.frames.length;
  keyframes += e.detail.frames.filter((f) => f.key).length;
  if (frames === 1) console.log(`first video frame after ${Date.now() - t0}ms: codec ${e.detail.codec}, ${e.detail.frames[0].data.length} bytes, key=${e.detail.frames[0].key}`);
  if (frames >= 30) {
    console.log(`OK: ${frames} frames (${keyframes} key frames)`);
    clearTimeout(timer);
    session.close();
    process.exit(0);
  }
});
session.addEventListener('closed', (e) => { console.log('closed:', e.detail.reason); });
