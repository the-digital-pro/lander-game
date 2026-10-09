// Player ship mesh.  Ported from objectPlayer (LanderSrc.txt:12801-12837).
//
// The original stores 9 vertices and 9 faces as 32-bit fixed-point EQUDs
// (TILE_SIZE = 2^24).  We convert to floats with one tile = 1.0 unit.  The
// original Y axis points down, so we negate Y for our Y-up scene.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';

// Vertex positions in original-Y orientation (LanderSrc.txt:12816-12824).
const SHIP_VERTICES: ReadonlyArray<[number, number, number]> = [
  [1.0, 0.3125, 0.5],       // V0  front-right hull
  [1.0, 0.3125, -0.5],      // V1  front-left hull
  [0.0, 0.0390625, -1.2],   // V2  left wing tip
  [-0.9, 0.3125, 0.0],      // V3  rear point
  [0.0, 0.0390625, 1.2],    // V4  right wing tip
  [-0.1, -0.46875, 0.0],    // V5  cockpit canopy (highest after Y flip)
  [0.333, 0.3125, 0.25],    // V6  landing leg fwd-right
  [0.333, 0.3125, -0.25],   // V7  landing leg fwd-left
  [-0.2, 0.3125, 0.0],      // V8  landing leg rear
];

// Face (v1, v2, v3, colour) from LanderSrc.txt:12829-12837.  Colour is the
// Archimedes' 12-bit RGB format: &XYZ -> R = X/15, G = Y/15, B = Z/15.
interface Face {
  a: number;
  b: number;
  c: number;
  colour: number;
}
const SHIP_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 5, colour: 0x080 }, // upper hull, forward triangle
  { a: 1, b: 2, c: 5, colour: 0x040 }, // upper hull, left front
  { a: 0, b: 5, c: 4, colour: 0x040 }, // upper hull, right front
  { a: 2, b: 3, c: 5, colour: 0x040 }, // upper hull, left rear
  { a: 3, b: 4, c: 5, colour: 0x040 }, // upper hull, right rear
  { a: 1, b: 2, c: 3, colour: 0x088 }, // belly, left
  { a: 0, b: 3, c: 4, colour: 0x088 }, // belly, right
  { a: 0, b: 1, c: 3, colour: 0x044 }, // belly, forward
  { a: 6, b: 7, c: 8, colour: 0xc80 }, // landing pad underside (amber)
];

const scratchColour = new THREE.Color();

/** Local-space point the engine light and glow hang from. */
const ENGINE_Y = -0.42;

export interface Ship extends THREE.Group {
  userData: {
    engineLight: THREE.PointLight;
    engineGlow: THREE.Sprite;
  };
}

function buildGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,220,170,0.75)');
  gradient.addColorStop(0.6, 'rgba(255,120,40,0.22)');
  gradient.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Build the player ship as a Three.js Group.  The mesh is centred on its
 * local origin (matching the original's xObject/yObject/zObject layout) and
 * sized so one unit = one tile.  Caller positions/rotates the group in the
 * scene.
 *
 * The hull is the original nine triangles in the original colours; what is
 * new is that it is lit, casts a shadow, and carries an engine light that
 * throws a warm pool onto the ground when it burns close to it.
 */
export function buildShip(): Ship {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const face of SHIP_FACES) {
    const va = SHIP_VERTICES[face.a];
    const vb = SHIP_VERTICES[face.b];
    const vc = SHIP_VERTICES[face.c];
    // Negate Y to flip from original positive-down to Y-up.
    positions.push(va[0], -va[1], va[2]);
    positions.push(vb[0], -vb[1], vb[2]);
    positions.push(vc[0], -vc[1], vc[2]);

    // 12-bit Archimedes colours are display values: sRGB -> linear.
    // Lifted a little at the dark end, as scenery.ts does and for the same
    // reason: these were unlit display colours and now sit under a sun.
    scratchColour.setRGB(
      Math.pow(((face.colour >> 8) & 0xf) / 15, 0.75),
      Math.pow(((face.colour >> 4) & 0xf) / 15, 0.75),
      Math.pow((face.colour & 0xf) / 15, 0.75),
      THREE.SRGBColorSpace,
    );
    for (let i = 0; i < 3; i++) {
      colors.push(scratchColour.r, scratchColour.g, scratchColour.b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    // A touch of self-light so the dark-green hull never sinks into the
    // dark-green land beneath it.
    emissive: new THREE.Color(0x0b2a1c),
  });

  const hull = new THREE.Mesh(geom, shadeWithClouds(mat));
  hull.castShadow = true;

  const engineLight = new THREE.PointLight(0xffa860, 0, 11, 2);
  engineLight.position.set(0, ENGINE_Y - 0.3, 0);

  const engineGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: buildGlowTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    }),
  );
  engineGlow.position.set(0, ENGINE_Y, 0);
  engineGlow.renderOrder = 13;

  const group = new THREE.Group() as Ship;
  group.add(hull, engineLight, engineGlow);
  group.userData = { engineLight, engineGlow };
  return group;
}

let engineLevel = 0;

/**
 * Drive the engine light and glow.  `throttle` is 0 (off), ~0.35 (hover) or
 * 1 (full thrust); the response is eased so the light breathes rather than
 * snapping.  Call once per rendered frame.
 */
export function setShipEngine(ship: Ship, throttle: number, time: number): void {
  engineLevel += (throttle - engineLevel) * 0.3;
  const flicker = 0.88 + 0.12 * Math.sin(time * 61) * Math.sin(time * 37);
  const level = engineLevel * flicker;
  ship.userData.engineLight.intensity = level * 16;
  const glow = ship.userData.engineGlow;
  glow.material.opacity = Math.min(1, level * 1.4);
  const size = 0.5 + level * 1.1;
  glow.scale.set(size, size, 1);
  glow.material.color.setScalar(1 + level * 2.5);
}
