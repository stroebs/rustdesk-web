// BLAKE2b (RFC 7693), keyed, variable output length: libsodium's crypto_generichash.
// Used only to derive the per-direction session keys of key exchange version 1,
// twice per session, so this favours clarity (BigInt) over speed.

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;

function compress(h, block, t, last) {
  const m = new Array(16);
  const dv = new DataView(block.buffer, block.byteOffset, 128);
  for (let i = 0; i < 16; i++) m[i] = dv.getBigUint64(i * 8, true);
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= t >> 64n;
  if (last) v[14] ^= MASK;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]);
    G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]);
    G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]);
    G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]);
    G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Incremental keyed BLAKE2b, mirroring libsodium's generichash state API. */
export class Blake2b {
  constructor(outlen = 32, key = new Uint8Array(0)) {
    if (outlen < 1 || outlen > 64) throw new Error('blake2b: output length must be 1..64');
    if (key.length > 64) throw new Error('blake2b: key longer than 64 bytes');
    this.outlen = outlen;
    this.h = [...IV];
    this.h[0] ^= 0x01010000n ^ (BigInt(key.length) << 8n) ^ BigInt(outlen);
    this.t = 0n;
    this.buf = new Uint8Array(128);
    this.len = 0;
    if (key.length) {
      this.update(key);
      this.len = 128; // the key occupies one full (zero-padded) block
    }
  }

  update(data) {
    for (const byte of data) {
      if (this.len === 128) {
        this.t += 128n;
        compress(this.h, this.buf, this.t, false);
        this.buf.fill(0);
        this.len = 0;
      }
      this.buf[this.len++] = byte;
    }
    return this;
  }

  digest() {
    this.t += BigInt(this.len);
    this.buf.fill(0, this.len);
    compress(this.h, this.buf, this.t, true);
    const out = new Uint8Array(64);
    const dv = new DataView(out.buffer);
    this.h.forEach((x, i) => dv.setBigUint64(i * 8, x, true));
    return out.slice(0, this.outlen);
  }
}

export function blake2b(data, { key, outlen = 64 } = {}) {
  return new Blake2b(outlen, key).update(data).digest();
}
