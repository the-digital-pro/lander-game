// Fourier-based landscape height.  Ported from GetLandscapeAltitude
// (LanderSrc.txt:1285-1465).
//
// The original sums six sine waves of (x, z), then subtracts from
// LAND_MID_HEIGHT, then clamps to SEA_LEVEL, then forces the launchpad tile
// to LAUNCHPAD_ALTITUDE.
//
// The sin lookup in the original uses 32-bit integer phase that wraps every
// 2^32.  With TILE_SIZE = 2^24, that's one full sin period per 256 tiles, so
// the equivalent float frequency factor is 2*PI / 256.
//
// Because every term has an integer multiplier, the whole landscape repeats
// exactly every 256 tiles on both axes.  We lean on that: the world is a
// seamless 256x256 torus, the same way the original's object map wrapped on
// the top byte of each coordinate.  Everything that touches the map goes
// through wrap() / wrapDelta().
//
// On top of the original single launchpad this module also owns the extra
// landing zones.  Each one flattens a patch of the landscape and blends back
// into the natural terrain over a short skirt.
//
// And the volcanoes: three cones stamped into the landscape, each with a
// crater at its summit.  They are part of the terrain proper - the ship
// collides with them as with any other hill - while what comes out of them
// is the business of volcanoes.ts.

import {
  LAND_MID_HEIGHT,
  SEA_LEVEL,
  LAUNCHPAD_ALTITUDE,
  LAUNCHPAD_SIZE,
} from './constants';

export const WORLD_SIZE = 256;
const HALF_WORLD = WORLD_SIZE / 2;
const FREQ = (2 * Math.PI) / WORLD_SIZE;

/** Wrap a world coordinate into [0, WORLD_SIZE). */
export function wrap(v: number): number {
  v %= WORLD_SIZE;
  return v < 0 ? v + WORLD_SIZE : v;
}

/** Shortest signed distance around the torus, in [-128, 128). */
export function wrapDelta(d: number): number {
  d = (d + HALF_WORLD) % WORLD_SIZE;
  if (d < 0) d += WORLD_SIZE;
  return d - HALF_WORLD;
}

/** Tile index for an (already integer) tile coordinate pair. */
export function tileIndex(ix: number, iz: number): number {
  return ((iz & 255) << 8) | (ix & 255);
}

function s(k: number): number {
  return Math.sin(FREQ * k);
}

/**
 * The pure six-sine landscape: inverse altitude at world-map coordinate
 * (x, z) in tile units, before the sea clamp and before any landing zone is
 * stamped in.  Larger value = lower terrain.
 */
export function rawAltitude(x: number, z: number): number {
  // In the original each sin lookup is scaled by 1/128 (4x) or 1/256 (2x).
  // After the integer math, the resulting amplitudes are 1 tile and 0.5
  // tiles respectively, giving a +/- 5 tile envelope around LAND_MID_HEIGHT.
  const sum =
    s(x - 2 * z) +
    s(4 * x + 3 * z) +
    s(3 * z - 5 * x) +
    s(7 * x + 5 * z) +
    0.5 * s(5 * x + 11 * z) +
    0.5 * s(10 * x + 7 * z);
  return LAND_MID_HEIGHT - sum;
}

// ---------------------------------------------------------------------------
// Landing zones.
// ---------------------------------------------------------------------------

export interface LandingPad {
  id: number;
  name: string;
  /** South-west corner, in tiles. */
  x0: number;
  z0: number;
  size: number;
  /** Centre, in tiles. */
  cx: number;
  cz: number;
  /** Inverse altitude of the flat pad surface. */
  altitude: number;
  /** The original 1987 launchpad. */
  home: boolean;
}

/** Tiles over which a pad's plateau blends back into natural terrain. */
const PAD_SKIRT = 3;
const OUTPOST_SIZE = 6;
const OUTPOST_COUNT = 5;
const OUTPOST_NAMES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'];

function torusDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax - bx), wrapDelta(az - bz));
}

/**
 * Pick outpost sites.  The landscape is deterministic, so the sites are
 * too: scan for patches that are already fairly level and well clear of the
 * sea, then spread them out with farthest-point sampling so no part of the
 * map is far from somewhere to refuel.
 */
function chooseLandingPads(): LandingPad[] {
  const pads: LandingPad[] = [
    {
      id: 0,
      name: 'BASE',
      x0: 0,
      z0: 0,
      size: LAUNCHPAD_SIZE,
      cx: LAUNCHPAD_SIZE / 2,
      cz: LAUNCHPAD_SIZE / 2,
      altitude: LAUNCHPAD_ALTITUDE,
      home: true,
    },
  ];

  interface Candidate {
    x0: number;
    z0: number;
    mean: number;
    rough: number;
  }
  const candidates: Candidate[] = [];
  const margin = PAD_SKIRT;
  for (let z0 = 0; z0 < WORLD_SIZE; z0 += 2) {
    for (let x0 = 0; x0 < WORLD_SIZE; x0 += 2) {
      let sum = 0;
      let n = 0;
      let lo = Infinity;
      let hi = -Infinity;
      let dry = true;
      for (let dz = -margin; dz <= OUTPOST_SIZE + margin && dry; dz++) {
        for (let dx = -margin; dx <= OUTPOST_SIZE + margin; dx++) {
          const a = rawAltitude(x0 + dx, z0 + dz);
          if (a > SEA_LEVEL - 0.4) {
            dry = false;
            break;
          }
          if (dx >= 0 && dx <= OUTPOST_SIZE && dz >= 0 && dz <= OUTPOST_SIZE) {
            sum += a;
            n++;
            if (a < lo) lo = a;
            if (a > hi) hi = a;
          }
        }
      }
      if (!dry) continue;
      const mean = sum / n;
      const rough = hi - lo;
      // Mid-altitude shelves only: not on a summit, not on the beach.
      if (mean < 2.0 || mean > 4.8 || rough > 1.4) continue;
      candidates.push({ x0, z0, mean, rough });
    }
  }

  for (let k = 0; k < OUTPOST_COUNT; k++) {
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const cx = c.x0 + OUTPOST_SIZE / 2;
      const cz = c.z0 + OUTPOST_SIZE / 2;
      let nearest = Infinity;
      for (const p of pads) {
        const d = torusDistance(cx, cz, p.cx, p.cz);
        if (d < nearest) nearest = d;
      }
      // Spread first, flatness second.
      const score = nearest - c.rough * 10;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    pads.push({
      id: pads.length,
      name: OUTPOST_NAMES[k],
      x0: best.x0,
      z0: best.z0,
      size: OUTPOST_SIZE,
      cx: best.x0 + OUTPOST_SIZE / 2,
      cz: best.z0 + OUTPOST_SIZE / 2,
      altitude: Math.round(best.mean * 8) / 8,
      home: false,
    });
  }
  return pads;
}

export const PADS: ReadonlyArray<LandingPad> = chooseLandingPads();

/** The pad whose footprint contains world point (x, z), if any. */
export function padAt(x: number, z: number): LandingPad | null {
  for (const p of PADS) {
    const half = p.size / 2;
    if (
      Math.abs(wrapDelta(x - p.cx)) <= half &&
      Math.abs(wrapDelta(z - p.cz)) <= half
    ) {
      return p;
    }
  }
  return null;
}

/** Nearest pad to world point (x, z), with its torus distance. */
export function nearestPad(x: number, z: number): { pad: LandingPad; distance: number } {
  let pad = PADS[0];
  let distance = Infinity;
  for (const p of PADS) {
    const d = torusDistance(x, z, p.cx, p.cz);
    if (d < distance) {
      distance = d;
      pad = p;
    }
  }
  return { pad, distance };
}

/**
 * How far world point (x, z) is outside the nearest pad footprint, in
 * tiles.  0 on a pad; used to keep scenery and virus off the aprons.
 */
export function padClearance(x: number, z: number): number {
  let clearance = Infinity;
  for (const p of PADS) {
    const dx = Math.abs(wrapDelta(x - p.cx)) - p.size / 2;
    const dz = Math.abs(wrapDelta(z - p.cz)) - p.size / 2;
    const d = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
    if (d < clearance) clearance = d;
  }
  return clearance;
}

// ---------------------------------------------------------------------------
// Volcanoes.
// ---------------------------------------------------------------------------

export interface Volcano {
  id: number;
  /** Centre of the crater, in tiles. */
  cx: number;
  cz: number;
  /** Radius of the whole cone, and of the crater at its top. */
  radius: number;
  craterRadius: number;
  /** Scene-space height (Y up) of the crater rim, and of the lava inside. */
  rimY: number;
  floorY: number;
}

const VOLCANO_COUNT = 3;
const VOLCANO_RADIUS = 12;
/** Height the cone would reach at its centre if it came to a point. */
const VOLCANO_HEIGHT = 8;
const CRATER_RADIUS = 2.6;
const CRATER_DEPTH = 1.7;
/** Height of the cone at the crater's rim. */
const RIM_LIFT = VOLCANO_HEIGHT * Math.pow(1 - CRATER_RADIUS / VOLCANO_RADIUS, 1.5);

/**
 * Site the volcanoes: on solid ground, on what is already high land, well
 * away from every landing zone (lava is thrown a long way) and from each
 * other.  Deterministic, like the pads, because the landscape is.
 */
function chooseVolcanoes(): Volcano[] {
  interface Candidate {
    x: number;
    z: number;
    raw: number;
    padDistance: number;
  }
  const candidates: Candidate[] = [];
  for (let z = 2; z < WORLD_SIZE; z += 4) {
    for (let x = 2; x < WORLD_SIZE; x += 4) {
      const raw = rawAltitude(x, z);
      let solid = raw < SEA_LEVEL - 0.5;
      for (let k = 0; k < 8 && solid; k++) {
        const angle = (k / 8) * Math.PI * 2;
        solid = rawAltitude(x + Math.cos(angle) * 5, z + Math.sin(angle) * 5) < SEA_LEVEL - 0.5;
      }
      if (!solid) continue;
      let padDistance = Infinity;
      for (const pad of PADS) {
        padDistance = Math.min(padDistance, torusDistance(x, z, pad.cx, pad.cz));
      }
      // Lava bombs carry about 38 tiles; no pad should ever be in range.
      if (padDistance < 50) continue;
      candidates.push({ x, z, raw, padDistance });
    }
  }

  const volcanoes: Volcano[] = [];
  for (let k = 0; k < VOLCANO_COUNT; k++) {
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      let spacing = 128;
      for (const v of volcanoes) spacing = Math.min(spacing, torusDistance(c.x, c.z, v.cx, v.cz));
      if (spacing < 70) continue;
      // Spread out, on high ground (small raw altitude = high).
      const score = spacing + (5 - c.raw) * 6 + Math.min(c.padDistance, 90) * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    volcanoes.push({
      id: k,
      cx: best.x,
      cz: best.z,
      radius: VOLCANO_RADIUS,
      craterRadius: CRATER_RADIUS,
      rimY: -(best.raw - RIM_LIFT),
      floorY: -(best.raw - (RIM_LIFT - CRATER_DEPTH)),
    });
  }
  return volcanoes;
}

export const VOLCANOES: ReadonlyArray<Volcano> = chooseVolcanoes();

/** Nearest volcano to world point (x, z), with its torus distance. */
export function nearestVolcano(x: number, z: number): { volcano: Volcano; distance: number } | null {
  let volcano: Volcano | null = null;
  let distance = Infinity;
  for (const v of VOLCANOES) {
    const d = torusDistance(x, z, v.cx, v.cz);
    if (d < distance) {
      distance = d;
      volcano = v;
    }
  }
  return volcano ? { volcano, distance } : null;
}

/** Stamp the volcanoes into an altitude sample. */
function withVolcanoes(x: number, z: number, altitude: number): number {
  for (const v of VOLCANOES) {
    const dx = wrapDelta(x - v.cx);
    const dz = wrapDelta(z - v.cz);
    if (dx >= v.radius || dx <= -v.radius || dz >= v.radius || dz <= -v.radius) continue;
    const d = Math.hypot(dx, dz);
    if (d >= v.radius) continue;

    // The foot of the cone rides on whatever land was there; toward the
    // summit that is ironed out, so the top is a clean cone and the crater
    // floor is level.
    const centre = -v.rimY + RIM_LIFT; // natural altitude at the centre
    const t = Math.min(1, Math.max(0, (v.radius * 0.6 - d) / (v.radius * 0.6 - v.craterRadius)));
    const base = altitude + (centre - altitude) * (t * t * (3 - 2 * t));

    if (d <= v.craterRadius) {
      // Inside the rim: steep walls down to a nearly flat floor.
      const u = d / v.craterRadius;
      return base - (RIM_LIFT - CRATER_DEPTH * (1 - u * u * u * u));
    }
    // The flank: concave, steepening toward the top, and meeting the
    // surrounding land with no crease.
    return base - VOLCANO_HEIGHT * Math.pow(1 - d / v.radius, 1.5);
  }
  return altitude;
}

// ---------------------------------------------------------------------------
// Wind farms.
// ---------------------------------------------------------------------------

export interface TurbineSite {
  id: number;
  /** Which farm - a row of turbines that turn together - this one stands in. */
  farm: number;
  /** Foot of the tower, in tiles. */
  x: number;
  z: number;
  /**
   * The bearing its wind blows along when the farm faces dead ahead, in
   * radians: 0 is east (+x), a quarter turn is north (+z).
   */
  heading: number;
}

const FARM_COUNT = 5;
/** Turbines in a farm, and the tiles between neighbours in the row. */
const FARM_SIZE = 3;
const FARM_SPACING = 8;
/** Further than a turbine's wind carries: nobody lands in a gale. */
const FARM_PAD_CLEARANCE = 34;
const FARM_SEPARATION = 48;

/**
 * Site the wind farms.  Each is a short row of turbines on firm, fairly
 * level ground, set square to the way it blows and facing out over whatever
 * lower ground it has, so its wind runs clear instead of into a hillside.
 * They keep off the volcanoes and well away from every landing zone.
 */
function chooseTurbines(): TurbineSite[] {
  interface Candidate {
    x: number;
    z: number;
    heading: number;
    spots: Array<[x: number, z: number]>;
    rough: number;
    mean: number;
  }

  const firm = (x: number, z: number): boolean => {
    if (rawAltitude(x, z) > SEA_LEVEL - 0.8) return false;
    for (let k = 0; k < 6; k++) {
      const angle = (k / 6) * Math.PI * 2;
      if (rawAltitude(x + Math.cos(angle) * 2, z + Math.sin(angle) * 2) > SEA_LEVEL - 0.5) return false;
    }
    return true;
  };

  const candidates: Candidate[] = [];
  for (let z = 2; z < WORLD_SIZE; z += 4) {
    for (let x = 2; x < WORLD_SIZE; x += 4) {
      // Three ways the row could lie: along either diagonal, or east-west.
      // (Never north-south.  The camera always looks north, and a rotor
      // facing east or west would only ever be seen edge-on.)
      for (const bearing of [0, Math.PI / 4, (3 * Math.PI) / 4]) {
        const rowX = Math.cos(bearing);
        const rowZ = Math.sin(bearing);
        const spots: Array<[number, number]> = [];
        let lo = Infinity;
        let hi = -Infinity;
        let sum = 0;
        let ok = true;
        for (let i = 0; i < FARM_SIZE && ok; i++) {
          const along = (i - (FARM_SIZE - 1) / 2) * FARM_SPACING;
          const sx = x + rowX * along;
          const sz = z + rowZ * along;
          ok = firm(sx, sz);
          for (const pad of PADS) {
            if (torusDistance(sx, sz, pad.cx, pad.cz) < FARM_PAD_CLEARANCE) ok = false;
          }
          for (const v of VOLCANOES) {
            if (torusDistance(sx, sz, v.cx, v.cz) < v.radius + 9) ok = false;
          }
          const a = rawAltitude(sx, sz);
          lo = Math.min(lo, a);
          hi = Math.max(hi, a);
          sum += a;
          spots.push([wrap(sx), wrap(sz)]);
        }
        if (!ok || hi - lo > 1.1) continue;

        // Blow across the row, toward the lower side (a larger inverse
        // altitude is lower ground).
        let fall = 0;
        for (const reach of [5, 10, 15]) {
          fall += rawAltitude(x - rowZ * reach, z + rowX * reach) - rawAltitude(x + rowZ * reach, z - rowX * reach);
        }
        const side = fall >= 0 ? 1 : -1;
        candidates.push({
          x,
          z,
          heading: Math.atan2(rowX * side, -rowZ * side),
          spots,
          rough: hi - lo,
          mean: sum / FARM_SIZE,
        });
      }
    }
  }

  const farms: Candidate[] = [];
  const home = PADS[0];
  for (let k = 0; k < FARM_COUNT; k++) {
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      let spacing = 128;
      let alike = 0;
      for (const f of farms) {
        spacing = Math.min(spacing, torusDistance(c.x, c.z, f.x, f.z));
        if (Math.abs(f.heading - c.heading) < 0.1) alike++;
      }
      if (spacing < FARM_SEPARATION) continue;
      // The first goes as near home as the clearance allows, so the hazard
      // is met early; the rest spread out.  Level, open ground either way,
      // and not all blowing the same way.
      const reach = k === 0 ? -torusDistance(c.x, c.z, home.cx, home.cz) : Math.min(spacing, 110);
      const score = reach - c.rough * 8 + (5 - c.mean) * 3 - alike * 16;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    farms.push(best);
  }

  const sites: TurbineSite[] = [];
  farms.forEach((farm, index) => {
    for (const [x, z] of farm.spots) {
      sites.push({ id: sites.length, farm: index, x, z, heading: farm.heading });
    }
  });
  return sites;
}

export const TURBINES: ReadonlyArray<TurbineSite> = chooseTurbines();

/** How far world point (x, z) is from the foot of the nearest turbine, in tiles. */
export function turbineClearance(x: number, z: number): number {
  let clearance = Infinity;
  for (const t of TURBINES) {
    const d = torusDistance(x, z, t.x, t.z);
    if (d < clearance) clearance = d;
  }
  return clearance;
}

/** Stamp the landing zones into a raw altitude sample. */
function withPads(x: number, z: number, raw: number): number {
  for (const p of PADS) {
    const dx = Math.abs(wrapDelta(x - p.cx)) - p.size / 2;
    const dz = Math.abs(wrapDelta(z - p.cz)) - p.size / 2;
    if (dx >= PAD_SKIRT || dz >= PAD_SKIRT) continue;
    if (dx <= 0 && dz <= 0) return p.altitude;
    const d = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
    if (d >= PAD_SKIRT) continue;
    const t = d / PAD_SKIRT;
    return p.altitude + (raw - p.altitude) * (t * t * (3 - 2 * t));
  }
  return raw;
}

/**
 * Returns inverse altitude at world-map coordinate (x, z) in tile units.
 * Larger return value = lower terrain (sea level is at SEA_LEVEL).  Convert
 * to Y-up world coordinates by negating.
 *
 * This is the collision surface: clamped at the sea, flat on every pad.
 */
export function getLandscapeAltitude(x: number, z: number): number {
  const altitude = withPads(x, z, withVolcanoes(x, z, rawAltitude(x, z)));
  // Don't let the terrain dip below sea level.
  return altitude > SEA_LEVEL ? SEA_LEVEL : altitude;
}

// ---------------------------------------------------------------------------
// Cached height grids.
// ---------------------------------------------------------------------------

/** Deepest seabed we bother modelling below the waterline. */
const SEABED_FLOOR = SEA_LEVEL + 2.4;

/**
 * Altitude at every integer tile corner, NOT clamped at the sea, so the
 * terrain mesh can carry on down as a visible seabed under the water.
 */
const cornerAltitude = new Float32Array(WORLD_SIZE * WORLD_SIZE);
for (let iz = 0; iz < WORLD_SIZE; iz++) {
  for (let ix = 0; ix < WORLD_SIZE; ix++) {
    const a = withPads(ix, iz, withVolcanoes(ix, iz, rawAltitude(ix, iz)));
    cornerAltitude[(iz << 8) | ix] = a > SEABED_FLOOR ? SEABED_FLOOR : a;
  }
}

/** Unclamped (seabed-following) altitude at integer corner (ix, iz). */
export function cornerHeight(ix: number, iz: number): number {
  return cornerAltitude[((iz & 255) << 8) | (ix & 255)];
}

/**
 * Altitude of the rendered terrain surface at any point: the same two
 * triangles per tile that terrainMesh.ts draws, so anything placed with
 * this sits exactly on what the player sees.  Follows the seabed.
 */
export function meshAltitude(x: number, z: number): number {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const u = x - fx;
  const v = z - fz;
  const h00 = cornerHeight(fx, fz);
  const h10 = cornerHeight(fx + 1, fz);
  const h01 = cornerHeight(fx, fz + 1);
  if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
  const h11 = cornerHeight(fx + 1, fz + 1);
  return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

/** Rendered surface altitude with the sea on top: what things rest on. */
export function surfaceAltitude(x: number, z: number): number {
  const a = meshAltitude(x, z);
  return a > SEA_LEVEL ? SEA_LEVEL : a;
}

/** Scene-space Y (up) of the ground or sea surface under a scene point. */
export function groundY(sceneX: number, sceneZ: number): number {
  return -surfaceAltitude(sceneX, -sceneZ);
}

/** True if the surface under world point (x, z) is open water. */
export function isSea(x: number, z: number): boolean {
  return meshAltitude(x, z) >= SEA_LEVEL - 1e-3;
}

/**
 * Per-tile land mask: 1 where the tile is dry ground the virus can take
 * hold of.  Pads and their aprons are shielded, and nothing lives on the
 * bare rock of a volcano for it to infect.
 */
export const LAND_MASK = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
export const LAND_TILE_COUNT = (() => {
  let count = 0;
  for (let iz = 0; iz < WORLD_SIZE; iz++) {
    for (let ix = 0; ix < WORLD_SIZE; ix++) {
      const centre =
        (cornerHeight(ix, iz) +
          cornerHeight(ix + 1, iz) +
          cornerHeight(ix, iz + 1) +
          cornerHeight(ix + 1, iz + 1)) /
        4;
      const dry = centre < SEA_LEVEL - 0.05;
      const shielded = padClearance(ix + 0.5, iz + 0.5) < 1.5;
      const cone = nearestVolcano(ix + 0.5, iz + 0.5);
      const barren = cone !== null && cone.distance < cone.volcano.radius * 0.7;
      if (dry && !shielded && !barren) {
        LAND_MASK[(iz << 8) | ix] = 1;
        count++;
      }
    }
  }
  return count;
})();

/**
 * True if (x, z) is on the original launchpad.
 */
export function isOnLaunchpad(x: number, z: number): boolean {
  return padAt(x, z)?.home === true;
}
