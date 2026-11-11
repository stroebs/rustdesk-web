// Maps browser input events to RustDesk MouseEvent / KeyEvent messages
// ("Legacy" keyboard mode: characters as Unicode code points, special keys as
// ControlKey, modifiers listed on every event).

import { enums } from './protobuf.js';
import { MOUSE } from './session.js';

const CK = enums.ControlKey;

// KeyboardEvent.key -> ControlKey name
const CONTROL_KEYS = {
  Enter: 'Return', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'UpArrow', ArrowDown: 'DownArrow', ArrowLeft: 'LeftArrow', ArrowRight: 'RightArrow',
  CapsLock: 'CapsLock', NumLock: 'NumLock', ScrollLock: 'Scroll', Pause: 'Pause', PrintScreen: 'Snapshot',
  ContextMenu: 'Apps', Control: 'Control', Shift: 'Shift', Alt: 'Alt', Meta: 'Meta', OS: 'Meta', Clear: 'Clear',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};

// Right-hand modifiers have their own ControlKeys.
const RIGHT_MODIFIERS = { ShiftRight: 'RShift', ControlRight: 'RControl', AltRight: 'RAlt', MetaRight: 'RWin' };

/** Modifiers held during the event, as ControlKey values. AltGr is not Ctrl+Alt. */
export function modifiersOf(e) {
  const altGr = e.getModifierState?.('AltGraph');
  const mods = [];
  if (e.ctrlKey && !altGr) mods.push(CK.Control);
  if (e.altKey && !altGr) mods.push(CK.Alt);
  if (e.shiftKey) mods.push(CK.Shift);
  if (e.metaKey) mods.push(CK.Meta);
  return mods;
}

/**
 * Translate a keydown/keyup event into KeyEvent fields, or null to ignore it
 * (dead keys, IME composition, unmapped keys).
 */
export function keyEventFor(e, down) {
  if (e.isComposing || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return null;
  const modifiers = modifiersOf(e);
  const right = RIGHT_MODIFIERS[e.code];
  const name = right ?? CONTROL_KEYS[e.key];
  if (name && CK[name] !== undefined) return { control_key: CK[name], down, modifiers };
  // A single printable character (may be outside the BMP, e.g. emoji).
  const chars = [...e.key];
  if (chars.length === 1) return { chr: chars[0].codePointAt(0), down, modifiers };
  return null;
}

/** Ctrl+Alt+Del the way the native client sends it (rustdesk/src/keyboard.rs). */
export function ctrlAltDelEvent(peerPlatform) {
  return peerPlatform === 'Windows'
    ? { control_key: CK.CtrlAltDel, down: true }
    : { control_key: CK.Delete, modifiers: [CK.Control, CK.Alt], press: true };
}

const BUTTONS = [MOUSE.LEFT, MOUSE.MIDDLE, MOUSE.RIGHT, MOUSE.BACK, MOUSE.FORWARD];

/** MouseEvent mask for a button press/release (PointerEvent.button: 0 left, 1 middle, 2 right, 3 back, 4 forward). */
export function buttonMask(button, down) {
  const b = BUTTONS[button];
  return b === undefined ? null : (b << 3) | (down ? MOUSE.DOWN : MOUSE.UP);
}

/** Wheel event: one notch per event, positive y scrolls up (as the native client sends). */
export function wheelEvent(e) {
  const y = e.deltaY === 0 ? 0 : e.deltaY < 0 ? 1 : -1;
  const x = e.deltaX === 0 ? 0 : e.deltaX < 0 ? 1 : -1;
  return { mask: MOUSE.WHEEL, x, y };
}

/**
 * Map a point on the displayed canvas to remote screen coordinates.
 * `rect` is the canvas's on-page box, `size` its intrinsic (remote) resolution,
 * `display` the remote display's origin in the virtual desktop.
 */
export function toRemote(clientX, clientY, rect, size, display = { x: 0, y: 0 }) {
  const x = ((clientX - rect.left) / rect.width) * size.width;
  const y = ((clientY - rect.top) / rect.height) * size.height;
  return {
    x: Math.round(Math.min(Math.max(x, 0), size.width - 1)) + (display.x ?? 0),
    y: Math.round(Math.min(Math.max(y, 0), size.height - 1)) + (display.y ?? 0),
  };
}

/** Ctrl+V / Cmd+V: let the browser's paste event deliver the local clipboard first. */
export function isPasteShortcut(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key?.toLowerCase() === 'v';
}

/** The remote's own paste keystroke: Cmd+V on macOS peers, Ctrl+V elsewhere. */
export function pasteKeyEvent(peerPlatform) {
  return { chr: 'v'.codePointAt(0), press: true, modifiers: [peerPlatform === 'Mac OS' ? CK.Meta : CK.Control] };
}
