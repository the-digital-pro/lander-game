// Ground markers: the things drawn on the landscape to tell the player
// where they are in relation to it.
//
// Original draws a shadow oval beneath any object whose flag-bit-1 is set
// (player ship included - LanderSrc.txt object header flags).  The shadow
// tells the player how high the ship is, which is critical for landing.
//
// The sun now casts real shadows too, but a low sun throws those well off
// to one side, which is no help when you are trying to put the ship down on
// a six-tile pad.  So the straight-down shadow stays as a flying aid, and is
// joined by a landing ring (which reads green/red over a pad depending on
// whether the descent is survivable) and a reticle showing where rounds
// fired right now would strike the ground.

import * as THREE from 'three';

import { groundY } from './terrain';

const UP = new THREE.Vector3(0, 1, 0);
const normal = new THREE.Vector3();

/**
 * Lay a flat (XZ-plane) marker on the terrain at scene (x, z), tilted to
 * the slope and lifted `lift` off it.  Returns the surface height there.
 */
export function layOnGround(marker: THREE.Object3D, x: number, z: number, lift: number): number {
  const y = groundY(x, z);
  const e = 0.35;
  normal
    .set(groundY(x - e, z) - groundY(x + e, z), 2 * e, groundY(x, z - e) - groundY(x, z + e))
    .normalize();
  marker.position.set(x + normal.x * lift, y + normal.y * lift, z + normal.z * lift);
  marker.quaternion.setFromUnitVectors(UP, normal);
  return y;
}

function radialTexture(stops: ReadonlyArray<[number, string]>): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft radial disc texture, shared by anything that glows on the ground. */
export function buildGlowDiscTexture(): THREE.Texture {
  return radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.35, 'rgba(255,255,255,0.55)'],
    [0.75, 'rgba(255,255,255,0.12)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
}

export function flatPlane(size: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(size, size);
  // PlaneGeometry faces +Z by default; we want it flat on the XZ plane
  // facing up (+Y), so rotate -90 degrees around X.
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export type LandingCue = 'none' | 'safe' | 'fast';

export interface GroundMarkers {
  group: THREE.Group;
  /**
   * Position the shadow and landing ring under the ship.  `cue` colours the
   * ring when the ship is over a pad.
   */
  placeUnderShip(shipPos: THREE.Vector3, cue: LandingCue): void;
  /** Show the aim reticle at a predicted impact point, or hide it. */
  placeReticle(impact: THREE.Vector3 | null, onTarget: boolean, time: number): void;
  setVisible(visible: boolean): void;
}

const RING_IDLE = new THREE.Color().setRGB(0.55, 0.85, 1.0);
const RING_SAFE = new THREE.Color().setRGB(0.3, 2.2, 0.7);
const RING_FAST = new THREE.Color().setRGB(2.6, 0.3, 0.2);
const RETICLE_IDLE = new THREE.Color().setRGB(1.6, 1.3, 0.6);
const RETICLE_LOCK = new THREE.Color().setRGB(3.2, 0.5, 0.4);

export function buildGroundMarkers(): GroundMarkers {
  const group = new THREE.Group();

  // Shadow: dark, soft-edged, semi-transparent.
  const shadow = new THREE.Mesh(
    flatPlane(1.7),
    new THREE.MeshBasicMaterial({
      map: radialTexture([
        [0, 'rgba(0,0,0,0.85)'],
        [0.55, 'rgba(0,0,0,0.6)'],
        [1, 'rgba(0,0,0,0)'],
      ]),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  shadow.renderOrder = 2;

  const ringGeometry = new THREE.RingGeometry(0.78, 0.86, 48);
  ringGeometry.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(
    ringGeometry,
    new THREE.MeshBasicMaterial({
      color: RING_IDLE.clone(),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  ring.renderOrder = 3;

  // Aim reticle: a ring with four ticks.  Drawn without depth test so a
  // hillside never hides where the rounds are going.
  const reticle = new THREE.Group();
  const reticleMaterial = new THREE.MeshBasicMaterial({
    color: RETICLE_IDLE.clone(),
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const reticleRing = new THREE.RingGeometry(0.5, 0.56, 40);
  reticleRing.rotateX(-Math.PI / 2);
  reticle.add(new THREE.Mesh(reticleRing, reticleMaterial));
  for (let i = 0; i < 4; i++) {
    const tick = new THREE.PlaneGeometry(0.07, 0.34);
    tick.rotateX(-Math.PI / 2);
    tick.translate(0, 0, -0.78);
    tick.rotateY((i * Math.PI) / 2);
    reticle.add(new THREE.Mesh(tick, reticleMaterial));
  }
  reticle.traverse((o) => {
    o.renderOrder = 14;
  });
  reticle.visible = false;

  group.add(shadow, ring, reticle);

  const shadowMaterial = shadow.material as THREE.MeshBasicMaterial;
  const ringMaterial = ring.material as THREE.MeshBasicMaterial;

  return {
    group,
    placeUnderShip(shipPos, cue) {
      const surfaceY = layOnGround(shadow, shipPos.x, shipPos.z, 0.02);
      ring.position.copy(shadow.position);
      ring.quaternion.copy(shadow.quaternion);

      // Fade + shrink with altitude above the surface.
      const heightAboveGround = shipPos.y - surfaceY;
      const t = Math.max(0, Math.min(1, heightAboveGround / 12));
      const scale = 1 - 0.55 * t; // shrinks to ~45% at 12+ tiles altitude
      shadow.scale.set(scale, 1, scale);
      shadowMaterial.opacity = 0.75 * (1 - t * 0.85);

      // The ring does the opposite: wide when high, closing on the shadow
      // as the ship comes down, like a rangefinder.
      const spread = 1 + t * 0.9;
      ring.scale.set(spread, 1, spread);
      ringMaterial.color.copy(cue === 'safe' ? RING_SAFE : cue === 'fast' ? RING_FAST : RING_IDLE);
      ringMaterial.opacity = (cue === 'none' ? 0.3 : 0.75) * (1 - t * 0.7);
      ring.visible = heightAboveGround > 0.45;
    },
    placeReticle(impact, onTarget, time) {
      if (!impact) {
        reticle.visible = false;
        return;
      }
      reticle.visible = true;
      layOnGround(reticle, impact.x, impact.z, 0.05);
      const pulse = onTarget ? 1.25 + 0.15 * Math.sin(time * 18) : 1;
      reticle.scale.setScalar(pulse);
      reticle.rotateY(time * (onTarget ? 2.4 : 0.5));
      reticleMaterial.color.copy(onTarget ? RETICLE_LOCK : RETICLE_IDLE);
      reticleMaterial.opacity = onTarget ? 0.95 : 0.6;
    },
    setVisible(visible) {
      group.visible = visible;
    },
  };
}
