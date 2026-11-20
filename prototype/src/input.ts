import type { InputState } from './protocol';

// Keyboard, mouse and gamepad are merged into one input state, read once per frame.
const keys = new Set<string>();
let mouseButtons = 0;
let seq = 0;
let lastX = 0, lastY = 0, lastButtons = 0;
let eventTime = 0; // when the oldest input event not yet sent happened (performance.now timeline)
const mark = (e: Event) => { if (!eventTime) eventTime = e.timeStamp; };
export const gamepadInfo = { id: '', mapping: '', connected: false };

export function installInput(canvas: HTMLCanvasElement) {
  addEventListener('keydown', (e) => { if (!e.repeat) mark(e); keys.add(e.code); });
  addEventListener('keyup', (e) => { mark(e); keys.delete(e.code); });
  addEventListener('blur', () => { keys.clear(); mouseButtons = 0; });
  canvas.addEventListener('mousedown', (e) => { mouseButtons |= 1 << e.button; });
  addEventListener('mouseup', (e) => { mouseButtons &= ~(1 << e.button); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // The Gamepad API only reports a pad after a button is pressed on the page.
  addEventListener('gamepadconnected', (e) => { gamepadInfo.id = e.gamepad.id; gamepadInfo.mapping = e.gamepad.mapping; gamepadInfo.connected = true; });
  addEventListener('gamepaddisconnected', () => { gamepadInfo.connected = false; });
}

// Returns a new input message when the state changed since the last call, else null.
export function pollInput(): InputState | null {
  let x = 0, y = 0, buttons = mouseButtons & 7;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (keys.has('Space')) buttons |= 8;
  if (gamepadInfo.connected) {
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      // Only the "standard" mapping has known button and axis numbers.
      if (pad.mapping !== 'standard') continue;
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.2) { x += ax; y -= ay; }
      if (pad.buttons[14]?.pressed) x -= 1;
      if (pad.buttons[15]?.pressed) x += 1;
      if (pad.buttons[12]?.pressed) y += 1;
      if (pad.buttons[13]?.pressed) y -= 1;
      if (pad.buttons[0]?.pressed) buttons |= 8;
      break;
    }
  }
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  if (x === lastX && y === lastY && buttons === lastButtons) { eventTime = 0; return null; }
  lastX = x; lastY = y; lastButtons = buttons;
  // t is the time of the event that caused the change (for gamepads: the poll time, the API has no event time).
  const t = eventTime || performance.now();
  eventTime = 0;
  return { seq: ++seq, moveX: x, moveY: y, buttons, t };
}
