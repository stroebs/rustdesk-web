import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { decode, encode } from '../public/assets/client/protobuf.js';
import { messages } from '../public/assets/client/schema.js';

// Vectors encoded by protobufjs from proto/*.proto (one random message per type).
// The full randomized cross-check against protobufjs runs outside CI.
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/protobuf-vectors.json', import.meta.url), 'utf8'));

const b64 = (u8) => Buffer.from(u8).toString('base64');
function canon(type, obj) {
  const out = {};
  for (const [, name, ftype, kind, repeated, oneof] of messages[type]) {
    const v = obj[name];
    if (v === undefined || v === null) continue;
    const norm = (x) => (kind === 'm' ? canon(ftype, x) : kind === 'e' ? Number(x) : ftype === 'bytes' ? b64(x) : ftype === 'bool' || ftype === 'string' ? x : String(x));
    if (repeated) {
      if (v.length) out[name] = v.map(norm);
      continue;
    }
    const n = norm(v);
    if (!oneof && kind !== 'm' && (n === '0' || n === 0 || n === false || n === '')) continue;
    out[name] = n;
  }
  return out;
}

describe('protobuf runtime', () => {
  it('generated schema matches proto/*.proto', () => {
    execFileSync(process.execPath, ['tools/gen-proto.mjs', '--check'], { stdio: 'pipe' });
  });

  it(`decodes ${vectors.length} protobufjs-encoded vectors and re-encodes them losslessly`, () => {
    for (const { type, hex, canonical } of vectors) {
      const decoded = decode(type, Buffer.from(hex, 'hex'));
      assert.deepEqual(canon(type, decoded), canonical, `decode ${type}`);
      assert.deepEqual(canon(type, decode(type, encode(type, decoded))), canonical, `round trip ${type}`);
    }
  });

  it('marks the set oneof member', () => {
    const bytes = encode('RendezvousMessage', { relay_response: { uuid: 'u-1', relay_server: 'hbbr', pk: new Uint8Array([1, 2]) } });
    const msg = decode('RendezvousMessage', bytes);
    assert.equal(msg.union, 'relay_response');
    assert.equal(msg.relay_response.union, 'pk');
    assert.deepEqual([...msg.relay_response.pk], [1, 2]);
    assert.equal(msg.relay_response.uuid, 'u-1');
  });

  it('handles 64-bit and negative values exactly', () => {
    const t = { time: -5, last_delay: 4294967295, from_client: true };
    assert.deepEqual(decode('TestDelay', encode('TestDelay', t)), { time: -5, from_client: true, last_delay: 4294967295, target_bitrate: 0 });
    const big = 18446744073709551615n;
    assert.equal(decode('LoginRequest', encode('LoginRequest', { session_id: big })).session_id, big);
    assert.equal(decode('MouseEvent', encode('MouseEvent', { x: -1920, y: 5 })).x, -1920);
  });

  it('skips unknown fields', () => {
    // Field 99 (varint) then a known field: id = "1".
    const bytes = Uint8Array.from([0x98, 0x06, 0x01, 0x0a, 0x01, 0x31]);
    assert.equal(decode('PunchHoleRequest', bytes).id, '1');
  });

  it('rejects truncated input', () => {
    const bytes = encode('PunchHoleRequest', { id: '123456789' });
    assert.throws(() => decode('PunchHoleRequest', bytes.subarray(0, bytes.length - 2)), /truncated/);
  });
});
