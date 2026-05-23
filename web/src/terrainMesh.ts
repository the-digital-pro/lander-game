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

function tileColour(avgAltitude: number, sceneX: number, sceneZ: number): RGB {
  // Launchpad tiles in scene coords: X in [0, LAUNCHPAD_SIZE), Z in
  // (-LAUNCHPAD_SIZE, 0].
  if (
    sceneX >= 0 &&
    sceneX < LAUNCHPAD_SIZE &&
    sceneZ <= 0 &&
    sceneZ > -LAUNCHPAD_SIZE
  ) {
    return { r: 0.72, g: 0.74, b: 0.78 };
  }
  if (avgAltitude >= SEA_LEVEL - 0.05) {
    return { r: 0.08, g: 0.22, b: 0.55 };
  }
  if (avgAltitude > 4.5) {
    return { r: 0.32, g: 0.5, b: 0.22 };
  }
  if (avgAltitude > 3.2) {
    return { r: 0.55, g: 0.55, b: 0.28 };
  }
  if (avgAltitude > 1.8) {
    return { r: 0.62, g: 0.46, b: 0.26 };
  }
  return { r: 0.78, g: 0.74, b: 0.6 };
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
    for (let ix = 0; ix < PATCH_TILES_X - 1; ix++) {
      const h00 = heights[iz][ix];
      const h10 = heights[iz][ix + 1];
      const h01 = heights[iz + 1][ix];
      const h11 = heights[iz + 1][ix + 1];

      const sceneX = baseX + ix;
      const sceneZ = baseZ - iz;
      const avg = (h00 + h10 + h01 + h11) / 4;
      const c = tileColour(avg, sceneX, sceneZ);

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
