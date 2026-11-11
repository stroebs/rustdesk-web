import { buttonMask, ctrlAltDelEvent, keyEventFor, toRemote, wheelEvent } from '../client/input.js';
import { MOUSE, RemoteSession } from '../client/session.js';
import { VideoRenderer, detectDecoders, videoSupported } from '../client/video.js';
import { api, enc } from '../lib/api.js';
import { clear, h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { errorBox, field, input } from '../lib/ui.js';

const wsUrl = (kind) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${kind}`;

function shell(title, ...body) {
  return h('div', { class: 'remote-shell' },
    h('header', { class: 'remote-bar' },
      h('a', { class: 'icon-btn', href: '#/devices', title: 'Back to devices', 'aria-label': 'Back to devices' }, icon('x')),
      h('strong', null, title),
    ),
    h('div', { class: 'remote-center' }, ...body),
  );
}

function notice(title, text, extra) {
  return h('div', { class: 'card remote-card' }, h('div', { class: 'card-body stack' }, h('h2', null, title), h('p', { class: 'muted' }, text), extra));
}

/** Explain why the browser can't show video, if it can't. */
function videoProblem() {
  if (videoSupported()) return null;
  if (!window.isSecureContext) {
    return notice('HTTPS is required for remote sessions',
      `Browsers only decode video for pages served over HTTPS (or from localhost). This console is served from ${location.origin}.`,
      h('p', { class: 'muted' }, 'Put the console behind a reverse proxy with a certificate, or set TLS_CERT_FILE and TLS_KEY_FILE so it serves HTTPS itself. See the README.'));
  }
  return notice('This browser cannot decode video', 'Remote sessions need the WebCodecs API: use a current Chrome, Edge, Firefox or Safari.');
}

function connectForm(defaultId) {
  const idInput = input('id', { value: defaultId ?? '', placeholder: '123 456 789', required: true, inputmode: 'numeric', autocomplete: 'off', class: 'mono' });
  const form = h('form', { class: 'form' }, field('RustDesk ID', idInput), h('button', { type: 'submit', class: 'btn primary' }, 'Continue'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = idInput.value.replace(/\s/g, '');
    if (id) location.hash = `#/connect/${enc(id)}`;
  });
  return h('div', { class: 'card remote-card' }, h('div', { class: 'card-body stack' }, h('h2', null, 'Connect to a device'), form));
}

async function session(root, peerId, user) {
  const problem = videoProblem();
  if (problem) return root.append(shell(peerId, problem));

  const [cfg, decoders, device] = await Promise.all([
    api.get('/remote/config'),
    detectDecoders(),
    api.get(`/devices/${enc(peerId)}`).then((r) => r.device).catch(() => null),
  ]);
  const title = device?.hostname ? `${device.hostname} · ${peerId}` : peerId;
  if (!cfg.ready) {
    return root.append(shell(title, notice('Remote sessions are not set up yet', 'The console needs a little more configuration first:',
      h('ul', null, cfg.problems.map((p) => h('li', null, p)), h('li', null, h('a', { href: '#/settings' }, 'Open Settings'))))));
  }

  const status = h('span', { class: 'muted' });
  const bar = h('header', { class: 'remote-bar' },
    h('a', { class: 'icon-btn', href: '#/devices', title: 'Close', 'aria-label': 'Close' }, icon('x')),
    h('strong', null, title),
    status,
    h('span', { class: 'spacer' }),
  );
  const stage = h('div', { class: 'remote-center' });
  const view = h('div', { class: 'remote-shell' }, bar, stage);
  root.append(view);

  let current = null; // { session, renderer, cleanup }

  function showPasswordForm(error) {
    const pw = input('password', { type: 'password', autocomplete: 'off', required: true });
    const err = h('div', { class: ['form-error', !error && 'hidden'], role: 'alert' }, error ?? '');
    const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Connect');
    const form = h('form', { class: 'form' }, err, field('Password', pw, 'The permanent or one-time password shown on the remote device.'), submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      start(pw.value);
    });
    clear(stage).append(h('div', { class: 'card remote-card' }, h('div', { class: 'card-body stack' }, h('h2', null, `Connect to ${title}`), form)));
    pw.focus();
  }

  function showClosed(reason) {
    clear(stage).append(notice('Session ended', reason || 'The connection was closed.',
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => showPasswordForm() }, 'Reconnect'), h('a', { class: 'btn', href: '#/devices' }, 'Back to devices'))));
    status.textContent = '';
  }

  async function start(password) {
    const s = new RemoteSession({
      openSocket: (kind) => new WebSocket(wsUrl(kind)),
      peerId,
      key: cfg.key,
      // Shown on the remote device and in its connection audit log.
      myName: `${user.display_name || user.username} (RustDesk Web)`,
      decoding: decoders,
    });
    s.addEventListener('status', (e) => {
      status.textContent = e.detail;
      clear(stage).append(h('div', { class: 'remote-wait' }, h('div', { class: 'spinner' }), e.detail));
    });
    try {
      await s.connect(password);
    } catch (err) {
      s.close();
      return err.code === 'bad_password' ? showPasswordForm('Wrong password.') : showClosed(err.message);
    }
    api.post('/remote/sessions', { peer_id: peerId, detail: `kx v${s.kxVersion}` }).catch(() => {});
    current = attach(s);
  }

  function attach(s) {
    const canvas = h('canvas', { class: 'remote-canvas', tabindex: 0, 'aria-label': `Screen of ${title}` });
    const wrap = h('div', { class: 'remote-screen fit' }, canvas);
    clear(stage).append(wrap);
    const renderer = new VideoRenderer(canvas, {
      onKeyframeNeeded: () => s.send({ misc: { refresh_video: true } }),
    });
    s.addEventListener('video', (e) => renderer.push(e.detail));
    s.addEventListener('message_box', (e) => { status.textContent = e.detail.text || e.detail.title || ''; });
    s.addEventListener('closed', (e) => {
      cleanup();
      showClosed(e.detail.reason);
    });

    const display = () => s.peerInfo?.displays?.[s.peerInfo.current_display] ?? { x: 0, y: 0 };
    const platform = s.peerInfo?.platform ?? '';
    status.textContent = `Connected · ${platform} ${s.peerInfo?.version ?? ''}`.trim();

    // Mouse: coalesce moves to one per animation frame.
    let pendingMove = null;
    let rafId = 0;
    const point = (e) => toRemote(e.clientX, e.clientY, canvas.getBoundingClientRect(), { width: canvas.width, height: canvas.height }, display());
    const onMove = (e) => {
      if (!canvas.width) return;
      pendingMove = point(e);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (pendingMove) s.sendMouse(MOUSE.MOVE, pendingMove.x, pendingMove.y);
          pendingMove = null;
        });
      }
    };
    const onButton = (down) => (e) => {
      if (!canvas.width) return;
      e.preventDefault();
      if (down) {
        canvas.focus();
        canvas.setPointerCapture?.(e.pointerId);
      }
      const mask = buttonMask(e.button, down);
      if (mask === null) return;
      const p = point(e);
      s.sendMouse(mask, p.x, p.y);
    };
    const onWheel = (e) => {
      e.preventDefault();
      const w = wheelEvent(e);
      if (w.x || w.y) s.sendMouse(w.mask, w.x, w.y);
    };
    const onKey = (down) => (e) => {
      if (document.activeElement !== canvas) return;
      const ev = keyEventFor(e, down);
      if (!ev) return;
      e.preventDefault();
      s.sendKey(ev);
    };
    const keyDown = onKey(true);
    const keyUp = onKey(false);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onButton(true));
    canvas.addEventListener('pointerup', onButton(false));
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);

    // Toolbar
    const tools = h('span', { class: 'row remote-tools' },
      h('button', { type: 'button', class: 'btn sm', onclick: () => s.sendKey(ctrlAltDelEvent(platform)) }, 'Ctrl+Alt+Del'),
      h('button', {
        type: 'button',
        class: 'btn sm',
        onclick: (e) => {
          const fit = wrap.classList.toggle('fit');
          e.currentTarget.textContent = fit ? 'Actual size' : 'Fit to window';
        },
      }, 'Actual size'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : view.requestFullscreen?.()) }, 'Full screen'),
      h('button', { type: 'button', class: 'btn sm danger', onclick: () => { s.close(); cleanup(); showClosed('You disconnected.'); } }, 'Disconnect'),
    );
    bar.append(tools);
    canvas.focus();

    function cleanup() {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      cancelAnimationFrame(rafId);
      renderer.close();
      tools.remove();
      current = null;
    }
    return { session: s, cleanup };
  }

  // Leaving the page ends the session.
  const onHash = () => {
    if (!view.isConnected || !location.hash.startsWith(`#/connect/${enc(peerId)}`)) {
      current?.session.close();
      current?.cleanup();
      window.removeEventListener('hashchange', onHash);
    }
  };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', () => current?.session.close(), { once: true });

  showPasswordForm();
}

export default {
  title: 'Remote session',
  fullscreen: true,
  async render({ root, params, session: me }) {
    const peerId = params[0];
    if (!peerId) return root.append(shell('Remote session', videoProblem() ?? connectForm()));
    try {
      await session(root, peerId, me.user);
    } catch (err) {
      root.append(shell(peerId, errorBox(err)));
    }
  },
};
