// Fourier-based landscape height.  Ported from GetLandscapeAltitude
// (LanderSrc.txt:1285-1465).
//
// The original sums six sine waves of (x, z), then subtracts from
// LAND_MID_HEIGHT, then clamps to SEA_LEVEL, then forces the launchpad tile
// to LAUNCHPAD_ALTITUDE.
//
// The sin lookup in the original uses 32-bit integer phase that wraps every
// 2^32.  With TILE_SIZE = 2^24, that's one full sin period per 256 tiles, so
// the equivalent float frequency factor is 2*PI / 256.

import {
  LAND_MID_HEIGHT,
  SEA_LEVEL,
  LAUNCHPAD_ALTITUDE,
  LAUNCHPAD_SIZE,
} from './constants';

const FREQ = (2 * Math.PI) / 256;

function s(k: number): number {
  return Math.sin(FREQ * k);
}

/**
 * Returns inverse altitude at world-map coordinate (x, z) in tile units.
 * Larger return value = lower terrain (sea level is at SEA_LEVEL).  Convert
 * to Y-up world coordinates by negating.
 */
export function getLandscapeAltitude(x: number, z: number): number {
  // In the original each sin lookup is scaled by 1/128 (4x) or 1/256 (2x).
  // After the integer math, the resulting amplitudes are 1 tile and 0.5
  // tiles respectively, giving a +/- 5 tile envelope around LAND_MID_HEIGHT.
  const sum =
    s(x - 2 * z) +
    s(4 * x + 3 * z) +
    s(3 * z - 5 * x) +
    s(7 * x + 5 * z) +
    0.5 * s(5 * x + 11 * z) +
    0.5 * s(10 * x + 7 * z);

  let altitude = LAND_MID_HEIGHT - sum;

  // Don't let the terrain dip below sea level.
  if (altitude > SEA_LEVEL) altitude = SEA_LEVEL;

  // The launchpad area is flat at a known altitude.  Original uses unsigned
  // compare so negative coords fall through.
  if (x >= 0 && x < LAUNCHPAD_SIZE && z >= 0 && z < LAUNCHPAD_SIZE) {
    altitude = LAUNCHPAD_ALTITUDE;
  }

  return altitude;
}

/**
 * True if (x, z) is on the launchpad tile.
 */
export function isOnLaunchpad(x: number, z: number): boolean {
  return x >= 0 && x < LAUNCHPAD_SIZE && z >= 0 && z < LAUNCHPAD_SIZE;
}
