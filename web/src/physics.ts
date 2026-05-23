// Player physics.  Ported from MoveAndDrawPlayer (LanderSrc.txt:1734-2218)
// and LandOnLaunchpad (LanderSrc.txt:2492-2564).
//
// We work in Y-up scene coordinates throughout (the original used Y-down).
// Constants here are in scene units (one tile = 1.0) per frame.

import * as THREE from 'three';

import type { InputState } from './input';
import {
  LAUNCHPAD_SIZE,
  LAUNCHPAD_ALTITUDE,
  LAUNCHPAD_Y,
  UNDERCARRIAGE_Y,
  LANDING_SPEED,
  SAFE_HEIGHT,
} from './constants';
import { getLandscapeAltitude } from './terrain';

const MAP_SIZE = 256;
const OBJECT_NONE = 0xff;

export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  fuel: number;
  alive: boolean;
  onPad: boolean;
  lives: number;
  crashFrames: number; // counts down from 30 after a crash
  justCrashed: boolean; // set true on the frame the crash happens; cleared next step
  gameOver: boolean;
  score: number;
  highScore: number;
}

// Original (50 Hz) per-frame values:
//   gravity ≈ &30000 / 2^24 = 0.01172          (LanderSrc.txt:12253)
//   thrust  ≈ roof/2048 where |roof|≈2^30      (LanderSrc.txt:1939)
//           = 2^19 / 2^24 = 0.03125
//   hover   = roof/8192 = 0.0078125             (LanderSrc.txt:2019)
//   friction = vel/64                           (LanderSrc.txt:1932)
//
// We run at 60 Hz fixed-step.  Matching the source per-second values
// literally feels brutal by modern standards (~37 tiles/sec terminal fall,
// the player has under a second to react) so we soften gravity to about
// 60% of source.  Thrust + friction stay at the source rate so the ship
// has plenty of authority to climb.
const GRAVITY_BASE = 0.01172 * (50 / 60) * 0.6; // ~0.00586
const THRUST_ACCEL = 0.03125 * (50 / 60); // 0.02604
const HOVER_THRUST_ACCEL = THRUST_ACCEL / 4;
// Original retention/sec = (63/64)^50 ≈ 0.456.  Per-frame at 60: 0.987.
const FRICTION = Math.pow(63 / 64, 50 / 60); // ≈ 0.987

// Gravity ramps up as the player kills more objects, just like the
// original ramped gravity with score milestones (deep-dive comment:
// 1024 → &50000, 1488 → &70000).  Score in our port = destroyed objects,
// so use much smaller thresholds.
const GRAVITY_RAMP: ReadonlyArray<[score: number, multiplier: number]> = [
  [0, 1.0],
  [10, 1.67], // &50000 / &30000
  [25, 2.33], // &70000 / &30000
];

function gravityAtScore(score: number): number {
  let mult = 1.0;
  for (const [threshold, m] of GRAVITY_RAMP) {
    if (score >= threshold) mult = m;
  }
  return GRAVITY_BASE * mult;
}

// Engine cutout above this altitude (LanderSrc.txt:1904-1907 + constant at
// :94).  Stops the player from escaping the playfield.
const HIGHEST_ALTITUDE_SCENE_Y = 52; // ship can rise to scene Y = 52 (= original altitude -52)

// Original (LanderSrc.txt:5895, 11992, 2549): initial fuel 3413, max 5120,
// burn 4/frame thrust + 2/frame hover at 50 fps.  Full tank therefore lasts
// ~21 s of full thrust (5120/4/50) or ~17 s starting at the original 3413.
// Refill rate is &20 = 32/frame when landed, refilling fully in ~3 s.
// Scaling to 60 fps and unit-fuel (1.0 = max), per-frame:
//   thrust: (4/5120) * (50/60) = 0.00065  ≈ 0.00067
//   hover:  half that
//   refill: (32/5120) * (50/60) = 0.0052
// Fuel: original burns 4/frame at 50 fps; max=5120, initial=3413.
//   thrust burn/sec = 4 * 50 / 5120 = 0.0391
//   hover burn/sec  = 2 * 50 / 5120 = 0.0195
//   refill/sec      = 32 * 50 / 5120 = 0.3125 (full tank in ~3.2 s)
const FUEL_BURN_THRUST = 0.0391 / 60;
const FUEL_BURN_HOVER = 0.0195 / 60;
const FUEL_REFILL = 0.3125 / 60;
const FUEL_MAX = 1.0;
const FUEL_INITIAL = 3413 / 5120; // ~0.667

// Ship CENTRE Y when resting on the launchpad.  Scene Y = -inverse-altitude.
const SHIP_REST_Y = -LAUNCHPAD_Y;
// Launchpad in scene coords: world Z in [0, LAUNCHPAD_SIZE) maps to scene Z
// in (-LAUNCHPAD_SIZE, 0] because forward is -Z.

const tmpUp = new THREE.Vector3();
const UP_LOCAL = new THREE.Vector3(0, 1, 0);

const STARTING_LIVES = 3;
const CRASH_FRAMES = 30;

const HIGH_SCORE_KEY = 'lander-high-score';

function loadHighScore(): number {
  if (typeof localStorage === 'undefined') return 0;
  const raw = localStorage.getItem(HIGH_SCORE_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

function saveHighScore(score: number): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(HIGH_SCORE_KEY, String(score));
}

export function createPlayer(): PlayerState {
  return {
    position: new THREE.Vector3(
      LAUNCHPAD_SIZE / 2,
      SHIP_REST_Y,
      -LAUNCHPAD_SIZE / 2,
    ),
    velocity: new THREE.Vector3(0, 0, 0),
    fuel: FUEL_INITIAL,
    alive: true,
    onPad: true,
    lives: STARTING_LIVES,
    crashFrames: 0,
    justCrashed: false,
    gameOver: false,
    score: 0,
    highScore: loadHighScore(),
  };
}

/** Increment score, updating high-score if surpassed. */
export function addScore(player: PlayerState, delta: number): void {
  player.score += delta;
  if (player.score > player.highScore) {
    player.highScore = player.score;
    saveHighScore(player.highScore);
  }
}

/** Force a crash from external code (e.g., a falling rock hitting the ship). */
export function triggerCrash(player: PlayerState): void {
  if (!player.alive) return;
  crash(player);
}

function crash(player: PlayerState): void {
  player.alive = false;
  player.justCrashed = true;
  player.crashFrames = CRASH_FRAMES;
  player.velocity.set(0, 0, 0);
}

function respawn(player: PlayerState): void {
  player.position.set(LAUNCHPAD_SIZE / 2, SHIP_REST_Y, -LAUNCHPAD_SIZE / 2);
  player.velocity.set(0, 0, 0);
  player.fuel = 1.0;
  player.alive = true;
  player.onPad = true;
  player.crashFrames = 0;
}

/**
 * Reset the entire game state — new run, full lives, fuel, position.  Keeps
 * the high score.
 */
export function restartGame(player: PlayerState): void {
  respawn(player);
  player.lives = STARTING_LIVES;
  player.gameOver = false;
  player.justCrashed = false;
  player.score = 0;
}

export function updatePhysics(
  player: PlayerState,
  shipQuat: THREE.Quaternion,
  input: InputState,
  objectMap: Uint8Array,
): void {
  // Clear the one-shot crash flag from the previous frame.
  player.justCrashed = false;

  if (!player.alive) {
    if (player.gameOver) return;
    player.crashFrames -= 1;
    if (player.crashFrames <= 0) {
      if (player.lives > 0) {
        player.lives -= 1;
        respawn(player);
      } else {
        player.gameOver = true;
      }
    }
    return;
  }

  // Engine cutout above HIGHEST_ALTITUDE (LanderSrc.txt:1904-1907).
  const engineLive = player.position.y < HIGHEST_ALTITUDE_SCENE_Y;
  const fullThrust = engineLive && input.thrust && player.fuel > 0;
  const hover = engineLive && input.hover && player.fuel > 0;

  // Ship's "up" axis in world space = direction of thrust acceleration.
  tmpUp.copy(UP_LOCAL).applyQuaternion(shipQuat);

  // Friction along each axis (LanderSrc.txt:1932,1959,1986).
  player.velocity.multiplyScalar(FRICTION);

  // Full thrust BEFORE position integration (LanderSrc.txt:1939, 1966, 1993).
  if (fullThrust) {
    player.velocity.addScaledVector(tmpUp, THRUST_ACCEL);
  }

  // Integrate.
  player.position.add(player.velocity);

  // Hover thrust AFTER integration — original calls this "delayed inertia"
  // (LanderSrc.txt:2025-2029).
  if (hover) {
    player.velocity.addScaledVector(tmpUp, HOVER_THRUST_ACCEL);
  }

  // Gravity (LanderSrc.txt:2031-2033).  Scene-Y down is -Y.  Ramped by
  // score so the game gets progressively harder.
  player.velocity.y -= gravityAtScore(player.score);

  // Fuel burn.
  if (fullThrust) player.fuel = Math.max(0, player.fuel - FUEL_BURN_THRUST);
  else if (hover) player.fuel = Math.max(0, player.fuel - FUEL_BURN_HOVER);

  handleGroundCollision(player, objectMap);
}

function handleGroundCollision(player: PlayerState, objectMap: Uint8Array): void {
  // Sample altitude in WORLD coords (Z forward = positive).  Our scene's
  // forward is -Z, so the world Z is the negated scene Z.
  const altitude = getLandscapeAltitude(player.position.x, -player.position.z);
  const terrainSceneY = -altitude;
  const shipBottomY = player.position.y - UNDERCARRIAGE_Y;
  const gap = shipBottomY - terrainSceneY;

  // Object collision: if the ship is within SAFE_HEIGHT of the terrain and
  // there's a *destructible* object (type 1..11) on the current tile, we've
  // clipped it (LanderSrc.txt:2109-2150).  Smoking remains (type >= 12) are
  // pass-through.
  if (gap > 0 && gap < SAFE_HEIGHT) {
    const tileX = Math.floor(player.position.x);
    const tileZ = Math.floor(-player.position.z);
    if (tileX >= 0 && tileX < MAP_SIZE && tileZ >= 0 && tileZ < MAP_SIZE) {
      const type = objectMap[tileZ * MAP_SIZE + tileX];
      if (type !== OBJECT_NONE && type < 12) {
        crash(player);
        return;
      }
    }
  }

  if (gap > 0) {
    // Safely above ground with no object hazard.
    player.onPad = false;
    return;
  }

  // Launchpad in scene Z: (-LAUNCHPAD_SIZE, 0].
  const onPadXZ =
    player.position.x >= 0 &&
    player.position.x < LAUNCHPAD_SIZE &&
    player.position.z <= 0 &&
    player.position.z > -LAUNCHPAD_SIZE;

  if (!onPadXZ) {
    crash(player);
    return;
  }

  // Speed cap from LanderSrc.txt:2526-2529 — sum of absolute components.
  const speed =
    Math.abs(player.velocity.x) +
    Math.abs(player.velocity.y) +
    Math.abs(player.velocity.z);
  if (speed >= LANDING_SPEED) {
    crash(player);
    return;
  }

  // Touchdown.
  player.position.y = SHIP_REST_Y;
  player.velocity.set(0, 0, 0);
  player.onPad = true;
  player.fuel = Math.min(FUEL_MAX, player.fuel + FUEL_REFILL);
}
