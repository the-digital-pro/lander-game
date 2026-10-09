// Landbots.
//
// Rogue saucers that drift low over the land spraying virus, after the
// seeders of Zarch (1987): slow, predictable, easy enough to kill - and
// every second one is left alive, more of the map goes red.  They do not
// chase the player.  They wander toward whatever nearby ground is still
// clean, so left alone a swarm spreads out and quietly takes the planet.
//
// From the third wave they also defend themselves: a bot that has the ship
// in range glows up for half a second, then lobs a slow plasma bolt at
// where the ship is heading.
//
// Bots live in WORLD coordinates (x, forward-positive z) and wrap with the
// map; they are drawn at whichever copy is nearest the player.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { infectionAt, sprayVirus } from './infection';
import {
  spawnBeamMote,
  spawnHullSparks,
  spawnSmokeParticle,
  spawnVirusDroplet,
} from './particles';
import { buildGlowDiscTexture, flatPlane, layOnGround } from './shadow';
import {
  LAND_MASK,
  isSea,
  padClearance,
  surfaceAltitude,
  tileIndex,
  wrap,
  wrapDelta,
} from './terrain';

// --- Tuning -----------------------------------------------------------------

/** Height the saucer rides above the surface, in tiles. */
const HOVER_HEIGHT = 1.35;
/** Radius of ground the sprayer reaches. */
export const SPRAY_RADIUS = 2.6;
/** Frames between applications of virus to the map. */
const SPRAY_INTERVAL = 6;
/** Infection level added at the centre of the spray per application. */
const SPRAY_AMOUNT = 0.075;
/** Frames a new arrival takes to descend its beam. */
const ARRIVAL_FRAMES = 150;
const ARRIVAL_HEIGHT = 30;
/** Collision ellipsoid (tiles): generous, the things are hard enough to hit. */
const HIT_RADIUS = 1.3;
const HIT_HALF_HEIGHT = 0.8;
/** Range at which an armed bot will engage the ship. */
const ENGAGE_RANGE = 19;
const CHARGE_FRAMES = 32;
const PLASMA_SPEED = 0.17;
/** Don't bother with spray particles for bots the player can't see. */
const FX_RANGE = 85;

export interface Landbot {
  id: number;
  /** World position.  `y` is scene-space height (up). */
  wx: number;
  wz: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  hp: number;
  maxHp: number;
  phase: 'arriving' | 'active';
  /** True while it is actually laying virus (over land, not arriving). */
  spraying: boolean;
}

interface BotInternal extends Landbot {
  tx: number;
  tz: number;
  retarget: number;
  age: number;
  seed: number;
  speed: number;
  armed: boolean;
  cooldown: number;
  /** Frames left until a charged shot is released; -1 when not charging. */
  charge: number;
  flash: number;
  group: THREE.Group;
  body: THREE.Group;
  hull: THREE.MeshLambertMaterial;
  dome: THREE.MeshBasicMaterial;
  cone: THREE.Mesh;
  glow: THREE.Mesh;
}

/** What the swarm needs to know about the world each fixed frame. */
export interface LandbotHost {
  /** Player position: world x, world (forward-positive) z, scene y. */
  playerX: number;
  playerZ: number;
  playerY: number;
  /** Player velocity per frame, in world axes. */
  playerVX: number;
  playerVZ: number;
  playerVY: number;
  /** False while the ship is dead, landed or freshly respawned. */
  playerTargetable: boolean;
  /** Launch a plasma bolt.  Position and velocity are in world axes. */
  firePlasma(wx: number, y: number, wz: number, vx: number, vy: number, vz: number): void;
}

// --- Shared geometry and materials -----------------------------------------

const scratch = new THREE.Color();

function buildHullGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.0, -0.36],
    [0.26, -0.34],
    [0.5, -0.17],
    [1.1, -0.03],
    [1.17, 0.05],
    [0.94, 0.15],
    [0.5, 0.27],
    [0.33, 0.31],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geometry = new THREE.LatheGeometry(profile, 12).toNonIndexed();
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals(); // non-indexed -> one flat normal per facet

  // Colour each facet by where it sits on the saucer.
  const position = geometry.attributes.position;
  const colours = new Float32Array(position.count * 3);
  for (let face = 0; face < position.count; face += 3) {
    let y = 0;
    let r = 0;
    for (let v = 0; v < 3; v++) {
      y += position.getY(face + v) / 3;
      r += Math.hypot(position.getX(face + v), position.getZ(face + v)) / 3;
    }
    let hex: number;
    if (y > 0.2) hex = 0xa9c3df; // crown
    else if (y > 0.08) hex = 0x5f83ad; // upper deck: the steel blue of the original
    else if (y > -0.01) hex = 0x28324a; // rim band
    else if (r > 0.42) hex = 0x3d4c68; // belly
    else hex = 0x8a1f30; // sprayer housing
    // Alternate facets a step darker so the disc reads as panelled.
    const dim = (face / 3) % 2 === 0 ? 1 : 0.86;
    scratch.setHex(hex).multiplyScalar(dim);
    for (let v = 0; v < 3; v++) {
      colours[(face + v) * 3] = scratch.r;
      colours[(face + v) * 3 + 1] = scratch.g;
      colours[(face + v) * 3 + 2] = scratch.b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function buildRimLights(): THREE.BufferGeometry {
  const lamp = new THREE.BoxGeometry(0.13, 0.09, 0.13);
  const positions: number[] = [];
  const index: number[] = [];
  const count = 8;
  for (let k = 0; k < count; k++) {
    const angle = (k / count) * Math.PI * 2;
    const p = lamp.attributes.position;
    for (let i = 0; i < p.count; i++) {
      positions.push(
        p.getX(i) + Math.cos(angle) * 1.13,
        p.getY(i) + 0.05,
        p.getZ(i) + Math.sin(angle) * 1.13,
      );
    }
    const idx = lamp.index!;
    for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + k * p.count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

const HULL_GEOMETRY = buildHullGeometry();
const RIM_GEOMETRY = buildRimLights();
const DOME_GEOMETRY = new THREE.SphereGeometry(0.34, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
DOME_GEOMETRY.translate(0, 0.3, 0);
// Spray cone: unit height hanging down from the origin; scaled to reach the ground.
const CONE_GEOMETRY = new THREE.CylinderGeometry(0.14, SPRAY_RADIUS * 0.8, 1, 16, 1, true);
CONE_GEOMETRY.translate(0, -0.5, 0);
const GLOW_GEOMETRY = flatPlane(SPRAY_RADIUS * 2.6);

const HULL_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const RIM_MATERIAL = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(3.4, 0.35, 0.5) });
const CONE_MATERIAL = new THREE.MeshBasicMaterial({
  color: new THREE.Color().setRGB(1.0, 0.06, 0.16),
  transparent: true,
  opacity: 0.14,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const GLOW_MATERIAL = new THREE.MeshBasicMaterial({
  map: buildGlowDiscTexture(),
  color: new THREE.Color().setRGB(1.6, 0.08, 0.2),
  transparent: true,
  opacity: 0.55,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

const DOME_IDLE = new THREE.Color().setRGB(2.4, 0.3, 1.0);
const DOME_CHARGED = new THREE.Color().setRGB(6.0, 3.2, 4.0);
const FLASH_COLOUR = new THREE.Color().setRGB(0.85, 0.85, 0.95);

// --- The swarm --------------------------------------------------------------

export class Landbots {
  readonly group = new THREE.Group();
  private readonly list: BotInternal[] = [];
  private nextId = 1;

  /** Live bots.  Treat as read-only. */
  get bots(): readonly Landbot[] {
    return this.list;
  }

  /**
   * Drop `count` bots onto dry land, well away from the player, the pads
   * and each other, tuned for `wave`.
   */
  spawnWave(count: number, wave: number, playerX: number, playerZ: number): void {
    for (let n = 0; n < count; n++) {
      let wx = 0;
      let wz = 0;
      // Relax the spacing rules if the map is being stubborn.
      for (let attempt = 0; attempt < 400; attempt++) {
        wx = Math.random() * 256;
        wz = Math.random() * 256;
        const strict = attempt < 300;
        if (LAND_MASK[tileIndex(Math.floor(wx), Math.floor(wz))] === 0) continue;
        if (padClearance(wx, wz) < (strict ? 18 : 6)) continue;
        if (Math.hypot(wrapDelta(wx - playerX), wrapDelta(wz - playerZ)) < (strict ? 55 : 30)) continue;
        let crowded = false;
        for (const other of this.list) {
          if (Math.hypot(wrapDelta(wx - other.wx), wrapDelta(wz - other.wz)) < (strict ? 30 : 10)) {
            crowded = true;
            break;
          }
        }
        if (!crowded) break;
      }
      this.spawn(wx, wz, wave, n * 22);
    }
  }

  private spawn(wx: number, wz: number, wave: number, delay: number): void {
    const hull = shadeWithClouds(HULL_MATERIAL.clone());
    const dome = new THREE.MeshBasicMaterial({ color: DOME_IDLE.clone() });

    const body = new THREE.Group();
    const hullMesh = new THREE.Mesh(HULL_GEOMETRY, hull);
    hullMesh.castShadow = true;
    body.add(hullMesh, new THREE.Mesh(RIM_GEOMETRY, RIM_MATERIAL), new THREE.Mesh(DOME_GEOMETRY, dome));

    const cone = new THREE.Mesh(CONE_GEOMETRY, CONE_MATERIAL);
    cone.position.y = -0.34;
    cone.renderOrder = 8;

    const group = new THREE.Group();
    group.add(body, cone);

    const glow = new THREE.Mesh(GLOW_GEOMETRY, GLOW_MATERIAL);
    glow.renderOrder = 4;

    this.group.add(group, glow);

    const maxHp = 3 + Math.ceil(wave / 2);
    const surface = -surfaceAltitude(wx, wz);
    this.list.push({
      id: this.nextId++,
      wx,
      wz,
      y: surface + HOVER_HEIGHT + ARRIVAL_HEIGHT,
      vx: 0,
      vz: 0,
      vy: 0,
      hp: maxHp,
      maxHp,
      phase: 'arriving',
      spraying: false,
      tx: wx,
      tz: wz,
      retarget: 0,
      // Negative age staggers the arrivals so a wave doesn't land as one.
      age: -delay,
      seed: Math.random() * 100,
      speed: Math.min(0.026 + 0.0035 * wave, 0.06),
      armed: wave >= 3,
      cooldown: 120 + Math.random() * 180,
      charge: -1,
      flash: 0,
      group,
      body,
      hull,
      dome,
      cone,
      glow,
    });
  }

  /** Choose somewhere nearby worth infecting. */
  private pickTarget(bot: BotInternal): void {
    let best = -Infinity;
    const speed = Math.hypot(bot.vx, bot.vz) || 1;
    for (let k = 0; k < 10; k++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 8 + Math.random() * 28;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const cx = bot.wx + dx * distance;
      const cz = bot.wz + dz * distance;
      let score = Math.random() * 0.5;
      // Stay over ground that can be infected (this also keeps them off pads)...
      if (LAND_MASK[tileIndex(Math.floor(cx), Math.floor(cz))] === 0) score -= 4;
      // ...and prefer ground that has not been yet,
      score -= infectionAt(cx, cz) * 3;
      // without doubling back on themselves more than they have to.
      score += ((dx * bot.vx + dz * bot.vz) / speed) * 0.6;
      if (score > best) {
        best = score;
        bot.tx = wrap(cx);
        bot.tz = wrap(cz);
        bot.retarget = (distance / bot.speed) * 1.2;
      }
    }
  }

  /** Advance every bot by one fixed frame. */
  step(host: LandbotHost): void {
    for (const bot of this.list) {
      bot.age += 1;
      if (bot.flash > 0) bot.flash = Math.max(0, bot.flash - 0.09);
      if (bot.age < 0) continue; // still waiting its turn to arrive

      const distanceToPlayer = Math.hypot(
        wrapDelta(bot.wx - host.playerX),
        wrapDelta(bot.wz - host.playerZ),
      );
      const visible = distanceToPlayer < FX_RANGE;
      const surface = -surfaceAltitude(bot.wx, bot.wz);

      if (bot.phase === 'arriving') {
        const t = Math.min(1, bot.age / ARRIVAL_FRAMES);
        const ease = 1 - (1 - t) * (1 - t) * (1 - t);
        const previous = bot.y;
        bot.y = surface + HOVER_HEIGHT + ARRIVAL_HEIGHT * (1 - ease);
        bot.vy = bot.y - previous;
        if (visible && Math.random() < 0.6) {
          spawnBeamMote(
            host.playerX + wrapDelta(bot.wx - host.playerX),
            surface + Math.random() * (bot.y - surface),
            -(host.playerZ + wrapDelta(bot.wz - host.playerZ)),
          );
        }
        if (t >= 1) {
          bot.phase = 'active';
          this.pickTarget(bot);
        }
        continue;
      }

      // --- Wander ---------------------------------------------------------
      bot.retarget -= 1;
      const toX = wrapDelta(bot.tx - bot.wx);
      const toZ = wrapDelta(bot.tz - bot.wz);
      const toTarget = Math.hypot(toX, toZ);
      if (bot.retarget <= 0 || toTarget < 2.5) this.pickTarget(bot);
      if (toTarget > 1e-3) {
        bot.vx += ((toX / toTarget) * bot.speed - bot.vx) * 0.04;
        bot.vz += ((toZ / toTarget) * bot.speed - bot.vz) * 0.04;
      }
      bot.wx = wrap(bot.wx + bot.vx);
      bot.wz = wrap(bot.wz + bot.vz);

      // Ride the terrain, looking a little ahead so hills don't swallow it.
      const ahead = -surfaceAltitude(bot.wx + bot.vx * 14, bot.wz + bot.vz * 14);
      const bob = Math.sin(bot.age * 0.05 + bot.seed) * 0.16;
      const targetY = Math.max(surface, ahead) + HOVER_HEIGHT + bob;
      const previousY = bot.y;
      bot.y += (targetY - bot.y) * 0.09;
      bot.vy = bot.y - previousY;

      // --- Spray ----------------------------------------------------------
      bot.spraying = !isSea(bot.wx, bot.wz);
      if (bot.spraying) {
        if (bot.age % SPRAY_INTERVAL === 0) {
          sprayVirus(bot.wx, bot.wz, SPRAY_RADIUS, SPRAY_AMOUNT);
        }
        if (visible) {
          const sx = host.playerX + wrapDelta(bot.wx - host.playerX);
          const sz = -(host.playerZ + wrapDelta(bot.wz - host.playerZ));
          spawnVirusDroplet(sx, bot.y - 0.36, sz, SPRAY_RADIUS);
          if (bot.age % 2 === 0) spawnVirusDroplet(sx, bot.y - 0.36, sz, SPRAY_RADIUS);
        }
      }

      // A bot that has taken a beating trails smoke.
      if (visible && bot.hp <= bot.maxHp / 2 && Math.random() < 0.3) {
        spawnSmokeParticle(
          host.playerX + wrapDelta(bot.wx - host.playerX),
          bot.y + 0.3,
          -(host.playerZ + wrapDelta(bot.wz - host.playerZ)),
          0.9,
        );
      }

      // --- Defend ---------------------------------------------------------
      if (!bot.armed) continue;
      if (bot.charge >= 0) {
        bot.charge -= 1;
        if (bot.charge < 0) {
          if (host.playerTargetable && distanceToPlayer < ENGAGE_RANGE * 1.3) {
            // Lead the ship: aim where it will be when the bolt gets there.
            const flight = distanceToPlayer / PLASMA_SPEED;
            const lead = Math.min(flight, 70) * 0.7;
            const ax = wrapDelta(host.playerX - bot.wx) + host.playerVX * lead;
            const az = wrapDelta(host.playerZ - bot.wz) + host.playerVZ * lead;
            const ay = host.playerY + host.playerVY * lead * 0.5 - (bot.y + 0.3);
            const length = Math.hypot(ax, ay, az) || 1;
            host.firePlasma(
              bot.wx,
              bot.y + 0.3,
              bot.wz,
              (ax / length) * PLASMA_SPEED,
              (ay / length) * PLASMA_SPEED,
              (az / length) * PLASMA_SPEED,
            );
          }
          bot.cooldown = 150 + Math.random() * 130;
        }
      } else if (bot.cooldown > 0) {
        bot.cooldown -= 1;
      } else if (host.playerTargetable && distanceToPlayer < ENGAGE_RANGE) {
        bot.charge = CHARGE_FRAMES;
      }
    }
  }

  /**
   * Place every bot's meshes for this rendered frame.  `backstep` (0..1 of
   * a fixed frame) pulls each one back along its velocity so motion is
   * smooth on displays faster than the 60 Hz sim.
   */
  render(playerX: number, playerZ: number, backstep: number, time: number): void {
    for (const bot of this.list) {
      const waiting = bot.age < 0;
      bot.group.visible = !waiting;
      if (waiting) {
        bot.glow.visible = false;
        continue;
      }
      const wx = playerX + wrapDelta(bot.wx - playerX) - bot.vx * backstep;
      const wz = playerZ + wrapDelta(bot.wz - playerZ) - bot.vz * backstep;
      const y = bot.y - bot.vy * backstep;
      bot.group.position.set(wx, y, -wz);

      // Bank into the direction of travel; spin the disc under the dome.
      bot.group.rotation.set(-bot.vz * 5, 0, -bot.vx * 5);
      bot.body.rotation.y = time * 1.7 + bot.seed;

      bot.hull.emissive.copy(FLASH_COLOUR).multiplyScalar(bot.flash);
      const charging = bot.charge >= 0 ? 1 - bot.charge / CHARGE_FRAMES : 0;
      bot.dome.color
        .copy(DOME_IDLE)
        .lerp(DOME_CHARGED, charging)
        .multiplyScalar(0.8 + 0.2 * Math.sin(time * 7 + bot.seed));

      const surface = layOnGround(bot.glow, wx, -wz, 0.04);
      const spraying = bot.spraying && bot.phase === 'active';
      bot.glow.visible = spraying;
      bot.cone.visible = spraying;
      if (spraying) {
        bot.cone.scale.y = Math.max(0.2, y - 0.34 - surface);
        const flicker = 0.92 + 0.08 * Math.sin(time * 23 + bot.seed * 3);
        bot.cone.scale.x = bot.cone.scale.z = flicker;
      }
    }
  }

  /**
   * The bot whose hull contains scene point (x, y, z), if any.  `pad`
   * widens the test (for the ship's own bulk).
   */
  hitTest(x: number, y: number, z: number, pad = 0): Landbot | null {
    const radius = HIT_RADIUS + pad;
    const halfHeight = HIT_HALF_HEIGHT + pad;
    for (const bot of this.list) {
      if (bot.age < 0) continue;
      const dy = (bot.y - y) / halfHeight;
      if (dy > 1 || dy < -1) continue;
      const dx = wrapDelta(bot.wx - x) / radius;
      const dz = wrapDelta(bot.wz + z) / radius; // scene z is -world z
      if (dx * dx + dy * dy + dz * dz < 1) return bot;
    }
    return null;
  }

  /** Nearest live bot to world point (x, z), with its distance. */
  nearest(x: number, z: number): { bot: Landbot; distance: number } | null {
    let found: Landbot | null = null;
    let distance = Infinity;
    for (const bot of this.list) {
      const d = Math.hypot(wrapDelta(bot.wx - x), wrapDelta(bot.wz - z));
      if (d < distance) {
        distance = d;
        found = bot;
      }
    }
    return found ? { bot: found, distance } : null;
  }

  /**
   * Apply damage.  Returns true if that finished the bot off (the caller
   * owns the fireworks and the score); it is removed either way when dead.
   */
  damage(target: Landbot, amount: number, sceneX: number, sceneY: number, sceneZ: number): boolean {
    const bot = target as BotInternal;
    bot.hp -= amount;
    bot.flash = 1;
    spawnHullSparks(sceneX, sceneY, sceneZ);
    if (bot.hp > 0) return false;
    this.remove(bot);
    return true;
  }

  private remove(bot: BotInternal): void {
    const i = this.list.indexOf(bot);
    if (i >= 0) this.list.splice(i, 1);
    this.group.remove(bot.group, bot.glow);
    bot.hull.dispose();
    bot.dome.dispose();
  }

  clear(): void {
    while (this.list.length > 0) this.remove(this.list[this.list.length - 1]);
  }
}
