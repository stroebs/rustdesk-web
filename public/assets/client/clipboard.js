// Text clipboard exchange with a RustDesk peer.
//
// Peers send `clipboard` (older clients) or `multi_clipboards` (text, HTML, RTF,
// images... for clients >= 1.3.0); content is zstd-compressed when that makes it
// smaller (rustdesk/src/clipboard.rs). Only plain text is exchanged here.

import { decompress } from '../vendor/fzstd.js';
import { enums } from './protobuf.js';

const TEXT = enums.ClipboardFormat.Text;
// A remote clipboard larger than this is ignored (also guards against zstd bombs).
export const MAX_CLIPBOARD_BYTES = 8 * 1024 * 1024;

/**
 * Content size a zstd frame declares in its header (RFC 8878 section 3.1.1.1), or null
 * if absent. fzstd allocates the declared size up front, so it is checked first.
 */
export function zstdDeclaredSize(b) {
  if (b.length < 6 || b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) return null;
  const fhd = b[4];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const didSize = [0, 1, 2, 4][fhd & 3];
  const fcsSize = fcsFlag === 0 ? singleSegment : [0, 2, 4, 8][fcsFlag];
  if (!fcsSize) return null;
  const at = 5 + (singleSegment ? 0 : 1) + didSize;
  if (b.length < at + fcsSize) return null;
  let size = 0;
  for (let i = fcsSize - 1; i >= 0; i--) size = size * 256 + b[at + i];
  return fcsSize === 2 ? size + 256 : size;
}

function contentOf(cb) {
  if (!cb.compress) return cb.content;
  const declared = zstdDeclaredSize(cb.content);
  if (declared !== null && declared > MAX_CLIPBOARD_BYTES) throw new Error('clipboard too large');
  const out = decompress(cb.content);
  if (out.length > MAX_CLIPBOARD_BYTES) throw new Error('clipboard too large');
  return out;
}

/** The text in a Message's clipboard / multi_clipboards, or null if it carries no text. */
export function clipboardText(msg) {
  const list = msg.union === 'clipboard' ? [msg.clipboard] : msg.union === 'multi_clipboards' ? msg.multi_clipboards.clipboards : [];
  const cb = list.find((c) => (c.format ?? TEXT) === TEXT);
  if (!cb) return null;
  try {
    return new TextDecoder().decode(contentOf(cb));
  } catch {
    return null;
  }
}

/** Message carrying local text to the peer (sent uncompressed; peers accept both). */
export function clipboardMessage(text) {
  return { multi_clipboards: { clipboards: [{ format: TEXT, compress: false, content: new TextEncoder().encode(text) }] } };
}
