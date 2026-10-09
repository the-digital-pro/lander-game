// The sea.
//
// In the original the sea was just terrain clamped flat at SEA_LEVEL and
// painted a single blue.  Here the terrain mesh runs on down as real seabed
// and this lays a moving, translucent surface over it.
//
// The surface is real geometry, not a flat sheet with a moving texture.  A
// grid of vertices is displaced every frame by a sum of Gerstner
// (trochoidal) waves - the classic model of a deep-water swell, in which
// each point of water travels in a circle so that crests come out sharp and
// troughs broad.  Nine of them, with wavelengths from about 14 tiles down
// to 2 and speeds from the deep-water dispersion relation (long waves
// outrun short ones), make a sea that never visibly repeats.
//
// Three things tie that swell to this particular world:
//
//   * Every wave vector is a whole number of cycles per 256 tiles, so the
//     sea is exactly periodic over the map and nothing jumps when the world
//     wraps under the ship.
//   * Depth below the surface comes from a 256x256 texture of the landscape
//     (which repeats exactly, like the world itself).  The swell is damped
//     as the water shoals, so it laps at a beach rather than standing
//     through it, and depth also drives the colour, the transparency and
//     the caustics on the shallow bottom.
//   * A separate set of breakers runs along the depth contours - so always
//     parallel to whatever shore is nearest - rolling in, whitening as the
//     water shallows, and leaving foam behind them.
//   * The same texture carries how *open* the water is at each point: a
//     blurred measure of how much sea surrounds it.  Swell and surf need
//     room to build, so an inland pond or a narrow inlet stays nearly calm
//     while the open sea rolls.
//
// Shading is worked out per pixel from the same wave equations (plus a few
// shorter ripples too fine to be worth vertices), so the lighting is smooth
// however coarse the mesh: Fresnel reflection of the dusk sky, the sun's
// glitter path, light glowing through the backs of crests, and whitecaps
// where the swell pinches up.  The cloud layer (clouds.ts) shows up twice:
// its shadows dull the water they fall on, and its underside is mirrored in
// the surface wherever that is calm enough to hold a reflection.
//
// The waves are visual.  For collisions the sea is still the flat plane at
// SEA_LEVEL that the original used - the mean level of this surface.

import * as THREE from 'three';

import { CLOUD_BELLY, CLOUD_GLSL, cloudUniforms } from './clouds';
import { SEA_LEVEL } from './constants';
import { FOG_COLOR, FOG_FAR, FOG_NEAR, SKY_GLSL, SUN_SKY_DIR, timeUniform } from './env';
import { cornerHeight, WORLD_SIZE } from './terrain';

// ---------------------------------------------------------------------------
// The swell.
// ---------------------------------------------------------------------------

interface WaveSpec {
  /** Whole cycles across the world along scene X and Z: sets length and heading. */
  m: number;
  n: number;
  /** Wave steepness (amplitude x wavenumber).  The sum must stay well below 1. */
  steepness: number;
  /** Phase offset, radians. */
  phase: number;
}

// Mostly running south-east - toward the camera and across it, so the low
// sun catches the backs of the crests - with one crossing swell so the sea
// isn't a single marching rank.
const SWELL: ReadonlyArray<WaveSpec> = [
  { m: 11, n: 15, steepness: 0.075, phase: 0.0 },
  { m: 19, n: 10, steepness: 0.06, phase: 1.7 },
  { m: -9, n: 21, steepness: 0.04, phase: 4.1 },
  { m: 22, n: 31, steepness: 0.07, phase: 2.6 },
  { m: 37, n: 17, steepness: 0.06, phase: 5.3 },
  { m: 30, n: 52, steepness: 0.06, phase: 0.9 },
  { m: 70, n: 37, steepness: 0.055, phase: 3.4 },
  { m: 58, n: 85, steepness: 0.05, phase: 6.0 },
  { m: 104, n: 41, steepness: 0.045, phase: 2.1 },
];

/** Too short to be worth vertices: these only ever perturb the shading. */
const RIPPLES: ReadonlyArray<WaveSpec> = [
  { m: 139, n: 96, steepness: 0.05, phase: 1.1 },
  { m: 88, n: 181, steepness: 0.045, phase: 3.9 },
  { m: -120, n: 160, steepness: 0.04, phase: 5.6 },
  { m: 251, n: 78, steepness: 0.04, phase: 0.4 },
  { m: 150, n: 290, steepness: 0.035, phase: 2.9 },
];

/**
 * "Gravity" for the dispersion relation, in tiles/s^2.  Chosen for the look:
 * it gives the longest swell a period of about 6.5 seconds.
 */
const GRAVITY = 2.0;
/** How far each wave's circular motion sharpens its crest (0 = pure sine). */
const PINCH = 0.85;
/** Overall wave height multiplier. */
const SEA_STATE = 1.0;
/** Height of the breakers that roll in along the shore, tiles. */
const BREAKER_HEIGHT = 0.085;

interface Wave {
  kx: number;
  kz: number;
  k: number;
  dx: number;
  dz: number;
  amplitude: number;
  omega: number;
  wavelength: number;
  phase: number;
}

function resolve(spec: WaveSpec): Wave {
  const unit = (2 * Math.PI) / WORLD_SIZE;
  const kx = spec.m * unit;
  const kz = spec.n * unit;
  const k = Math.hypot(kx, kz);
  return {
    kx,
    kz,
    k,
    dx: kx / k,
    dz: kz / k,
    amplitude: spec.steepness / k,
    // Deep water: omega^2 = g k.
    omega: Math.sqrt(GRAVITY * k),
    wavelength: (2 * Math.PI) / k,
    phase: spec.phase,
  };
}

const swell = SWELL.map(resolve);
const ripples = RIPPLES.map(resolve);

/** Tallest the swell can stack up, for normalising crest height in the shader. */
const CREST_HEIGHT = swell.reduce((sum, w) => sum + w.amplitude, 0) * SEA_STATE;

const f = (value: number): string => value.toFixed(6);

/**
 * GLSL to displace one vertex by one wave.  Short waves are faded out with
 * distance, before the mesh gets too coarse out there to carry them.
 */
function displaceTerm(w: Wave): string {
  return /* glsl */ `{
    float ph = dot(vec2(${f(w.kx)}, ${f(w.kz)}), base) - ${f(w.omega)} * uTime + ${f(w.phase)};
    float a = ${f(w.amplitude)} * calm * (1.0 - smoothstep(${f(w.wavelength * 9)}, ${f(w.wavelength * 16)}, range));
    disp.y += a * sin(ph);
    disp.xz += (${f(PINCH)} * a * cos(ph)) * vec2(${f(w.dx)}, ${f(w.dz)});
  }`;
}

/**
 * GLSL to accumulate one wave's contribution to the surface slope, pinch
 * and height at a pixel.  Faded with distance once it would be finer than
 * the pixels that have to show it.
 */
function shadeTerm(w: Wave): string {
  return /* glsl */ `{
    float ph = dot(vec2(${f(w.kx)}, ${f(w.kz)}), base) - ${f(w.omega)} * uTime + ${f(w.phase)};
    float a = ${f(w.amplitude)} * calm * (1.0 - smoothstep(${f(w.wavelength * 35)}, ${f(w.wavelength * 70)}, range));
    float c = cos(ph);
    float s = sin(ph);
    slope += (a * c) * vec2(${f(w.kx)}, ${f(w.kz)});
    pinch += a * ${f(w.k)} * s;
    height += a * s;
  }`;
}

// ---------------------------------------------------------------------------
// The sea chart: depth and openness, one texel per tile corner.
// ---------------------------------------------------------------------------

/** Depth range packed into the 8-bit texture: [-DRY, WET] tiles. */
const DEPTH_DRY = 1.0;
const DEPTH_WET = 2.4;
/** Radius, in tiles, over which the surrounding sea is averaged for openness. */
const FETCH_RADIUS = 8;

/** One wrap-around box blur along each axis. */
function boxBlur(source: Float32Array, radius: number): Float32Array {
  const n = WORLD_SIZE;
  const span = radius * 2 + 1;
  const pass = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += source[z * n + ((x + d) & 255)];
      pass[z * n + x] = sum / span;
    }
  }
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += pass[((z + d) & 255) * n + x];
      out[z * n + x] = sum / span;
    }
  }
  return out;
}

function buildSeaChart(): THREE.DataTexture {
  const n = WORLD_SIZE;
  const wet = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      wet[iz * n + ix] = cornerHeight(ix, iz) - SEA_LEVEL > 0.25 ? 1 : 0;
    }
  }
  // Blurred twice: close enough to a Gaussian that coastlines read as soft
  // gradients of shelter rather than boxes.
  const around = boxBlur(boxBlur(wet, FETCH_RADIUS), FETCH_RADIUS);

  const data = new Uint8Array(n * n * 2);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const depth = cornerHeight(ix, iz) - SEA_LEVEL; // > 0 under water
      const packed = (depth + DEPTH_DRY) / (DEPTH_DRY + DEPTH_WET);
      data[i * 2] = Math.round(Math.min(1, Math.max(0, packed)) * 255);
      // A straight open coast is half surrounded by sea and should count as
      // fully open; a pond a few tiles across should count as closed.
      const open = Math.min(1, Math.max(0, (around[i] - 0.12) / 0.38));
      data[i * 2 + 1] = Math.round(open * open * (3 - 2 * open) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Shaders.
// ---------------------------------------------------------------------------

/** Shared by both stages: depth lookup, tiling noise, and the breakers. */
const COMMON = /* glsl */ `
  uniform sampler2D uSeabed;
  uniform float uTime;
  uniform float uSeaState;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Value noise on a lattice that repeats every 'period' cells, so any
  // pattern built from it is seamless across the world wrap.
  float tileNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    vec2 j = mod(i + 1.0, period);
    i = mod(i, period);
    return mix(
      mix(hash12(i), hash12(vec2(j.x, i.y)), t.x),
      mix(hash12(vec2(i.x, j.y)), hash12(j), t.x),
      t.y
    );
  }

  // The sea chart at a point.  x: depth of the seabed below the mean
  // surface, in tiles (negative on land).  y: openness, 0 in a pond to 1
  // on the open sea.
  vec2 seaChart(vec2 base) {
    // Scene Z runs backwards from world Z.  Texel (i, j) holds the value
    // at tile corner (i, j), hence the half-texel shift.
    vec2 packed = texture2D(uSeabed, (vec2(base.x, -base.y) + 0.5) / ${f(WORLD_SIZE)}).rg;
    return vec2(packed.x * ${f(DEPTH_DRY + DEPTH_WET)} - ${f(DEPTH_DRY)}, packed.y);
  }

  // How much of the open-sea swell survives at this depth: full in deep
  // water, a fifth at the waterline, none up the beach.
  float shoreCalm(float depth) {
    return smoothstep(-0.4, 0.0, depth) * mix(0.2, 1.0, smoothstep(0.1, 1.7, depth));
  }

  // Breakers.  Their phase is a function of depth, so crests lie along the
  // depth contours and advance toward shallower water; a little
  // low-frequency noise stops them arriving as perfect rings.
  float breakerPhase(vec2 base, float depth) {
    return depth * 5.5 + uTime * 1.15 + 2.4 * tileNoise(base * 0.125, 32.0);
  }
  float breakerCrest(float phase) {
    float c = 0.5 + 0.5 * sin(phase);
    c *= c;
    return c * c;
  }
  // Where breakers exist at all: from about 1.7 tiles deep in to the shore.
  float breakerBand(float depth) {
    return smoothstep(1.7, 0.6, depth) * smoothstep(-0.05, 0.15, depth);
  }
`;

const VERTEX_SHADER = /* glsl */ `
  ${COMMON}
  varying vec3 vWorld;
  varying vec2 vBase;
  varying float vViewDepth;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 base = world.xz;
    vec2 chart = seaChart(base);
    float depth = chart.x;
    float open = chart.y;
    float range = distance(world.xyz, cameraPosition);
    float calm = shoreCalm(depth) * mix(0.08, 1.0, open) * uSeaState;

    vec3 disp = vec3(0.0);
    ${swell.map(displaceTerm).join('\n')}
    disp.y += ${f(BREAKER_HEIGHT)} * open
      * breakerCrest(breakerPhase(base, depth)) * breakerBand(depth);

    world.xyz += disp;
    vBase = base;
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${COMMON}
  uniform vec3 uSunDir;
  uniform vec3 uFog;
  varying vec3 vWorld;
  varying vec2 vBase;
  varying float vViewDepth;

  ${SKY_GLSL}
  ${CLOUD_GLSL}

  // Three octaves of drifting noise: the broken, streaky texture of foam.
  float foamGrain(vec2 p) {
    vec2 drift = vec2(uTime * 0.06, uTime * 0.045);
    return tileNoise(p + drift, 256.0) * 0.5
      + tileNoise(p * 3.0 - drift * 2.0, 768.0) * 0.3
      + tileNoise(p * 8.0 + drift * 3.0, 2048.0) * 0.2;
  }

  // Fine chop: the surface slope of two octaves of drifting noise.  Sines
  // alone give faces so smooth that the sky reflects off them in tidy
  // rings; this breaks those up into glitter.
  vec2 chop(vec2 p) {
    const float e = 0.05;
    vec2 d1 = vec2(uTime * 0.35, uTime * 0.22);
    float n = tileNoise(p * 4.0 + d1, 1024.0);
    vec2 g = vec2(
      tileNoise((p + vec2(e, 0.0)) * 4.0 + d1, 1024.0) - n,
      tileNoise((p + vec2(0.0, e)) * 4.0 + d1, 1024.0) - n
    );
    vec2 d2 = vec2(-uTime * 0.5, uTime * 0.41);
    n = tileNoise(p * 11.0 + d2, 2816.0);
    g += 0.45 * vec2(
      tileNoise((p + vec2(e, 0.0)) * 11.0 + d2, 2816.0) - n,
      tileNoise((p + vec2(0.0, e)) * 11.0 + d2, 2816.0) - n
    );
    return g / e;
  }

  // Caustics: a slowly writhing net of bright lines, from the ridges of
  // two warped noise fields.
  float caustics(vec2 p) {
    vec2 warp = vec2(
      tileNoise(p * 2.0 + uTime * 0.21, 512.0),
      tileNoise(p * 2.0 - uTime * 0.17 + 37.0, 512.0)
    ) - 0.5;
    float a = tileNoise(p * 3.0 + warp * 1.6 + uTime * 0.11, 768.0);
    float b = tileNoise(p * 5.0 - warp * 1.2 - uTime * 0.13, 1280.0);
    float ridgeA = 1.0 - abs(2.0 * a - 1.0);
    float ridgeB = 1.0 - abs(2.0 * b - 1.0);
    return pow(ridgeA, 5.0) * 0.7 + pow(ridgeB, 6.0) * 0.5;
  }

  void main() {
    vec2 base = vBase;
    vec2 chart = seaChart(base);
    float depth = chart.x;
    float open = chart.y;
    float range = length(cameraPosition - vWorld);
    // How much water is over the bottom here, right now: the still depth
    // plus however far the surface has been lifted or dropped.
    float column = vWorld.y - (${f(-SEA_LEVEL)}) + depth;

    // Rebuild the surface at this pixel from the wave equations: its slope
    // (for the normal), how hard it is pinching (for whitecaps) and its
    // height (for light through the crests).
    vec2 slope = vec2(0.0);
    float pinch = 0.0;
    float height = 0.0;
    float calm = shoreCalm(depth) * mix(0.08, 1.0, open) * uSeaState;
    ${swell.map(shadeTerm).join('\n')}
    // Ripples need far less room than swell: sheltered water still ruffles.
    calm = mix(0.4, 1.0, smoothstep(0.0, 1.0, depth)) * mix(0.5, 1.0, open) * uSeaState;
    ${ripples.map(shadeTerm).join('\n')}
    // (The noise-based terms below are each skipped where they could not
    // show: most of the sea is open water a long way off.)
    if (range < 44.0) {
      slope += chop(base) * 0.017 * calm * (1.0 - smoothstep(16.0, 44.0, range));
    }

    vec3 n = normalize(vec3(-slope.x, 1.0 - ${f(PINCH)} * pinch, -slope.y));
    vec3 view = normalize(cameraPosition - vWorld);

    // --- Reflection: the dusk sky, by Fresnel. ---
    float facing = clamp(dot(n, view), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    vec3 r = reflect(-view, n);
    r.y = abs(r.y) + 0.02; // a ray bounced below the horizon would hit more sea
    r = normalize(r);
    vec3 sky = skyGlow(r, uSunDir);
    sky = mix(uFog, sky, smoothstep(-0.012, 0.075, r.y));

    // The cloud layer overhead, mirrored.  Traced off the water's mean
    // plane rather than its ripples: a ripple swings the ray across dozens
    // of tiles of sky, which would scatter the image into noise where the
    // eye expects a soft, steady reflection.  Its underside is slate,
    // warming where it faces the afterglow.
    vec3 mirror = normalize(vec3(-view.x, max(view.y, 0.04), -view.z) + vec3(n.x, 0.0, n.z) * 0.25);
    float reach = (${f(CLOUD_BELLY)} - vWorld.y) / mirror.y;
    float overhead = cloudDensity(vWorld.xz + mirror.xz * reach)
      * (1.0 - smoothstep(70.0, 220.0, reach));
    float warm = max(dot(normalize(mirror.xz + vec2(1e-5)), normalize(uSunDir.xz)), 0.0);
    sky = mix(sky, mix(vec3(0.115, 0.105, 0.215), vec3(0.80, 0.42, 0.30), warm * warm), overhead * 0.6);

    // How much direct sun is getting through the clouds to this spot.
    float sunlight = cloudShade(vWorld);

    // The sun itself: a tight core for sparkle inside a soft path.
    float toSun = max(dot(r, uSunDir), 0.0);
    vec3 glitter = vec3(3.2, 2.2, 1.3) * (pow(toSun, 900.0) * 3.2 + pow(toSun, 70.0) * 0.1);
    glitter *= (0.25 + 0.75 * fresnel) * sunlight;

    // --- The water itself. ---
    float deep = smoothstep(0.0, 1.9, depth);
    vec3 body = mix(vec3(0.045, 0.340, 0.360), vec3(0.005, 0.045, 0.135), deep);
    // Shade it from a sun lifted off the horizon, so the swell has form.
    vec3 key = normalize(vec3(uSunDir.x, 0.55, uSunDir.z));
    float lit = max(dot(n, key), 0.0) * sunlight;
    body *= 0.5 + 0.6 * lit;

    // Looking sunward, light comes through the thin backs of the crests.
    float sunward = pow(max(dot(normalize(-view.xz + vec2(1e-5)), normalize(uSunDir.xz)), 0.0), 3.0);
    float crest = smoothstep(0.0, ${f(CREST_HEIGHT * 0.55)}, height);
    body += vec3(0.02, 0.24, 0.19) * sunward * crest * (0.35 + 0.65 * deep) * sunlight;

    // Light focused onto the bottom, where it is shallow enough to see.
    float shallows = smoothstep(1.4, 0.2, depth) * smoothstep(-0.02, 0.12, depth);
    if (shallows > 0.001) {
      body += vec3(0.30, 0.42, 0.36) * caustics(base) * shallows * 0.5 * sunlight;
    }

    vec3 col = mix(body, sky, fresnel);

    // --- Foam. ---
    // Whitecaps, where the swell pinches up sharply.
    float capEdge = smoothstep(0.80, 0.60, 1.0 - ${f(PINCH)} * pinch);
    float foam = 0.0;
    if (capEdge > 0.0 || depth < 1.75) {
      float grain = foamGrain(base);
      foam = capEdge * smoothstep(0.35, 0.65, grain);
      if (depth < 1.75) {
        // Surf: the breaker's crest, whitening as the water shoals...
        float phase = breakerPhase(base, depth);
        float surf = breakerCrest(phase) * breakerBand(depth) * smoothstep(1.2, 0.3, depth);
        // ...the spent foam it drags behind it...
        float trail = (0.5 + 0.5 * sin(phase - 1.3))
          * smoothstep(0.75, 0.05, depth) * smoothstep(-0.05, 0.05, depth);
        // ...and the froth on the leading edge of the water as it runs up
        // the sand and drains back.  Keyed to the water actually there this
        // instant, so it follows the moving waterline on any slope.
        float swash = smoothstep(0.2, 0.04, column);
        foam += open * (surf * (0.5 + 0.9 * grain) + trail * smoothstep(0.3, 0.7, grain) * 0.8)
          + swash * mix(0.2, 1.0, open) * (0.3 + 0.7 * smoothstep(0.25, 0.7, grain));
      }
      foam = clamp(foam, 0.0, 1.0);
    }

    // Foam is lit by the same low warm sun; kept under white so it never
    // blooms like a light source.
    vec3 foamColour = mix(vec3(0.46, 0.50, 0.66), vec3(0.98, 0.84, 0.72), 0.3 + 0.7 * lit);
    col += glitter * (1.0 - foam);
    col = mix(col, foamColour, foam);

    // See-through where the water is thin, opaque where it is deep, where
    // it is reflecting, and where it is foam.
    float alpha = mix(0.4, 0.95, smoothstep(0.0, 1.3, column));
    alpha = max(alpha, fresnel);
    alpha = max(alpha, foam * 0.92);
    alpha = min(1.0, alpha + dot(glitter, vec3(0.3)));
    // The very edge thins away to nothing rather than ending in a hard line
    // where the surface happens to cut the sand.
    alpha *= smoothstep(0.0, 0.06, column);

    float fog = smoothstep(${f(FOG_NEAR)}, ${f(FOG_FAR)}, vViewDepth);
    col = mix(col, uFog, fog);
    alpha = mix(alpha, 1.0, fog);

    gl_FragColor = vec4(col, alpha);
  }
`;

// ---------------------------------------------------------------------------
// Mesh.
// ---------------------------------------------------------------------------

/** Vertex spacing by distance from the ship: [from, to, step], in tiles. */
type Span = readonly [from: number, to: number, step: number];

// Dense around the ship, where waves are big on screen, and thinning out
// toward the haze.  Deeper ahead (-Z) than behind: the camera only ever
// looks north.
const SPANS_X: ReadonlyArray<Span> = [
  [-132, -68, 2],
  [-68, -36, 1],
  [-36, 36, 0.5],
  [36, 68, 1],
  [68, 132, 2],
];
const SPANS_Z: ReadonlyArray<Span> = [
  [-116, -76, 2],
  [-76, -44, 1],
  [-44, 28, 0.5],
  [28, 52, 1],
];
/**
 * The mesh moves in steps of the coarsest spacing.  Every vertex then
 * always lands on the same world lattice, and since the waves are a
 * function of world position, the surface doesn't shimmer as the mesh
 * slides under it.
 */
const SNAP = 2;

function axis(spans: ReadonlyArray<Span>): number[] {
  const points: number[] = [spans[0][0]];
  for (const [from, to, step] of spans) {
    for (let v = from + step; v <= to + 1e-6; v += step) points.push(v);
  }
  return points;
}

function buildGrid(): THREE.BufferGeometry {
  const xs = axis(SPANS_X);
  const zs = axis(SPANS_Z);
  const positions = new Float32Array(xs.length * zs.length * 3);
  let p = 0;
  for (const z of zs) {
    for (const x of xs) {
      positions[p++] = x;
      positions[p++] = 0;
      positions[p++] = z;
    }
  }
  const index = new Uint32Array((xs.length - 1) * (zs.length - 1) * 6);
  let i = 0;
  for (let j = 0; j < zs.length - 1; j++) {
    for (let k = 0; k < xs.length - 1; k++) {
      const a = j * xs.length + k;
      const b = a + 1;
      const c = a + xs.length;
      const d = c + 1;
      // Wound to face up.
      index[i++] = a; index[i++] = c; index[i++] = b;
      index[i++] = b; index[i++] = c; index[i++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

export function buildWater(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...cloudUniforms,
      uSeabed: { value: buildSeaChart() },
      uTime: timeUniform,
      uSeaState: { value: SEA_STATE },
      uSunDir: { value: SUN_SKY_DIR },
      uFog: { value: FOG_COLOR },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });
  const water = new THREE.Mesh(buildGrid(), material);
  water.position.y = -SEA_LEVEL;
  water.renderOrder = 1;
  // Vertices are displaced in the shader, so the geometry's own bounds
  // say nothing useful about where it will be drawn.
  water.frustumCulled = false;
  return water;
}

/** Keep the sea under the ship.  (x, z) is the ship in scene coordinates. */
export function followWater(water: THREE.Mesh, x: number, z: number): void {
  water.position.x = Math.round(x / SNAP) * SNAP;
  water.position.z = Math.round(z / SNAP) * SNAP;
}
