import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { MAX_CLIPBOARD_BYTES, clipboardMessage, clipboardText, zstdDeclaredSize } from '../public/assets/client/clipboard.js';
import { decode, encode, enums } from '../public/assets/client/protobuf.js';
import { decompress } from '../public/assets/vendor/fzstd.js';

// Produced by the zstd CLI (libzstd 1.5.7) at levels 1/3/19, with and without checksums.
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/zstd-vectors.json', import.meta.url), 'utf8'));
const TEXT = enums.ClipboardFormat.Text;
const roundTrip = (m) => decode('Message', encode('Message', m));

describe('vendored fzstd', () => {
  it(`decodes ${vectors.length} libzstd frames exactly`, () => {
    for (const v of vectors) {
      const out = decompress(new Uint8Array(Buffer.from(v.zst, 'hex')));
      assert.equal(out.length, v.len, v.name);
      assert.equal(crypto.createHash('sha256').update(out).digest('hex'), v.sha256, v.name);
    }
  });
});

describe('clipboard messages', () => {
  it('reads text from compressed multi_clipboards, as peers >= 1.3 send it', () => {
    const v = vectors.find((x) => x.name === 'sentence.l3.zst');
    const msg = roundTrip({ multi_clipboards: { clipboards: [
      { format: enums.ClipboardFormat.Html, content: new TextEncoder().encode('<b>x</b>') },
      { format: TEXT, compress: true, content: Buffer.from(v.zst, 'hex') },
    ] } });
    assert.equal(clipboardText(msg), 'Clipboard from the remote side — ünïcødé ✓ 日本語');
  });

  it('reads text from a plain clipboard message', () => {
    const msg = roundTrip({ clipboard: { format: TEXT, content: new TextEncoder().encode('hello') } });
    assert.equal(clipboardText(msg), 'hello');
  });

  it('ignores messages without text', () => {
    assert.equal(clipboardText(roundTrip({ multi_clipboards: { clipboards: [{ format: enums.ClipboardFormat.ImagePng, content: new Uint8Array([1]) }] } })), null);
    assert.equal(clipboardText(roundTrip({ test_delay: { time: 1 } })), null);
  });

  it('builds an uncompressed text message the peer understands', () => {
    const msg = roundTrip(clipboardMessage('from the browser ✓'));
    assert.equal(msg.union, 'multi_clipboards');
    assert.equal(msg.multi_clipboards.clipboards[0].compress, false);
    assert.equal(clipboardText(msg), 'from the browser ✓');
  });

  it('reads the content size declared in zstd frame headers', () => {
    for (const v of vectors) {
      const declared = zstdDeclaredSize(Buffer.from(v.zst, 'hex'));
      assert.ok(declared === null || declared === v.len, `${v.name}: ${declared} vs ${v.len}`);
    }
    assert.ok(vectors.some((v) => zstdDeclaredSize(Buffer.from(v.zst, 'hex')) === v.len), 'at least one frame declares its size');
  });

  it('refuses a frame that declares more than the limit, without decoding it', () => {
    // Magic, FHD = FCS flag 3 (8-byte size) + single segment, size = 1 GiB, then junk.
    const bomb = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 0x40, 0, 0, 0, 0, 1, 2, 3]);
    assert.equal(zstdDeclaredSize(bomb), 2 ** 30);
    assert.ok(2 ** 30 > MAX_CLIPBOARD_BYTES);
    const msg = roundTrip({ clipboard: { format: TEXT, compress: true, content: bomb } });
    assert.equal(clipboardText(msg), null);
  });
});
