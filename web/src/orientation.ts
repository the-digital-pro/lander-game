// Ship orientation computed from mouse polar coordinates.
//
// Ported from MoveAndDrawPlayer (LanderSrc.txt:1734-1870) and
// CalculateRotationMatrix (LanderSrc.txt:6311-6630).  The original builds:
//
//   matrix = Y_yaw(shipDirection) * Z_pitch(shipPitch)
//
// So `shipDirection` is a YAW (rotation around world vertical), and
// `shipPitch` is the amount the ship leans FORWARD in whatever direction
// it's currently facing.  The mouse polar angle drives yaw and the polar
// distance drives pitch.  Both are smoothed with `new = (old + raw) / 2`
// damping (LanderSrc.txt:1855-1865).
//
// Coordinate translation from original to our Y-up scene:
//
//   * Original world: +X right, +Y down, +Z forward (into screen)
//   * Our scene:      +X right, +Y up,   -Z forward (Three.js convention)
//
// So we rotate yaw around +Y by `-direction` (sign flips because scene Y is
// flipped from original) and tilt pitch around scene -Z (which is the
// scene's "forward" / original's +Z).  At rest the ship's nose points along
// its local +X axis which we map to scene +X — same convention as the
// original, where "shipDirection = 0 → ship faces right" (LanderSrc.txt:
// 12447-12451).

import * as THREE from 'three';

export interface ShipOrientationState {
  direction: number;
  pitch: number;
}

const MAX_PITCH = 1.3;
const PITCH_AXIS_SCENE = new THREE.Vector3(0, 0, -1);
const YAW_AXIS_SCENE = new THREE.Vector3(0, 1, 0);

export function createShipOrientation(): ShipOrientationState {
  return { direction: 0, pitch: 0 };
}

/**
 * Update direction + pitch from a normalised mouse offset (each axis in
 * roughly [-1, 1]).  Mouse Y is NOT negated — that matches the original's
 * polar-angle convention (Archimedes mouse-Y was 0 at the bottom of the
 * screen, which is equivalent to browser-Y positive-down once we put both
 * through atan2 unchanged).
 */
export function updateOrientation(
  state: ShipOrientationState,
  mouseX: number,
  mouseY: number,
): void {
  const rawAngle = Math.atan2(mouseY, mouseX);
  let rawPitch = Math.min(Math.hypot(mouseX, mouseY), 1) * MAX_PITCH;
  if (!Number.isFinite(rawPitch)) rawPitch = 0;

  // Half-and-half damping matching LanderSrc.txt:1855-1865.  Yaw damps
  // along the shortest arc so wrapping past +/- pi doesn't snap.
  const deltaAngle = wrapPi(rawAngle - state.direction);
  state.direction = wrapPi(state.direction + deltaAngle * 0.5);
  state.pitch = (state.pitch + rawPitch) * 0.5;
}

/**
 * Build the ship quaternion: yaw around world Y, then forward-lean pitch.
 */
export function applyOrientation(target: THREE.Object3D, state: ShipOrientationState): void {
  const pitchQuat = new THREE.Quaternion().setFromAxisAngle(PITCH_AXIS_SCENE, state.pitch);
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(YAW_AXIS_SCENE, -state.direction);
  target.quaternion.copy(yawQuat).multiply(pitchQuat);
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
