// Ported from LanderSrc.txt:34-178.
// The original used 32-bit fixed-point coordinates with TILE_SIZE = &01000000
// (2^24). We normalise to floats with one tile = 1.0 unit.

export const TILE_SIZE = 1.0;

export const TILES_X = 13;
export const TILES_Z = 11;

export const MAX_PARTICLES = 484;
export const LAUNCHPAD_OBJECT = 9;

// Altitudes in the original are inverse: larger value = lower terrain. We
// keep the original convention internally and flip when handing positions to
// Three.js (Y-up world).
export const LAUNCHPAD_ALTITUDE = 3.5;        // &03500000
export const SEA_LEVEL = 5.5;                 // &05500000
export const LANDING_SPEED = 0.125;           // &00200000
export const SMOKE_RISING_SPEED = 0.03125;    // &00080000
export const UNDERCARRIAGE_Y = 0.390625;      // &00640000

export const BUFFER_SIZE = 4308;

// Derived constants (LanderSrc.txt:87-178)
export const LAUNCHPAD_Y = LAUNCHPAD_ALTITUDE - UNDERCARRIAGE_Y;
export const LAUNCHPAD_SIZE = TILE_SIZE * 8;
export const HIGHEST_ALTITUDE = TILE_SIZE * 52;
export const SPLASH_HEIGHT = TILE_SIZE / 16;
export const CRASH_CLOUD_Y = (TILE_SIZE * 5) / 16;
export const SMOKE_HEIGHT = (TILE_SIZE * 3) / 4;
export const SAFE_HEIGHT = (TILE_SIZE * 3) / 2;
export const CAMERA_PLAYER_Z = (TILES_Z - 6) * TILE_SIZE;
export const LAND_MID_HEIGHT = TILE_SIZE * 5;
export const PLAYER_FRONT_Z = (TILES_Z - 5) * TILE_SIZE;
export const ROCK_HEIGHT = TILE_SIZE * 32;
export const LANDSCAPE_X_WIDTH = TILE_SIZE * (TILES_X - 2);
export const LANDSCAPE_Z_DEPTH = TILE_SIZE * (TILES_Z - 1);
export const LANDSCAPE_X = LANDSCAPE_X_WIDTH / 2;
export const LANDSCAPE_Y = 0;
export const LANDSCAPE_Z = LANDSCAPE_Z_DEPTH + 10 * TILE_SIZE;
export const HALF_TILES_X = Math.floor(TILES_X / 2);
export const LANDSCAPE_X_HALF = TILE_SIZE * HALF_TILES_X;
export const LANDSCAPE_Z_BEYOND = LANDSCAPE_Z_DEPTH + TILE_SIZE;
export const LANDSCAPE_Z_FRONT = LANDSCAPE_Z - LANDSCAPE_Z_DEPTH;
export const LANDSCAPE_Z_MID = LANDSCAPE_Z - CAMERA_PLAYER_Z;
