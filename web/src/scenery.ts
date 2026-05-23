// Static scenery objects.  Ported from the original object blueprints in
// LanderSrc.txt:12701-13276 and the placement logic in PlaceObjectsOnMap
// (LanderSrc.txt:12276-12413).
//
// All mesh data is decoded from the original's fixed-point EQUDs to floats,
// with Y negated so objects point UP in our Y-up scene (the original Y axis
// was positive-down).
//
// We pre-build every visible scenery mesh at startup and rely on Three.js
// frustum culling.  Most of the 2048-tile world is empty so only ~20
// objects are drawn per frame.

import * as THREE from 'three';

import { LAUNCHPAD_ALTITUDE, LAUNCHPAD_SIZE, SEA_LEVEL } from './constants';
import { getLandscapeAltitude } from './terrain';

interface Face {
  a: number;
  b: number;
  c: number;
  colour: number;
}

// ---------------------------------------------------------------------------
// Object 9: rocket (LanderSrc.txt:13249-13276) — 13 verts, 8 faces.
// ---------------------------------------------------------------------------
const ROCKET_VERTS: ReadonlyArray<[number, number, number]> = [
  [0, -1.75, 0],
  [-0.21875, -0.15909, 0.21875],
  [-0.21875, -0.15909, -0.21875],
  [0.21875, -0.15909, 0.21875],
  [0.21875, -0.15909, -0.21875],
  [-0.4375, 0, 0.4375],
  [-0.4375, 0, -0.4375],
  [0.4375, 0, 0.4375],
  [0.4375, 0, -0.4375],
  [-0.109375, -0.97223, 0.109375],
  [-0.109375, -0.97223, -0.109375],
  [0.109375, -0.97223, 0.109375],
  [0.109375, -0.97223, -0.109375],
];
const ROCKET_FACES: ReadonlyArray<Face> = [
  { a: 9, b: 1, c: 5, colour: 0xcc0 },
  { a: 11, b: 3, c: 7, colour: 0xcc0 },
  { a: 0, b: 1, c: 3, colour: 0xc00 },
  { a: 0, b: 1, c: 2, colour: 0x800 },
  { a: 3, b: 0, c: 4, colour: 0x800 },
  { a: 0, b: 2, c: 4, colour: 0xc00 },
  { a: 10, b: 2, c: 6, colour: 0xcc0 },
  { a: 12, b: 4, c: 8, colour: 0xcc0 },
];

// ---------------------------------------------------------------------------
// Object 1/3/4: small leafy tree (LanderSrc.txt:12860-12882).
// ---------------------------------------------------------------------------
const SMALL_LEAFY_VERTS: ReadonlyArray<[number, number, number]> = [
  [0.1875, -1.5, 0.1875], // V0  canopy peak
  [-0.15, 0, 0], // V1  trunk left
  [0.15, 0, 0], // V2  trunk right
  [0, -1.05, -0.75],
  [0.5, -0.75, -0.5],
  [-0.75, -1.2, -0.1667],
  [-0.5, -1.35, 0.25],
  [0.5, -1.65, 0.1667],
  [0.75, -1.35, -0.25],
  [-0.375, -1.2, 0.6],
  [0.75, -0.75, 0.75],
];
const SMALL_LEAFY_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 9, c: 10, colour: 0x040 },
  { a: 0, b: 1, c: 2, colour: 0x400 }, // trunk
  { a: 0, b: 3, c: 4, colour: 0x080 },
  { a: 0, b: 5, c: 6, colour: 0x080 },
  { a: 0, b: 7, c: 8, colour: 0x080 },
];

// ---------------------------------------------------------------------------
// Object 2/6: tall leafy tree (LanderSrc.txt:12905-12931).
// ---------------------------------------------------------------------------
const TALL_LEAFY_VERTS: ReadonlyArray<[number, number, number]> = [
  [0.214, -2.55, 0.1875],
  [-0.1875, 0, 0],
  [0.1875, 0, 0],
  [0, -1.95, -0.75],
  [0.5, -1.648, -0.5],
  [-0.675, -1.8, -0.214],
  [-0.75, -1.35, 0.375],
  [0, -0.9, -0.6],
  [-0.5, -0.75, -0.375],
  [-0.375, -1.5, 0.6],
  [0.75, -1.2, 0.75],
  [-0.3, -0.9, 0.9],
  [0.5, -0.75, 0.75],
  [0.1875, -1.648, 0.1875],
];
const TALL_LEAFY_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 9, c: 10, colour: 0x040 },
  { a: 13, b: 11, c: 12, colour: 0x080 },
  { a: 0, b: 1, c: 2, colour: 0x400 }, // trunk
  { a: 0, b: 3, c: 4, colour: 0x080 },
  { a: 0, b: 5, c: 6, colour: 0x040 },
  { a: 13, b: 7, c: 8, colour: 0x040 },
];

// ---------------------------------------------------------------------------
// Object 7: fir tree (LanderSrc.txt:13026-13039) — 5 verts, 2 faces.
// ---------------------------------------------------------------------------
const FIR_VERTS: ReadonlyArray<[number, number, number]> = [
  [-0.375, -0.214, -0.214],
  [0.375, -0.214, -0.214],
  [0, -1.8, 0.214],
  [0.15, 0, 0],
  [-0.15, 0, 0],
];
const FIR_FACES: ReadonlyArray<Face> = [
  { a: 2, b: 3, c: 4, colour: 0x400 }, // trunk strip
  { a: 0, b: 1, c: 2, colour: 0x040 }, // leaf triangle
];

// ---------------------------------------------------------------------------
// Object 8: building (LanderSrc.txt:13112-13146) — 16 verts, 12 faces.
// ---------------------------------------------------------------------------
const BUILDING_VERTS: ReadonlyArray<[number, number, number]> = [
  [-0.9, -0.85, 0], // V0  back wall left peak
  [-0.75, -0.85, 0], // V1
  [0.75, -0.85, 0], // V2
  [0.9, -0.85, 0], // V3  back wall right peak
  [-0.9, -0.45, 0.65], // V4  front wall top corners
  [-0.9, -0.45, -0.65], // V5
  [0.9, -0.45, 0.65], // V6
  [0.9, -0.45, -0.65], // V7
  [-0.75, -0.6, 0.5], // V8  eaves
  [-0.75, -0.6, -0.5], // V9
  [0.75, -0.6, 0.5], // V10
  [0.75, -0.6, -0.5], // V11
  [-0.75, 0, 0.5], // V12 base
  [-0.75, 0, -0.5], // V13
  [0.75, 0, 0.5], // V14
  [0.75, 0, -0.5], // V15
];
const BUILDING_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 4, c: 6, colour: 0x400 }, // roof front
  { a: 0, b: 3, c: 6, colour: 0x400 },
  { a: 1, b: 8, c: 9, colour: 0xddd },
  { a: 2, b: 10, c: 11, colour: 0x555 },
  { a: 8, b: 12, c: 13, colour: 0xfff },
  { a: 8, b: 9, c: 13, colour: 0xfff },
  { a: 10, b: 14, c: 15, colour: 0x777 },
  { a: 10, b: 11, c: 15, colour: 0x777 },
  { a: 9, b: 13, c: 15, colour: 0xbbb },
  { a: 9, b: 11, c: 15, colour: 0xbbb },
  { a: 0, b: 5, c: 7, colour: 0x800 }, // roof back
  { a: 0, b: 3, c: 7, colour: 0x800 },
];

// ---------------------------------------------------------------------------
// Smoking remains (LanderSrc.txt:12954-12967) — 5 verts, 2 black faces.
// ---------------------------------------------------------------------------
const SMOKING_VERTS: ReadonlyArray<[number, number, number]> = [
  [-0.15, 0, 0], // V0 base left
  [0.15, 0, 0], // V1 base right
  [0.169, -0.25, 0], // V2 first kink
  [0.1875, -0.5, 0], // V3 mid kink
  [-0.167, -1.2, 0], // V4 top (leaning left)
];
const SMOKING_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 3, colour: 0x000 },
  { a: 2, b: 3, c: 4, colour: 0x000 },
];

// ---------------------------------------------------------------------------
// Object 5: gazebo (LanderSrc.txt:13062-13089) — 13 verts, 8 faces.
// ---------------------------------------------------------------------------
const GAZEBO_VERTS: ReadonlyArray<[number, number, number]> = [
  [0, -1.0, 0], // V0 roof peak
  [-0.5, -0.75, 0.5],
  [-0.5, -0.75, -0.5],
  [0.5, -0.75, -0.5],
  [0.5, -0.75, 0.5],
  [-0.5, 0, 0.5],
  [-0.5, 0, -0.5],
  [0.5, 0, -0.5],
  [0.5, 0, 0.5],
  [-0.4, -0.75, 0.5],
  [-0.4, -0.75, -0.5],
  [0.4, -0.75, -0.5],
  [0.4, -0.75, 0.5],
];
const GAZEBO_FACES: ReadonlyArray<Face> = [
  { a: 1, b: 5, c: 9, colour: 0x444 },
  { a: 2, b: 6, c: 10, colour: 0x444 },
  { a: 0, b: 1, c: 4, colour: 0x400 },
  { a: 3, b: 7, c: 11, colour: 0x444 },
  { a: 4, b: 8, c: 12, colour: 0x444 },
  { a: 0, b: 1, c: 2, colour: 0x840 },
  { a: 0, b: 3, c: 4, colour: 0x840 },
  { a: 0, b: 2, c: 3, colour: 0x400 },
];

// ---------------------------------------------------------------------------
// Mesh builder.
// ---------------------------------------------------------------------------

function rgb12(c: number): { r: number; g: number; b: number } {
  return {
    r: ((c >> 8) & 0xf) / 15,
    g: ((c >> 4) & 0xf) / 15,
    b: (c & 0xf) / 15,
  };
}

function buildObjectGeom(
  vertices: ReadonlyArray<[number, number, number]>,
  faces: ReadonlyArray<Face>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const f of faces) {
    const va = vertices[f.a];
    const vb = vertices[f.b];
    const vc = vertices[f.c];
    // Negate Y to flip from original positive-down to Y-up.
    positions.push(va[0], -va[1], va[2]);
    positions.push(vb[0], -vb[1], vb[2]);
    positions.push(vc[0], -vc[1], vc[2]);

    const col = rgb12(f.colour);
    for (let i = 0; i < 3; i++) {
      colors.push(col.r, col.g, col.b);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

// One geometry per object type — instances share via mesh.material reuse.
const GEOMS = {
  smallLeafy: buildObjectGeom(SMALL_LEAFY_VERTS, SMALL_LEAFY_FACES),
  tallLeafy: buildObjectGeom(TALL_LEAFY_VERTS, TALL_LEAFY_FACES),
  fir: buildObjectGeom(FIR_VERTS, FIR_FACES),
  gazebo: buildObjectGeom(GAZEBO_VERTS, GAZEBO_FACES),
  rocket: buildObjectGeom(ROCKET_VERTS, ROCKET_FACES),
  building: buildObjectGeom(BUILDING_VERTS, BUILDING_FACES),
  smoking: buildObjectGeom(SMOKING_VERTS, SMOKING_FACES),
};

const SHARED_MATERIAL = new THREE.MeshBasicMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
});

function geomForType(type: number): THREE.BufferGeometry {
  // Per LanderSrc.txt:4640-4651.
  switch (type) {
    case 1:
    case 3:
    case 4:
      return GEOMS.smallLeafy;
    case 2:
    case 6:
      return GEOMS.tallLeafy;
    case 5:
      return GEOMS.gazebo;
    case 7:
      return GEOMS.fir;
    case 8:
      return GEOMS.building;
    case 9:
      return GEOMS.rocket;
    default:
      return GEOMS.smallLeafy;
  }
}

/** Sentinel object-map value for a destroyed-but-still-on-the-map tile. */
export const SMOKING_REMAINS_TYPE = 13;

// ---------------------------------------------------------------------------
// Object map.
// ---------------------------------------------------------------------------

const MAP_SIZE = 256;
const OBJECT_NONE = 0xff;

/**
 * Populate a 256x256 byte array with random objects, then add the three
 * launchpad rockets at fixed positions (LanderSrc.txt:12305-12413).
 */
export function populateObjectMap(): Uint8Array {
  const map = new Uint8Array(MAP_SIZE * MAP_SIZE);
  map.fill(OBJECT_NONE);

  // 2048 random placements; skip sea and launchpad tiles.
  for (let i = 0; i < 2048; i++) {
    const x = Math.floor(Math.random() * MAP_SIZE);
    const z = Math.floor(Math.random() * MAP_SIZE);
    const alt = getLandscapeAltitude(x, z);
    if (alt >= SEA_LEVEL - 1e-6 || alt <= LAUNCHPAD_ALTITUDE + 1e-6) {
      continue;
    }
    // Random type 1-8 (per LanderSrc.txt:12348-12361).
    const type = 1 + Math.floor(Math.random() * 8);
    map[z * MAP_SIZE + x] = type;
  }

  // Three launchpad rockets at world (7, 1), (7, 3), (7, 5).
  map[1 * MAP_SIZE + 7] = 9;
  map[3 * MAP_SIZE + 7] = 9;
  map[5 * MAP_SIZE + 7] = 9;

  return map;
}

// ---------------------------------------------------------------------------
// Scene placement.
// ---------------------------------------------------------------------------

export interface Scenery {
  group: THREE.Group;
  meshes: Map<number, THREE.Mesh>;
  map: Uint8Array;
}

/**
 * Build a Group containing one Mesh per occupied tile in the object map.
 * Each mesh shares a geometry per type (one per type) and a single material,
 * keeping draw setup light.  Three.js frustum culling keeps the per-frame
 * draw count low (~tens of meshes at any time).  Returns the group together
 * with a tile-keyed mesh index so individual objects can be destroyed.
 */
export function buildScenery(map: Uint8Array): Scenery {
  const group = new THREE.Group();
  const meshes = new Map<number, THREE.Mesh>();

  for (let z = 0; z < MAP_SIZE; z++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const type = map[z * MAP_SIZE + x];
      if (type === OBJECT_NONE) continue;

      const geom = geomForType(type);
      const mesh = new THREE.Mesh(geom, SHARED_MATERIAL);

      const onPad = x >= 0 && x < LAUNCHPAD_SIZE && z >= 0 && z < LAUNCHPAD_SIZE;
      const surfaceAlt = onPad ? LAUNCHPAD_ALTITUDE : getLandscapeAltitude(x, z);
      mesh.position.set(x, -surfaceAlt, -z);
      group.add(mesh);
      meshes.set(z * MAP_SIZE + x, mesh);
    }
  }
  return { group, meshes, map };
}

/**
 * Destroy the object at (tileX, tileZ) in the object map.  Replaces the mesh
 * with the smoking-remains mesh in place (LanderSrc.txt:12943) and marks the
 * tile with SMOKING_REMAINS_TYPE — collision logic treats types >= 12 as
 * pass-through so the player can fly over remains safely.  Returns the
 * world-space position of the destroyed object so the caller can spawn an
 * explosion there, or null if no object was present.
 */
export function destroyObject(
  scenery: Scenery,
  tileX: number,
  tileZ: number,
): THREE.Vector3 | null {
  if (tileX < 0 || tileX >= MAP_SIZE || tileZ < 0 || tileZ >= MAP_SIZE) return null;
  const key = tileZ * MAP_SIZE + tileX;
  const type = scenery.map[key];
  if (type === OBJECT_NONE || type >= 12) return null; // empty or already remains
  const oldMesh = scenery.meshes.get(key);
  if (!oldMesh) {
    scenery.map[key] = OBJECT_NONE;
    return null;
  }
  const pos = oldMesh.position.clone();
  scenery.group.remove(oldMesh);

  const remains = new THREE.Mesh(GEOMS.smoking, SHARED_MATERIAL);
  remains.position.copy(pos);
  scenery.group.add(remains);
  scenery.meshes.set(key, remains);
  scenery.map[key] = SMOKING_REMAINS_TYPE;

  return pos;
}
