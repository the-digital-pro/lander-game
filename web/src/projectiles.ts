// Things that fly and hit other things: the ship's bullets, the landbots'
// plasma bolts, rocks falling out of the sky, and the lava bombs that
// volcanoes throw.
//
// The old port kept bullets and rocks in the particle table and searched
// it for them every frame.  They are game objects, not decoration, so they
// live here in small pooled lists and merely *emit* particles for their
// glow.  This module owns their motion and what happens when they meet the
// ground or the sea; what happens when they meet a bot, a tree or the ship
// is the host's business.
//
// Everything here is in SCENE coordinates and stays close to the player, so
// when the world wraps under the ship the host just shifts the lot.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { SEA_LEVEL } from './constants';
import {
  spawnDirt,
  spawnExplosion,
  spawnLavaTrail,
  spawnMeteorTrail,
  spawnPlasmaGlow,
  spawnSplash,
  spawnTracer,
} from './particles';
import { layOnGround } from './shadow';
import { groundY } from './terrain';

/** Callbacks into the game for collisions this module can't judge itself. */
export interface ProjectileHost {
  /**
   * A bullet is at scene (x, y, z).  Return true if it struck something
   * (bot, scenery) and should be removed.
   */
  bulletAt(x: number, y: number, z: number): boolean;
  /**
   * Something hostile of the given radius is at scene (x, y, z).  Return
   * true if it struck the ship.
   */
  hazardAt(
    x: number,
    y: number,
    z: number,
    radius: number,
    kind: 'rock' | 'plasma' | 'lava',
  ): boolean;
  /** A bullet shot a rock out of the sky at scene (x, y, z). */
  rockShot(x: number, y: number, z: number): void;
  /** A rock came down at scene (x, y, z). */
  rockLanded(x: number, y: number, z: number): void;
  /** A lava bomb came down at scene (x, y, z). */
  lavaLanded(x: number, y: number, z: number): void;
}

interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

const SEA_Y = -SEA_LEVEL;

function overSea(x: number, z: number): boolean {
  return groundY(x, z) <= SEA_Y + 1e-3;
}

const scratch = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Bullets (LanderSrc.txt:2401-2463).  Fired from the ship's nose - its local
// +X axis - inheriting the ship's velocity.
// ---------------------------------------------------------------------------

const BULLET_SPEED = 0.35;
const BULLET_OFFSET = 0.6;
const BULLET_LIFE = 46;
const BULLET_GRAVITY = 0.001;

const bullets: Body[] = [];

export function fireBullet(
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipNose: THREE.Vector3,
): void {
  if (bullets.length >= 96) return;
  bullets.push({
    x: shipPos.x + shipNose.x * BULLET_OFFSET,
    y: shipPos.y + shipNose.y * BULLET_OFFSET,
    z: shipPos.z + shipNose.z * BULLET_OFFSET,
    vx: shipVel.x + shipNose.x * BULLET_SPEED,
    vy: shipVel.y + shipNose.y * BULLET_SPEED,
    vz: shipVel.z + shipNose.z * BULLET_SPEED,
    life: BULLET_LIFE,
  });
}

/**
 * Where would a bullet fired right now come down?  Runs the same flight as
 * a real one against the terrain.  Writes the impact point to `out` and
 * returns true, or returns false if it would burn out first.
 */
export function predictImpact(
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipNose: THREE.Vector3,
  out: THREE.Vector3,
): boolean {
  let x = shipPos.x + shipNose.x * BULLET_OFFSET;
  let y = shipPos.y + shipNose.y * BULLET_OFFSET;
  let z = shipPos.z + shipNose.z * BULLET_OFFSET;
  const vx = shipVel.x + shipNose.x * BULLET_SPEED;
  let vy = shipVel.y + shipNose.y * BULLET_SPEED;
  const vz = shipVel.z + shipNose.z * BULLET_SPEED;
  for (let frame = 0; frame < BULLET_LIFE; frame++) {
    vy -= BULLET_GRAVITY;
    x += vx;
    y += vy;
    z += vz;
    const floor = groundY(x, z);
    if (y <= floor) {
      out.set(x, floor, z);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plasma: what an armed landbot throws back.  Slow, bright, dodgeable.
// ---------------------------------------------------------------------------

const PLASMA_LIFE = 190;
const PLASMA_RADIUS = 0.8;

const plasma: Body[] = [];

export function firePlasma(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
): void {
  if (plasma.length >= 24) return;
  plasma.push({ x, y, z, vx, vy, vz, life: PLASMA_LIFE });
}

// ---------------------------------------------------------------------------
// Rocks (LanderSrc.txt:4570 DropRocksFromTheSky).  The original dropped an
// octahedron; these are tumbling, burning lumps that can be shot down.
//
// Lava bombs are the same kind of thing coming the other way - thrown up
// out of a volcano rather than dropped from the sky - so they share the
// rocks' flight, their landing markers and their bookkeeping.  The
// differences: they are molten (bullets go straight through), they leave
// melt behind them, and what they do on landing is the volcano's affair.
// ---------------------------------------------------------------------------

const ROCK_GRAVITY = 0.0024;
const ROCK_HIT_RADIUS = 0.75;
const ROCK_SHOT_RADIUS = 0.95;
const MAX_ROCKS = 8;
const MAX_LAVA_BOMBS = 40;

interface Rock extends Body {
  mesh: THREE.Mesh;
  /** Ring on the ground where this rock is going to come down. */
  marker: THREE.Mesh;
  /** Height it started from, for scaling the marker as it closes. */
  dropHeight: number;
  spinX: number;
  spinZ: number;
  /** True for a lava bomb. */
  molten: boolean;
}

const rockGeometry = (() => {
  const geometry = new THREE.IcosahedronGeometry(0.46, 0);
  // Knock the vertices about so it reads as a lump, not a d20.
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.78 + ((i * 37) % 11) / 22;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  geometry.computeVertexNormals();
  return geometry;
})();
const rockMaterial = shadeWithClouds(
  new THREE.MeshLambertMaterial({
    color: 0x4a3f3a,
    emissive: new THREE.Color().setRGB(1.5, 0.42, 0.08),
    flatShading: true,
  }),
);

// A rock falls from above the top of the view, so the first the player
// would otherwise know of it is the bang.  Each one paints a warning ring
// where it is going to land, closing in as it comes down.
const markerGeometry = (() => {
  const geometry = new THREE.RingGeometry(0.82, 1.0, 40);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
})();
const markerMaterial = new THREE.MeshBasicMaterial({
  color: new THREE.Color().setRGB(3.0, 0.55, 0.15),
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false,
});

// Lava doesn't take light, it gives it: unlit, and bright enough to bloom.
const lavaMaterial = new THREE.MeshBasicMaterial({
  color: new THREE.Color().setRGB(3.8, 1.4, 0.24),
});

export const rockGroup = new THREE.Group();
const rocks: Rock[] = [];
/** Retired meshes waiting for reuse, rocks and lava bombs kept apart. */
const spareRocks: Array<{ mesh: THREE.Mesh; marker: THREE.Mesh }> = [];
const spareBombs: Array<{ mesh: THREE.Mesh; marker: THREE.Mesh }> = [];

function countOf(molten: boolean): number {
  let n = 0;
  for (const rock of rocks) if (rock.molten === molten) n++;
  return n;
}

function launch(
  molten: boolean,
  x: number, y: number, z: number,
  vx: number, vy0: number, vz: number,
  scale: number,
): void {
  const spare = (molten ? spareBombs : spareRocks).pop();
  const mesh =
    spare?.mesh ?? new THREE.Mesh(rockGeometry, molten ? lavaMaterial : rockMaterial);
  const marker = spare?.marker ?? new THREE.Mesh(markerGeometry, markerMaterial);
  mesh.castShadow = !molten;
  mesh.scale.setScalar(scale);
  marker.renderOrder = 14;
  rockGroup.add(mesh, marker);

  // Fly it ahead to find the landing point for the marker.
  let lx = x;
  let ly = y;
  let lz = z;
  let vy = vy0;
  let top = y;
  for (let frame = 0; frame < 900 && ly > groundY(lx, lz); frame++) {
    vy -= ROCK_GRAVITY;
    lx += vx;
    ly += vy;
    lz += vz;
    if (ly > top) top = ly;
  }
  const floor = layOnGround(marker, lx, lz, 0.06);

  rocks.push({
    x,
    y,
    z,
    vx,
    vy: vy0,
    vz,
    life: 900,
    mesh,
    marker,
    dropHeight: Math.max(1, top - floor),
    spinX: (Math.random() - 0.5) * 0.25,
    spinZ: (Math.random() - 0.5) * 0.25,
    molten,
  });
}

/** Start a rock falling from scene (x, y, z) with a little sideways drift. */
export function dropRock(x: number, y: number, z: number): void {
  if (countOf(false) >= MAX_ROCKS) return;
  launch(false, x, y, z, (Math.random() - 0.5) * 0.06, -0.02, (Math.random() - 0.5) * 0.06, 1);
}

/** Throw a lava bomb from scene (x, y, z) with the given velocity. */
export function launchLavaBomb(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
): void {
  if (countOf(true) >= MAX_LAVA_BOMBS) return;
  launch(true, x, y, z, vx, vy, vz, 0.8 + Math.random() * 0.7);
}

function retireRock(index: number): void {
  const rock = rocks[index];
  rockGroup.remove(rock.mesh, rock.marker);
  (rock.molten ? spareBombs : spareRocks).push({ mesh: rock.mesh, marker: rock.marker });
  rocks.splice(index, 1);
}

// ---------------------------------------------------------------------------
// Stepping.
// ---------------------------------------------------------------------------

/** Advance everything by one fixed frame. */
export function updateProjectiles(host: ProjectileHost): void {
  // --- Rocks --------------------------------------------------------------
  for (let i = rocks.length - 1; i >= 0; i--) {
    const rock = rocks[i];
    rock.vy -= ROCK_GRAVITY;
    rock.x += rock.vx;
    rock.y += rock.vy;
    rock.z += rock.vz;
    rock.life -= 1;
    rock.mesh.rotation.x += rock.spinX;
    rock.mesh.rotation.z += rock.spinZ;
    if (rock.molten) spawnLavaTrail(rock.x, rock.y, rock.z);
    else spawnMeteorTrail(rock.x, rock.y, rock.z);

    if (host.hazardAt(rock.x, rock.y, rock.z, ROCK_HIT_RADIUS, rock.molten ? 'lava' : 'rock')) {
      retireRock(i);
      continue;
    }
    const floor = groundY(rock.x, rock.z);
    if (rock.y <= floor || rock.life <= 0) {
      if (rock.molten) {
        host.lavaLanded(rock.x, floor, rock.z);
      } else {
        scratch.set(rock.x, floor + 0.2, rock.z);
        if (overSea(rock.x, rock.z)) {
          spawnSplash(scratch, 40);
        } else {
          spawnExplosion(scratch, 0.7);
          spawnDirt(rock.x, floor, rock.z, 10);
        }
        host.rockLanded(rock.x, floor, rock.z);
      }
      retireRock(i);
    }
  }

  // --- Bullets ------------------------------------------------------------
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.vy -= BULLET_GRAVITY;
    b.x += b.vx;
    b.y += b.vy;
    b.z += b.vz;
    b.life -= 1;

    let spent = b.life <= 0;

    if (!spent && host.bulletAt(b.x, b.y, b.z)) spent = true;

    if (!spent) {
      for (let r = rocks.length - 1; r >= 0; r--) {
        const rock = rocks[r];
        if (rock.molten) continue; // nothing solid there to hit
        const dx = rock.x - b.x;
        const dy = rock.y - b.y;
        const dz = rock.z - b.z;
        if (dx * dx + dy * dy + dz * dz < ROCK_SHOT_RADIUS * ROCK_SHOT_RADIUS) {
          scratch.set(rock.x, rock.y, rock.z);
          spawnExplosion(scratch, 0.6);
          host.rockShot(rock.x, rock.y, rock.z);
          retireRock(r);
          spent = true;
          break;
        }
      }
    }

    if (!spent) {
      const floor = groundY(b.x, b.z);
      if (b.y <= floor) {
        // Bullet landed: a splash on the sea, a kick of dirt on land.
        if (overSea(b.x, b.z)) {
          scratch.set(b.x, SEA_Y, b.z);
          spawnSplash(scratch, 8);
        } else {
          spawnDirt(b.x, floor, b.z, 2);
        }
        spent = true;
      }
    }

    if (spent) {
      const last = bullets.pop()!;
      if (i < bullets.length) bullets[i] = last;
    } else {
      spawnTracer(b.x, b.y, b.z, b.vx, b.vy, b.vz);
    }
  }

  // --- Plasma -------------------------------------------------------------
  for (let i = plasma.length - 1; i >= 0; i--) {
    const p = plasma[i];
    p.x += p.vx;
    p.y += p.vy;
    p.z += p.vz;
    p.life -= 1;
    spawnPlasmaGlow(p.x, p.y, p.z);

    let spent = p.life <= 0 || p.y <= groundY(p.x, p.z);
    if (!spent && host.hazardAt(p.x, p.y, p.z, PLASMA_RADIUS, 'plasma')) spent = true;
    if (spent) {
      const last = plasma.pop()!;
      if (i < plasma.length) plasma[i] = last;
    }
  }
}

/** Place the rock meshes and their landing markers for this rendered frame. */
export function renderProjectiles(backstep: number, time: number): void {
  // One shared material: every marker pulses together, faster than a
  // heartbeat, so it reads as a warning rather than decoration.
  markerMaterial.opacity = 0.55 + 0.4 * Math.sin(time * 14);
  for (const rock of rocks) {
    rock.mesh.position.set(
      rock.x - rock.vx * backstep,
      rock.y - rock.vy * backstep,
      rock.z - rock.vz * backstep,
    );
    // Wide while the rock is high, tightening to its true size at impact.
    const remaining = Math.max(0, (rock.y - rock.marker.position.y) / rock.dropHeight);
    // (An eruption throws many at once; their rings are kept tighter.)
    rock.marker.scale.setScalar(1 + remaining * (rock.molten ? 1.1 : 2.2));
  }
}

/** Keep everything alongside the player when the world wraps. */
export function shiftProjectiles(dx: number, dz: number): void {
  for (const list of [bullets, plasma, rocks] as Body[][]) {
    for (const body of list) {
      body.x += dx;
      body.z += dz;
    }
  }
  for (const rock of rocks) {
    rock.marker.position.x += dx;
    rock.marker.position.z += dz;
  }
}

export function clearProjectiles(): void {
  bullets.length = 0;
  plasma.length = 0;
  while (rocks.length > 0) retireRock(rocks.length - 1);
}

/** True if any plasma is in the air (drives the incoming-fire warning). */
export function plasmaInFlight(): boolean {
  return plasma.length > 0;
}
