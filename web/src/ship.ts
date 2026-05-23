// Player ship mesh.  Ported from objectPlayer (LanderSrc.txt:12801-12837).
//
// The original stores 9 vertices and 9 faces as 32-bit fixed-point EQUDs
// (TILE_SIZE = 2^24).  We convert to floats with one tile = 1.0 unit.  The
// original Y axis points down, so we negate Y for our Y-up scene.

import * as THREE from 'three';

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

function rgb12(c: number): { r: number; g: number; b: number } {
  return {
    r: ((c >> 8) & 0xf) / 15,
    g: ((c >> 4) & 0xf) / 15,
    b: (c & 0xf) / 15,
  };
}

/**
 * Build the player ship as a Three.js Group.  The mesh is centred on its
 * local origin (matching the original's xObject/yObject/zObject layout) and
 * sized so one unit = one tile.  Caller positions/rotates the group in the
 * scene.
 */
export function buildShip(): THREE.Group {
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

    const col = rgb12(face.colour);
    for (let i = 0; i < 3; i++) {
      colors.push(col.r, col.g, col.b);
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

  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, mat));
  return group;
}
