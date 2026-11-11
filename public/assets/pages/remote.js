import { buttonMask, ctrlAltDelEvent, isPasteShortcut, keyEventFor, pasteKeyEvent, toRemote, wheelEvent } from '../client/input.js';
import { MOUSE, RemoteSession } from '../client/session.js';
import { VideoRenderer, detectDecoders, videoSupported } from '../client/video.js';
import { api, enc } from '../lib/api.js';
import { clear, h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { checkbox, errorBox, field, input, toast } from '../lib/ui.js';

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

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

  const passwordUrl = `/remote/passwords/${enc(peerId)}`;
  const [cfg, decoders, device, savedInfo] = await Promise.all([
    api.get('/remote/config'),
    detectDecoders(),
    api.get(`/devices/${enc(peerId)}`).then((r) => r.device).catch(() => null),
    api.get(passwordUrl).catch(() => ({ saved: false })),
  ]);
  // A password saved for this device (by this administrator) is used without asking.
  let saved = savedInfo.saved;
  let remember = true;
  let savedProblem = null;
  // Logs in with the saved password: the console answers the device's challenge.
  const SAVED = {
    async answer(salt, challenge) {
      try {
        return fromBase64((await api.post(`${passwordUrl}/answer`, { salt, challenge })).answer);
      } catch (err) {
        if (err.status !== 404 && err.status !== 409) throw err;
        saved = false;
        savedProblem = err.status === 409 ? 'The password on the device has changed.' : null;
        return null;
      }
    },
  };
  const forgetPassword = async () => {
    saved = false;
    await api.del(passwordUrl);
  };
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
    const rememberBox = checkbox('remember', 'Remember password', remember);
    const form = h('form', { class: 'form' }, err, field('Password', pw, 'The permanent or one-time password shown on the remote device.'),
      h('div', { class: 'stack-sm' }, rememberBox, h('span', { class: 'field-hint' }, 'Saved for your account only, as a salted hash (like the RustDesk app), never the password itself.')),
      submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      remember = form.elements.remember.checked;
      start(pw.value);
    });
    clear(stage).append(h('div', { class: 'card remote-card' }, h('div', { class: 'card-body stack' }, h('h2', null, `Connect to ${title}`), form)));
    pw.focus();
  }

  function showClosed(reason) {
    clear(stage).append(notice('Session ended', reason || 'The connection was closed.',
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => (saved ? start(SAVED) : showPasswordForm()) }, 'Reconnect'), h('a', { class: 'btn', href: '#/devices' }, 'Back to devices'))));
    status.textContent = '';
  }

  async function start(credential) {
    const usingSaved = credential === SAVED;
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
      await s.connect(credential);
    } catch (err) {
      s.close();
      if (err.code !== 'bad_password') return showClosed(err.message);
      if (!usingSaved) return showPasswordForm('Wrong password.');
      // The saved password was refused (or is gone): forget it and ask.
      if (saved) await forgetPassword().catch(() => {});
      const why = savedProblem ?? 'The saved password no longer works.';
      savedProblem = null;
      return showPasswordForm(`${why} Enter the current password.`);
    }
    if (!usingSaved && remember && s.passwordHash) {
      api.put(passwordUrl, { salt: s.passwordHash.salt, hash: toBase64(s.passwordHash.hash) })
        .then(() => { saved = true; current?.showForget(); }, () => toast('Could not save the password', 'error'));
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
    // While switching displays, frames of the previous one can still be in flight.
    s.addEventListener('video', (e) => {
      if ((s.peerInfo?.displays?.length ?? 1) > 1 && e.detail.display !== s.peerInfo.current_display) return;
      renderer.push(e.detail);
    });
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
    // Paste: on Ctrl/Cmd+V the browser fires a paste event carrying the local
    // clipboard. Send that text to the device first, then the device's own paste
    // keystroke. If no paste event arrives (nothing to paste), just send the keys.
    let pasteTimer = 0;
    let swallowPasteKeyUp = false;
    const sendPaste = () => {
      clearTimeout(pasteTimer);
      pasteTimer = 0;
      s.sendKey(pasteKeyEvent(platform));
    };
    const onPaste = (e) => {
      if (document.activeElement !== canvas) return;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain');
      if (text) s.sendClipboardText(text);
      sendPaste();
    };
    const onKey = (down) => (e) => {
      if (document.activeElement !== canvas) return;
      if (down && isPasteShortcut(e)) {
        // No preventDefault: that would cancel the paste event.
        swallowPasteKeyUp = true;
        clearTimeout(pasteTimer);
        pasteTimer = setTimeout(sendPaste, 300);
        return;
      }
      if (!down && swallowPasteKeyUp && e.key?.toLowerCase() === 'v') {
        swallowPasteKeyUp = false;
        return;
      }
      const ev = keyEventFor(e, down);
      if (!ev) return;
      e.preventDefault();
      s.sendKey(ev);
    };

    // Device clipboard -> local clipboard. Browsers may refuse without focus or a
    // user gesture; then offer a button instead.
    let remoteClip = null;
    const copyButton = h('button', { type: 'button', class: 'btn sm hidden', title: 'The remote device copied text; click to copy it here' }, 'Copy remote clipboard');
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(remoteClip ?? '');
        copyButton.classList.add('hidden');
        toast('Copied the remote clipboard');
      } catch (err) {
        toast(`Could not copy: ${err.message}`, 'error');
      }
      canvas.focus();
    });
    s.addEventListener('clipboard', async (e) => {
      remoteClip = e.detail;
      try {
        await navigator.clipboard.writeText(remoteClip);
        copyButton.classList.add('hidden');
      } catch {
        copyButton.classList.remove('hidden');
      }
    });

    // Display switcher (only when the device has more than one).
    const displayButtons = (s.peerInfo?.displays ?? []).map((d, i) =>
      h('button', {
        type: 'button',
        class: 'btn sm',
        title: `Display ${i + 1}${d.name ? ` (${d.name})` : ''}, ${d.width}×${d.height}`,
        'aria-label': `Show display ${i + 1}`,
        onclick: () => {
          if (i === s.peerInfo.current_display) return;
          renderer.waitForKeyframe();
          s.switchDisplay(i);
          canvas.focus();
        },
      }, String(i + 1)));
    const markDisplay = () => displayButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === s.peerInfo.current_display)));
    s.addEventListener('display', () => {
      renderer.waitForKeyframe();
      markDisplay();
    });
    markDisplay();
    const keyDown = onKey(true);
    const keyUp = onKey(false);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onButton(true));
    canvas.addEventListener('pointerup', onButton(false));
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('paste', onPaste);

    // Toolbar
    const tools = h('span', { class: 'row remote-tools' },
      copyButton,
      displayButtons.length > 1 ? h('span', { class: 'segmented', role: 'group', 'aria-label': 'Displays' }, h('span', { class: 'muted' }, 'Display'), displayButtons) : null,
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
    const forget = h('button', {
      type: 'button',
      class: 'btn sm',
      title: 'Ask for the password next time',
      onclick: async () => {
        await forgetPassword();
        forget.remove();
        toast('Saved password forgotten');
      },
    }, 'Forget password');
    const showForget = () => { if (!forget.isConnected) tools.insertBefore(forget, tools.lastChild); };
    if (saved) showForget();
    bar.append(tools);
    canvas.focus();

    function cleanup() {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('paste', onPaste);
      clearTimeout(pasteTimer);
      cancelAnimationFrame(rafId);
      renderer.close();
      tools.remove();
      current = null;
    }
    return { session: s, cleanup, showForget };
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

  if (saved) start(SAVED);
  else showPasswordForm();
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
