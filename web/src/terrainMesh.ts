// The landscape, as lit flat-shaded patchwork.
//
// We work in Y-up SCENE coordinates throughout (one tile = 1.0 unit;
// forward is -Z).  terrain.ts works in WORLD coords (Z positive = forward),
// so scene Z is the negated world Z.
//
// The whole 256x256 map is meshed once, up front, as an 8x8 grid of 32-tile
// chunks.  Geometry never changes after that.  Each frame the chunks are
// simply slid to whichever copy of themselves is nearest the player, which
// is all it takes to make the torus world wrap seamlessly; Three.js frustum
// culling and the fog do the rest.  When the virus changes a tile, only that
// tile's colour is rewritten and only that slice of the buffer is re-sent to
// the GPU.
//
// Unlike the original, the mesh does not stop at the waterline: it carries
// on down as seabed, and water.ts lays a translucent sea over the top.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { SEA_LEVEL } from './constants';
import { lavaSurgeUniform, timeUniform } from './env';
import { infection, MUTATION_LEVEL } from './infection';
import { VOLCANOES, cornerHeight, padClearance, wrapDelta, WORLD_SIZE } from './terrain';

const CHUNK_TILES = 32;
const CHUNKS_PER_SIDE = WORLD_SIZE / CHUNK_TILES;
const VERTS_PER_TILE = 6;
const VERTS_PER_CHUNK = CHUNK_TILES * CHUNK_TILES * VERTS_PER_TILE;

// ---------------------------------------------------------------------------
// Palette.  Altitude is INVERSE - smaller value = higher terrain - so the
// table runs summit -> seabed.  Authored in sRGB, held in linear.
// ---------------------------------------------------------------------------

interface ColourStop {
  alt: number;
  r: number;
  g: number;
  b: number;
}

const scratch = new THREE.Color();
function stop(alt: number, hex: number): ColourStop {
  scratch.setHex(hex);
  return { alt, r: scratch.r, g: scratch.g, b: scratch.b };
}

const LAND_STOPS: ReadonlyArray<ColourStop> = [
  stop(0.4, 0xf4f7fa), // summit snow
  stop(1.3, 0xcfcac2), // pale scree
  stop(2.1, 0x8f7862), // bare rock
  stop(2.8, 0x47733a), // upland forest
  stop(3.7, 0x5aa044), // meadow
  stop(4.6, 0x93bd4f), // lowland
  stop(5.1, 0xcbc474), // dry scrub
  stop(5.5, 0xe9d9a0), // beach
  stop(5.95, 0xb5b784), // wet sand
  stop(6.7, 0x3f7f80), // shallows
  stop(7.9, 0x16384c), // deep
];

// What the virus leaves behind: the brown / crimson / sickly pink quilt of
// an infected Zarch landscape.
const INFECTED = [0x7c1421, 0xa51f2e, 0x5a1c18, 0xc43a55, 0x3b0f18, 0x8e2f24].map(
  (hex) => stop(0, hex),
);

const PAD_CONCRETE = stop(0, 0x4b5059);
const PAD_APRON = stop(0, 0x7b7469);

// A volcano's own ground: basalt, scoria and ash, and the dark crust that
// floats on lava.
const BASALT = [0x2b2624, 0x3a2f2b, 0x4d362b, 0x57504d, 0x241f1f].map((hex) => stop(0, hex));
const LAVA_CRUST = stop(0, 0x1c0d09);
/** Lava channels running down each cone from the rim. */
const LAVA_STREAMS = 3;

/**
 * How hot the tile at world (x, z) is, 0..1: the lava lake in a crater is 1,
 * and a few streams run down the flanks from it, cooling as they go.
 * Also reports how far up a cone the tile is (0 off it, 1 at the centre).
 */
const volcanic = { heat: 0, rise: 0 };
function volcanicAt(x: number, z: number): typeof volcanic {
  volcanic.heat = 0;
  volcanic.rise = 0;
  for (const v of VOLCANOES) {
    const dx = wrapDelta(x - v.cx);
    const dz = wrapDelta(z - v.cz);
    const d = Math.hypot(dx, dz);
    if (d >= v.radius) continue;
    volcanic.rise = 1 - d / v.radius;
    if (d < v.craterRadius - 0.35) {
      volcanic.heat = 1;
      return volcanic;
    }
    const reach = v.radius * 0.66;
    if (d > v.craterRadius + 0.4 && d < reach) {
      const angle = Math.atan2(dz, dx);
      for (let k = 0; k < LAVA_STREAMS; k++) {
        // Each stream leaves the rim on its own bearing and wanders a
        // little on the way down.
        const bearing = v.id * 1.9 + k * ((Math.PI * 2) / LAVA_STREAMS) + 0.35 * Math.sin(d * 0.7 + k * 2.1 + v.id);
        let off = angle - bearing;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        if (Math.abs(off) * d < 0.62) {
          const along = (d - v.craterRadius) / (reach - v.craterRadius);
          volcanic.heat = Math.max(volcanic.heat, 0.85 * Math.pow(1 - along, 0.8) + 0.08);
        }
      }
    }
    return volcanic;
  }
  return volcanic;
}

/**
 * Deterministic per-tile hash -> 32-bit integer.  Stable for the life of
 * the page so a tile always picks the same variation.
 */
function tileHash(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const out = { r: 0, g: 0, b: 0, glow: 0, heat: 0 };

/**
 * Colour for one tile.  Altitude picks the band; a checkerboard and a
 * little per-tile drift keep the unmistakable Archimedes patchwork; the
 * infection level then drags the whole thing toward the virus palette.
 * Lighting is no longer baked in here - the sun does that now.
 *
 * Returns a shared object (linear RGB plus the tile's glow level); read it
 * before calling again.  Pass `healthy` to get the tile as it would look
 * with no virus on it, which is what the scanner draws its base map from.
 */
export function tileColour(ix: number, iz: number, healthy = false): typeof out {
  const mean =
    (cornerHeight(ix, iz) +
      cornerHeight(ix + 1, iz) +
      cornerHeight(ix, iz + 1) +
      cornerHeight(ix + 1, iz + 1)) /
    4;

  let k = 1;
  while (k < LAND_STOPS.length - 1 && mean > LAND_STOPS[k].alt) k++;
  const lo = LAND_STOPS[k - 1];
  const hi = LAND_STOPS[k];
  const t = Math.min(1, Math.max(0, (mean - lo.alt) / (hi.alt - lo.alt)));
  let r = lo.r + (hi.r - lo.r) * t;
  let g = lo.g + (hi.g - lo.g) * t;
  let b = lo.b + (hi.b - lo.b) * t;

  const h = tileHash(ix & 255, iz & 255);
  const parity = ((ix + iz) & 1) === 0;
  const submerged = mean >= SEA_LEVEL;

  if (!submerged) {
    // Per-tile drift between yellower and bluer greens, plus a brightness
    // wobble, so no two neighbours quite match.
    const drift = ((h & 0xff) / 255 - 0.5) * 0.5;
    const value = 0.9 + (((h >>> 8) & 0xff) / 255) * 0.2;
    r *= (1 + drift) * value;
    g *= value;
    b *= (1 - drift) * value;
  }
  // Checkerboard: every other tile a step darker so the grid always reads.
  if (parity) {
    const dim = submerged ? 0.93 : 0.84;
    r *= dim;
    g *= dim;
    b *= dim;
  }

  // Landing zones: concrete on the pad, gravel apron fading into the land.
  const clearance = padClearance(ix + 0.5, iz + 0.5);
  if (clearance < 3) {
    const shade = parity ? 0.88 : 1;
    if (clearance <= 0) {
      r = PAD_CONCRETE.r * shade;
      g = PAD_CONCRETE.g * shade;
      b = PAD_CONCRETE.b * shade;
    } else {
      const f = clearance / 3;
      r = PAD_APRON.r * shade + (r - PAD_APRON.r * shade) * f;
      g = PAD_APRON.g * shade + (g - PAD_APRON.g * shade) * f;
      b = PAD_APRON.b * shade + (b - PAD_APRON.b * shade) * f;
    }
  }

  // Volcanoes: the land gives way to bare rock up the cone, and to lava
  // where it is running.
  const cone = volcanicAt(ix + 0.5, iz + 0.5);
  const heat = cone.heat;
  if (cone.rise > 0) {
    const rock = BASALT[(h >>> 20) % BASALT.length];
    const dim = parity ? 0.84 : 1;
    // Vegetation hangs on around the foot and is gone a third of the way up.
    const f = Math.min(1, cone.rise / 0.32);
    const k = f * f * (3 - 2 * f);
    r += (rock.r * dim - r) * k;
    g += (rock.g * dim - g) * k;
    b += (rock.b * dim - b) * k;
    if (heat > 0) {
      r += (LAVA_CRUST.r - r) * heat;
      g += (LAVA_CRUST.g - g) * heat;
      b += (LAVA_CRUST.b - b) * heat;
    }
  }

  let glow = 0;
  const level = healthy ? 0 : infection[((iz & 255) << 8) | (ix & 255)];
  if (level > 0) {
    const sick = INFECTED[(h >>> 16) % INFECTED.length];
    const dim = parity ? 0.82 : 1;
    // Ease in, then commit: the last stretch past MUTATION_LEVEL is where
    // a tile visibly "turns".
    const e = level * level * (3 - 2 * level);
    const f = level < MUTATION_LEVEL ? e * 0.85 : e;
    r += (sick.r * dim - r) * f;
    g += (sick.g * dim - g) * f;
    b += (sick.b * dim - b) * f;
    glow = e;
  }

  out.r = r;
  out.g = g;
  out.b = b;
  out.glow = glow;
  out.heat = heat;
  return out;
}

// ---------------------------------------------------------------------------
// Chunks.
// ---------------------------------------------------------------------------

interface Chunk {
  mesh: THREE.Mesh;
  /** World-tile origin of this chunk. */
  ox: number;
  oz: number;
  colour: THREE.BufferAttribute;
  glow: THREE.BufferAttribute;
  /** Lava heat per vertex.  Fixed for the life of the page. */
  heat: THREE.BufferAttribute;
  /** Dirty vertex span accumulated this frame; lo > hi means clean. */
  lo: number;
  hi: number;
}

function writeTile(chunk: Chunk, lx: number, lz: number): void {
  const c = tileColour(chunk.ox + lx, chunk.oz + lz);
  const first = (lz * CHUNK_TILES + lx) * VERTS_PER_TILE;
  const colours = chunk.colour.array as Float32Array;
  const glows = chunk.glow.array as Float32Array;
  const heats = chunk.heat.array as Float32Array;
  for (let v = 0; v < VERTS_PER_TILE; v++) {
    const o = (first + v) * 3;
    colours[o] = c.r;
    colours[o + 1] = c.g;
    colours[o + 2] = c.b;
    glows[first + v] = c.glow;
    heats[first + v] = c.heat;
  }
  if (first < chunk.lo) chunk.lo = first;
  if (first + VERTS_PER_TILE - 1 > chunk.hi) chunk.hi = first + VERTS_PER_TILE - 1;
}

function flushChunk(chunk: Chunk): void {
  if (chunk.lo > chunk.hi) return;
  const count = chunk.hi - chunk.lo + 1;
  chunk.colour.addUpdateRange(chunk.lo * 3, count * 3);
  chunk.colour.needsUpdate = true;
  chunk.glow.addUpdateRange(chunk.lo, count);
  chunk.glow.needsUpdate = true;
  chunk.lo = Infinity;
  chunk.hi = -Infinity;
}

function buildMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  // A heightfield only ever shows the light its top faces, so the default
  // "render back faces into the shadow map" would cast nothing at all.
  material.shadowSide = THREE.FrontSide;

  // Infected ground glows: a slow red swell rolling through the virus, fed
  // by a per-vertex infection level.  Bright enough to catch the bloom.
  //
  // Lava glows the same way, from its own per-vertex heat: hotter is
  // brighter and yellower, it churns slowly, and the whole lot surges when
  // a volcano is working up to something.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uLavaSurge = lavaSurgeUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aGlow;
        attribute float aHeat;
        varying float vGlow;
        varying float vHeat;
        varying vec2 vGroundXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGlow = aGlow;
        vHeat = aHeat;
        vGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uLavaSurge;
        varying float vGlow;
        varying float vHeat;
        varying vec2 vGroundXZ;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float virusSwell = sin(uTime * 2.3 + vGroundXZ.x * 0.55 - vGroundXZ.y * 0.4) * 0.5 + 0.5;
        virusSwell *= virusSwell;
        totalEmissiveRadiance += vec3(1.0, 0.05, 0.08) * vGlow * (0.05 + 0.42 * virusSwell);
        if (vHeat > 0.0) {
          float churn = sin(uTime * 1.3 + vGroundXZ.x * 2.1) * sin(uTime * 0.9 - vGroundXZ.y * 1.7);
          churn = 0.62 + 0.38 * churn;
          vec3 molten = mix(vec3(1.6, 0.16, 0.02), vec3(3.4, 1.25, 0.2), vHeat * churn);
          totalEmissiveRadiance += molten * vHeat * (0.45 + 0.55 * churn) * (1.0 + 1.6 * uLavaSurge);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'lander-terrain';
  return shadeWithClouds(material);
}

function buildChunk(ox: number, oz: number, material: THREE.Material): Chunk {
  const positions = new Float32Array(VERTS_PER_CHUNK * 3);

  let p = 0;
  for (let lz = 0; lz < CHUNK_TILES; lz++) {
    for (let lx = 0; lx < CHUNK_TILES; lx++) {
      const ix = ox + lx;
      const iz = oz + lz;
      const y00 = -cornerHeight(ix, iz);
      const y10 = -cornerHeight(ix + 1, iz);
      const y01 = -cornerHeight(ix, iz + 1);
      const y11 = -cornerHeight(ix + 1, iz + 1);
      const x0 = lx;
      const x1 = lx + 1;
      const z0 = -lz;
      const z1 = -(lz + 1);
      // Two triangles split along the (x1,z0)-(x0,z1) diagonal, wound so
      // they face up.  terrain.ts meshAltitude() mirrors this split.
      positions[p++] = x0; positions[p++] = y00; positions[p++] = z0;
      positions[p++] = x1; positions[p++] = y10; positions[p++] = z0;
      positions[p++] = x0; positions[p++] = y01; positions[p++] = z1;
      positions[p++] = x1; positions[p++] = y10; positions[p++] = z0;
      positions[p++] = x1; positions[p++] = y11; positions[p++] = z1;
      positions[p++] = x0; positions[p++] = y01; positions[p++] = z1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const colour = new THREE.BufferAttribute(new Float32Array(VERTS_PER_CHUNK * 3), 3);
  const glow = new THREE.BufferAttribute(new Float32Array(VERTS_PER_CHUNK), 1);
  const heat = new THREE.BufferAttribute(new Float32Array(VERTS_PER_CHUNK), 1);
  colour.setUsage(THREE.DynamicDrawUsage);
  glow.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', colour);
  geometry.setAttribute('aGlow', glow);
  geometry.setAttribute('aHeat', heat);
  // Non-indexed, so this yields one flat normal per face.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  const chunk: Chunk = { mesh, ox, oz, colour, glow, heat, lo: Infinity, hi: -Infinity };
  for (let lz = 0; lz < CHUNK_TILES; lz++) {
    for (let lx = 0; lx < CHUNK_TILES; lx++) writeTile(chunk, lx, lz);
  }
  // The initial fill uploads with the buffer itself; nothing to re-send.
  chunk.lo = Infinity;
  chunk.hi = -Infinity;
  return chunk;
}

export interface Terrain {
  group: THREE.Group;
  /**
   * Slide every chunk to its copy nearest the player.  `worldZ` is the
   * player's world (forward-positive) Z.
   */
  follow(worldX: number, worldZ: number): void;
  /** Recolour tiles whose infection level changed (indices from infection.ts). */
  recolour(changedTiles: readonly number[]): void;
}

export function buildTerrain(): Terrain {
  const group = new THREE.Group();
  const material = buildMaterial();
  const chunks: Chunk[] = [];
  for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
    for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
      const chunk = buildChunk(cx * CHUNK_TILES, cz * CHUNK_TILES, material);
      chunks.push(chunk);
      group.add(chunk.mesh);
    }
  }

  const half = CHUNK_TILES / 2;

  return {
    group,
    follow(worldX, worldZ) {
      for (const chunk of chunks) {
        const nearX = worldX + wrapDelta(chunk.ox + half - worldX) - half;
        const nearZ = worldZ + wrapDelta(chunk.oz + half - worldZ) - half;
        chunk.mesh.position.set(nearX, 0, -nearZ);
      }
    },
    recolour(changedTiles) {
      if (changedTiles.length === 0) return;
      for (let k = 0; k < changedTiles.length; k++) {
        const i = changedTiles[k];
        const ix = i & 255;
        const iz = i >> 8;
        const chunk = chunks[(iz >> 5) * CHUNKS_PER_SIDE + (ix >> 5)];
        writeTile(chunk, ix & 31, iz & 31);
      }
      for (const chunk of chunks) flushChunk(chunk);
    },
  };
}
