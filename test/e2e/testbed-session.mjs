// Drive a real session against the testbed peer (see testbed/compose.yml):
// login, video, switching to the second display, and clipboard in both directions.
//   node test/e2e/testbed-session.mjs [password]
import { execFileSync } from 'node:child_process';
import { RemoteSession } from '../../public/assets/client/session.js';
import { sha256 } from '../../public/assets/client/sha256.js';

const peer = (cmd, input) =>
  execFileSync('docker', ['compose', '-f', 'testbed/compose.yml', 'exec', '-T', 'peer', 'sh', '-c', cmd], { input }).toString();
const key = peer('cat /keys/id_ed25519.pub').trim();
const urls = { id: process.env.HBBS_WS ?? 'ws://127.0.0.1:21181', relay: process.env.HBBR_WS ?? 'ws://127.0.0.1:21182' };
const session = new RemoteSession({ openSocket: (kind) => new WebSocket(urls[kind]), peerId: '123456789', key, myName: 'e2e test' });
session.addEventListener('status', (e) => console.log('status:', e.detail));

const fail = (msg) => {
  console.log(`FAIL: ${msg}`);
  process.exit(1);
};
/** Resolve with the first event of `type` satisfying `pred`, or fail after `ms`. */
const waitFor = (type, pred, ms, what) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => fail(`timed out waiting for ${what}`), ms);
    const on = (e) => {
      if (!pred(e.detail)) return;
      clearTimeout(timer);
      session.removeEventListener(type, on);
      resolve(e.detail);
    };
    session.addEventListener(type, on);
  });
const until = async (check, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`timed out waiting for ${what}`);
};

const t0 = Date.now();
let info;
try {
  info = await session.connect(process.argv[2] ?? 'testbed-password');
} catch (err) {
  console.log(`FAIL (${err.code}): ${err.message}`);
  process.exit(2);
}
console.log(`logged in after ${Date.now() - t0}ms (kx_version ${session.kxVersion}): ${info.hostname} ${info.platform} ${info.version} displays: ${info.displays.map((d) => `${d.width}x${d.height}@${d.x},${d.y}`).join(' ')}`);

// 1. Video on the first display.
let frames = 0;
session.addEventListener('video', (e) => { frames += e.detail.frames.length; });
const first = await waitFor('video', () => true, 10000, 'video');
console.log(`first video frame after ${Date.now() - t0}ms: codec ${first.codec}, display ${first.display}, ${first.frames[0].data.length} bytes, key=${first.frames[0].key}`);
await until(() => frames >= 30, 10000, '30 frames');
console.log(`OK video: ${frames} frames`);

// 2. Switch to the second display.
if (info.displays.length >= 2) {
  const switched = waitFor('display', (d) => d.index === 1, 10000, 'display switch confirmation');
  const onSecond = waitFor('video', (v) => v.display === 1 && v.frames.some((f) => f.key), 10000, 'a keyframe from display 1');
  session.switchDisplay(1);
  const { display } = await switched;
  await onSecond;
  if (display.x !== 1280) fail(`display 1 reported at x=${display.x}, expected 1280`);
  console.log(`OK display switch: now streaming display 1 (${display.width}x${display.height}@${display.x},${display.y})`);
} else {
  console.log('SKIP display switch: peer has one display');
}

// 3. Clipboard, device -> browser. Checked first: once a client has set the clipboard of
// an X11 peer, RustDesk 1.5.1's listener often misses the next local change there. Long and repetitive so the peer zstd-compresses it.
const fromDevice = `device clipboard ${Date.now()} — ünïcødé ✓\n${'repeated line of text\n'.repeat(200)}`;
const received = waitFor('clipboard', (text) => text === fromDevice, 15000, 'the device clipboard');
peer('DISPLAY=:99 xclip -selection clipboard -i', fromDevice);
await received;
console.log(`OK clipboard from device (${new TextEncoder().encode(fromDevice).length} bytes)`);

// 4. Clipboard, browser -> device.
const toDevice = `from the browser ${Date.now()} ✓`;
session.sendClipboardText(toDevice);
let onDevice = '';
await until(() => (onDevice = peer('DISPLAY=:99 xclip -o -selection clipboard 2>/dev/null || true')) === toDevice, 10000, `device clipboard to become "${toDevice}" (is "${onDevice}")`);
console.log('OK clipboard to device');
session.close();

// 5. Log in again with only the saved form of the password (sha256(password + salt)), as
// the console does for remembered passwords: the device's challenge is answered from it.
const saved = session.passwordHash;
if (saved?.hash?.length !== 32) fail('no password hash after a password login');
let challenged = false;
const again = new RemoteSession({ openSocket: (kind) => new WebSocket(urls[kind]), peerId: '123456789', key, myName: 'e2e test (saved password)' });
await again.connect({
  answer: async (salt, challenge) => {
    challenged = true;
    if (salt !== saved.salt) fail(`device salt changed: ${salt} vs ${saved.salt}`);
    return sha256(saved.hash, new TextEncoder().encode(challenge));
  },
}).catch((err) => fail(`login with the saved password failed (${err.code}): ${err.message}`));
if (!challenged) fail('device never sent a challenge');
again.close();
console.log('OK login with saved password');

console.log('OK: all checks passed');
process.exit(0);
