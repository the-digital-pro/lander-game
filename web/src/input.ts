// Mouse + button state.  Ported from LanderSrc.txt:1743-1773.
//
// The original reads absolute mouse position each frame via SWI OS_Mouse and
// uses that position (relative to a 1024x1024 grid centred at 511,511) to
// derive ship orientation.  We mirror that: the mouse position relative to
// the canvas centre drives orientation; the position itself is the "target",
// not a delta.
//
// Button mapping matches the original (LanderSrc.txt:1751-1769):
//   left   = full thrust
//   middle = hover (half thrust)
//   right  = fire bullets
// Right-click context menu is suppressed.
//
// The Archimedes shipped with a three-button mouse; most machines this runs
// on now have a trackpad.  So every button also has a key: W / Up for
// thrust, S / Shift / Down for hover, Space / F for fire.  The stick is
// still the pointer.

export interface InputState {
  /** Mouse offset from canvas centre, normalised so each axis is in [-1, 1]. */
  x: number;
  y: number;
  thrust: boolean;
  hover: boolean;
  fire: boolean;
  /** Pointer position in CSS pixels, for drawing the stick indicator. */
  clientX: number;
  clientY: number;
}

type Action = 'thrust' | 'hover' | 'fire';

const KEY_ACTIONS: Record<string, Action> = {
  KeyW: 'thrust',
  ArrowUp: 'thrust',
  KeyS: 'hover',
  ArrowDown: 'hover',
  ShiftLeft: 'hover',
  ShiftRight: 'hover',
  Space: 'fire',
  KeyF: 'fire',
};

const MOUSE_ACTIONS: Record<number, Action> = { 0: 'thrust', 1: 'hover', 2: 'fire' };

export function attachInput(canvas: HTMLCanvasElement): InputState {
  const state: InputState = {
    x: 0,
    y: 0,
    thrust: false,
    hover: false,
    fire: false,
    clientX: window.innerWidth / 2,
    clientY: window.innerHeight / 2,
  };

  // Each action can be held by the mouse, the keyboard, or both.
  const mouseHeld: Record<Action, boolean> = { thrust: false, hover: false, fire: false };
  const keysHeld: Record<Action, number> = { thrust: 0, hover: 0, fire: 0 };
  const keysDown = new Set<string>();

  function sync(): void {
    state.thrust = mouseHeld.thrust || keysHeld.thrust > 0;
    state.hover = mouseHeld.hover || keysHeld.hover > 0;
    state.fire = mouseHeld.fire || keysHeld.fire > 0;
  }

  function onMove(ev: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return; // canvas not yet sized
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    state.x = (ev.clientX - cx) / radius;
    state.y = (ev.clientY - cy) / radius;
    state.clientX = ev.clientX;
    state.clientY = ev.clientY;
  }

  function setButton(button: number, down: boolean): void {
    const action = MOUSE_ACTIONS[button];
    if (!action) return;
    mouseHeld[action] = down;
    sync();
  }

  function releaseAll(): void {
    mouseHeld.thrust = mouseHeld.hover = mouseHeld.fire = false;
    keysHeld.thrust = keysHeld.hover = keysHeld.fire = 0;
    keysDown.clear();
    sync();
  }

  // Track the pointer over the whole window so the HUD never eats the stick.
  window.addEventListener('mousemove', onMove);
  canvas.addEventListener('mousedown', (ev) => {
    ev.preventDefault(); // stop middle-click autoscroll
    setButton(ev.button, true);
  });
  window.addEventListener('mouseup', (ev) => setButton(ev.button, false));
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  window.addEventListener('keydown', (ev) => {
    const action = KEY_ACTIONS[ev.code];
    if (!action) return;
    ev.preventDefault(); // Space and the arrows would scroll the page
    if (keysDown.has(ev.code)) return; // auto-repeat
    keysDown.add(ev.code);
    keysHeld[action] += 1;
    sync();
  });
  window.addEventListener('keyup', (ev) => {
    const action = KEY_ACTIONS[ev.code];
    if (!action || !keysDown.delete(ev.code)) return;
    keysHeld[action] = Math.max(0, keysHeld[action] - 1);
    sync();
  });

  // A button released outside the window never sends its "up".
  window.addEventListener('blur', releaseAll);

  return state;
}
