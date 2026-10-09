// The virus.
//
// Every tile of the 256x256 map carries an infection level in [0, 1].
// Landbots raise it wherever their spray lands; nothing else does - there is
// no creep, so destroying the bots really does stop the spread.  The level
// drives the tile's colour on the terrain and on the scanner, mutates any
// tree standing on it, and sums into the planet-wide toxicity figure that
// ends the game if it reaches critical.
//
// After Zarch (1987): seeders scatter virus that turns the green land brown
// and red, and the player is paid at the end of each wave for whatever
// stayed clean.

import { LAND_MASK, LAND_TILE_COUNT, tileIndex } from './terrain';

const TILE_COUNT = 256 * 256;

/** Infection level per tile, row-major, index = (z << 8) | x. */
export const infection = new Float32Array(TILE_COUNT);

/**
 * Fraction of all dry land that has to be lost before the planet is
 * written off.  The HUD's toxicity meter reads 100% at this point.
 */
export const CRITICAL_FRACTION = 0.42;

/** Level at which a tile counts as "taken" (trees mutate, scenery scores). */
export const MUTATION_LEVEL = 0.5;

let totalLevel = 0;

// Change tracking.  Consumers (terrain mesh, scanner, scenery) drain the
// list once per frame so each only touches what actually moved.
const dirtyFlag = new Uint8Array(TILE_COUNT);
let dirtyTiles: number[] = [];
let drained: number[] = [];

function setLevel(i: number, level: number): void {
  const old = infection[i];
  if (level === old) return;
  infection[i] = level;
  totalLevel += level - old;
  if (dirtyFlag[i] === 0) {
    dirtyFlag[i] = 1;
    dirtyTiles.push(i);
  }
}

/** Infection level of the tile under world point (x, z). */
export function infectionAt(x: number, z: number): number {
  return infection[tileIndex(Math.floor(x), Math.floor(z))];
}

/**
 * Lay down virus around world point (x, z).  `amount` is the level added at
 * the centre; it falls off toward `radius`.  Sea and shielded pad aprons
 * take nothing.  Returns the total level actually added.
 */
export function sprayVirus(x: number, z: number, radius: number, amount: number): number {
  const reach = Math.ceil(radius);
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  let delivered = 0;
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const tx = cx + dx;
      const tz = cz + dz;
      const distance = Math.hypot(tx + 0.5 - x, tz + 0.5 - z);
      if (distance > radius) continue;
      const i = tileIndex(tx, tz);
      if (LAND_MASK[i] === 0) continue;
      const current = infection[i];
      if (current >= 1) continue;
      const falloff = 1 - distance / radius;
      const next = Math.min(1, current + amount * (0.3 + 0.7 * falloff));
      setLevel(i, next);
      delivered += next - current;
    }
  }
  return delivered;
}

/** Fraction of dry land currently infected, 0..1. */
export function infectedFraction(): number {
  return totalLevel / LAND_TILE_COUNT;
}

/** Planet toxicity, 0..1, where 1 means the planet is lost. */
export function toxicity(): number {
  return Math.min(1, totalLevel / (LAND_TILE_COUNT * CRITICAL_FRACTION));
}

// ---------------------------------------------------------------------------
// Recovery.  Clearing a wave lets part of the infected land grow back; the
// chosen tiles fade out over a few seconds, staggered so it reads as the
// land recovering rather than a switch being thrown.
// ---------------------------------------------------------------------------

const healingTiles: number[] = [];
const healingDelay: number[] = [];
const HEAL_RATE = 1 / 70; // level per frame once a tile starts recovering
const HEAL_STAGGER_FRAMES = 240;

function hash32(n: number): number {
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return (n ^ (n >>> 15)) >>> 0;
}

/**
 * Start recovering roughly `fraction` of the currently infected tiles.
 * `seed` varies the pick from wave to wave.
 */
export function beginRecovery(fraction: number, seed: number): void {
  const threshold = fraction * 0xffffffff;
  for (let i = 0; i < TILE_COUNT; i++) {
    if (infection[i] <= 0) continue;
    const h = hash32(i + seed * 7919);
    if (h > threshold) continue;
    healingTiles.push(i);
    healingDelay.push(hash32(h) % HEAL_STAGGER_FRAMES);
  }
}

/** Advance recovery by one fixed frame. */
export function updateInfection(): void {
  for (let k = healingTiles.length - 1; k >= 0; k--) {
    if (healingDelay[k] > 0) {
      healingDelay[k] -= 1;
      continue;
    }
    const i = healingTiles[k];
    const next = infection[i] - HEAL_RATE;
    if (next > 0) {
      setLevel(i, next);
      continue;
    }
    setLevel(i, 0);
    const lastTile = healingTiles.pop()!;
    const lastDelay = healingDelay.pop()!;
    if (k < healingTiles.length) {
      healingTiles[k] = lastTile;
      healingDelay[k] = lastDelay;
    }
  }
}

/** Wipe the map clean for a new game. */
export function resetInfection(): void {
  for (let i = 0; i < TILE_COUNT; i++) {
    if (infection[i] !== 0) setLevel(i, 0);
  }
  totalLevel = 0;
  healingTiles.length = 0;
  healingDelay.length = 0;
}

/**
 * Hand back the tiles whose level changed since the last call.  The array
 * is reused on the next call, so consume it before draining again.
 */
export function drainChangedTiles(): readonly number[] {
  const out = dirtyTiles;
  for (let k = 0; k < out.length; k++) dirtyFlag[out[k]] = 0;
  dirtyTiles = drained;
  dirtyTiles.length = 0;
  drained = out;
  return out;
}
