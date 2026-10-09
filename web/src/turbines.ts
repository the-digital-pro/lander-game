// Wind turbines.
//
// Five wind farms stand about the map, each a row of three turbines (sited
// by terrain.ts).  These are not the kind that harvest wind.  They make it:
// every rotor throws a stream of air out in front of itself, twenty tiles
// long and widening as it goes, and draws a shorter, weaker draught in from
// behind.  A ship that strays into either is carried along with it.
//
// The wind is modelled as a velocity, not a force.  The air in a stream is
// moving at some speed, and a ship in it is dragged toward that speed - so a
// ship is never blown along faster than the wind itself, flying with it is
// easy and flying into it is a fight.  A stream is strongest at the rotor
// and dies away with distance and toward its edges; pass over the top of
// one, or under it close in, and you miss it altogether.
//
// Nothing about a farm stands still.  Each swings slowly from side to side,
// taking its wind with it, and gusts and slackens as it goes.  And since air
// can't be seen, the streams are drawn: pale streaks that ride the wind at
// the wind's own speed.
//
// The machines themselves are solid.  Tower, nacelle and the whole disc the
// blades sweep will destroy a ship that touches them - and the draught
// behind a rotor leads straight into it.
//
// Turbines live in WORLD coordinates and wrap with the map; like everything
// else that does, they are drawn at whichever copy is nearest the ship.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { FOG_FAR, FOG_NEAR } from './env';
import { spawnWindDust } from './particles';
import { groundY, isSea, TURBINES, wrapDelta, type TurbineSite } from './terrain';

// --- Shape (tiles) ----------------------------------------------------------

/** Height of the rotor's axis above the foot of the tower. */
const HUB_HEIGHT = 6.4;
const ROTOR_RADIUS = 3.1;
/** The rotor turns this far out in front of the tower's axis. */
const ROTOR_OFFSET = 0.95;

// --- The wind (frames are fixed 60 Hz steps) --------------------------------

/** How far downwind of the rotor a stream carries. */
export const WIND_REACH = 20;
/** How far upwind of it the draught is felt. */
const INTAKE_REACH = 6;
/** Speed of the air at the rotor in a full gust, tiles per frame. */
const WIND_SPEED = 0.3;
/** The draught going in is this much of what comes out. */
const INTAKE_SHARE = 0.45;
/** A stream's radius grows by this for every tile it travels. */
export const WIND_SPREAD = 0.17;
/** Share of the gap between the ship's speed and the wind's closed each frame. */
const GRIP = 0.045;
/** Rough air: the most a full-strength stream knocks the ship about per frame. */
const TURBULENCE = 0.0022;
/** A farm swings this far (radians) either side of dead ahead... */
const SWING = 0.6;
/** ...taking this long over the round trip. */
const SWING_FRAMES = 55 * 60;
/** Rotor speed in a full gust, radians per frame. */
const SPIN = 0.095;

// --- Collision --------------------------------------------------------------

/** Allowance for the ship's own size. */
const SHIP_RADIUS = 0.45;
const TOWER_RADIUS = 0.4;
const NACELLE_RADIUS = 0.75;
/** Half the depth of the slab of air the blades sweep. */
const DISC_HALF_DEPTH = 0.5;

// --- Streaks ----------------------------------------------------------------

/** Farms further than this from the ship don't draw their wind. */
const FX_RANGE = 95;
const MAX_STREAKS = 420;
/** Streaks started per turbine per frame in a full gust. */
const STREAK_RATE = 0.34;
/** One in this many shows the draught going in rather than the stream out. */
const INTAKE_STREAKS = 0.24;
/** A streak is as long as the distance its air covers in this many frames. */
const STREAK_STRETCH = 15;
const STREAK_HALF_WIDTH = 0.036;
/** How fast a streak winds around the axis of its stream, radians per frame. */
const SWIRL = 0.005;

/** One turbine as the rest of the game sees it. */
export interface TurbineState {
  site: TurbineSite;
  /** The bearing its wind is blowing along right now (see TurbineSite.heading). */
  heading: number;
  /** How hard it is blowing at the moment: 0.6 (slack) to 1 (full gust). */
  gust: number;
}

interface TurbineInternal extends TurbineState {
  /** Scene-space height (Y up) of the tower's foot and of the rotor's axis. */
  baseY: number;
  hubY: number;
  /** Unit vector the wind blows along, in world axes. */
  ax: number;
  az: number;
  /** Centre of the rotor, in world coordinates. */
  rx: number;
  rz: number;
  spin: number;
  spinRate: number;
  /** Fraction of a streak owed. */
  owed: number;
  /** Scene position of the rotor's centre this rendered frame. */
  sceneX: number;
  sceneZ: number;
}

/** What the wind did to the ship this frame. */
export interface WindEffect {
  /** 0 (still air) to 1 (the full blast at a rotor). */
  strength: number;
}

// --- Geometry ---------------------------------------------------------------

const scratchColour = new THREE.Color();

/**
 * Make a geometry flat-shaded and give every facet a colour, chosen from
 * where its centre is.
 */
function facet(
  source: THREE.BufferGeometry,
  colourAt: (x: number, y: number, z: number) => number,
): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  geometry.deleteAttribute('uv');
  geometry.computeVertexNormals(); // non-indexed -> one flat normal per facet
  const position = geometry.attributes.position;
  const colours = new Float32Array(position.count * 3);
  for (let face = 0; face < position.count; face += 3) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let v = 0; v < 3; v++) {
      x += position.getX(face + v) / 3;
      y += position.getY(face + v) / 3;
      z += position.getZ(face + v) / 3;
    }
    scratchColour.setHex(colourAt(x, y, z));
    for (let v = 0; v < 3; v++) {
      colours[(face + v) * 3] = scratchColour.r;
      colours[(face + v) * 3 + 1] = scratchColour.g;
      colours[(face + v) * 3 + 2] = scratchColour.b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/** Join faceted geometries into one. */
function join(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    let length = 0;
    for (const part of parts) length += part.attributes[name].array.length;
    const merged = new Float32Array(length);
    let offset = 0;
    for (const part of parts) {
      merged.set(part.attributes[name].array as Float32Array, offset);
      offset += part.attributes[name].array.length;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(merged, 3));
  }
  geometry.computeBoundingSphere();
  return geometry;
}

const WHITE = 0xe6ebf2;
const WHITE_SHADE = 0xc4ccd8;
const WARNING_RED = 0xd8342a;
const STEEL = 0x8a93a1;
const CONCRETE = 0x6b7078;

/** Tower and plinth.  Origin at the foot; runs down a way for sloping ground. */
function buildTowerGeometry(): THREE.BufferGeometry {
  const bottom = -1;
  const top = HUB_HEIGHT - 0.2;
  const tower = new THREE.CylinderGeometry(0.2, TOWER_RADIUS, top - bottom, 10, 8);
  tower.translate(0, (top + bottom) / 2, 0);
  const plinth = new THREE.CylinderGeometry(0.82, 0.98, 0.95, 8);
  plinth.translate(0, -0.2, 0);
  return join([
    // One warning band low on the tower, where a low-flying ship would see it.
    facet(tower, (_x, y) => (y > 0.85 && y < 1.75 ? WARNING_RED : y > top - 0.9 ? WHITE_SHADE : WHITE)),
    facet(plinth, () => CONCRETE),
  ]);
}

/** The housing on top.  Origin on the rotor's axis over the tower; +X is downwind. */
function buildNacelleGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1.95, 0.66, 0.72, 3, 1, 1);
  box.translate(-0.2, 0.08, 0);
  // Taper the tail.
  const p = box.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getX(i) < -1) p.setXYZ(i, p.getX(i), p.getY(i) * 0.7 + 0.04, p.getZ(i) * 0.62);
  }
  return facet(box, (x, y) => (y < -0.2 ? STEEL : x < -0.7 ? WARNING_RED : WHITE));
}

/** Spinner and three blades.  Origin at the rotor's centre; it turns about +X. */
function buildRotorGeometry(): THREE.BufferGeometry {
  const spinner = new THREE.ConeGeometry(0.36, 0.8, 8);
  spinner.rotateZ(-Math.PI / 2);
  spinner.translate(0.3, 0, 0);
  const parts = [facet(spinner, () => WHITE_SHADE)];

  // Chord at stations along the blade, root to tip.
  const chord = [0.3, 0.6, 0.52, 0.42, 0.33, 0.24, 0.13];
  const sections = chord.length - 1;
  const root = 0.2;
  for (let k = 0; k < 3; k++) {
    // X is thickness (along the axis), Y runs out along the blade, Z is chord.
    const blade = new THREE.BoxGeometry(1, 1, 1, 1, sections, 1);
    const p = blade.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i) + 0.5;
      const station = Math.round(t * sections);
      const thickness = 0.17 - 0.12 * t;
      // Twisted, as a real blade is: coarse at the root, fine at the tip.
      const twist = 0.55 - 0.45 * t;
      const x = p.getX(i) * thickness;
      const z = (p.getZ(i) + 0.18) * chord[station];
      p.setXYZ(
        i,
        x * Math.cos(twist) + z * Math.sin(twist),
        root + t * (ROTOR_RADIUS - root),
        z * Math.cos(twist) - x * Math.sin(twist),
      );
    }
    blade.rotateX((k * Math.PI * 2) / 3);
    // Red at the tip and one band inboard, so the disc reads as rings.
    parts.push(
      facet(blade, (_x, y, z) => {
        const r = Math.hypot(y, z) / ROTOR_RADIUS;
        return r > 0.84 || (r > 0.52 && r < 0.68) ? WARNING_RED : WHITE;
      }),
    );
  }
  return join(parts);
}

// --- The wind as a field ----------------------------------------------------

/**
 * Speed of the air on the axis of a stream, `s` tiles downwind of the rotor
 * (negative: upwind), as a share of what leaves the rotor.
 */
function axialSpeed(s: number): number {
  if (s >= 0) {
    const u = 1 - s / WIND_REACH;
    return u <= 0 ? 0 : u * Math.sqrt(u);
  }
  const u = 1 + s / INTAKE_REACH;
  return u <= 0 ? 0 : INTAKE_SHARE * u * u;
}

/** Radius of a stream `s` tiles downwind (negative: upwind) of the rotor. */
function streamRadius(s: number): number {
  return s >= 0 ? ROTOR_RADIUS + s * WIND_SPREAD : ROTOR_RADIUS * (1 - (0.4 * s) / INTAKE_REACH);
}

// --- Streak shader ----------------------------------------------------------

const STREAK_VERTEX = /* glsl */ `
  attribute vec3 aDir;
  attribute float aSide;
  attribute float aAlpha;
  varying float vAlpha;
  varying float vSide;
  void main() {
    // A ribbon: push each edge out sideways, square to both the streak and
    // the line of sight, so it faces the camera from wherever it is seen.
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 along = normalize(mat3(modelViewMatrix) * aDir);
    vec3 side = cross(along, normalize(mv.xyz));
    float len = length(side);
    side = len > 1e-4 ? side / len : vec3(0.0, 1.0, 0.0);
    mv.xyz += side * aSide * ${STREAK_HALF_WIDTH.toFixed(3)};
    gl_Position = projectionMatrix * mv;
    float fog = 1.0 - smoothstep(${FOG_NEAR.toFixed(1)}, ${FOG_FAR.toFixed(1)}, -mv.z);
    vAlpha = aAlpha * fog;
    vSide = aSide;
  }
`;

const STREAK_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying float vSide;
  void main() {
    float soft = 1.0 - vSide * vSide;
    gl_FragColor = vec4(vec3(0.72, 0.88, 1.0), vAlpha * soft);
  }
`;

const UP = new THREE.Vector3(0, 1, 0);
const AXIS = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const NO_TURN = new THREE.Quaternion();
const yaw = new THREE.Quaternion();
const roll = new THREE.Quaternion();
const turn = new THREE.Quaternion();
const place = new THREE.Vector3();
const matrix = new THREE.Matrix4();

const BEACON_LIT = new THREE.Color().setRGB(5.0, 0.35, 0.25);
const BEACON_DARK = new THREE.Color().setRGB(0.22, 0.02, 0.02);

export class Turbines {
  readonly group = new THREE.Group();
  private readonly list: TurbineInternal[];
  private readonly towers: THREE.InstancedMesh;
  private readonly nacelles: THREE.InstancedMesh;
  private readonly rotors: THREE.InstancedMesh;
  private readonly beacons: THREE.InstancedMesh;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;

  // Streaks, struct-of-arrays.  `s` is distance along the stream's axis;
  // `rho` and `phi` place the streak across it, as a share of the stream's
  // radius and an angle around the axis.
  private streakCount = 0;
  private readonly streakOwner = new Uint8Array(MAX_STREAKS);
  private readonly streakIntake = new Uint8Array(MAX_STREAKS);
  private readonly streakS = new Float32Array(MAX_STREAKS);
  private readonly streakRho = new Float32Array(MAX_STREAKS);
  private readonly streakPhi = new Float32Array(MAX_STREAKS);
  private readonly streakAge = new Float32Array(MAX_STREAKS);
  private readonly streakGeometry = new THREE.BufferGeometry();
  private readonly streakPosition = new Float32Array(MAX_STREAKS * 6 * 3);
  private readonly streakDir = new Float32Array(MAX_STREAKS * 6 * 3);
  private readonly streakAlpha = new Float32Array(MAX_STREAKS * 6);

  private readonly effect: WindEffect = { strength: 0 };

  constructor() {
    this.list = TURBINES.map((site) => {
      const baseY = groundY(site.x, -site.z);
      return {
        site,
        heading: site.heading,
        gust: 1,
        baseY,
        hubY: baseY + HUB_HEIGHT,
        ax: Math.cos(site.heading),
        az: Math.sin(site.heading),
        rx: site.x,
        rz: site.z,
        // Start the rotors out of step with one another.
        spin: site.id * 0.83,
        spinRate: 0,
        owed: 0,
        sceneX: 0,
        sceneZ: 0,
      };
    });

    const paint = shadeWithClouds(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.list.length));
      mesh.count = this.list.length;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances are spread over the whole map and re-placed every frame.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    this.towers = instanced(buildTowerGeometry(), paint);
    this.nacelles = instanced(buildNacelleGeometry(), paint);
    this.rotors = instanced(buildRotorGeometry(), paint);
    for (const mesh of [this.towers, this.nacelles, this.rotors]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    // Aircraft warning lights: unlit, and bright enough to bloom.
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: BEACON_DARK.clone() });
    this.beacons = instanced(new THREE.BoxGeometry(0.17, 0.15, 0.17), this.beaconMaterial);

    // Each streak is a ribbon of two quads: clear at the tail, brightest
    // most of the way along, clear again at the nose.
    const side = new Float32Array(MAX_STREAKS * 6);
    const index = new Uint16Array(MAX_STREAKS * 12);
    for (let i = 0; i < MAX_STREAKS; i++) {
      const v = i * 6;
      for (let k = 0; k < 6; k++) side[v + k] = k % 2 === 0 ? 1 : -1;
      index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3, v + 2, v + 3, v + 4, v + 4, v + 3, v + 5], i * 12);
    }
    const dynamic = (array: Float32Array, itemSize: number): THREE.BufferAttribute => {
      const attribute = new THREE.BufferAttribute(array, itemSize);
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };
    this.streakGeometry.setAttribute('position', dynamic(this.streakPosition, 3));
    this.streakGeometry.setAttribute('aDir', dynamic(this.streakDir, 3));
    this.streakGeometry.setAttribute('aAlpha', dynamic(this.streakAlpha, 1));
    this.streakGeometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.streakGeometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.streakGeometry.setDrawRange(0, 0);
    const streaks = new THREE.Mesh(
      this.streakGeometry,
      new THREE.ShaderMaterial({
        vertexShader: STREAK_VERTEX,
        fragmentShader: STREAK_FRAGMENT,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    // Rewritten every frame, like the particles; nothing to cull against.
    streaks.frustumCulled = false;
    streaks.renderOrder = 11;
    this.group.add(streaks);

    this.step(0, 0, 0);
  }

  /** Every turbine's current state.  Treat as read-only. */
  get states(): readonly TurbineState[] {
    return this.list;
  }

  /** Advance every turbine, and the streaks in their wind, by one fixed frame. */
  step(tick: number, playerX: number, playerZ: number): void {
    for (const t of this.list) {
      // A farm moves as one: same swing, same gusts.
      const phase = t.site.farm * 2.4;
      t.heading = t.site.heading + SWING * Math.sin((tick / SWING_FRAMES) * Math.PI * 2 + phase);
      t.gust = 0.8 + 0.2 * Math.sin(tick * 0.011 + phase * 1.7);
      t.ax = Math.cos(t.heading);
      t.az = Math.sin(t.heading);
      t.rx = t.site.x + t.ax * ROTOR_OFFSET;
      t.rz = t.site.z + t.az * ROTOR_OFFSET;
      t.spinRate = SPIN * t.gust;
      t.spin += t.spinRate;

      const distance = Math.hypot(wrapDelta(t.site.x - playerX), wrapDelta(t.site.z - playerZ));
      if (distance > FX_RANGE) continue;
      t.owed += STREAK_RATE * t.gust;
      while (t.owed >= 1) {
        t.owed -= 1;
        this.startStreak(t.site.id);
      }
      if (tick % 2 === 0) this.scour(t, playerX, playerZ);
    }

    for (let i = this.streakCount - 1; i >= 0; i--) {
      const t = this.list[this.streakOwner[i]];
      const intake = this.streakIntake[i] === 1;
      this.streakS[i] += this.streakSpeed(this.streakS[i], intake, t.gust);
      this.streakPhi[i] += SWIRL;
      this.streakAge[i] += 1;
      // Spent at the far end of the stream - or, going in, at the blades.
      if (this.streakS[i] >= (intake ? -0.3 : WIND_REACH - 0.4)) this.endStreak(i);
    }
  }

  /**
   * Where a stream comes down on the land or the sea it drags dust or spray
   * along with it, which marks out the reach of the wind on the surface.
   */
  private scour(t: TurbineInternal, playerX: number, playerZ: number): void {
    const s = 3 + Math.random() * (WIND_REACH - 5);
    const radius = streamRadius(s);
    const lateral = (Math.random() * 2 - 1) * radius * 0.85;
    const wx = t.rx + t.ax * s - t.az * lateral;
    const wz = t.rz + t.az * s + t.ax * lateral;
    const sceneX = playerX + wrapDelta(wx - playerX);
    const sceneZ = -(playerZ + wrapDelta(wz - playerZ));
    const floor = groundY(sceneX, sceneZ);
    const speed = this.windFrom(t, wx, floor + 0.4, wz);
    if (speed < WIND_SPEED * 0.05) return;
    spawnWindDust(sceneX, floor, sceneZ, t.ax * speed, -t.az * speed, isSea(wx, wz));
  }

  private startStreak(owner: number): void {
    if (this.streakCount >= MAX_STREAKS) return;
    const i = this.streakCount++;
    const intake = Math.random() < INTAKE_STREAKS;
    this.streakOwner[i] = owner;
    this.streakIntake[i] = intake ? 1 : 0;
    this.streakS[i] = intake ? -INTAKE_REACH * (0.75 + Math.random() * 0.25) : 0.3 + Math.random() * 1.2;
    // Even over the disc's area, a little short of its edge.
    this.streakRho[i] = Math.sqrt(0.03 + Math.random() * 0.85);
    this.streakPhi[i] = Math.random() * Math.PI * 2;
    this.streakAge[i] = 0;
  }

  private endStreak(i: number): void {
    const last = --this.streakCount;
    if (i === last) return;
    this.streakOwner[i] = this.streakOwner[last];
    this.streakIntake[i] = this.streakIntake[last];
    this.streakS[i] = this.streakS[last];
    this.streakRho[i] = this.streakRho[last];
    this.streakPhi[i] = this.streakPhi[last];
    this.streakAge[i] = this.streakAge[last];
  }

  /** Tiles per frame a streak at `s` moves.  Never quite stalls. */
  private streakSpeed(s: number, intake: boolean, gust: number): number {
    return WIND_SPEED * gust * ((intake ? 0.12 : 0.2) + (intake ? 1 : 0.8) * axialSpeed(s));
  }

  /**
   * Speed of the wind one turbine makes at a world point, in tiles per
   * frame along that turbine's own bearing.  0 outside its streams.
   */
  private windFrom(t: TurbineInternal, wx: number, y: number, wz: number): number {
    const dx = wrapDelta(wx - t.rx);
    const dz = wrapDelta(wz - t.rz);
    const s = dx * t.ax + dz * t.az;
    if (s >= WIND_REACH || s <= -INTAKE_REACH) return 0;
    const dy = y - t.hubY;
    const across = dx * dx + dy * dy + dz * dz - s * s;
    const radius = streamRadius(s);
    if (across >= radius * radius) return 0;
    // Full strength through the middle of the stream, easing to nothing at
    // its edge.
    const k = Math.min(1, (1 - Math.sqrt(Math.max(0, across)) / radius) * 1.7);
    return WIND_SPEED * t.gust * axialSpeed(s) * k * k * (3 - 2 * k);
  }

  /**
   * Let the wind at the ship.  `position` and `velocity` are the ship's, in
   * scene space; the velocity is changed in place.  Returns how strongly
   * the ship is being blown (the object is reused - read it at once).
   */
  blow(position: THREE.Vector3, velocity: THREE.Vector3, tick: number): WindEffect {
    const wx = position.x;
    const wz = -position.z;
    let windX = 0;
    let windZ = 0;
    let strength = 0;
    for (const t of this.list) {
      if (
        Math.abs(wrapDelta(wx - t.site.x)) > WIND_REACH + 2 ||
        Math.abs(wrapDelta(wz - t.site.z)) > WIND_REACH + 2
      ) {
        continue;
      }
      const speed = this.windFrom(t, wx, position.y, wz);
      if (speed <= 0) continue;
      windX += t.ax * speed;
      windZ += t.az * speed;
      strength += speed / WIND_SPEED;
    }
    this.effect.strength = Math.min(1, strength);
    if (strength <= 0) return this.effect;
    strength = this.effect.strength;

    // Drag the ship toward the speed of the air around it.  (Scene Z is the
    // negated world Z.)  The wind blows level; it doesn't hold a ship up.
    velocity.x += GRIP * (windX - strength * velocity.x);
    velocity.z += GRIP * (-windZ - strength * velocity.z);

    // Rough air.  Smooth enough to fly through, uneven enough to feel.
    const knock = TURBULENCE * strength;
    velocity.x += knock * Math.sin(tick * 0.71) * Math.sin(tick * 0.23 + 1.3);
    velocity.y += knock * Math.sin(tick * 0.53 + 0.7) * Math.sin(tick * 0.19);
    velocity.z += knock * Math.sin(tick * 0.61 + 2.1) * Math.sin(tick * 0.29);
    return this.effect;
  }

  /**
   * Has the ship hit a turbine?  Takes where it is and where it was a frame
   * ago, in scene space, so that it can't pass through a rotor between
   * frames.
   */
  strikes(position: THREE.Vector3, previous: THREE.Vector3): boolean {
    const wx = position.x;
    const wz = -position.z;
    for (const t of this.list) {
      const fx = wrapDelta(wx - t.site.x);
      const fz = wrapDelta(wz - t.site.z);
      if (Math.abs(fx) > ROTOR_RADIUS + 3 || Math.abs(fz) > ROTOR_RADIUS + 3) continue;

      // Tower.
      const reach = TOWER_RADIUS + SHIP_RADIUS;
      if (position.y < t.hubY && fx * fx + fz * fz < reach * reach) return true;

      // Nacelle.
      const dy = position.y - t.hubY;
      const housing = NACELLE_RADIUS + SHIP_RADIUS;
      if (fx * fx + dy * dy + fz * fz < housing * housing) return true;

      // The disc the blades sweep.  Blades turn far too fast to slip
      // between, so all of it counts.
      const dx = wrapDelta(wx - t.rx);
      const dz = wrapDelta(wz - t.rz);
      const s = dx * t.ax + dz * t.az;
      // The same, a frame ago.  (Scene Z flips, so does its change.)
      const px = dx - (position.x - previous.x);
      const py = dy - (position.y - previous.y);
      const pz = dz + (position.z - previous.z);
      const before = px * t.ax + pz * t.az;
      const limit = ROTOR_RADIUS + SHIP_RADIUS * 0.6;
      let across = Infinity;
      if (Math.abs(s) < DISC_HALF_DEPTH) {
        across = dx * dx + dy * dy + dz * dz - s * s;
      } else if (s * before < 0) {
        // Went through the plane of the disc this frame: where?
        const f = before / (before - s);
        const cx = px + (dx - px) * f;
        const cy = py + (dy - py) * f;
        const cz = pz + (dz - pz) * f;
        across = cx * cx + cy * cy + cz * cz;
      }
      if (across < limit * limit) return true;
    }
    return false;
  }

  /** Is there turbine at this world point?  (For rounds: tower and nacelle.) */
  blocks(wx: number, y: number, wz: number): boolean {
    for (const t of this.list) {
      const fx = wrapDelta(wx - t.site.x);
      const fz = wrapDelta(wz - t.site.z);
      if (Math.abs(fx) > 1.5 || Math.abs(fz) > 1.5) continue;
      const flat = fx * fx + fz * fz;
      if (y > t.baseY - 1 && y < t.hubY && flat < 0.55 * 0.55) return true;
      const dy = y - t.hubY;
      if (flat + dy * dy < 0.85 * 0.85) return true;
    }
    return false;
  }

  /** Distance from world (x, z) to the nearest turbine, in tiles. */
  nearest(x: number, z: number): number {
    let nearest = Infinity;
    for (const t of this.list) {
      const d = Math.hypot(wrapDelta(t.site.x - x), wrapDelta(t.site.z - z));
      if (d < nearest) nearest = d;
    }
    return nearest;
  }

  /**
   * Place every turbine and streak for this rendered frame.  (playerX,
   * playerZ) is the ship in world coordinates; `backstep` is how far (0..1
   * of a fixed frame) the render lags the newest sim state.
   */
  render(playerX: number, playerZ: number, backstep: number, time: number): void {
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      const x = playerX + wrapDelta(t.site.x - playerX);
      const z = -(playerZ + wrapDelta(t.site.z - playerZ));
      // Rotation about Y by the bearing turns +X to face along the wind.
      yaw.setFromAxisAngle(UP, t.heading);

      this.towers.setMatrixAt(i, matrix.compose(place.set(x, t.baseY, z), NO_TURN, ONE));
      this.nacelles.setMatrixAt(i, matrix.compose(place.set(x, t.hubY, z), yaw, ONE));

      t.sceneX = x + t.ax * ROTOR_OFFSET;
      t.sceneZ = z - t.az * ROTOR_OFFSET;
      roll.setFromAxisAngle(AXIS, t.spin - t.spinRate * backstep);
      turn.multiplyQuaternions(yaw, roll);
      this.rotors.setMatrixAt(i, matrix.compose(place.set(t.sceneX, t.hubY, t.sceneZ), turn, ONE));

      this.beacons.setMatrixAt(
        i,
        matrix.compose(place.set(x - t.ax * 0.75, t.hubY + 0.47, z + t.az * 0.75), yaw, ONE),
      );
    }
    for (const mesh of [this.towers, this.nacelles, this.rotors, this.beacons]) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Two quick flashes, then dark, the way the real ones do it.
    const beat = time % 1.6;
    this.beaconMaterial.color.copy(beat < 0.1 || (beat > 0.24 && beat < 0.34) ? BEACON_LIT : BEACON_DARK);

    this.renderStreaks(backstep);
  }

  private renderStreaks(backstep: number): void {
    const { streakPosition: position, streakDir: dir, streakAlpha: alpha } = this;
    for (let i = 0; i < this.streakCount; i++) {
      const t = this.list[this.streakOwner[i]];
      const intake = this.streakIntake[i] === 1;
      const speed = this.streakSpeed(this.streakS[i], intake, t.gust);
      const s = this.streakS[i] - speed * backstep;
      const phi = this.streakPhi[i] - SWIRL * backstep;
      const length = speed * STREAK_STRETCH;

      // Fade in from nothing, and out toward wherever the streak ends.
      const fadeIn = Math.min(1, this.streakAge[i] / 14);
      const fadeOut = intake ? Math.min(1, -s / 1.6) : Math.min(1, (WIND_REACH - s) / 7);
      const level = fadeIn * Math.max(0, fadeOut) * (intake ? 0.45 : 0.7);

      // Tail, body, nose: three points along the streak's path.
      const v = i * 6;
      for (let k = 0; k < 3; k++) {
        const at = k === 0 ? -1 : k === 1 ? -0.22 : 0;
        const ps = s + at * length;
        const radius = streamRadius(ps) * this.streakRho[i];
        const angle = phi + at * STREAK_STRETCH * SWIRL;
        const lateral = Math.cos(angle) * radius;
        const x = t.sceneX + t.ax * ps - t.az * lateral;
        const y = t.hubY + Math.sin(angle) * radius;
        const z = t.sceneZ - t.az * ps - t.ax * lateral;
        for (let e = 0; e < 2; e++) {
          const o = (v + k * 2 + e) * 3;
          position[o] = x;
          position[o + 1] = y;
          position[o + 2] = z;
        }
        alpha[v + k * 2] = alpha[v + k * 2 + 1] = k === 1 ? level : 0;
      }
      // All six corners share the streak's direction: nose minus tail.
      const tail = v * 3;
      const nose = (v + 4) * 3;
      const dx = position[nose] - position[tail];
      const dy = position[nose + 1] - position[tail + 1];
      const dz = position[nose + 2] - position[tail + 2];
      for (let k = 0; k < 6; k++) {
        const o = (v + k) * 3;
        dir[o] = dx;
        dir[o + 1] = dy;
        dir[o + 2] = dz;
      }
    }

    this.streakGeometry.setDrawRange(0, this.streakCount * 12);
    // Only the live head of each buffer needs re-sending.  (Skip entirely
    // when empty: a zero-length range means "the whole array" to WebGL2.)
    if (this.streakCount === 0) return;
    const attributes = this.streakGeometry.attributes;
    for (const name of ['position', 'aDir', 'aAlpha'] as const) {
      const attribute = attributes[name] as THREE.BufferAttribute;
      attribute.addUpdateRange(0, this.streakCount * 6 * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
}
