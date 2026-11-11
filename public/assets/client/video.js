// Decodes RustDesk video frames with WebCodecs and paints them on a canvas.
// WebCodecs is only exposed in secure contexts (HTTPS or localhost).

const CODECS = {
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
  av1: 'av01.0.05M.08',
  h264: 'avc1.42E01F', // Annex B: no `description`
  h265: 'hev1.1.6.L93.B0',
};
const MAX_QUEUE = 30;

export const videoSupported = () => typeof globalThis.VideoDecoder === 'function';

/** Which codecs this browser can decode, e.g. { vp9: true, av1: true, h264: false }. */
export async function detectDecoders() {
  const out = {};
  if (!videoSupported()) return out;
  await Promise.all(Object.entries(CODECS).map(async ([name, codec]) => {
    try {
      out[name] = Boolean((await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true })).supported);
    } catch {
      out[name] = false;
    }
  }));
  return out;
}

export class VideoRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onKeyframeNeeded?: () => void, onResize?: (w: number, h: number) => void, onError?: (e: Error) => void }} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.hooks = hooks;
    this.decoder = null;
    this.codec = null;
    this.needKey = true;
    this.frames = 0;
  }

  #reset(requestKey) {
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      /* ignore */
    }
    this.decoder = null;
    this.needKey = true;
    if (requestKey) this.hooks.onKeyframeNeeded?.();
  }

  #create(codec) {
    this.decoder = new VideoDecoder({
      output: (frame) => this.#paint(frame),
      error: (err) => {
        this.hooks.onError?.(err);
        this.#reset(true);
      },
    });
    this.decoder.configure({ codec: CODECS[codec], optimizeForLatency: true });
  }

  #paint(frame) {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.hooks.onResize?.(w, h);
    }
    this.ctx.drawImage(frame, 0, 0);
    frame.close();
    this.frames++;
  }

  /** Feed one VideoFrame message: { codec, frames: [{ data, key, pts }] }. */
  push({ codec, frames }) {
    if (!CODECS[codec]) return;
    if (codec !== this.codec) {
      this.codec = codec;
      this.#reset(false);
    }
    for (const f of frames) {
      if (this.needKey && !f.key) continue;
      if (!this.decoder) this.#create(codec);
      if (this.decoder.decodeQueueSize > MAX_QUEUE) {
        // Falling behind (slow device or tab in background): skip to the next keyframe.
        this.#reset(true);
        continue;
      }
      this.decoder.decode(new EncodedVideoChunk({
        type: f.key ? 'key' : 'delta',
        timestamp: Number(f.pts) * 1000,
        data: f.data,
      }));
      this.needKey = false;
    }
  }

  close() {
    this.#reset(false);
  }
}
