// RustDesk remote session over WebSocket: rendezvous with hbbs, relay through
// hbbr, end-to-end encryption with the peer, password login, then a stream of
// protocol messages. Mirrors rustdesk/src/client.rs (Client::start, secure_connection,
// create_relay, handle_hash) for the relay-only path a browser can use.
//
// Runs in browsers and in Node.js (tests): the caller supplies `openSocket(kind)`
// returning a WebSocket for kind 'id' (hbbs) or 'relay' (hbbr).

import nacl from '../vendor/nacl.js';
import { Blake2b } from './blake2b.js';
import { decode, encode, enums } from './protobuf.js';
import { sha256 } from './sha256.js';

const KX_VERSION_LATEST = 1;
const KX_SPLIT_CONTEXT = new TextEncoder().encode('rdkx-spl');
// Version we report to the peer; it enables the features this client implements.
export const CLIENT_VERSION = '1.4.0';
const CONNECT_TIMEOUT = 18_000;
const READ_TIMEOUT = 18_000;

export const MOUSE = {
  MOVE: 0, DOWN: 1, UP: 2, WHEEL: 3,
  LEFT: 0x01, RIGHT: 0x02, MIDDLE: 0x04, BACK: 0x08, FORWARD: 0x10,
};

export class SessionError extends Error {
  constructor(message, code = 'error') {
    super(message);
    this.code = code;
  }
}

const utf8 = (s) => new TextEncoder().encode(s);
const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function base64ToBytes(s) {
  const bin = atob(s.trim());
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Promise-based reader over a WebSocket carrying one protobuf message per binary frame. */
class Channel {
  #queue = [];
  #waiters = [];
  #closed = null;

  static open(ws, timeoutMs = CONNECT_TIMEOUT) {
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new SessionError('Timed out connecting to the server', 'timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Channel(ws));
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new SessionError('Could not connect to the server', 'network'));
      }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.cipher = null;
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') return;
      let bytes = new Uint8Array(e.data);
      try {
        if (this.cipher) bytes = this.cipher.open(bytes);
      } catch (err) {
        this.#fail(err);
        ws.close();
        return;
      }
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(bytes);
      else this.#queue.push(bytes);
    });
    ws.addEventListener('close', (e) => this.#fail(new SessionError(e.reason || 'Connection closed', 'closed')));
  }

  #fail(err) {
    if (this.#closed) return;
    this.#closed = err;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  get closed() {
    return this.#closed;
  }

  next(timeoutMs = READ_TIMEOUT) {
    if (this.#queue.length) return Promise.resolve(this.#queue.shift());
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new SessionError('Timed out waiting for the remote device', 'timeout'));
      }, timeoutMs);
      waiter.resolve = (v) => { clearTimeout(timer); resolve(v); };
      waiter.reject = (e) => { clearTimeout(timer); reject(e); };
      this.#waiters.push(waiter);
    });
  }

  send(bytes) {
    if (this.#closed) throw this.#closed;
    this.ws.send(this.cipher ? this.cipher.seal(bytes) : bytes);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** secretbox stream cipher with little-endian counter nonces (hbb_common::tcp::Encrypt). */
export class Cipher {
  constructor(sendKey, recvKey = sendKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendSeq = 0n;
    this.recvSeq = 0n;
  }

  static nonce(seq) {
    const n = new Uint8Array(nacl.secretbox.nonceLength);
    new DataView(n.buffer).setBigUint64(0, seq, true);
    return n;
  }

  seal(data) {
    this.sendSeq += 1n;
    return nacl.secretbox(data, Cipher.nonce(this.sendSeq), this.sendKey);
  }

  open(data) {
    // Messages of 0-1 bytes are never encrypted (hbb_common skips them on both sides).
    if (data.length <= 1) return data;
    this.recvSeq += 1n;
    const out = nacl.secretbox.open(data, Cipher.nonce(this.recvSeq), this.recvKey);
    if (!out) throw new SessionError('Decryption failed: the connection was tampered with or desynchronised', 'crypto');
    return out;
  }

  /** Key exchange version 1: one subkey per direction, bound to the handshake transcript. */
  static split(key, { initiatorPk, responderPk, advertised, picked }) {
    const derive = (direction) =>
      new Blake2b(32, key)
        .update(KX_SPLIT_CONTEXT)
        .update([direction])
        .update(u32le(advertised))
        .update(u32le(picked))
        .update(initiatorPk)
        .update(responderPk)
        .digest();
    // We sent the sealed key, so we are the initiator: send with subkey 1, receive with 2.
    return new Cipher(derive(1), derive(2));
  }
}

/** Verify a libsodium combined signature over an IdPk and return it. */
function openIdPk(signed, signerPk) {
  const body = signed?.length ? nacl.sign.open(signed, signerPk) : null;
  return body ? decode('IdPk', body) : null;
}

const PUNCH_FAILURES = {
  [enums['PunchHoleResponse.Failure'].ID_NOT_EXIST]: ['This ID does not exist on the server', 'id_not_exist'],
  [enums['PunchHoleResponse.Failure'].OFFLINE]: ['The remote device is offline', 'offline'],
  [enums['PunchHoleResponse.Failure'].LICENSE_MISMATCH]: ['The server rejected the key: check the public key in Settings', 'key_mismatch'],
  [enums['PunchHoleResponse.Failure'].LICENSE_OVERUSE]: ['The server key is over its usage limit', 'key_overuse'],
};

export class RemoteSession extends EventTarget {
  /**
   * @param {object} o
   * @param {(kind: 'id'|'relay') => WebSocket} o.openSocket
   * @param {string} o.peerId     RustDesk ID to connect to
   * @param {string} o.key        server public key (base64), used for licence_key and peer verification
   * @param {string} o.myId       how this client identifies itself to the peer
   * @param {string} o.myName     display name shown on the remote device
   * @param {object} [o.decoding] e.g. { vp9: true, av1: true, h264: false }
   */
  constructor({ openSocket, peerId, key, myId = 'rustdesk-web', myName = 'RustDesk Web', decoding = { vp9: true } }) {
    super();
    this.openSocket = openSocket;
    this.peerId = String(peerId).replace(/\s/g, '');
    this.key = key;
    this.myId = myId;
    this.myName = myName;
    this.decoding = decoding;
    this.channel = null;
    this.peerInfo = null;
    this.kxVersion = null;
  }

  #emit(type, detail) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  #status(text) {
    this.#emit('status', text);
  }

  /** Rendezvous, relay, secure, log in. Resolves with the peer's PeerInfo. */
  async connect(password) {
    if (!this.key) throw new SessionError('The server public key is not configured', 'no_key');
    const rsPk = base64ToBytes(this.key);
    if (rsPk.length !== nacl.sign.publicKeyLength) throw new SessionError('The server public key is not valid', 'no_key');

    this.#status('Finding the remote device…');
    let { uuid, relayServer, signedIdPk } = await this.#rendezvous();
    if (!uuid) uuid = await this.#requestRelay(relayServer);

    this.#status('Connecting through the relay…');
    const channel = await Channel.open(this.openSocket('relay'));
    this.channel = channel;
    channel.send(encode('RendezvousMessage', {
      request_relay: { licence_key: this.key, id: this.peerId, uuid, conn_type: enums.ConnType.DEFAULT_CONN },
    }));

    this.#status('Securing the connection…');
    await this.#secure(signedIdPk, rsPk);

    this.#status('Logging in…');
    const peerInfo = await this.#login(password);
    this.peerInfo = peerInfo;
    this.#pump();
    return peerInfo;
  }

  async #rendezvous() {
    const ch = await Channel.open(this.openSocket('id'));
    try {
      const request = encode('RendezvousMessage', {
        punch_hole_request: {
          id: this.peerId,
          // A browser can only use the relay: declare a symmetric NAT and force it.
          nat_type: enums.NatType.SYMMETRIC,
          licence_key: this.key,
          conn_type: enums.ConnType.DEFAULT_CONN,
          version: CLIENT_VERSION,
          force_relay: true,
        },
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        ch.send(request);
        const deadline = Date.now() + attempt * 3000;
        while (Date.now() < deadline) {
          let msg;
          try {
            msg = decode('RendezvousMessage', await ch.next(deadline - Date.now()));
          } catch (err) {
            if (err.code === 'timeout') break;
            throw err;
          }
          if (msg.union === 'punch_hole_response') {
            const ph = msg.punch_hole_response;
            if (!ph.socket_addr.length) {
              if (ph.other_failure) throw new SessionError(ph.other_failure, 'refused');
              const [text, code] = PUNCH_FAILURES[ph.failure] ?? ['The server could not reach the remote device', 'punch_failed'];
              throw new SessionError(text, code);
            }
            // The peer answered with a direct address we cannot use; ask for a relay instead.
            return { uuid: null, relayServer: ph.relay_server, signedIdPk: ph.pk };
          }
          if (msg.union === 'relay_response') {
            const rr = msg.relay_response;
            if (rr.refuse_reason) throw new SessionError(rr.refuse_reason, 'refused');
            return { uuid: rr.uuid, relayServer: rr.relay_server, signedIdPk: rr.pk ?? new Uint8Array(0) };
          }
          // key_exchange and anything else: not for us.
        }
      }
      throw new SessionError('The remote device did not answer. It may be offline or unable to reach the relay server.', 'timeout');
    } finally {
      ch.close();
    }
  }

  async #requestRelay(relayServer) {
    const uuid = crypto.randomUUID();
    const ch = await Channel.open(this.openSocket('id'));
    try {
      ch.send(encode('RendezvousMessage', { request_relay: { id: this.peerId, uuid, relay_server: relayServer, secure: true } }));
      for (;;) {
        const msg = decode('RendezvousMessage', await ch.next(CONNECT_TIMEOUT));
        if (msg.union !== 'relay_response') continue;
        if (msg.relay_response.refuse_reason) throw new SessionError(msg.relay_response.refuse_reason, 'refused');
        return uuid;
      }
    } finally {
      ch.close();
    }
  }

  async #secure(signedIdPk, rsPk) {
    // 1. hbbs vouches for the peer's long-term signing key.
    const vouched = openIdPk(signedIdPk, rsPk);
    if (!vouched || vouched.id !== this.peerId || vouched.pk.length !== nacl.sign.publicKeyLength) {
      // The native client falls back to an unencrypted session here; we refuse.
      throw new SessionError('Could not verify the remote device with the server key. Check the public key in Settings.', 'unverified');
    }
    // 2. The peer signs a fresh box key with it.
    const first = decode('Message', await this.channel.next());
    if (first.union !== 'signed_id') throw new SessionError('Unexpected handshake from the remote device', 'handshake');
    const offer = openIdPk(first.signed_id.id, vouched.pk);
    if (!offer || offer.id !== this.peerId || offer.pk.length !== nacl.box.publicKeyLength) {
      throw new SessionError('The remote device failed identity verification', 'unverified');
    }
    // 3. Seal a random session key to it and switch to encryption.
    const ours = nacl.box.keyPair();
    const key = nacl.randomBytes(nacl.secretbox.keyLength);
    const sealed = nacl.box(key, new Uint8Array(nacl.box.nonceLength), offer.pk, ours.secretKey);
    const picked = Math.min(offer.kx_version ?? 0, KX_VERSION_LATEST);
    this.channel.send(encode('Message', { public_key: { asymmetric_value: ours.publicKey, symmetric_value: sealed, kx_version: picked } }));
    this.channel.cipher = picked >= 1
      ? Cipher.split(key, { initiatorPk: ours.publicKey, responderPk: offer.pk, advertised: offer.kx_version, picked })
      : new Cipher(key);
    this.kxVersion = picked;
  }

  async #login(password) {
    for (;;) {
      const msg = decode('Message', await this.channel.next());
      if (msg.union === 'hash') {
        const { salt, challenge } = msg.hash;
        const stored = sha256(utf8(password), utf8(salt));
        const answer = sha256(stored, utf8(challenge));
        this.channel.send(encode('Message', { login_request: this.#loginRequest(answer) }));
      } else if (msg.union === 'login_response') {
        const r = msg.login_response;
        if (r.union === 'error') throw new SessionError(r.error, /password/i.test(r.error) ? 'bad_password' : 'login');
        if (r.union === 'peer_info') return r.peer_info;
      } else if (msg.union === 'test_delay') {
        this.#echoTestDelay(msg.test_delay);
      } else if (msg.union === 'message_box') {
        this.#emit('message_box', msg.message_box);
      } else if (msg.union === 'misc' && msg.misc.union === 'close_reason') {
        throw new SessionError(msg.misc.close_reason, 'closed');
      }
    }
  }

  #loginRequest(password) {
    const d = this.decoding;
    const { PreferCodec } = { PreferCodec: enums['SupportedDecoding.PreferCodec'] };
    const yes = enums['OptionMessage.BoolOption'].Yes;
    return {
      username: this.peerId,
      password,
      my_id: this.myId,
      my_name: this.myName,
      my_platform: 'Web',
      session_id: new DataView(nacl.randomBytes(8).buffer).getBigUint64(0) & ((1n << 63n) - 1n),
      version: CLIENT_VERSION,
      option: {
        image_quality: enums.ImageQuality.Balanced,
        disable_audio: yes,
        disable_clipboard: yes,
        supported_decoding: {
          ability_vp9: d.vp9 ? 1 : 0,
          ability_vp8: d.vp8 ? 1 : 0,
          ability_av1: d.av1 ? 1 : 0,
          ability_h264: d.h264 ? 1 : 0,
          ability_h265: d.h265 ? 1 : 0,
          prefer: d.vp9 ? PreferCodec.VP9 : PreferCodec.Auto,
        },
      },
    };
  }

  #echoTestDelay(t) {
    if (!t.from_client) this.send({ test_delay: t });
  }

  async #pump() {
    this.#emit('connected', this.peerInfo);
    try {
      for (;;) {
        const msg = decode('Message', await this.channel.next(10 * 60_000));
        switch (msg.union) {
          case 'video_frame': {
            const v = msg.video_frame;
            const codec = { vp9s: 'vp9', vp8s: 'vp8', av1s: 'av1', h264s: 'h264', h265s: 'h265' }[v.union];
            if (codec) this.#emit('video', { codec, display: v.display, frames: v[v.union].frames });
            break;
          }
          case 'test_delay':
            this.#echoTestDelay(msg.test_delay);
            break;
          case 'peer_info':
            this.peerInfo = msg.peer_info;
            this.#emit('peer_info', msg.peer_info);
            break;
          case 'misc':
            if (msg.misc.union === 'close_reason') {
              this.#emit('closed', { reason: msg.misc.close_reason });
              this.close();
              return;
            }
            this.#emit('misc', msg.misc);
            break;
          case 'message_box':
            this.#emit('message_box', msg.message_box);
            break;
          default:
            this.#emit('message', msg);
        }
      }
    } catch (err) {
      if (!this.closedByUser) this.#emit('closed', { reason: err.message, error: err });
    }
  }

  /** Send a Message (plain object, e.g. { mouse_event: {...} }). */
  send(message) {
    this.channel?.send(encode('Message', message));
  }

  sendMouse(mask, x, y, modifiers = []) {
    this.send({ mouse_event: { mask, x: Math.round(x), y: Math.round(y), modifiers } });
  }

  sendKey(event) {
    this.send({ key_event: { mode: enums.KeyboardMode.Legacy, ...event } });
  }

  close() {
    this.closedByUser = true;
    this.channel?.close();
  }
}

export { Channel };
