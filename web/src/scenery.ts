// Static scenery objects.  Ported from the original object blueprints in
// LanderSrc.txt:12701-13276 and the placement logic in PlaceObjectsOnMap
// (LanderSrc.txt:12276-12413).
//
// All mesh data is decoded from the original's fixed-point EQUDs to floats,
// with Y negated so objects point UP in our Y-up scene (the original Y axis
// was positive-down).
//
// Rendering is instanced: one InstancedMesh per blueprint, so the whole
// map's worth of trees, buildings and wreckage is about a dozen draw calls
// however many objects are in view.  The world is a torus, so each object is
// drawn at whichever copy of itself is nearest the player.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { SEA_LEVEL } from './constants';
import { infection, MUTATION_LEVEL } from './infection';
import { spawnSmokeParticle } from './particles';
import {
  PADS,
  meshAltitude,
  nearestVolcano,
  padClearance,
  tileIndex,
  turbineClearance,
  wrapDelta,
  WORLD_SIZE,
} from './terrain';

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
// Smoking remains, left-leaning (LanderSrc.txt:12954-12967) — 5 verts, 2
// black faces.  Used for destroyed trees, fir, rocket — alternates with the
// right-leaning variant by tile parity.
// ---------------------------------------------------------------------------
const SMOKING_LEFT_VERTS: ReadonlyArray<[number, number, number]> = [
  [-0.166, 0, 0],   // V0 base
  [0.167, 0, 0],    // V1 base
  [0.168, -0.187, 0], // V2 first kink (leaning right at base)
  [0.1875, -0.375, 0], // V3 mid kink
  [-0.167, -1.2, 0],   // V4 top (leans left)
];
const SMOKING_LEFT_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 3, colour: 0x000 },
  { a: 2, b: 3, c: 4, colour: 0x000 },
];

// ---------------------------------------------------------------------------
// Smoking remains, right-leaning (LanderSrc.txt:12990-13003) — mirror of
// the left variant.
// ---------------------------------------------------------------------------
const SMOKING_RIGHT_VERTS: ReadonlyArray<[number, number, number]> = [
  [0.167, 0, 0],     // V0 base
  [-0.167, 0, 0],    // V1 base
  [-0.168, -0.187, 0], // V2 first kink (leaning left at base)
  [-0.1875, -0.375, 0], // V3 mid kink
  [0.167, -1.2, 0],     // V4 top (leans right)
];
const SMOKING_RIGHT_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 3, colour: 0x000 },
  { a: 2, b: 3, c: 4, colour: 0x000 },
];

// ---------------------------------------------------------------------------
// Smoking building (LanderSrc.txt:13169-13187) — 6 verts, 6 faces.
// Footprint floor (V0..V3) + two surviving walls (V4 leans up from the
// front-left, V5 leans up from the back-right).
// ---------------------------------------------------------------------------
const SMOKING_BUILDING_VERTS: ReadonlyArray<[number, number, number]> = [
  [-0.75, 0, 0.5],   // V0
  [-0.75, 0, -0.5],  // V1
  [0.75, 0, 0.5],    // V2
  [0.75, 0, -0.5],   // V3
  [-0.75, -0.4, 0.5], // V4  upright wall section, front-left
  [0.75, -0.3, -0.5], // V5  upright wall section, back-right
];
const SMOKING_BUILDING_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 2, colour: 0x000 }, // burnt floor
  { a: 1, b: 2, c: 3, colour: 0x000 }, // burnt floor
  { a: 0, b: 2, c: 4, colour: 0x333 }, // surviving wall
  { a: 0, b: 1, c: 4, colour: 0x666 },
  { a: 2, b: 3, c: 5, colour: 0x555 },
  { a: 1, b: 3, c: 5, colour: 0x777 },
];

// ---------------------------------------------------------------------------
// Smoking gazebo (LanderSrc.txt:13210-13226) — 6 verts, 4 faces.  Two
// leaning posts (V0/V1) and a square footprint (V2..V5).
// ---------------------------------------------------------------------------
const SMOKING_GAZEBO_VERTS: ReadonlyArray<[number, number, number]> = [
  [0, -0.45, -0.0625],   // V0  leaning post top
  [0.1, -0.45, -0.0625], // V1  leaning post top
  [0.5, 0, 0.5],         // V2  base
  [-0.5, 0, 0.5],        // V3  base
  [0.5, 0, -0.5],        // V4  base
  [-0.5, 0, -0.5],       // V5  base
];
const SMOKING_GAZEBO_FACES: ReadonlyArray<Face> = [
  { a: 0, b: 1, c: 2, colour: 0x000 },
  { a: 0, b: 1, c: 3, colour: 0x333 },
  { a: 0, b: 1, c: 4, colour: 0x444 },
  { a: 0, b: 1, c: 5, colour: 0x000 },
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

const scratchColour = new THREE.Color();

/**
 * One 4-bit Archimedes colour channel -> a display value for a lit scene.
 *
 * The original palette was authored to be shown as-is, unlit, and its
 * foliage and roofs are very dark (&040 is a 27% green).  Put under a sun
 * those faces would render at a fraction of that and turn to silhouettes,
 * so the dark end is lifted - hue is untouched - to land a sunlit face
 * about where the original drew it.
 */
function litChannel(nibble: number): number {
  return 0.86 * Math.pow(nibble / 15, 0.62);
}

/**
 * Build a flat-shaded geometry from a ported blueprint.  Colours are the
 * Archimedes' 12-bit RGB (&XYZ -> R = X/15 ...), which are display values,
 * so they are converted from sRGB into the linear space the lighting works
 * in.  `recolour` lets a variant swap face colours (mutated foliage).
 */
function buildObjectGeom(
  vertices: ReadonlyArray<[number, number, number]>,
  faces: ReadonlyArray<Face>,
  recolour?: (colour: number) => number,
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

    const c = recolour ? recolour(f.colour) : f.colour;
    scratchColour.setRGB(
      litChannel((c >> 8) & 0xf),
      litChannel((c >> 4) & 0xf),
      litChannel(c & 0xf),
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
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Foliage on infected ground mutates: greens turn to the crimson and pink
 * of a Zarch tree gone bad.  Trunks (&400) are left alone.
 */
function mutantFoliage(colour: number): number {
  if (colour === 0x040) return 0x913;
  if (colour === 0x080) return 0xf4a;
  return colour;
}

// One geometry per blueprint.  Order matters: it is the Kind index.
const KIND = {
  smallLeafy: 0,
  tallLeafy: 1,
  fir: 2,
  gazebo: 3,
  building: 4,
  rocket: 5,
  smallLeafyMutant: 6,
  tallLeafyMutant: 7,
  firMutant: 8,
  smokingLeft: 9,
  smokingRight: 10,
  smokingGazebo: 11,
  smokingBuilding: 12,
} as const;

const GEOMS: ReadonlyArray<THREE.BufferGeometry> = [
  buildObjectGeom(SMALL_LEAFY_VERTS, SMALL_LEAFY_FACES),
  buildObjectGeom(TALL_LEAFY_VERTS, TALL_LEAFY_FACES),
  buildObjectGeom(FIR_VERTS, FIR_FACES),
  buildObjectGeom(GAZEBO_VERTS, GAZEBO_FACES),
  buildObjectGeom(BUILDING_VERTS, BUILDING_FACES),
  buildObjectGeom(ROCKET_VERTS, ROCKET_FACES),
  buildObjectGeom(SMALL_LEAFY_VERTS, SMALL_LEAFY_FACES, mutantFoliage),
  buildObjectGeom(TALL_LEAFY_VERTS, TALL_LEAFY_FACES, mutantFoliage),
  buildObjectGeom(FIR_VERTS, FIR_FACES, mutantFoliage),
  buildObjectGeom(SMOKING_LEFT_VERTS, SMOKING_LEFT_FACES),
  buildObjectGeom(SMOKING_RIGHT_VERTS, SMOKING_RIGHT_FACES),
  buildObjectGeom(SMOKING_GAZEBO_VERTS, SMOKING_GAZEBO_FACES),
  buildObjectGeom(SMOKING_BUILDING_VERTS, SMOKING_BUILDING_FACES),
];

// The blueprints are open sheets of triangles, not solids, so both sides
// have to render and both sides have to light.
const SHARED_MATERIAL = shadeWithClouds(
  new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  }),
);

/** Sentinel object-map value for a destroyed-but-still-on-the-map tile. */
export const SMOKING_REMAINS_TYPE = 13;

const OBJECT_NONE = 0xff;

function isTree(type: number): boolean {
  return type === 1 || type === 2 || type === 3 || type === 4 || type === 6 || type === 7;
}

/** Blueprint for a live object type.  Per LanderSrc.txt:4640-4651. */
function kindForType(type: number, mutated: boolean): number {
  switch (type) {
    case 1:
    case 3:
    case 4:
      return mutated ? KIND.smallLeafyMutant : KIND.smallLeafy;
    case 2:
    case 6:
      return mutated ? KIND.tallLeafyMutant : KIND.tallLeafy;
    case 5:
      return KIND.gazebo;
    case 7:
      return mutated ? KIND.firMutant : KIND.fir;
    case 8:
      return KIND.building;
    case 9:
    case 10:
    case 11:
      return KIND.rocket;
    default:
      return KIND.smallLeafy;
  }
}

/**
 * Pick the smoking-remains blueprint for a destroyed object.  Mirrors the
 * original objectTypes table (LanderSrc.txt:4640-4666) which maps
 * different destroyed object types to specific variant blueprints -
 * gazebos become `objectSmokingGazebo`, buildings become
 * `objectSmokingBuilding`, and everything else alternates between the
 * left- and right-leaning generic smoking stumps.
 */
function remainsKindFor(originalType: number, tileX: number, tileZ: number): number {
  if (originalType === 5) return KIND.smokingGazebo;
  if (originalType === 8) return KIND.smokingBuilding;
  // Alternate left/right by tile parity so neighbouring stumps don't all
  // lean the same way.
  const parity = ((tileX + tileZ) & 1) === 0;
  return parity ? KIND.smokingLeft : KIND.smokingRight;
}

/** Height of each object type above its base, in tiles (unscaled). */
function baseHeight(type: number): number {
  switch (type) {
    case 2:
    case 6:
      return 2.55;
    case 5:
      return 1.0;
    case 7:
      return 1.8;
    case 8:
      return 0.85;
    case 9:
    case 10:
    case 11:
      return 1.75;
    default:
      return 1.65;
  }
}

function tileHash(i: number): number {
  let h = Math.imul(i + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Trees get a little per-tile variety in size and facing so a wood doesn't
 * look stamped out.  Everything man-made keeps its ported proportions.
 */
function objectScale(tile: number, type: number): number {
  if (!isTree(type)) return 1;
  return 0.88 + ((tileHash(tile) & 0xff) / 255) * 0.4;
}

function objectYaw(tile: number, type: number): number {
  const h = tileHash(tile) >>> 8;
  if (isTree(type)) return ((h & 0xfff) / 0xfff) * Math.PI * 2;
  if (type === 5 || type === 8) return (h & 3) * (Math.PI / 2);
  return 0;
}

// ---------------------------------------------------------------------------
// Object map.
// ---------------------------------------------------------------------------

/**
 * Populate a 256x256 byte array with random objects, then add the launchpad
 * rockets at fixed positions (LanderSrc.txt:12305-12413).
 */
export function populateObjectMap(): Uint8Array {
  const map = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
  map.fill(OBJECT_NONE);

  // 2048 random placements; skip the sea and keep the landing zones and
  // their approaches clear.
  for (let i = 0; i < 2048; i++) {
    const x = Math.floor(Math.random() * WORLD_SIZE);
    const z = Math.floor(Math.random() * WORLD_SIZE);
    const alt = meshAltitude(x + 0.5, z + 0.5);
    if (alt >= SEA_LEVEL - 0.08) continue;
    if (padClearance(x + 0.5, z + 0.5) < 2.5) continue;
    if (alt < 0.9) continue; // nothing grows on the summits
    const cone = nearestVolcano(x + 0.5, z + 0.5);
    if (cone && cone.distance < cone.volcano.radius * 0.8) continue; // or on a volcano
    if (turbineClearance(x + 0.5, z + 0.5) < 3) continue; // or under a turbine
    // Random type 1-8 (per LanderSrc.txt:12348-12361).
    let type = 1 + Math.floor(Math.random() * 8);
    // Above the tree line it is firs or nothing.
    if (alt < 2.2) type = 7;
    map[(z << 8) | x] = type;
  }

  for (const pad of PADS) {
    if (pad.home) {
      // Three launchpad rockets at world (7, 1), (7, 3), (7, 5).
      map[(1 << 8) | 7] = 9;
      map[(3 << 8) | 7] = 9;
      map[(5 << 8) | 7] = 9;
    } else {
      // Each outpost gets a hut and a rocket on its eastern apron, so it
      // reads as a place and not just a slab.
      const ex = pad.x0 + pad.size + 1;
      map[tileIndex(ex, pad.z0 + 1)] = 8;
      map[tileIndex(ex, pad.z0 + pad.size - 2)] = 9;
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Scene placement.
// ---------------------------------------------------------------------------

export interface DestroyedTile {
  /** World tile-centre of the wreck. */
  wx: number;
  wz: number;
  /** Scene Y at the top of the wreckage, where smoke spawns. */
  smokeY: number;
  /** Original object type before destruction (1..11) - drives smoke profile. */
  originalType: number;
}

export interface Scenery {
  group: THREE.Group;
  /** Object type per tile; OBJECT_NONE where empty.  Shared with physics. */
  map: Uint8Array;
  /** Every tile destroyed so far in this game (LanderSrc.txt:4908-4945). */
  destroyedTiles: DestroyedTile[];
  /** Set when instances need rebuilding (something was destroyed/mutated). */
  dirty: boolean;
}

interface SceneryInternal extends Scenery {
  meshes: THREE.InstancedMesh[];
  /** Tile indices that hold something (live or wreckage). */
  occupied: number[];
  /** Original type of each destroyed tile, for picking its remains. */
  remainsOf: Uint8Array;
  lastX: number;
  lastZ: number;
}

const MAX_INSTANCES = 2200;

export function buildScenery(): Scenery {
  const group = new THREE.Group();
  const meshes = GEOMS.map((geom) => {
    const mesh = new THREE.InstancedMesh(geom, SHARED_MATERIAL, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Instances are spread over the whole map and re-placed as the player
    // moves; per-mesh culling would need its bounds recomputed each time.
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  });

  const scenery: SceneryInternal = {
    group,
    meshes,
    map: new Uint8Array(0),
    occupied: [],
    remainsOf: new Uint8Array(WORLD_SIZE * WORLD_SIZE),
    destroyedTiles: [],
    dirty: true,
    lastX: Infinity,
    lastZ: Infinity,
  };
  resetScenery(scenery);
  return scenery;
}

/** Scatter a fresh set of objects for a new game. */
export function resetScenery(scenery: Scenery): void {
  const s = scenery as SceneryInternal;
  s.map = populateObjectMap();
  s.occupied.length = 0;
  for (let i = 0; i < s.map.length; i++) {
    if (s.map[i] !== OBJECT_NONE) s.occupied.push(i);
  }
  s.remainsOf.fill(0);
  s.destroyedTiles.length = 0;
  s.dirty = true;
}

/** How far the player may drift before instances are re-placed. */
const REPLACE_DISTANCE = 8;

/**
 * Re-place every instance at its copy nearest the player.  Cheap enough
 * (a thousand-odd matrix writes) to do whenever something changed or the
 * player has moved far enough for a different copy to be the near one.
 */
export function updateScenery(scenery: Scenery, worldX: number, worldZ: number): void {
  const s = scenery as SceneryInternal;
  if (
    !s.dirty &&
    Math.abs(wrapDelta(worldX - s.lastX)) < REPLACE_DISTANCE &&
    Math.abs(wrapDelta(worldZ - s.lastZ)) < REPLACE_DISTANCE
  ) {
    return;
  }
  s.dirty = false;
  s.lastX = worldX;
  s.lastZ = worldZ;

  for (const mesh of s.meshes) mesh.count = 0;

  for (let k = 0; k < s.occupied.length; k++) {
    const tile = s.occupied[k];
    const type = s.map[tile];
    if (type === OBJECT_NONE) continue;
    const tx = tile & 255;
    const tz = tile >> 8;

    let kind: number;
    let scale = 1;
    let yaw = 0;
    if (type >= 12) {
      const original = s.remainsOf[tile];
      kind = remainsKindFor(original, tx, tz);
      yaw = original === 5 || original === 8 ? objectYaw(tile, original) : 0;
    } else {
      kind = kindForType(type, infection[tile] >= MUTATION_LEVEL);
      scale = objectScale(tile, type);
      yaw = objectYaw(tile, type);
    }

    const mesh = s.meshes[kind];
    const n = mesh.count;
    if (n >= MAX_INSTANCES) continue;
    const cx = tx + 0.5;
    const cz = tz + 0.5;
    const x = worldX + wrapDelta(cx - worldX);
    const z = worldZ + wrapDelta(cz - worldZ);
    const y = -meshAltitude(cx, cz);

    // Column-major TRS: scale, then yaw about Y, then translate.
    const cos = Math.cos(yaw) * scale;
    const sin = Math.sin(yaw) * scale;
    const m = mesh.instanceMatrix.array as Float32Array;
    const o = n * 16;
    m[o] = cos;      m[o + 1] = 0;     m[o + 2] = -sin;  m[o + 3] = 0;
    m[o + 4] = 0;    m[o + 5] = scale; m[o + 6] = 0;     m[o + 7] = 0;
    m[o + 8] = sin;  m[o + 9] = 0;     m[o + 10] = cos;  m[o + 11] = 0;
    m[o + 12] = x;   m[o + 13] = y;    m[o + 14] = -z;   m[o + 15] = 1;
    mesh.count = n + 1;
  }

  for (const mesh of s.meshes) {
    if (mesh.count === 0) continue;
    mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Note that the virus moved on these tiles; any tree standing on one may
 * have just mutated (or recovered).
 */
export function noteInfectionChange(scenery: Scenery, changedTiles: readonly number[]): void {
  if (scenery.dirty) return;
  for (let k = 0; k < changedTiles.length; k++) {
    if (isTree(scenery.map[changedTiles[k]])) {
      scenery.dirty = true;
      return;
    }
  }
}

/**
 * Height above the ground that a live object on this tile reaches, or 0 if
 * the tile is empty or already wreckage.  Used so shots that pass overhead
 * don't count as hits.
 */
export function objectTopAt(scenery: Scenery, tileX: number, tileZ: number): number {
  const tile = tileIndex(tileX, tileZ);
  const type = scenery.map[tile];
  if (type === OBJECT_NONE || type >= 12) return 0;
  return baseHeight(type) * objectScale(tile, type);
}

// Smoke spawns this far above the wreckage tile (LanderSrc.txt:4930-4936:
// "SMOKE_HEIGHT above the base of the object, or 3/4 of the tile size").
const SMOKE_HEIGHT = 0.75;

export interface Destroyed {
  /** World tile-centre of what was hit. */
  wx: number;
  wz: number;
  /** Scene Y of its base. */
  y: number;
  /** Object type that was destroyed (1..11). */
  type: number;
  /** True if it was a mutated tree. */
  mutated: boolean;
}

const destroyedResult: Destroyed = { wx: 0, wz: 0, y: 0, type: 0, mutated: false };

/**
 * Destroy the object at (tileX, tileZ) in the object map.  Swaps it for the
 * appropriate smoking-remains variant (LanderSrc.txt:4654-4664) and marks
 * the tile with SMOKING_REMAINS_TYPE - collision logic treats types >= 12
 * as pass-through so the player can fly over remains safely.  Returns what
 * was destroyed (a shared object - read it before the next call), or null
 * if nothing was there.
 */
export function destroyObject(scenery: Scenery, tileX: number, tileZ: number): Destroyed | null {
  const s = scenery as SceneryInternal;
  const tile = tileIndex(tileX, tileZ);
  const type = s.map[tile];
  if (type === OBJECT_NONE || type >= 12) return null; // empty or already remains

  const wx = (tileX & 255) + 0.5;
  const wz = (tileZ & 255) + 0.5;
  const y = -meshAltitude(wx, wz);

  s.remainsOf[tile] = type;
  s.map[tile] = SMOKING_REMAINS_TYPE;
  s.dirty = true;

  // Record where rising smoke should emanate from for this wreckage.
  // Original type is preserved so the emitter can pick a smoke profile
  // (trees barely wisp; buildings churn out thick plumes).
  s.destroyedTiles.push({ wx, wz, smokeY: y + SMOKE_HEIGHT, originalType: type });

  destroyedResult.wx = wx;
  destroyedResult.wz = wz;
  destroyedResult.y = y;
  destroyedResult.type = type;
  destroyedResult.mutated = isTree(type) && infection[tile] >= MUTATION_LEVEL;
  return destroyedResult;
}

// ---------------------------------------------------------------------------
// Wreckage smoke.
// ---------------------------------------------------------------------------

// Rising-smoke cadence.  Original spawns one smoke particle per destroyed
// tile on 1-in-4 frames (LanderSrc.txt:4913-4945).  We add per-object-type
// profiles so a building churns out a thick plume while a tree barely wisps,
// and cull by distance so far-away wreckage doesn't blow the particle
// budget.
//
// Per-type profile:
//   chance  - per-frame probability of emitting a burst
//   burst   - number of particles spawned per emission
//   lifeMul - multiplier on per-particle lifetime (longer = thicker plume)
//
// Object types from LanderSrc.txt:4640-4651.
interface SmokeProfile {
  chance: number;
  burst: number;
  lifeMul: number;
}

const DEFAULT_SMOKE: SmokeProfile = { chance: 0.08, burst: 1, lifeMul: 0.75 };
const SMOKE_PROFILES: Record<number, SmokeProfile> = {
  // Trees: minimal wisps - bullet hits, but not much fuel to burn.
  1: { chance: 0.08, burst: 1, lifeMul: 0.7 }, // small leafy
  2: { chance: 0.10, burst: 1, lifeMul: 0.8 }, // tall leafy
  3: { chance: 0.08, burst: 1, lifeMul: 0.7 },
  4: { chance: 0.08, burst: 1, lifeMul: 0.7 },
  6: { chance: 0.10, burst: 1, lifeMul: 0.8 },
  7: { chance: 0.07, burst: 1, lifeMul: 0.65 }, // fir
  // Gazebo: more wreckage than a tree, less than a building.
  5: { chance: 0.22, burst: 1, lifeMul: 1.1 },
  // Building: heavy, persistent smoke - proper structure fire.
  8: { chance: 0.45, burst: 2, lifeMul: 1.6 },
  // Rocket: still has fuel - fastest emission, thickest plume.
  9: { chance: 0.55, burst: 2, lifeMul: 1.8 },
  10: { chance: 0.55, burst: 2, lifeMul: 1.8 },
  11: { chance: 0.55, burst: 2, lifeMul: 1.8 },
};

const SMOKE_VISIBLE_DIST = 60;

/** One fixed frame of smoke from every wreck near the player. */
export function emitWreckSmoke(scenery: Scenery, worldX: number, worldZ: number): void {
  for (const tile of scenery.destroyedTiles) {
    const dx = wrapDelta(tile.wx - worldX);
    const dz = wrapDelta(tile.wz - worldZ);
    if (dx * dx + dz * dz > SMOKE_VISIBLE_DIST * SMOKE_VISIBLE_DIST) continue;
    const profile = SMOKE_PROFILES[tile.originalType] ?? DEFAULT_SMOKE;
    if (Math.random() >= profile.chance) continue;
    for (let i = 0; i < profile.burst; i++) {
      spawnSmokeParticle(worldX + dx, tile.smokeY, -(worldZ + dz), profile.lifeMul);
    }
  }
}
