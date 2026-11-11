import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buttonMask, ctrlAltDelEvent, keyEventFor, modifiersOf, toRemote, wheelEvent } from '../public/assets/client/input.js';
import { enums } from '../public/assets/client/protobuf.js';

const CK = enums.ControlKey;
const key = (k, extra = {}) => ({ key: k, code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, getModifierState: () => false, ...extra });

describe('keyboard mapping (legacy mode)', () => {
  it('sends printable characters as code points', () => {
    assert.deepEqual(keyEventFor(key('a'), true), { chr: 97, down: true, modifiers: [] });
    assert.deepEqual(keyEventFor(key('A', { shiftKey: true }), false), { chr: 65, down: false, modifiers: [CK.Shift] });
    assert.equal(keyEventFor(key('é'), true).chr, 0xe9);
    assert.equal(keyEventFor(key('😀'), true).chr, 0x1f600);
  });

  it('keeps hotkey modifiers', () => {
    assert.deepEqual(keyEventFor(key('c', { ctrlKey: true }), true), { chr: 99, down: true, modifiers: [CK.Control] });
  });

  it('does not treat AltGr as Ctrl+Alt', () => {
    const e = key('@', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' });
    assert.deepEqual(modifiersOf(e), []);
    assert.equal(keyEventFor(e, true).chr, 64);
  });

  it('maps special keys to ControlKey', () => {
    assert.equal(keyEventFor(key('Enter'), true).control_key, CK.Return);
    assert.equal(keyEventFor(key('ArrowLeft'), true).control_key, CK.LeftArrow);
    assert.equal(keyEventFor(key('F11'), true).control_key, CK.F11);
    assert.equal(keyEventFor(key('Shift', { code: 'ShiftRight', shiftKey: true }), true).control_key, CK.RShift);
    assert.equal(keyEventFor(key('Control', { code: 'ControlLeft', ctrlKey: true }), true).control_key, CK.Control);
  });

  it('ignores dead keys, IME composition and unknown keys', () => {
    assert.equal(keyEventFor(key('Dead'), true), null);
    assert.equal(keyEventFor(key('a', { isComposing: true }), true), null);
    assert.equal(keyEventFor(key('AudioVolumeUp'), true), null);
  });

  it('sends Ctrl+Alt+Del like the native client', () => {
    assert.deepEqual(ctrlAltDelEvent('Windows'), { control_key: CK.CtrlAltDel, down: true });
    assert.deepEqual(ctrlAltDelEvent('Linux'), { control_key: CK.Delete, modifiers: [CK.Control, CK.Alt], press: true });
  });
});

describe('mouse mapping', () => {
  it('encodes button masks as button << 3 | type', () => {
    assert.equal(buttonMask(0, true), (0x01 << 3) | 1);
    assert.equal(buttonMask(2, false), (0x02 << 3) | 2);
    assert.equal(buttonMask(1, true), (0x04 << 3) | 1);
    assert.equal(buttonMask(9, true), null);
  });

  it('sends one wheel notch per event, up is positive', () => {
    assert.deepEqual(wheelEvent({ deltaX: 0, deltaY: -120 }), { mask: 3, x: 0, y: 1 });
    assert.deepEqual(wheelEvent({ deltaX: 40, deltaY: 3 }), { mask: 3, x: -1, y: -1 });
  });

  it('maps scaled canvas coordinates to the remote display', () => {
    const rect = { left: 100, top: 50, width: 640, height: 360 };
    const size = { width: 1920, height: 1080 };
    assert.deepEqual(toRemote(100, 50, rect, size), { x: 0, y: 0 });
    assert.deepEqual(toRemote(420, 230, rect, size), { x: 960, y: 540 });
    assert.deepEqual(toRemote(9999, 9999, rect, size), { x: 1919, y: 1079 });
    // Second monitor to the right of the first.
    assert.deepEqual(toRemote(100, 50, rect, size, { x: 1920, y: 0 }), { x: 1920, y: 0 });
  });
});
