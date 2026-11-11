// Minimal proto3 runtime driven by the generated schema (schema.js).
//
// Messages are plain objects with the .proto field names. A set oneof member is
// its own property, and the group name tells which one is set:
//   decode('RendezvousMessage', bytes) -> { union: 'relay_response', relay_response: {...} }
//   encode('RendezvousMessage', { punch_hole_request: { id: '123' } })
//
// 64-bit integers decode to Number when exactly representable, BigInt otherwise.
// Works in browsers and Node.js (used by the tests).

import { enums, messages } from './schema.js';

export { enums };

const utf8enc = new TextEncoder();
const utf8dec = new TextDecoder();
const TWO32 = 4294967296;

const WIRE = {
  double: 1, fixed64: 1, sfixed64: 1,
  float: 5, fixed32: 5, sfixed32: 5,
  string: 2, bytes: 2,
};
const wireOf = (f) => (f.kind === 'm' ? 2 : f.kind === 'e' ? 0 : WIRE[f.type] ?? 0);
const packable = (f) => f.repeated && f.kind !== 'm' && f.type !== 'string' && f.type !== 'bytes';

const cache = new Map();
function schemaOf(type) {
  let s = cache.get(type);
  if (!s) {
    const raw = messages[type];
    if (!raw) throw new Error(`protobuf: unknown message ${type}`);
    const fields = raw.map(([no, name, ftype, kind, repeated, oneof]) => ({ no, name, type: ftype, kind, repeated: Boolean(repeated), oneof }));
    s = { fields: [...fields].sort((a, b) => a.no - b.no), byNo: new Map(fields.map((f) => [f.no, f])) };
    cache.set(type, s);
  }
  return s;
}

function scalarDefault(f) {
  if (f.kind === 'e') return 0;
  switch (f.type) {
    case 'bool': return false;
    case 'string': return '';
    case 'bytes': return new Uint8Array(0);
    default: return 0;
  }
}

// ---------------------------------------------------------------- decoding

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Read a varint as two unsigned 32-bit halves. */
  varint64() {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    let b;
    do {
      if (this.pos >= this.end) throw new Error('protobuf: truncated varint');
      b = this.buf[this.pos++];
      if (shift < 28) lo |= (b & 0x7f) << shift;
      else if (shift === 28) {
        lo |= (b & 0x0f) << 28;
        hi |= (b & 0x7f) >>> 4;
      } else hi |= (b & 0x7f) << (shift - 32);
      shift += 7;
      if (shift > 70) throw new Error('protobuf: varint too long');
    } while (b & 0x80);
    return [lo >>> 0, hi >>> 0];
  }

  uint32() {
    return this.varint64()[0];
  }

  bytes(len) {
    if (this.pos + len > this.end) throw new Error('protobuf: truncated field');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire) {
    switch (wire) {
      case 0: this.varint64(); break;
      case 1: this.bytes(8); break;
      case 2: this.bytes(this.uint32()); break;
      case 5: this.bytes(4); break;
      default: throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
}

function toNumberOrBigInt(big) {
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

function fromVarint(type, [lo, hi]) {
  switch (type) {
    case 'bool': return lo !== 0 || hi !== 0;
    case 'uint32': return lo;
    case 'sint32': return (lo >>> 1) ^ -(lo & 1);
    case 'uint64': return hi < 0x200000 ? hi * TWO32 + lo : (BigInt(hi) << 32n) | BigInt(lo);
    case 'int64': return toNumberOrBigInt(BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo)));
    case 'sint64': {
      const u = (BigInt(hi) << 32n) | BigInt(lo);
      return toNumberOrBigInt((u >> 1n) ^ -(u & 1n));
    }
    default: return lo | 0; // int32 and enums: the low 32 bits, signed
  }
}

function readScalar(r, f, wire) {
  if (wire === 0) return fromVarint(f.kind === 'e' ? 'enum' : f.type, r.varint64());
  if (wire === 1) {
    const at = r.pos;
    r.bytes(8);
    if (f.type === 'double') return r.view.getFloat64(at, true);
    const lo = r.view.getUint32(at, true);
    const hi = r.view.getUint32(at + 4, true);
    return fromVarint(f.type === 'sfixed64' ? 'int64' : 'uint64', [lo, hi]);
  }
  if (wire === 5) {
    const at = r.pos;
    r.bytes(4);
    if (f.type === 'float') return r.view.getFloat32(at, true);
    return f.type === 'sfixed32' ? r.view.getInt32(at, true) : r.view.getUint32(at, true);
  }
  const data = r.bytes(r.uint32());
  return f.type === 'string' ? utf8dec.decode(data) : data;
}

function decodeFrom(type, r) {
  const { fields, byNo } = schemaOf(type);
  const obj = {};
  for (const f of fields) {
    if (f.oneof) continue;
    if (f.repeated) obj[f.name] = [];
    else if (f.kind !== 'm') obj[f.name] = scalarDefault(f);
  }
  while (r.pos < r.end) {
    const key = r.uint32();
    const no = key >>> 3;
    const wire = key & 7;
    const f = byNo.get(no);
    if (!f) {
      r.skip(wire);
      continue;
    }
    let value;
    if (f.kind === 'm') {
      if (wire !== 2) throw new Error(`protobuf: ${type}.${f.name} has wire type ${wire}`);
      const len = r.uint32();
      if (r.pos + len > r.end) throw new Error('protobuf: truncated message');
      value = decodeFrom(f.type, new Reader(r.buf, r.pos, r.pos + len));
      r.pos += len;
    } else if (packable(f) && wire === 2) {
      // Packed repeated scalars (the proto3 default).
      const len = r.uint32();
      const sub = new Reader(r.buf, r.pos, r.pos + len);
      r.pos += len;
      const w = wireOf(f);
      while (sub.pos < sub.end) obj[f.name].push(readScalar(sub, f, w));
      continue;
    } else {
      value = readScalar(r, f, wire);
    }
    if (f.repeated) obj[f.name].push(value);
    else {
      obj[f.name] = value;
      if (f.oneof) obj[f.oneof] = f.name;
    }
  }
  return obj;
}

export function decode(type, bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return decodeFrom(type, new Reader(buf));
}

// ---------------------------------------------------------------- encoding

class Writer {
  constructor() {
    this.buf = new Uint8Array(256);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  varint(value) {
    if (typeof value === 'number' && value >= 0 && value <= 0xffffffff && Number.isInteger(value)) {
      let v = value;
      while (v > 0x7f) {
        this.byte((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      this.byte(v);
      return;
    }
    let v = BigInt.asUintN(64, BigInt(value));
    while (v > 0x7fn) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.byte(Number(v));
  }

  raw(bytes) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  fixed(n, setter) {
    this.ensure(n);
    setter(new DataView(this.buf.buffer, this.pos, n));
    this.pos += n;
  }

  finish() {
    return this.buf.slice(0, this.pos);
  }
}

function isDefault(f, v) {
  if (v === null || v === undefined) return true;
  if (f.kind === 'm') return false;
  if (typeof v === 'string' || v instanceof Uint8Array) return v.length === 0;
  if (typeof v === 'bigint') return v === 0n;
  return v === 0 || v === false;
}

function writeScalar(w, f, v) {
  const type = f.kind === 'e' ? 'int32' : f.type;
  switch (type) {
    case 'bool': return w.varint(v ? 1 : 0);
    case 'string': {
      const b = utf8enc.encode(v);
      w.varint(b.length);
      return w.raw(b);
    }
    case 'bytes': {
      const b = v instanceof Uint8Array ? v : new Uint8Array(v);
      w.varint(b.length);
      return w.raw(b);
    }
    case 'sint32': return w.varint(((v << 1) ^ (v >> 31)) >>> 0);
    case 'sint64': {
      const b = BigInt(v);
      return w.varint(BigInt.asUintN(64, (b << 1n) ^ (b >> 63n)));
    }
    case 'double': return w.fixed(8, (dv) => dv.setFloat64(0, v, true));
    case 'float': return w.fixed(4, (dv) => dv.setFloat32(0, v, true));
    case 'fixed32': return w.fixed(4, (dv) => dv.setUint32(0, v, true));
    case 'sfixed32': return w.fixed(4, (dv) => dv.setInt32(0, v, true));
    case 'fixed64': case 'sfixed64': return w.fixed(8, (dv) => dv.setBigUint64(0, BigInt.asUintN(64, BigInt(v)), true));
    default: return w.varint(v); // int32 (negatives become 10 bytes), int64, uint32, uint64, enums
  }
}

function encodeInto(type, obj, w) {
  const { fields } = schemaOf(type);
  for (const f of fields) {
    const v = obj[f.name];
    if (f.repeated) {
      if (!v?.length) continue;
      if (packable(f)) {
        const sub = new Writer();
        for (const item of v) writeScalar(sub, f, item);
        const bytes = sub.finish();
        w.varint((f.no << 3) | 2);
        w.varint(bytes.length);
        w.raw(bytes);
      } else {
        for (const item of v) writeField(w, f, item);
      }
    } else if (f.oneof ? v !== undefined && v !== null : !isDefault(f, v)) {
      writeField(w, f, v);
    }
  }
}

function writeField(w, f, v) {
  if (f.kind === 'm') {
    const sub = new Writer();
    encodeInto(f.type, v, sub);
    const bytes = sub.finish();
    w.varint((f.no << 3) | 2);
    w.varint(bytes.length);
    w.raw(bytes);
  } else {
    w.varint((f.no << 3) | wireOf(f));
    writeScalar(w, f, v);
  }
}

export function encode(type, obj) {
  const w = new Writer();
  encodeInto(type, obj, w);
  return w.finish();
}
