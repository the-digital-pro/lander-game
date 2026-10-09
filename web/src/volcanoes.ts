// Volcanoes: what comes out of them.
//
// terrain.ts builds the three cones and their craters into the landscape;
// terrainMesh.ts paints them and makes the lava in them glow.  This module
// makes them dangerous.
//
// Each volcano runs its own slow cycle.  Most of the time it is dormant: a
// thin plume of ash, a few embers lifting off the lava lake.  Then it starts
// to rumble - the plume thickens, the lake brightens, it spits - which is
// the warning, and lasts long enough to get clear.  Then it erupts: a
// fountain of lava from the crater and a barrage of lava bombs thrown out in
// high arcs to land anywhere within about forty tiles.  A bomb destroys
// whatever it lands on, the ship included.
//
// The crater itself is always lethal up close, and during an eruption so is
// the whole column above it.
//
// Volcanoes live in WORLD coordinates and wrap with the map; like the
// landbots, their effects are produced at whichever copy is nearest the ship.

import * as THREE from 'three';

import { lavaSurgeUniform } from './env';
import { spawnAsh, spawnCraterEmber, spawnLavaFountain } from './particles';
import { buildGlowDiscTexture, flatPlane, layOnGround } from './shadow';
import { VOLCANOES, wrapDelta, type Volcano } from './terrain';

// --- Tuning (frames are fixed 60 Hz steps) ----------------------------------

/** Quiet time between eruptions. */
const DORMANT_MIN = 40 * 60;
const DORMANT_MAX = 95 * 60;
/** A run's first eruption comes sooner, so the hazard is met early. */
const FIRST_MIN = 22 * 60;
const FIRST_MAX = 50 * 60;
/** The warning. */
const RUMBLE_FRAMES = 6 * 60;
const ERUPT_FRAMES = 5.5 * 60;
/** Frames between lava bombs during an eruption. */
const BOMB_INTERVAL = 14;
/** Beyond this the ship can't see a volcano, so its fireworks are skipped. */
const FX_RANGE = 118;
/** How far out from the crater's centre, and how high above its rim, kills. */
const CRATER_REACH = 0.5;
const CRATER_HEAT = 2.4;
const FOUNTAIN_REACH = 1.3;
const FOUNTAIN_HEIGHT = 15;
/** Seconds a lava bomb's splash goes on glowing. */
const PUDDLE_LIFE = 9;
const MAX_PUDDLES = 28;

export type VolcanoPhase = 'dormant' | 'rumbling' | 'erupting';

export interface VolcanoActivity {
  volcano: Volcano;
  phase: VolcanoPhase;
  /** 0 (quiet) .. 1 (full eruption); eases back down afterwards. */
  intensity: number;
}

interface ActivityInternal extends VolcanoActivity {
  timer: number;
  glow: THREE.Sprite;
}

/** What the volcanoes need from the game each fixed frame. */
export interface VolcanoHost {
  /** Player position: world x, world (forward-positive) z, scene y. */
  playerX: number;
  playerZ: number;
  playerY: number;
  playerAlive: boolean;
  /** Throw a lava bomb.  Position and velocity are in world axes. */
  launchBomb(wx: number, y: number, wz: number, vx: number, vy: number, vz: number): void;
  /** The ship is in the crater's heat or the fountain. */
  scorch(): void;
  /** A volcano `distance` tiles from the ship has started to rumble / erupted. */
  onRumble(volcano: Volcano, distance: number): void;
  onErupt(volcano: Volcano, distance: number): void;
}

interface Puddle {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  /** World position of the splash. */
  wx: number;
  wz: number;
  born: number;
  active: boolean;
}

const GLOW_COLOUR = new THREE.Color().setRGB(2.6, 0.9, 0.2);
const PUDDLE_COLOUR = new THREE.Color().setRGB(3.2, 1.0, 0.16);

function between(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export class Volcanoes {
  readonly group = new THREE.Group();
  private readonly list: ActivityInternal[];
  private readonly puddles: Puddle[] = [];
  private surge = 0;

  constructor() {
    const glowTexture = buildGlowDiscTexture();

    this.list = VOLCANOES.map((volcano) => {
      // The light the lava lake throws up into its own smoke.
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture,
          color: GLOW_COLOUR.clone(),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0,
        }),
      );
      glow.renderOrder = 10;
      this.group.add(glow);
      return { volcano, phase: 'dormant' as VolcanoPhase, intensity: 0, timer: 0, glow };
    });

    const puddleGeometry = flatPlane(3.6);
    for (let i = 0; i < MAX_PUDDLES; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: PUDDLE_COLOUR.clone(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(puddleGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.puddles.push({ mesh, material, wx: 0, wz: 0, born: 0, active: false });
    }

    this.reset();
  }

  /** Every volcano's current state.  Treat as read-only. */
  get activity(): readonly VolcanoActivity[] {
    return this.list;
  }

  /** Put every volcano back to sleep, for a new run. */
  reset(): void {
    for (const a of this.list) {
      a.phase = 'dormant';
      a.intensity = 0;
      a.timer = between(FIRST_MIN, FIRST_MAX);
    }
    for (const puddle of this.puddles) {
      puddle.active = false;
      puddle.mesh.visible = false;
    }
  }

  /** Wake a volcano up now (testing). */
  provoke(id: number): void {
    const a = this.list[id];
    if (!a || a.phase !== 'dormant') return;
    a.timer = 0;
  }

  /** The most active volcano within `range` tiles of world (x, z), if any is stirring. */
  threatNear(x: number, z: number, range: number): VolcanoActivity | null {
    let found: VolcanoActivity | null = null;
    for (const a of this.list) {
      if (a.phase === 'dormant') continue;
      const d = Math.hypot(wrapDelta(a.volcano.cx - x), wrapDelta(a.volcano.cz - z));
      if (d > range) continue;
      if (!found || (a.phase === 'erupting' && found.phase !== 'erupting')) found = a;
    }
    return found;
  }

  /** Advance every volcano by one fixed frame. */
  step(host: VolcanoHost, tick: number): void {
    for (const a of this.list) {
      const v = a.volcano;
      const dx = wrapDelta(v.cx - host.playerX);
      const dz = wrapDelta(v.cz - host.playerZ);
      const distance = Math.hypot(dx, dz);
      // Scene position of the crater, at the copy nearest the ship.
      const sx = host.playerX + dx;
      const sz = -(host.playerZ + dz);
      const visible = distance < FX_RANGE;

      a.timer -= 1;
      if (a.timer <= 0) {
        if (a.phase === 'dormant') {
          a.phase = 'rumbling';
          a.timer = RUMBLE_FRAMES;
          host.onRumble(v, distance);
        } else if (a.phase === 'rumbling') {
          a.phase = 'erupting';
          a.timer = ERUPT_FRAMES;
          host.onErupt(v, distance);
        } else {
          a.phase = 'dormant';
          a.timer = between(DORMANT_MIN, DORMANT_MAX);
        }
      }

      if (a.phase === 'dormant') {
        a.intensity *= 0.985; // cool off
        if (visible) {
          if (tick % 6 === 0) spawnAsh(sx, v.rimY, sz, 0.6);
          if (tick % 9 === 0) spawnCraterEmber(sx, v.floorY + 0.2, sz);
        }
      } else if (a.phase === 'rumbling') {
        // Builds through the warning, with a heartbeat on top.
        const progress = 1 - a.timer / RUMBLE_FRAMES;
        a.intensity = progress * (0.42 + 0.2 * Math.sin(tick * 0.35));
        if (visible) {
          if (tick % 2 === 0) spawnAsh(sx, v.rimY, sz, 0.8 + progress * 0.5);
          if (tick % 3 === 0) spawnCraterEmber(sx, v.floorY + 0.2, sz);
          // Spitting, more and more often.
          if (Math.random() < progress * 0.5) spawnLavaFountain(sx, v.floorY + 0.3, sz, 0.45, 1);
        }
      } else {
        a.intensity = 1;
        if (visible) {
          spawnAsh(sx, v.rimY + 0.5, sz, 1.6);
          spawnAsh(sx, v.rimY + 0.5, sz, 1.3);
          spawnLavaFountain(sx, v.floorY + 0.4, sz, 1, 4);
          if (a.timer % BOMB_INTERVAL === 0) {
            const angle = Math.random() * Math.PI * 2;
            const out = between(0.028, 0.112);
            host.launchBomb(
              v.cx + Math.cos(angle) * 0.8,
              v.floorY + 0.9,
              v.cz + Math.sin(angle) * 0.8,
              Math.cos(angle) * out,
              between(0.24, 0.37),
              Math.sin(angle) * out,
            );
          }
        }
      }

      // The crater burns anything that gets down into it; a fountain burns
      // anything over it.
      if (host.playerAlive) {
        const erupting = a.phase === 'erupting';
        const reach = v.craterRadius + (erupting ? FOUNTAIN_REACH : CRATER_REACH);
        const ceiling = v.rimY + (erupting ? FOUNTAIN_HEIGHT : CRATER_HEAT);
        if (distance < reach && host.playerY < ceiling) host.scorch();
      }
    }
  }

  /** A lava bomb burst at scene (x, z): leave it glowing on the ground. */
  addPuddle(sceneX: number, sceneZ: number, time: number): void {
    let slot = this.puddles[0];
    for (const p of this.puddles) {
      if (!p.active) {
        slot = p;
        break;
      }
      if (p.born < slot.born) slot = p;
    }
    slot.active = true;
    slot.born = time;
    slot.wx = sceneX;
    slot.wz = -sceneZ;
    layOnGround(slot.mesh, sceneX, sceneZ, 0.05);
    slot.mesh.visible = true;
    slot.mesh.scale.setScalar(0.7 + Math.random() * 0.6);
  }

  /**
   * Place glows and splashes for this rendered frame.  (playerX, playerZ)
   * is the ship in world coordinates.
   */
  render(playerX: number, playerZ: number, time: number, dt: number): void {
    let surge = 0;
    for (const a of this.list) {
      const v = a.volcano;
      const dx = wrapDelta(v.cx - playerX);
      const dz = wrapDelta(v.cz - playerZ);
      if (Math.hypot(dx, dz) < 130) surge = Math.max(surge, a.intensity);

      // A steady ember of light even at rest, flaring with activity.
      const flicker = 0.9 + 0.1 * Math.sin(time * 9 + v.id * 2.3) * Math.sin(time * 5.3);
      const level = (0.22 + 0.78 * a.intensity) * flicker;
      a.glow.position.set(playerX + dx, v.rimY + 0.4 + a.intensity * 2.5, -(playerZ + dz));
      const size = 7 + a.intensity * 15;
      a.glow.scale.set(size, size * 0.8, 1);
      a.glow.material.opacity = Math.min(1, level * 0.75);
    }
    this.surge += (surge - this.surge) * (1 - Math.exp(-6 * dt));
    lavaSurgeUniform.value = this.surge;

    for (const p of this.puddles) {
      if (!p.active) continue;
      const age = (time - p.born) / PUDDLE_LIFE;
      if (age >= 1) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      // Keep it at the copy nearest the ship; height and tilt were set
      // when it landed.
      p.mesh.position.x = playerX + wrapDelta(p.wx - playerX);
      p.mesh.position.z = -(playerZ + wrapDelta(p.wz - playerZ));
      const cool = 1 - age;
      p.material.opacity = cool * cool * 0.9;
      p.material.color.copy(PUDDLE_COLOUR).multiplyScalar(0.35 + 0.65 * cool);
    }
  }
}
