// Exhaust particle system.  Ported from AddExhaustParticleToBuffer behaviour
// in LanderSrc.txt:2229-2366.
//
// The original spawns 8 particles per frame on full thrust, 1 on hover.
// Particle starts behind the ship (in the exhaust-plume direction), inherits
// the ship's velocity, gets a kick in the plume direction, and a small
// random spread.  Lifespan 8 + random(0..7) frames.  Gravity is applied to
// the particle's velocity each frame.

import * as THREE from 'three';

const MAX_PARTICLES = 384;

export type ParticleKind = 'exhaust' | 'explosion' | 'bullet' | 'rock';

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  kind: ParticleKind;
}

const particles: Particle[] = [];

const geom = new THREE.BufferGeometry();
const positionsAttr = new THREE.BufferAttribute(
  new Float32Array(MAX_PARTICLES * 3),
  3,
);
const colorsAttr = new THREE.BufferAttribute(
  new Float32Array(MAX_PARTICLES * 3),
  3,
);
const posArray = positionsAttr.array as Float32Array;
const colArray = colorsAttr.array as Float32Array;
positionsAttr.setUsage(THREE.DynamicDrawUsage);
colorsAttr.setUsage(THREE.DynamicDrawUsage);
geom.setAttribute('position', positionsAttr);
geom.setAttribute('color', colorsAttr);
geom.setDrawRange(0, 0);

const mat = new THREE.PointsMaterial({
  size: 0.18,
  vertexColors: true,
  sizeAttenuation: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  transparent: true,
});

export const particleSystem = new THREE.Points(geom, mat);
// The bounding sphere is computed once from initial (all-zero) positions
// and never recomputed when we mutate the buffers, so the default frustum
// culling drops the whole point cloud.  Disable culling — there are at most
// MAX_PARTICLES points, so cost is negligible.
particleSystem.frustumCulled = false;

const PARTICLE_GRAVITY = 0.0010;
const EXHAUST_SPEED = 0.040;
const EXHAUST_OFFSET = 0.25; // spawn just below the undercarriage
const SPREAD = 0.020;

function rand(): number {
  return Math.random() - 0.5;
}

/**
 * Add a single exhaust particle.  shipUp is the (unit) world-space up
 * direction of the ship — particles travel opposite to it (in the plume
 * direction below the ship's thrusters).
 */
export function spawnExhaustParticle(
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipUp: THREE.Vector3,
): void {
  if (particles.length >= MAX_PARTICLES) return;

  const pos = shipPos.clone().addScaledVector(shipUp, -EXHAUST_OFFSET);

  const vel = shipVel
    .clone()
    .addScaledVector(shipUp, -EXHAUST_SPEED)
    .add(new THREE.Vector3(rand() * SPREAD, rand() * SPREAD, rand() * SPREAD));

  const maxLife = 10 + Math.floor(Math.random() * 8);
  particles.push({ pos, vel, life: maxLife, maxLife, kind: 'exhaust' });
}

const BULLET_SPEED = 0.35;
const BULLET_OFFSET = 0.6;

/**
 * Fire a bullet (LanderSrc.txt:2401-2463).  Ship's nose direction is the
 * local +X axis transformed by ship.quaternion.
 */
export function spawnBullet(
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipNose: THREE.Vector3,
): void {
  if (particles.length >= MAX_PARTICLES) return;
  const pos = shipPos.clone().addScaledVector(shipNose, BULLET_OFFSET);
  const vel = shipVel.clone().addScaledVector(shipNose, BULLET_SPEED);
  particles.push({ pos, vel, life: 30, maxLife: 30, kind: 'bullet' });
}

/**
 * Convenience for one frame of thrust output.
 */
export function spawnExhaustBurst(
  count: number,
  shipPos: THREE.Vector3,
  shipVel: THREE.Vector3,
  shipUp: THREE.Vector3,
): void {
  for (let i = 0; i < count; i++) {
    spawnExhaustParticle(shipPos, shipVel, shipUp);
  }
}

/**
 * Explosion: omnidirectional burst with slight upward bias.  Used for crashes
 * (LanderSrc.txt:2606-2617 — AddExplosionToBuffer with size 81).
 */
export function spawnExplosion(centre: THREE.Vector3, count = 70): void {
  for (let i = 0; i < count; i++) {
    if (particles.length >= MAX_PARTICLES) break;
    // Uniform-ish direction on sphere, then biased upward.
    const phi = Math.random() * Math.PI * 2;
    const cosTheta = Math.random() * 2 - 1;
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const speed = 0.06 + Math.random() * 0.10;
    const vel = new THREE.Vector3(
      sinTheta * Math.cos(phi) * speed,
      cosTheta * speed + 0.04, // upward bias
      sinTheta * Math.sin(phi) * speed,
    );
    const maxLife = 25 + Math.floor(Math.random() * 20);
    particles.push({
      pos: centre.clone(),
      vel,
      life: maxLife,
      maxLife,
      kind: 'explosion',
    });
  }
}

/**
 * Drop a rock from the sky (LanderSrc.txt:4570 DropRocksFromTheSky).  Spawns
 * at the given world (X, Z) high above the player.  Falls under gravity.
 */
export function spawnFallingRock(worldX: number, sceneZ: number, fromHeight = 8): void {
  if (particles.length >= MAX_PARTICLES) return;
  particles.push({
    pos: new THREE.Vector3(worldX, fromHeight, sceneZ),
    vel: new THREE.Vector3(0, 0, 0),
    life: 240,
    maxLife: 240,
    kind: 'rock',
  });
}

/**
 * Expose the live particle array for collision tests.  Caller treats it as
 * read-only; use killParticle() to remove a particle.
 */
export function getParticles(): readonly Particle[] {
  return particles;
}

/** Remove a specific particle (used when a bullet destroys an object). */
export function killParticle(p: Particle): void {
  const idx = particles.indexOf(p);
  if (idx < 0) return;
  const last = particles.pop()!;
  if (idx < particles.length) particles[idx] = last;
}

/** Step the simulation by one fixed frame. */
export function updateParticles(): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vel.y -= PARTICLE_GRAVITY;
    p.pos.add(p.vel);
    p.life -= 1;
    if (p.life <= 0) {
      // O(1) swap-remove.
      const last = particles.pop()!;
      if (i < particles.length) particles[i] = last;
    }
  }

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    posArray[i * 3 + 0] = p.pos.x;
    posArray[i * 3 + 1] = p.pos.y;
    posArray[i * 3 + 2] = p.pos.z;

    const t = p.life / p.maxLife;
    if (p.kind === 'bullet') {
      colArray[i * 3 + 0] = 1.0;
      colArray[i * 3 + 1] = 1.0;
      colArray[i * 3 + 2] = 0.8 + 0.2 * t;
    } else if (p.kind === 'rock') {
      // Solid grey boulder.
      colArray[i * 3 + 0] = 0.55;
      colArray[i * 3 + 1] = 0.50;
      colArray[i * 3 + 2] = 0.45;
    } else {
      colArray[i * 3 + 0] = 1.0;
      colArray[i * 3 + 1] = 0.6 * t + 0.2;
      colArray[i * 3 + 2] = 0.1 * t * t;
    }
  }
  positionsAttr.needsUpdate = true;
  colorsAttr.needsUpdate = true;
  geom.setDrawRange(0, particles.length);
}

export function particleCount(): number {
  return particles.length;
}
