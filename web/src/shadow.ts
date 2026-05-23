// Ship-cast shadow on the ground.  Original draws a shadow oval beneath
// any object whose flag-bit-1 is set (player ship included — LanderSrc.txt
// object header flags).  The shadow tells the player how high the ship
// is, which is critical for landing.

import * as THREE from 'three';

import { getLandscapeAltitude } from './terrain';
import { LAUNCHPAD_SIZE, LAUNCHPAD_ALTITUDE } from './constants';

const SHADOW_RADIUS = 0.55;

export function buildShipShadow(): THREE.Mesh {
  // Flat circle, dark, semi-transparent.  Rendered slightly above the
  // ground so it doesn't z-fight the terrain.
  const geom = new THREE.CircleGeometry(SHADOW_RADIUS, 18);
  // CircleGeometry's plane faces +Z by default; we want it flat on the XZ
  // plane facing up (+Y), so rotate -90° around X.
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
  return new THREE.Mesh(geom, mat);
}

/**
 * Position the shadow directly under the ship on the terrain surface.
 * Scales down with altitude so it represents a clearer reference point
 * near the ground and fades out high up.
 */
export function placeShipShadow(shadow: THREE.Mesh, shipPos: THREE.Vector3): void {
  const worldX = shipPos.x;
  const worldZ = -shipPos.z; // scene Z forward = -Z → world Z = -scene Z
  const onPad =
    worldX >= 0 && worldX < LAUNCHPAD_SIZE && worldZ >= 0 && worldZ < LAUNCHPAD_SIZE;
  const altitude = onPad ? LAUNCHPAD_ALTITUDE : getLandscapeAltitude(worldX, worldZ);
  const surfaceY = -altitude;

  shadow.position.set(shipPos.x, surfaceY + 0.01, shipPos.z);

  // Fade + shrink with altitude above the surface.
  const heightAboveGround = shipPos.y - surfaceY;
  const t = Math.max(0, Math.min(1, heightAboveGround / 10));
  const scale = 1 - 0.6 * t; // shrinks to ~40% at 10+ tiles altitude
  shadow.scale.set(scale, 1, scale);
  const mat = shadow.material as THREE.MeshBasicMaterial;
  mat.opacity = 0.5 * (1 - t * 0.9); // mostly fades out high up
  shadow.visible = mat.opacity > 0.02;
}
