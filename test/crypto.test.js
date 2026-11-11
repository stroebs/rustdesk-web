import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Blake2b, blake2b } from '../public/assets/client/blake2b.js';
import nacl from '../public/assets/vendor/nacl.js';

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

// Generated with Python's hashlib.blake2b (independent C implementation); the
// first entry is the RFC 7693 Appendix A "abc" vector.
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/blake2b-vectors.json', import.meta.url), 'utf8'));

describe('BLAKE2b', () => {
  it(`matches ${vectors.length} reference vectors (keyed and unkeyed, across block boundaries)`, () => {
    for (const v of vectors) {
      assert.equal(hex(blake2b(unhex(v.msg), { key: unhex(v.key), outlen: v.outlen })), v.hex, `msg ${v.msg.length / 2}B key ${v.key.length / 2}B out ${v.outlen}`);
    }
  });

  it('gives the same result when fed incrementally', () => {
    const v = vectors.find((x) => x.msg.length / 2 === 1000 && x.key.length / 2 === 32 && x.outlen === 32);
    const msg = unhex(v.msg);
    const h = new Blake2b(32, unhex(v.key));
    for (let i = 0; i < msg.length; i += 37) h.update(msg.subarray(i, i + 37));
    assert.equal(hex(h.digest()), v.hex);
  });

  it('rejects invalid parameters', () => {
    assert.throws(() => new Blake2b(0), /output length/);
    assert.throws(() => new Blake2b(32, new Uint8Array(65)), /key/);
  });
});

describe('vendored tweetnacl', () => {
  it('has a CSPRNG in this environment', () => {
    assert.equal(nacl.randomBytes(32).length, 32);
    assert.notDeepEqual(nacl.randomBytes(16), nacl.randomBytes(16));
  });

  it('opens libsodium-style combined signatures (signature || message)', () => {
    const kp = nacl.sign.keyPair();
    const msg = new TextEncoder().encode('123456789');
    const signed = nacl.sign(msg, kp.secretKey);
    assert.equal(signed.length, 64 + msg.length);
    assert.deepEqual(nacl.sign.open(signed, kp.publicKey), msg);
    signed[70] ^= 1;
    assert.equal(nacl.sign.open(signed, kp.publicKey), null);
  });

  it('round-trips the zero-nonce box used to deliver the session key', () => {
    const peer = nacl.box.keyPair();
    const ours = nacl.box.keyPair();
    const key = nacl.randomBytes(32);
    const zero = new Uint8Array(24);
    const sealed = nacl.box(key, zero, peer.publicKey, ours.secretKey);
    assert.equal(sealed.length, 16 + 32);
    assert.deepEqual(nacl.box.open(sealed, zero, ours.publicKey, peer.secretKey), key);
  });
});
