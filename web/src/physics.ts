// Player physics.  Ported from MoveAndDrawPlayer (LanderSrc.txt:1734-2218)
// and LandOnLaunchpad (LanderSrc.txt:2492-2564).
//
// We work in Y-up scene coordinates throughout (the original used Y-down).
// Constants here are in scene units (one tile = 1.0) per frame.
//
// The flight model is the original's and is deliberately left alone:
// friction, thrust along the ship's up vector, delayed-inertia hover,
// gravity, the fuel curve and the landing-speed rule are all as ported.
// What has changed around it: the world wraps, there is more than one pad
// to land on (and the last one touched is where you come back), and the
// difficulty ramp follows the attack wave rather than a kill count.

import * as THREE from 'three';

import type { InputState } from './input';
import { UNDERCARRIAGE_Y, LANDING_SPEED, SAFE_HEIGHT } from './constants';
import {
  getLandscapeAltitude,
  isSea,
  padAt,
  PADS,
  WORLD_SIZE,
  type LandingPad,
} from './terrain';

const OBJECT_NONE = 0xff;

export type CrashCause =
  | 'terrain'
  | 'sea'
  | 'object'
  | 'hard-landing'
  | 'rock'
  | 'plasma'
  | 'landbot'
  | 'lava'
  | 'turbine'
  | 'toxicity';

export interface PlayerState {
  position: THREE.Vector3;
  /** Position one fixed step ago; the renderer interpolates between the two. */
  previous: THREE.Vector3;
  velocity: THREE.Vector3;
  fuel: number;
  alive: boolean;
  onPad: boolean;
  /** The pad the ship is resting on, if any. */
  pad: LandingPad | null;
  /** The pad the ship returns to after a crash: the last one it touched. */
  anchorPad: LandingPad;
  lives: number;
  crashFrames: number; // counts down after a crash
  justCrashed: boolean; // set true on the frame the crash happens; cleared next step
  crashCause: CrashCause;
  /** One-shot flags, each true for exactly one step. */
  justLanded: boolean;
  justRespawned: boolean;
  justGainedLife: boolean;
  /** Frames of grace after a respawn during which nothing can hurt the ship. */
  shield: number;
  /**
   * How far the world wrapped under the ship this step, in scene units.
   * Anything else held in scene coordinates must move by the same amount.
   */
  wrapX: number;
  wrapZ: number;
  gameOver: boolean;
  score: number;
  highScore: number;
  nextLifeAt: number;
}

// Original (50 Hz) per-frame values:
//   gravity ~ &30000 / 2^24 = 0.01172          (LanderSrc.txt:12253)
//   thrust  ~ roof/2048 where |roof|~2^30      (LanderSrc.txt:1939)
//           = 2^19 / 2^24 = 0.03125
//   hover   = roof/8192 = 0.0078125             (LanderSrc.txt:2019)
//   friction = vel/64                           (LanderSrc.txt:1932)
//
// We run at 60 Hz fixed-step.  Matching the source per-second values
// literally feels brutal by modern standards (~37 tiles/sec terminal fall,
// the player has under a second to react) so we soften gravity to about
// 30% of source.  Thrust + friction stay at the source rate so the ship
// has plenty of authority to climb and hover thrust comfortably exceeds
// gravity (~2.2x), letting the player hold altitude on hover alone with
// margin to react.
const GRAVITY_BASE = 0.01172 * (50 / 60) * 0.3; // ~0.00293
const THRUST_ACCEL = 0.03125 * (50 / 60); // 0.02604
const HOVER_THRUST_ACCEL = THRUST_ACCEL / 4; // 0.00651, ~2.2x gravity
// Original retention/sec = (63/64)^50 ~ 0.456.  Per-frame at 60: 0.987.
const FRICTION = Math.pow(63 / 64, 50 / 60); // ~ 0.987

// Gravity ramps up as the game goes on, just like the original ramped
// gravity with score milestones (deep-dive comment: 1024 -> &50000,
// 1488 -> &70000).  The milestones here are attack waves.  The steps are
// gentler than the source's 1.67x / 2.33x: with hover thrust fixed at ~2.2x
// base gravity, the source's top step would leave hover unable to hold the
// ship up at all.
const GRAVITY_RAMP: ReadonlyArray<[wave: number, multiplier: number]> = [
  [1, 1.0],
  [4, 1.2],
  [7, 1.4],
  [10, 1.6],
];

/** Gravity multiplier in force during the given attack wave. */
export function gravityScaleForWave(wave: number): number {
  let mult = 1.0;
  for (const [threshold, m] of GRAVITY_RAMP) {
    if (wave >= threshold) mult = m;
  }
  return mult;
}

// Engine cutout above this altitude (LanderSrc.txt:1904-1907 + constant at
// :94).  Stops the player from escaping the playfield.
const HIGHEST_ALTITUDE_SCENE_Y = 52; // ship can rise to scene Y = 52 (= original altitude -52)

// Original (LanderSrc.txt:5895, 11992, 2549): initial fuel 3413, max 5120,
// burn 4/frame thrust + 2/frame hover at 50 fps.  Full tank therefore lasts
// ~21 s of full thrust (5120/4/50) or ~17 s starting at the original 3413.
// Refill rate is &20 = 32/frame when landed, refilling fully in ~3 s.
//   thrust burn/sec = 4 * 50 / 5120 = 0.0391
//   hover burn/sec  = 2 * 50 / 5120 = 0.0195
//   refill/sec      = 32 * 50 / 5120 = 0.3125 (full tank in ~3.2 s)
const FUEL_BURN_THRUST = 0.0391 / 60;
const FUEL_BURN_HOVER = 0.0195 / 60;
const FUEL_REFILL = 0.3125 / 60;
const FUEL_MAX = 1.0;
const FUEL_INITIAL = 3413 / 5120; // ~0.667

const tmpUp = new THREE.Vector3();
const UP_LOCAL = new THREE.Vector3(0, 1, 0);

const STARTING_LIVES = 3;
const MAX_LIVES = 5;
const EXTRA_LIFE_EVERY = 10000;
/** Long enough to watch the wreck come down before the next ship appears. */
const CRASH_FRAMES = 100;
const RESPAWN_SHIELD_FRAMES = 150;

// The score scale changed with the move to waves, so old bests don't compare.
const HIGH_SCORE_KEY = 'lander-high-score-v2';

function loadHighScore(): number {
  try {
    const raw = localStorage.getItem(HIGH_SCORE_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // storage unavailable (private mode, sandboxed frame)
  }
}

function saveHighScore(score: number): void {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(score));
  } catch {
    // Nothing useful to do; the score just won't persist.
  }
}

/** Ship CENTRE Y when resting on a pad.  Scene Y = -inverse-altitude. */
function restY(pad: LandingPad): number {
  return -(pad.altitude - UNDERCARRIAGE_Y);
}

function placeOnPad(player: PlayerState, pad: LandingPad): void {
  // Scene Z is the negated world Z (forward is -Z).
  player.position.set(pad.cx, restY(pad), -pad.cz);
  player.previous.copy(player.position);
  player.velocity.set(0, 0, 0);
  player.onPad = true;
  player.pad = pad;
}

export function createPlayer(): PlayerState {
  const home = PADS[0];
  const player: PlayerState = {
    position: new THREE.Vector3(),
    previous: new THREE.Vector3(),
    velocity: new THREE.Vector3(0, 0, 0),
    fuel: FUEL_INITIAL,
    alive: true,
    onPad: true,
    pad: home,
    anchorPad: home,
    lives: STARTING_LIVES,
    crashFrames: 0,
    justCrashed: false,
    crashCause: 'terrain',
    justLanded: false,
    justRespawned: false,
    justGainedLife: false,
    shield: 0,
    wrapX: 0,
    wrapZ: 0,
    gameOver: false,
    score: 0,
    highScore: loadHighScore(),
    nextLifeAt: EXTRA_LIFE_EVERY,
  };
  placeOnPad(player, home);
  return player;
}

/** Add to the score, updating the high score and awarding extra ships. */
export function addScore(player: PlayerState, delta: number): void {
  player.score += delta;
  while (player.score >= player.nextLifeAt) {
    player.nextLifeAt += EXTRA_LIFE_EVERY;
    if (player.lives < MAX_LIVES) {
      player.lives += 1;
      player.justGainedLife = true;
    }
  }
  if (player.score > player.highScore) {
    player.highScore = player.score;
    saveHighScore(player.highScore);
  }
}

/**
 * Force a crash from external code (a falling rock, a plasma bolt...).
 * Ignored while the respawn shield is up, unless `force` is set.
 */
export function triggerCrash(player: PlayerState, cause: CrashCause, force = false): boolean {
  if (!player.alive) return false;
  if (player.shield > 0 && !force) return false;
  crash(player, cause);
  return true;
}

function crash(player: PlayerState, cause: CrashCause): void {
  player.alive = false;
  player.justCrashed = true;
  player.crashCause = cause;
  player.crashFrames = CRASH_FRAMES;
  player.velocity.set(0, 0, 0);
  player.previous.copy(player.position);
  player.onPad = false;
  player.pad = null;
}

function respawn(player: PlayerState): void {
  placeOnPad(player, player.anchorPad);
  player.fuel = 1.0;
  player.alive = true;
  player.crashFrames = 0;
  player.shield = RESPAWN_SHIELD_FRAMES;
  player.justRespawned = true;
}

/**
 * Reset the entire game state - new run, full lives, fuel, position.  Keeps
 * the high score.
 */
export function restartGame(player: PlayerState): void {
  player.anchorPad = PADS[0];
  respawn(player);
  player.fuel = FUEL_INITIAL;
  player.shield = 0;
  player.lives = STARTING_LIVES;
  player.gameOver = false;
  player.justCrashed = false;
  player.score = 0;
  player.nextLifeAt = EXTRA_LIFE_EVERY;
}

/** The original's landing-speed measure: the sum of |velocity| components. */
export function landingSpeed(player: PlayerState): number {
  return (
    Math.abs(player.velocity.x) +
    Math.abs(player.velocity.y) +
    Math.abs(player.velocity.z)
  );
}

export { LANDING_SPEED };

export function updatePhysics(
  player: PlayerState,
  shipQuat: THREE.Quaternion,
  input: InputState,
  objectMap: Uint8Array,
  gravityScale: number,
): void {
  // Clear the one-shot flags from the previous frame.
  player.justCrashed = false;
  player.justLanded = false;
  player.justRespawned = false;
  player.justGainedLife = false;
  player.wrapX = 0;
  player.wrapZ = 0;
  player.previous.copy(player.position);

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

  if (player.shield > 0) player.shield -= 1;

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

  // The map is a torus: keep the ship's coordinates canonical (x in
  // [0, 256), scene z in (-256, 0]) and report the jump so everything else
  // in scene space can follow.
  if (player.position.x < 0) player.wrapX = WORLD_SIZE;
  else if (player.position.x >= WORLD_SIZE) player.wrapX = -WORLD_SIZE;
  if (player.position.z > 0) player.wrapZ = -WORLD_SIZE;
  else if (player.position.z <= -WORLD_SIZE) player.wrapZ = WORLD_SIZE;
  if (player.wrapX !== 0 || player.wrapZ !== 0) {
    player.position.x += player.wrapX;
    player.position.z += player.wrapZ;
    player.previous.x += player.wrapX;
    player.previous.z += player.wrapZ;
  }

  // Hover thrust AFTER integration - original calls this "delayed inertia"
  // (LanderSrc.txt:2025-2029).
  if (hover) {
    player.velocity.addScaledVector(tmpUp, HOVER_THRUST_ACCEL);
  }

  // Gravity (LanderSrc.txt:2031-2033).  Scene-Y down is -Y.  Ramped by
  // wave so the game gets progressively harder.
  player.velocity.y -= GRAVITY_BASE * gravityScale;

  // Fuel burn.
  if (fullThrust) player.fuel = Math.max(0, player.fuel - FUEL_BURN_THRUST);
  else if (hover) player.fuel = Math.max(0, player.fuel - FUEL_BURN_HOVER);

  handleGroundCollision(player, objectMap);
}

function handleGroundCollision(player: PlayerState, objectMap: Uint8Array): void {
  // Sample altitude in WORLD coords (Z forward = positive).  Our scene's
  // forward is -Z, so the world Z is the negated scene Z.
  const worldX = player.position.x;
  const worldZ = -player.position.z;
  const altitude = getLandscapeAltitude(worldX, worldZ);
  const terrainSceneY = -altitude;
  const shipBottomY = player.position.y - UNDERCARRIAGE_Y;
  const gap = shipBottomY - terrainSceneY;

  // Object collision: if the ship is within SAFE_HEIGHT of the terrain and
  // there's a *destructible* object (type 1..11) on the current tile, we've
  // clipped it (LanderSrc.txt:2109-2150).  Smoking remains (type >= 12) are
  // pass-through.
  if (gap > 0 && gap < SAFE_HEIGHT) {
    const tileX = Math.floor(worldX) & 255;
    const tileZ = Math.floor(worldZ) & 255;
    const type = objectMap[(tileZ << 8) | tileX];
    if (type !== OBJECT_NONE && type < 12) {
      crash(player, 'object');
      return;
    }
  }

  if (gap > 0) {
    // Safely above ground with no object hazard.
    player.onPad = false;
    player.pad = null;
    return;
  }

  const pad = padAt(worldX, worldZ);
  if (!pad) {
    crash(player, isSea(worldX, worldZ) ? 'sea' : 'terrain');
    return;
  }

  // Speed cap from LanderSrc.txt:2526-2529 - sum of absolute components.
  if (landingSpeed(player) >= LANDING_SPEED) {
    crash(player, 'hard-landing');
    return;
  }

  // Touchdown.
  if (!player.onPad) player.justLanded = true;
  player.position.y = restY(pad);
  player.velocity.set(0, 0, 0);
  player.onPad = true;
  player.pad = pad;
  player.anchorPad = pad;
  player.fuel = Math.min(FUEL_MAX, player.fuel + FUEL_REFILL);
}
