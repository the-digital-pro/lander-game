// Chase camera.
//
// The original Lander view feels distant - the ship is small in the frame
// and the world extends ahead - and, crucially, it never turns: the camera
// always looks the same way, which is what makes "mouse offset from screen
// centre" a workable flight stick.  Both of those are kept.  CAMERA_PLAYER_Z
// (= 5 tiles) is the gameplay constant from the original; the visual camera
// sits further back and higher than that, so there is more ground in view to
// aim at.
//
// What is new is everything a fixed bolt-on camera lacks: it follows on a
// short spring instead of rigidly, widens its field of view with speed,
// shakes when things blow up, and lifts itself rather than clip into a
// hillside behind the ship.
//
// It also frames the ship *and the ground under it*, not the ship alone.
// Everything the player has to judge - the landing shadow, where rounds
// will fall, what a landbot is doing to the land - is down there, so the
// view is hung from a point partway between ship and surface and pulls
// back as the ship climbs, keeping both in shot until well up.

import * as THREE from 'three';

import { groundY } from './terrain';

const CAMERA_BACK = 14.5; // tiles behind the ship
const CAMERA_RISE = 5.2; // tiles above the ship
const LOOK_AHEAD = 7; // aim this far past the ship
const LOOK_DROP = 0.4; // ...and this far below it

const BASE_FOV = 44; // narrow-ish: keeps the world flat and distant
const SPEED_FOV = 9; // extra degrees at full tilt
/** Tightest the spring is allowed to stretch, so the ship stays on screen. */
const MAX_LAG_XZ = 3.2;
const GROUND_CLEARANCE = 1.8;
/** Share of the ship's height that sits below the focus point. */
const GROUND_SHARE = 0.45;
/** Height at which ship and shadow just fill the frame; above it, pull back. */
const FULL_FRAME_HEIGHT = 11;
const MAX_ZOOM = 3.2;

const base = new THREE.Quaternion();
const jolt = new THREE.Quaternion();
const euler = new THREE.Euler();

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** The point the camera is hung from: a smoothed copy of the ship. */
  private readonly anchor = new THREE.Vector3();
  private trauma = 0;
  private fov = BASE_FOV;
  private lift = 0;
  /** Smoothed height of the surface under the ship. */
  private ground = 0;
  private zoom = 1;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 400);
    // Work out the fixed viewing direction once.
    this.camera.position.set(0, CAMERA_RISE, CAMERA_BACK);
    this.camera.lookAt(0, -LOOK_DROP, -LOOK_AHEAD);
    base.copy(this.camera.quaternion);
  }

  /** Jump straight to the target (start of game, respawn). */
  snap(target: THREE.Vector3): void {
    this.anchor.copy(target);
    this.lift = 0;
    this.ground = groundY(target.x, target.z);
    this.zoom = THREE.MathUtils.clamp((target.y - this.ground) / FULL_FRAME_HEIGHT, 1, MAX_ZOOM);
  }

  /** The world wrapped under the ship; come along. */
  shift(dx: number, dz: number): void {
    this.anchor.x += dx;
    this.anchor.z += dz;
  }

  /** Add shake.  0.3 is a nearby bang, 1 is the ship itself going up. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * `speed` is the ship's speed in tiles per fixed frame; `dt` is real
   * seconds since the last rendered frame.
   */
  update(target: THREE.Vector3, speed: number, dt: number, time: number): void {
    // Critically-damped-ish follow, frame-rate independent.
    const kxz = 1 - Math.exp(-11 * dt);
    this.anchor.x += (target.x - this.anchor.x) * kxz;
    this.anchor.z += (target.z - this.anchor.z) * kxz;
    this.anchor.x = THREE.MathUtils.clamp(this.anchor.x, target.x - MAX_LAG_XZ, target.x + MAX_LAG_XZ);
    this.anchor.z = THREE.MathUtils.clamp(this.anchor.z, target.z - MAX_LAG_XZ, target.z + MAX_LAG_XZ);

    // Focus between the ship and the surface below it.  The surface height
    // is smoothed so skimming over rough ground doesn't shake the view;
    // past the point where pulling back stops, the focus just rides up
    // with the ship and the ground is allowed to drop out of frame.
    this.ground += (groundY(target.x, target.z) - this.ground) * (1 - Math.exp(-3 * dt));
    const height = Math.max(0, target.y - this.ground);
    const zoomTarget = THREE.MathUtils.clamp(height / FULL_FRAME_HEIGHT, 1, MAX_ZOOM);
    this.zoom += (zoomTarget - this.zoom) * (1 - Math.exp(-2.4 * dt));
    this.anchor.y = target.y - Math.min(height, FULL_FRAME_HEIGHT * MAX_ZOOM) * GROUND_SHARE;

    const camera = this.camera;
    const x = this.anchor.x;
    const z = this.anchor.z + CAMERA_BACK * this.zoom;
    let y = this.anchor.y + CAMERA_RISE * this.zoom;

    // Never sink into the ground behind the ship.  Eased, so cresting a
    // ridge lifts the view rather than popping it.
    const floor = Math.max(groundY(x, z), groundY(x, z - 3)) + GROUND_CLEARANCE;
    const wanted = Math.max(0, floor - y);
    this.lift += (wanted - this.lift) * (1 - Math.exp(-8 * dt));
    y += this.lift;

    // Shake: trauma squared, so small knocks stay small.
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const shake = this.trauma * this.trauma;
    const sx = Math.sin(time * 53.1) * Math.cos(time * 31.7);
    const sy = Math.sin(time * 47.3 + 1.3) * Math.cos(time * 29.9);
    const sr = Math.sin(time * 41.9 + 2.1);
    camera.position.set(x + sx * shake * 0.45, y + sy * shake * 0.35, z);
    euler.set(sy * shake * 0.018, sx * shake * 0.018, sr * shake * 0.03);
    camera.quaternion.copy(base).multiply(jolt.setFromEuler(euler));

    const targetFov = BASE_FOV + Math.min(1, speed / 0.9) * SPEED_FOV;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-3 * dt));
    if (Math.abs(this.fov - camera.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  /** World units -> pixels at unit distance, for sizing point sprites. */
  pixelScale(drawingBufferHeight: number): number {
    return drawingBufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }
}
