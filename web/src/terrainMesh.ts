// Flat-shaded terrain mesh built from sampled Fourier heights.
//
// We work in Y-up SCENE coordinates throughout (one tile = 1.0 unit;
// forward is -Z).  getLandscapeAltitude in terrain.ts takes WORLD coords
// (Z positive = forward), so we negate scene Z when sampling.

import * as THREE from 'three';

import { SEA_LEVEL, TILE_SIZE, LAUNCHPAD_SIZE } from './constants';
import { getLandscapeAltitude } from './terrain';

interface RGB {
  r: number;
  g: number;
  b: number;
}

// Visible patch dimensions; larger than the original 13x11 since modern
// hardware has no fillrate problem with this.
const PATCH_TILES_X = 41;
const PATCH_TILES_Z = 50;
const PATCH_HALF_X = Math.floor(PATCH_TILES_X / 2);

// Altitude palette stops.  Remember: altitude is INVERSE — smaller value =
// higher terrain.  So the table goes peak (top) → coast (bottom).  Values
// in [0, 15] to match the original's 4-bit-per-channel VIDC palette so the
// slope/distance brightness math composes the same way.
//
// Each stop is a base colour plus a "tile variant" — every second tile
// (checkerboard parity) is rendered slightly darker so adjacent tiles never
// merge into one big patch.
interface ColourStop {
  alt: number; // upper bound (exclusive) of this band, in altitude units
  r: number;
  g: number;
  b: number;
}
const PALETTE: ReadonlyArray<ColourStop> = [
  { alt: 1.2, r: 12, g: 13, b: 13 }, // mountain snow / pale rock
  { alt: 2.4, r: 8,  g: 6,  b: 4  }, // bare rock / brown
  { alt: 3.4, r: 4,  g: 8,  b: 3  }, // dark forest green
  { alt: 4.3, r: 6,  g: 10, b: 4  }, // mid grass
  { alt: 5.2, r: 10, g: 11, b: 5  }, // pale grassland / scrub
  { alt: 99,  r: 13, g: 12, b: 7  }, // sandy coast just above sea
];

function paletteIndexFor(alt: number): number {
  for (let i = 0; i < PALETTE.length; i++) {
    if (alt < PALETTE[i].alt) return i;
  }
  return PALETTE.length - 1;
}

/**
 * Deterministic per-tile hash → integer in [0, 255].  Stable across
 * terrain rebuilds so the same tile always picks the same variation.
 */
function tileHash(x: number, z: number): number {
  // Multiply-shift hash — cheap and decorrelates neighbours.
  let h = (x | 0) * 374761393 + (z | 0) * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return h & 0xff;
}

/**
 * Per-tile colour driven by altitude bands.
 *
 * Adapted from GetLandscapeTileColour (LanderSrc.txt:1545-1721) but
 * deliberately diverges from the original's bit-noise palette: we use a
 * cleaner altitude-band gradient (snow → rock → forest → grass → sand →
 * sea) so the world reads as recognisable terrain bands instead of
 * Archimedes static.
 *
 * The original's slope-based lighting (left-facing tiles brighter,
 * LanderSrc.txt:1556-1574) and distance brightening
 * (LanderSrc.txt:1630-1660) are kept verbatim — those carry the lighting
 * cues without affecting the base palette.
 *
 * To preserve the unmistakable Archimedes checkerboard, every other tile
 * (parity from sceneX + sceneZ) is rendered 1 brightness step darker.
 */
function tileColour(
  cornerAltitude: number,
  prevAltitude: number,
  rowsFromBack: number,
  sceneX: number,
  sceneZ: number,
): RGB {
  const onLaunchpad =
    sceneX >= 0 &&
    sceneX < LAUNCHPAD_SIZE &&
    sceneZ <= 0 &&
    sceneZ > -LAUNCHPAD_SIZE;

  let r: number;
  let g: number;
  let b: number;

  if (onLaunchpad) {
    // Grey: R=G=B=4 (LanderSrc.txt:1611-1614)
    r = 4; g = 4; b = 4;
  } else if (
    cornerAltitude >= SEA_LEVEL - 1e-3 &&
    prevAltitude >= SEA_LEVEL - 1e-3
  ) {
    // Sea: pure blue (LanderSrc.txt:1616-1620)
    r = 0; g = 0; b = 4;
  } else {
    // Pick a palette band from the average altitude, then optionally drift
    // a band lighter/darker on a small fraction of tiles to break up
    // perfect uniformity.
    const avgAlt = (cornerAltitude + prevAltitude) * 0.5;
    const baseIdx = paletteIndexFor(avgAlt);
    const h = tileHash(Math.floor(sceneX), Math.floor(sceneZ));

    let idx = baseIdx;
    // ~3% of tiles drift one band down (paler), ~3% drift one band up
    // (earthier).  Sparse — just an occasional rocky outcrop in grass.
    if (h < 8 && idx > 0) idx -= 1;
    else if (h > 247 && idx < PALETTE.length - 1) idx += 1;

    const stop = PALETTE[idx];
    r = stop.r; g = stop.g; b = stop.b;

    // Per-channel jitter: each channel only nudges (by ±1) on ~12% of
    // tiles, so most tiles take the palette colour unchanged and only
    // the occasional one is perturbed.
    const nudge = (bits: number): number => {
      const v = bits & 0xf;
      if (v === 0) return -1;
      if (v === 1) return 1;
      return 0;
    };
    r = Math.max(0, Math.min(15, r + nudge(h >> 2)));
    g = Math.max(0, Math.min(15, g + nudge(h >> 4)));
    b = Math.max(0, Math.min(15, b + nudge(h >> 6)));

    // Checkerboard parity: every other tile drops 1 step on each channel
    // (with a floor at 0) so the grid stays visible.
    const parity = ((Math.floor(sceneX) + Math.floor(sceneZ)) & 1) === 0;
    if (parity) {
      r = Math.max(0, r - 1);
      g = Math.max(0, g - 1);
      b = Math.max(0, b - 1);
    }
  }

  // Slope lighting (LanderSrc.txt:1556-1574): left-facing tiles brighter.
  const slope = Math.max(0, prevAltitude - cornerAltitude);
  const slopeBrightness = Math.min(4, slope * 4);

  // Distance brightening (LanderSrc.txt:1630-1660): closer rows paler.
  // Subtle — we don't want it to fight the fog.
  const rowBrightness = (rowsFromBack / PATCH_TILES_Z) * 3;

  const brightness = slopeBrightness + rowBrightness;
  r = Math.min(15, r + brightness);
  g = Math.min(15, g + brightness);
  b = Math.min(15, b + brightness);

  return { r: r / 15, g: g / 15, b: b / 15 };
}

/**
 * Build a flat-shaded terrain patch centred on (cameraSceneX, cameraSceneZ)
 * in scene coords.  The patch extends PATCH_TILES_X tiles either side and
 * PATCH_TILES_Z tiles forward (-Z) from the camera.
 */
export function buildTerrainMesh(cameraSceneX: number, cameraSceneZ: number): THREE.Mesh {
  const baseX = Math.floor(cameraSceneX) - PATCH_HALF_X;
  // Patch extends forward (-Z) from the camera, so the front edge (closest
  // to camera) is at cameraSceneZ and the far edge is at
  // cameraSceneZ - PATCH_TILES_Z.
  const baseZ = Math.floor(cameraSceneZ);

  // Sample heights at every corner.  getLandscapeAltitude expects world
  // coords (Z forward = positive), so negate the scene Z.
  const heights: number[][] = [];
  for (let iz = 0; iz < PATCH_TILES_Z; iz++) {
    const row: number[] = [];
    const sceneZ = baseZ - iz;
    for (let ix = 0; ix < PATCH_TILES_X; ix++) {
      const sceneX = baseX + ix;
      row.push(getLandscapeAltitude(sceneX * TILE_SIZE, -sceneZ * TILE_SIZE));
    }
    heights.push(row);
  }

  const positions: number[] = [];
  const colors: number[] = [];

  for (let iz = 0; iz < PATCH_TILES_Z - 1; iz++) {
    // Original's tileCornerRow: 1 at back, TILES_Z-1 at front.  Our iz=0 is
    // the closest row, iz=PATCH_TILES_Z-1 is the farthest, so:
    const rowsFromBack = PATCH_TILES_Z - 1 - iz;
    for (let ix = 0; ix < PATCH_TILES_X - 1; ix++) {
      const h00 = heights[iz][ix];
      const h10 = heights[iz][ix + 1];
      const h01 = heights[iz + 1][ix];
      const h11 = heights[iz + 1][ix + 1];

      const sceneX = baseX + ix;
      const sceneZ = baseZ - iz;
      // Use the right corner of this tile (heights[iz][ix+1]) as "current
      // point" and the left corner (heights[iz][ix]) as "previous point",
      // matching the original's left-to-right raster order.
      const c = tileColour(h10, h00, rowsFromBack, sceneX, sceneZ);

      const x0 = sceneX * TILE_SIZE;
      const x1 = (sceneX + 1) * TILE_SIZE;
      const z0 = sceneZ * TILE_SIZE;
      const z1 = (sceneZ - 1) * TILE_SIZE;

      const y00 = -h00;
      const y10 = -h10;
      const y01 = -h01;
      const y11 = -h11;

      // Winding chosen so normals face up; mesh is double-sided anyway.
      positions.push(x0, y00, z0, x0, y01, z1, x1, y10, z0);
      positions.push(x1, y10, z0, x0, y01, z1, x1, y11, z1);

      for (let v = 0; v < 6; v++) {
        colors.push(c.r, c.g, c.b);
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geom, mat);
}
