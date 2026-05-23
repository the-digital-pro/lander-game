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

export interface InputState {
  /** Mouse offset from canvas centre, normalised so each axis is in [-1, 1]. */
  x: number;
  y: number;
  thrust: boolean;
  hover: boolean;
  fire: boolean;
}

export function attachInput(canvas: HTMLCanvasElement): InputState {
  const state: InputState = {
    x: 0,
    y: 0,
    thrust: false,
    hover: false,
    fire: false,
  };

  function onMove(ev: MouseEvent): void {
    const rect = canvas.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return; // canvas not yet sized
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    state.x = (ev.clientX - cx) / radius;
    state.y = (ev.clientY - cy) / radius;
  }

  function setButton(button: number, down: boolean): void {
    switch (button) {
      case 0:
        state.thrust = down;
        break;
      case 1:
        state.hover = down;
        break;
      case 2:
        state.fire = down;
        break;
    }
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mousedown', (ev) => setButton(ev.button, true));
  canvas.addEventListener('mouseup', (ev) => setButton(ev.button, false));
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  return state;
}
