// Particle system.
//
// The original tracked every exhaust plume, spark, bullet and smoke wisp in
// one 484-entry table (AddExhaustParticleToBuffer and friends,
// LanderSrc.txt:2229-2366).  This keeps the same idea - one flat table,
// stepped once per fixed frame - but stores it as struct-of-arrays so
// thousands of particles cost no allocations and no garbage, and draws it
// as soft, size-attenuated GPU point sprites.
//
// There are two tables: `glow` is additive (fire, tracers, sparks, virus
// spray - anything that emits light, and so anything the bloom pass picks
// up) and `haze` is alpha-blended (smoke, dust), which lets smoke finally
// be dark instead of the grey-on-additive compromise the old port needed.
//
// Behaviours kept from the source: exhaust inherits the ship's velocity and
// is kicked down the plume (8 particles a frame at full thrust, 1 on hover),
// particles fall under their own gravity, and they bounce when they reach
// the ground.

import * as THREE from 'three';

import { FOG_FAR, FOG_NEAR } from './env';
import { groundY } from './terrain';

/** Particle bounces off the ground / sea surface. */
const BOUNCE = 1;
/** Particle is removed when it reaches the ground / sea surface. */
const DIE_ON_GROUND = 2;

/** A particle recipe.  Colours are linear and may exceed 1 (HDR -> bloom). */
interface Recipe {
  life: number;
  lifeJitter: number;
  size0: number;
  size1: number;
  c0: readonly [number, number, number];
  c1: readonly [number, number, number];
  alpha: number;
  gravity: number;
  drag: number;
  flags: number;
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aVel;
  attribute vec4 aColor;
  attribute float aSize;
  uniform float uBackstep;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    // The sim runs at a fixed 60 Hz; step each sprite back along its own
    // velocity so motion stays smooth on faster displays.
    vec3 p = position - aVel * uBackstep;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(-mv.z, 0.05);
    gl_PointSize = clamp(aSize * uScale / depth, 1.0, 420.0);
    float fog = 1.0 - smoothstep(${FOG_NEAR.toFixed(1)}, ${FOG_FAR.toFixed(1)}, depth);
    vColor = vec4(aColor.rgb, aColor.a * fog);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec4 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d >= 1.0) discard;
    float soft = 1.0 - d;
    soft = soft * soft * (3.0 - 2.0 * soft);
    gl_FragColor = vec4(vColor.rgb, vColor.a * soft);
  }
`;

const sharedUniforms = {
  uBackstep: { value: 0 },
  uScale: { value: 600 },
};

class ParticleTable {
  readonly points: THREE.Points;
  private count = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly sizeScale: Float32Array;
  private readonly recipe: Recipe[];

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly colours: Float32Array;
  private readonly sizes: Float32Array;
  private readonly geometry: THREE.BufferGeometry;

  constructor(
    private readonly capacity: number,
    blending: THREE.Blending,
    renderOrder: number,
  ) {
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.sizeScale = new Float32Array(capacity);
    this.recipe = new Array<Recipe>(capacity);

    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.colours = new Float32Array(capacity * 4);
    this.sizes = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    const dynamic = (array: Float32Array, itemSize: number): THREE.BufferAttribute => {
      const attribute = new THREE.BufferAttribute(array, itemSize);
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };
    this.geometry.setAttribute('position', dynamic(this.positions, 3));
    this.geometry.setAttribute('aVel', dynamic(this.velocities, 3));
    this.geometry.setAttribute('aColor', dynamic(this.colours, 4));
    this.geometry.setAttribute('aSize', dynamic(this.sizes, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: sharedUniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      blending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, material);
    // Positions are rewritten every frame, so a cached bounding sphere
    // would cull the whole cloud; there is only one draw call to save.
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
  }

  emit(
    recipe: Recipe,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    sizeScale = 1,
    lifeScale = 1,
  ): void {
    let i = this.count;
    if (i >= this.capacity) {
      // Table full: recycle a random slot rather than drop the new sprite,
      // so a long firefight degrades evenly instead of going dark.
      i = (Math.random() * this.capacity) | 0;
    } else {
      this.count++;
    }
    const life = Math.max(2, (recipe.life + Math.random() * recipe.lifeJitter) * lifeScale);
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.sizeScale[i] = sizeScale;
    this.recipe[i] = recipe;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last];
    this.py[i] = this.py[last];
    this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.sizeScale[i] = this.sizeScale[last];
    this.recipe[i] = this.recipe[last];
  }

  /** Step the simulation by one fixed frame and refresh the GPU buffers. */
  update(): void {
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= 1;
      if (this.life[i] <= 0) {
        this.remove(i);
        continue;
      }
      const recipe = this.recipe[i];
      this.vy[i] -= recipe.gravity;
      if (recipe.drag !== 1) {
        this.vx[i] *= recipe.drag;
        this.vy[i] *= recipe.drag;
        this.vz[i] *= recipe.drag;
      }
      this.px[i] += this.vx[i];
      this.py[i] += this.vy[i];
      this.pz[i] += this.vz[i];

      if (recipe.flags !== 0) {
        const floor = groundY(this.px[i], this.pz[i]);
        if (this.py[i] < floor) {
          if ((recipe.flags & DIE_ON_GROUND) !== 0) {
            this.remove(i);
            continue;
          }
          // Bounce, shedding most of the energy (as the original's
          // particles do when they reach the landscape).
          this.py[i] = floor;
          this.vy[i] = Math.abs(this.vy[i]) * 0.32;
          this.vx[i] *= 0.7;
          this.vz[i] *= 0.7;
        }
      }
    }

    const { positions, velocities, colours, sizes } = this;
    for (let i = 0; i < this.count; i++) {
      const recipe = this.recipe[i];
      const age = 1 - this.life[i] / this.maxLife[i]; // 0 -> 1
      const i3 = i * 3;
      const i4 = i * 4;
      positions[i3] = this.px[i];
      positions[i3 + 1] = this.py[i];
      positions[i3 + 2] = this.pz[i];
      velocities[i3] = this.vx[i];
      velocities[i3 + 1] = this.vy[i];
      velocities[i3 + 2] = this.vz[i];
      colours[i4] = recipe.c0[0] + (recipe.c1[0] - recipe.c0[0]) * age;
      colours[i4 + 1] = recipe.c0[1] + (recipe.c1[1] - recipe.c0[1]) * age;
      colours[i4 + 2] = recipe.c0[2] + (recipe.c1[2] - recipe.c0[2]) * age;
      // Quick fade-in, long fade-out.
      const fadeIn = age < 0.08 ? age / 0.08 : 1;
      colours[i4 + 3] = recipe.alpha * fadeIn * (1 - age * age);
      sizes[i] = (recipe.size0 + (recipe.size1 - recipe.size0) * age) * this.sizeScale[i];
    }

    this.geometry.setDrawRange(0, this.count);
    // Only the live head of each buffer needs re-sending.  (Skip entirely
    // when empty: a zero-length range means "the whole array" to WebGL2.)
    if (this.count === 0) return;
    const attributes = this.geometry.attributes;
    for (const name of ['position', 'aVel', 'aColor', 'aSize'] as const) {
      const attribute = attributes[name] as THREE.BufferAttribute;
      attribute.addUpdateRange(0, this.count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  /** Slide every live particle (the world wrapped under the player). */
  shift(dx: number, dz: number): void {
    for (let i = 0; i < this.count; i++) {
      this.px[i] += dx;
      this.pz[i] += dz;
    }
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  get live(): number {
    return this.count;
  }
}

const glow = new ParticleTable(6000, THREE.AdditiveBlending, 12);
const haze = new ParticleTable(1600, THREE.NormalBlending, 11);

/** Add to the scene once. */
export const particleSystem = new THREE.Group();
particleSystem.add(haze.points, glow.points);

function rand(): number {
  return Math.random() - 0.5;
}

// ---------------------------------------------------------------------------
// Recipes.
// ---------------------------------------------------------------------------

const EXHAUST: Recipe = {
  life: 13, lifeJitter: 11, size0: 0.34, size1: 0.06,
  c0: [3.4, 2.5, 1.2], c1: [1.5, 0.18, 0.02],
  alpha: 0.9, gravity: 0.001, drag: 1, flags: BOUNCE,
};
const TRACER: Recipe = {
  life: 5, lifeJitter: 0, size0: 0.34, size1: 0.05,
  c0: [4.2, 3.6, 1.6], c1: [2.0, 0.7, 0.1],
  alpha: 1, gravity: 0, drag: 1, flags: 0,
};
const FLASH: Recipe = {
  life: 7, lifeJitter: 2, size0: 5.5, size1: 1.0,
  c0: [4.0, 3.2, 2.2], c1: [2.0, 0.6, 0.1],
  alpha: 0.9, gravity: 0, drag: 1, flags: 0,
};
const SPARK: Recipe = {
  life: 26, lifeJitter: 30, size0: 0.24, size1: 0.04,
  c0: [3.6, 2.2, 0.7], c1: [1.2, 0.12, 0.0],
  alpha: 1, gravity: 0.0034, drag: 0.992, flags: BOUNCE,
};
const FIREBALL: Recipe = {
  life: 14, lifeJitter: 14, size0: 0.9, size1: 2.1,
  c0: [2.6, 1.3, 0.35], c1: [0.5, 0.06, 0.0],
  alpha: 0.55, gravity: -0.0006, drag: 0.92, flags: 0,
};
const BLAST_SMOKE: Recipe = {
  life: 55, lifeJitter: 45, size0: 0.9, size1: 3.0,
  c0: [0.05, 0.045, 0.045], c1: [0.14, 0.13, 0.14],
  alpha: 0.55, gravity: -0.0004, drag: 0.955, flags: 0,
};
const WRECK_SMOKE: Recipe = {
  life: 60, lifeJitter: 0, size0: 0.32, size1: 1.25,
  c0: [0.035, 0.035, 0.04], c1: [0.16, 0.15, 0.17],
  alpha: 0.5, gravity: 0, drag: 1, flags: 0,
};
const DUST: Recipe = {
  life: 30, lifeJitter: 25, size0: 0.4, size1: 1.5,
  c0: [0.34, 0.29, 0.2], c1: [0.4, 0.36, 0.3],
  alpha: 0.26, gravity: -0.0003, drag: 0.94, flags: 0,
};
const SPRAY: Recipe = {
  life: 26, lifeJitter: 22, size0: 0.2, size1: 0.07,
  c0: [0.55, 0.85, 1.1], c1: [0.25, 0.45, 0.7],
  alpha: 0.8, gravity: 0.0042, drag: 0.995, flags: DIE_ON_GROUND,
};
const MIST: Recipe = {
  life: 26, lifeJitter: 20, size0: 0.5, size1: 1.7,
  c0: [0.75, 0.86, 0.95], c1: [0.8, 0.9, 1.0],
  alpha: 0.22, gravity: 0, drag: 0.93, flags: 0,
};
const VIRUS: Recipe = {
  life: 46, lifeJitter: 20, size0: 0.2, size1: 0.11,
  c0: [3.6, 0.2, 0.42], c1: [1.3, 0.02, 0.1],
  alpha: 0.95, gravity: 0.0021, drag: 0.99, flags: DIE_ON_GROUND,
};
const VIRUS_BURST: Recipe = {
  life: 40, lifeJitter: 40, size0: 0.26, size1: 0.05,
  c0: [3.8, 0.3, 0.6], c1: [1.0, 0.0, 0.1],
  alpha: 1, gravity: 0.003, drag: 0.99, flags: BOUNCE,
};
const HULL_SPARK: Recipe = {
  life: 12, lifeJitter: 14, size0: 0.2, size1: 0.03,
  c0: [1.6, 3.2, 4.0], c1: [0.2, 0.6, 1.4],
  alpha: 1, gravity: 0.003, drag: 0.98, flags: BOUNCE,
};
const PLASMA: Recipe = {
  life: 7, lifeJitter: 2, size0: 0.62, size1: 0.1,
  c0: [4.2, 0.5, 1.6], c1: [1.4, 0.0, 0.4],
  alpha: 1, gravity: 0, drag: 1, flags: 0,
};
const EMBER: Recipe = {
  life: 16, lifeJitter: 14, size0: 0.5, size1: 0.08,
  c0: [3.8, 1.7, 0.4], c1: [1.0, 0.1, 0.0],
  alpha: 0.9, gravity: 0, drag: 0.96, flags: 0,
};
const BEAM_IN: Recipe = {
  life: 22, lifeJitter: 16, size0: 0.3, size1: 0.05,
  c0: [3.4, 0.35, 0.8], c1: [0.8, 0.0, 0.2],
  alpha: 0.9, gravity: -0.002, drag: 0.97, flags: 0,
};
const LAVA: Recipe = {
  life: 55, lifeJitter: 55, size0: 0.52, size1: 0.14,
  c0: [4.6, 1.9, 0.4], c1: [1.3, 0.12, 0.0],
  alpha: 1, gravity: 0.0038, drag: 0.995, flags: BOUNCE,
};
const LAVA_DRIP: Recipe = {
  life: 20, lifeJitter: 18, size0: 0.46, size1: 0.08,
  c0: [4.4, 1.7, 0.32], c1: [1.0, 0.1, 0.0],
  alpha: 1, gravity: 0.002, drag: 0.97, flags: DIE_ON_GROUND,
};
const CRATER_EMBER: Recipe = {
  life: 45, lifeJitter: 45, size0: 0.24, size1: 0.05,
  c0: [3.6, 1.3, 0.25], c1: [1.0, 0.1, 0.0],
  alpha: 0.9, gravity: -0.0007, drag: 0.985, flags: 0,
};
const ASH: Recipe = {
  life: 190, lifeJitter: 110, size0: 1.6, size1: 7.5,
  c0: [0.03, 0.027, 0.03], c1: [0.13, 0.12, 0.13],
  alpha: 0.5, gravity: -0.00012, drag: 0.992, flags: 0,
};
const SHOCK: Recipe = {
  life: 20, lifeJitter: 6, size0: 0.3, size1: 0.12,
  c0: [3.0, 2.4, 1.8], c1: [1.2, 0.4, 0.1],
  alpha: 0.85, gravity: 0, drag: 0.93, flags: 0,
};

// ---------------------------------------------------------------------------
// Emitters.
// ---------------------------------------------------------------------------

const EXHAUST_SPEED = 0.040;
const EXHAUST_OFFSET = 0.25; // spawn just below the undercarriage
const SPREAD = 0.020;

/**
 * One frame of thrust output.  shipUp is the (unit) world-space up
 * direction of the ship - particles travel opposite to it, down the plume.
 */
export function spawnExhaustBurst(
  count: number,
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipUp: THREE.Vector3,
): void {
  for (let i = 0; i < count; i++) {
    glow.emit(
      EXHAUST,
      shipPos.x - shipUp.x * EXHAUST_OFFSET,
      shipPos.y - shipUp.y * EXHAUST_OFFSET,
      shipPos.z - shipUp.z * EXHAUST_OFFSET,
      shipVel.x - shipUp.x * EXHAUST_SPEED + rand() * SPREAD,
      shipVel.y - shipUp.y * EXHAUST_SPEED + rand() * SPREAD,
      shipVel.z - shipUp.z * EXHAUST_SPEED + rand() * SPREAD,
    );
  }
}

/** Dust (or sea mist) kicked up where the plume washes over the surface. */
export function spawnGroundWash(x: number, y: number, z: number, overSea: boolean): void {
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.03 + Math.random() * 0.05;
  haze.emit(
    overSea ? MIST : DUST,
    x + rand() * 0.5,
    y + 0.08,
    z + rand() * 0.5,
    Math.cos(angle) * speed,
    0.004 + Math.random() * 0.012,
    Math.sin(angle) * speed,
  );
}

/** A bullet's glowing head; called every frame the bullet is alive. */
export function spawnTracer(
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
): void {
  glow.emit(TRACER, x, y, z, vx * 0.3, vy * 0.3, vz * 0.3);
}

/** A landbot's plasma bolt, same idea as the tracer. */
export function spawnPlasmaGlow(x: number, y: number, z: number): void {
  glow.emit(PLASMA, x, y, z, rand() * 0.01, rand() * 0.01, rand() * 0.01);
}

/** Fire and smoke shed by a falling meteor. */
export function spawnMeteorTrail(x: number, y: number, z: number): void {
  glow.emit(EMBER, x + rand() * 0.2, y + rand() * 0.2, z + rand() * 0.2, rand() * 0.02, 0.01, rand() * 0.02);
  if (Math.random() < 0.35) {
    haze.emit(WRECK_SMOKE, x, y, z, rand() * 0.01, 0.006, rand() * 0.01, 1.3, 0.7);
  }
}

function randomOnSphere(target: { x: number; y: number; z: number }): void {
  const phi = Math.random() * Math.PI * 2;
  const cosTheta = Math.random() * 2 - 1;
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  target.x = sinTheta * Math.cos(phi);
  target.y = cosTheta;
  target.z = sinTheta * Math.sin(phi);
}
const dir = { x: 0, y: 0, z: 0 };

/**
 * Explosion: a flash, an omnidirectional burst of sparks with a slight
 * upward bias, a fireball and a column of smoke.  Used for crashes
 * (LanderSrc.txt:2606-2617 - AddExplosionToBuffer) and everything else
 * that blows up.  `scale` 1 is a ship; a tree is about 0.4.
 */
export function spawnExplosion(centre: THREE.Vector3, scale = 1): void {
  const { x, y, z } = centre;
  glow.emit(FLASH, x, y, z, 0, 0, 0, scale);

  const sparks = Math.round(46 * scale);
  for (let i = 0; i < sparks; i++) {
    randomOnSphere(dir);
    const speed = (0.05 + Math.random() * 0.13) * (0.7 + 0.3 * scale);
    glow.emit(SPARK, x, y, z, dir.x * speed, dir.y * speed + 0.045, dir.z * speed);
  }
  const fire = Math.round(12 * scale);
  for (let i = 0; i < fire; i++) {
    randomOnSphere(dir);
    const speed = 0.02 + Math.random() * 0.05;
    glow.emit(FIREBALL, x, y, z, dir.x * speed, Math.abs(dir.y) * speed + 0.01, dir.z * speed, scale);
  }
  const smoke = Math.round(9 * scale);
  for (let i = 0; i < smoke; i++) {
    randomOnSphere(dir);
    const speed = 0.012 + Math.random() * 0.03;
    haze.emit(BLAST_SMOKE, x, y, z, dir.x * speed, Math.abs(dir.y) * speed + 0.012, dir.z * speed, scale);
  }
}

/** Expanding ring of sparks hugging the ground: a landbot's death rattle. */
export function spawnShockRing(centre: THREE.Vector3, speed = 0.22): void {
  const count = 44;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    glow.emit(SHOCK, centre.x, centre.y, centre.z, Math.cos(angle) * speed, 0.004, Math.sin(angle) * speed);
  }
}

/** The virus payload scattering when a landbot breaks up. */
export function spawnVirusBurst(centre: THREE.Vector3): void {
  for (let i = 0; i < 40; i++) {
    randomOnSphere(dir);
    const speed = 0.04 + Math.random() * 0.1;
    glow.emit(VIRUS_BURST, centre.x, centre.y, centre.z, dir.x * speed, dir.y * speed + 0.03, dir.z * speed);
  }
}

/** Sparks off a landbot's hull when a round lands. */
export function spawnHullSparks(x: number, y: number, z: number, count = 7): void {
  for (let i = 0; i < count; i++) {
    randomOnSphere(dir);
    const speed = 0.03 + Math.random() * 0.07;
    glow.emit(HULL_SPARK, x, y, z, dir.x * speed, dir.y * speed + 0.02, dir.z * speed);
  }
}

/** Water thrown up by an impact on the sea. */
export function spawnSplash(centre: THREE.Vector3, count = 14): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const out = 0.01 + Math.random() * 0.035;
    glow.emit(
      SPRAY,
      centre.x, centre.y + 0.05, centre.z,
      Math.cos(angle) * out, 0.05 + Math.random() * 0.08, Math.sin(angle) * out,
    );
  }
  for (let i = 0; i < Math.ceil(count / 4); i++) {
    haze.emit(MIST, centre.x + rand() * 0.3, centre.y + 0.1, centre.z + rand() * 0.3, rand() * 0.03, 0.02, rand() * 0.03);
  }
}

/** A puff of dirt where a round or a rock meets the ground. */
export function spawnDirt(x: number, y: number, z: number, count = 4): void {
  for (let i = 0; i < count; i++) {
    haze.emit(DUST, x, y + 0.05, z, rand() * 0.05, 0.015 + Math.random() * 0.03, rand() * 0.05, 0.8);
  }
}

/**
 * One droplet of virus falling from a landbot's sprayer.  (cx, cy, cz) is
 * the nozzle; the droplet fans out to roughly `radius` by ground level.
 */
export function spawnVirusDroplet(cx: number, cy: number, cz: number, radius: number): void {
  const angle = Math.random() * Math.PI * 2;
  const out = Math.sqrt(Math.random()) * radius * 0.03;
  glow.emit(VIRUS, cx, cy, cz, Math.cos(angle) * out, -0.012 - Math.random() * 0.02, Math.sin(angle) * out);
}

// --- Volcanoes ---------------------------------------------------------------

/** Wind that carries a volcano's plume, tiles per frame. */
const ASH_DRIFT_X = 0.016;
const ASH_DRIFT_Z = 0.007;

/**
 * One puff of the ash column over a crater.  `vigour` is about 0.6 for a
 * volcano at rest and 1.6 for one in full eruption.
 */
export function spawnAsh(x: number, y: number, z: number, vigour: number): void {
  haze.emit(
    ASH,
    x + rand() * 1.6,
    y,
    z + rand() * 1.6,
    ASH_DRIFT_X + rand() * 0.012,
    (0.03 + Math.random() * 0.03) * vigour,
    ASH_DRIFT_Z + rand() * 0.012,
    0.7 + vigour * 0.35,
  );
}

/** A glowing mote lifting off a lava lake. */
export function spawnCraterEmber(x: number, y: number, z: number): void {
  glow.emit(CRATER_EMBER, x + rand() * 3, y, z + rand() * 3, rand() * 0.02, 0.03 + Math.random() * 0.05, rand() * 0.02);
}

/**
 * The lava fountain: gobs of melt thrown up out of the crater.  `strength`
 * is 1 for a full eruption, less for the spatter that comes before one.
 */
export function spawnLavaFountain(x: number, y: number, z: number, strength: number, count: number): void {
  for (let i = 0; i < count; i++) {
    glow.emit(
      LAVA,
      x + rand() * 1.4,
      y,
      z + rand() * 1.4,
      rand() * 0.11 * strength,
      (0.1 + Math.random() * 0.26) * strength,
      rand() * 0.11 * strength,
      0.8 + Math.random() * 0.8,
    );
  }
}

/** Melt dripping off a lava bomb in flight. */
export function spawnLavaTrail(x: number, y: number, z: number): void {
  glow.emit(LAVA_DRIP, x + rand() * 0.2, y + rand() * 0.2, z + rand() * 0.2, rand() * 0.02, 0.006, rand() * 0.02);
  if (Math.random() < 0.3) {
    haze.emit(WRECK_SMOKE, x, y, z, rand() * 0.01, 0.006, rand() * 0.01, 1.4, 0.8);
  }
}

/** A lava bomb bursting on the ground. */
export function spawnLavaSplash(centre: THREE.Vector3): void {
  const { x, y, z } = centre;
  glow.emit(FLASH, x, y, z, 0, 0, 0, 0.8);
  for (let i = 0; i < 30; i++) {
    const angle = Math.random() * Math.PI * 2;
    const out = 0.03 + Math.random() * 0.11;
    glow.emit(LAVA, x, y, z, Math.cos(angle) * out, 0.05 + Math.random() * 0.13, Math.sin(angle) * out, 0.7 + Math.random() * 0.6);
  }
  for (let i = 0; i < 6; i++) {
    haze.emit(BLAST_SMOKE, x, y, z, rand() * 0.04, 0.015 + Math.random() * 0.03, rand() * 0.04, 0.8);
  }
}

/**
 * Dust (or spray) torn off the surface by a turbine's wind and carried
 * along with it.  (vx, vz) is the wind there, in scene axes.
 */
export function spawnWindDust(
  x: number, y: number, z: number,
  vx: number, vz: number,
  overSea: boolean,
): void {
  haze.emit(
    overSea ? MIST : DUST,
    x + rand() * 0.8,
    y + 0.1 + Math.random() * 0.3,
    z + rand() * 0.8,
    vx * 0.8 + rand() * 0.02,
    0.006 + Math.random() * 0.014,
    vz * 0.8 + rand() * 0.02,
    1.3,
    1.4,
  );
}

/** Motes drawn up a landbot's arrival beam. */
export function spawnBeamMote(x: number, y: number, z: number): void {
  glow.emit(BEAM_IN, x + rand() * 1.4, y, z + rand() * 1.4, 0, 0.04 + Math.random() * 0.06, 0);
}

// Smoke (LanderSrc.txt:3870-... AddSmokeParticleToBuffer + 4908-4945).
// Original spawns one smoke particle per destroyed tile, on 1-in-4 frames,
// at SMOKE_HEIGHT (= 0.75 tile) above the tile base.  Rises at
// SMOKE_RISING_SPEED tiles/frame with no gravity.  We scale to 60 fps and
// keep a small horizontal jitter for a wispy look.
const SMOKE_RISE = 0.03125 * (50 / 60); // ~0.026 per frame
const SMOKE_JITTER = 0.008;

/**
 * Spawn one rising-smoke particle.  `lifeMul` scales the particle's
 * lifetime - bigger means a longer-lived puff (so smoke from a building
 * lingers and reads as a thicker plume than a tree's quick wisp).
 */
export function spawnSmokeParticle(x: number, y: number, z: number, lifeMul = 1): void {
  haze.emit(
    WRECK_SMOKE,
    x, y, z,
    rand() * SMOKE_JITTER, SMOKE_RISE, rand() * SMOKE_JITTER,
    0.8 + lifeMul * 0.3,
    lifeMul,
  );
}

// ---------------------------------------------------------------------------
// Housekeeping.
// ---------------------------------------------------------------------------

/** Step both tables by one fixed frame. */
export function updateParticles(): void {
  glow.update();
  haze.update();
}

/** Keep particles alongside the player when the world wraps. */
export function shiftParticles(dx: number, dz: number): void {
  glow.shift(dx, dz);
  haze.shift(dx, dz);
}

export function clearParticles(): void {
  glow.clear();
  haze.clear();
}

/**
 * Per-render-frame uniforms.  `backstep` is how far (0..1 of a fixed frame)
 * the render lags the newest sim state; `pixelScale` converts world size to
 * pixels at unit distance for the current viewport.
 */
export function setParticleView(backstep: number, pixelScale: number): void {
  sharedUniforms.uBackstep.value = backstep;
  sharedUniforms.uScale.value = pixelScale;
}

export function particleCount(): number {
  return glow.live + haze.live;
}
