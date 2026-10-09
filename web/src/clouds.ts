// Clouds.
//
// There is one layer of broken cumulus over the whole world, hanging well
// above where the ship normally flies.  Because the camera in Lander looks
// mostly down, you rarely look *at* that layer; you live with what it does:
//
//   * its shadows slide across the land and the sea (shadeWithClouds, and
//     the same function inside the water shader);
//   * the sea reflects it;
//   * climb high enough and you go up into it - the view mists over - and
//     out of the top, to look down on it from above (buildCloudLayer).
//
// (The banks of cloud on the horizon are a separate thing, painted into the
// sky dome in sky.ts: far weather that the ship can never reach.)
//
// Everything above is driven by a single 256x256 "weather map", one texel
// per tile, built once on the CPU and uploaded as a texture.  It repeats
// exactly with the world, so cloud and shadow wrap seamlessly along with
// everything else, and because shadows, reflections and the visible cloud
// all read the same map they always agree with one another.  The map never
// changes; the weather moves by sliding two channels of it across the world
// at different speeds, which makes the clouds drift and their edges boil.

import * as THREE from 'three';

import { FOG_COLOR, FOG_FAR, FOG_NEAR, SUN_LIGHT_DIR } from './env';
import { WORLD_SIZE } from './terrain';

// --- Tuning -----------------------------------------------------------------

/** Scene-space height of the bottom and top of the layer. */
export const CLOUD_BASE = 15;
export const CLOUD_TOP = 21.5;
/** Fraction of the way up at which the clouds are at their widest. */
const FULLEST = 0.3;
/** Height at which the layer is fullest: where shadows and reflections sample it. */
export const CLOUD_BELLY = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * FULLEST;

/**
 * Coverage thresholds.  The map's shape channel is equalised, so these read
 * directly as areas: cloud begins where the map exceeds COVER_LO (the top
 * 30% of the world) and is solid by COVER_HI (the top 13%).
 */
const COVER_LO = 0.7;
const COVER_HI = 0.87;
/** How far the fine channel eats into the edges of the big shapes. */
const EROSION = 0.3;
/** Share of direct sunlight a solid cloud takes away. */
const SHADOW_STRENGTH = 0.62;

/** Drift of the big shapes and of the fine detail, tiles per second. */
const WIND_SHAPE: readonly [number, number] = [1.1, 0.5];
const WIND_DETAIL: readonly [number, number] = [1.9, 0.15];

// --- The weather map --------------------------------------------------------

const N = WORLD_SIZE;

function latticeValue(ix: number, iz: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const z = ((iz % period) + period) % period;
  let h = Math.imul(x + seed * 131, 374761393) + Math.imul(z + seed * 17, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise with `cycles` cells across the world; tiles exactly. */
function valueNoise(x: number, z: number, cycles: number, seed: number): number {
  const fx = (x * cycles) / N;
  const fz = (z * cycles) / N;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = latticeValue(ix, iz, cycles, seed);
  const b = latticeValue(ix + 1, iz, cycles, seed);
  const c = latticeValue(ix, iz + 1, cycles, seed);
  const d = latticeValue(ix + 1, iz + 1, cycles, seed);
  return a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * tz;
}

function fractal(octaves: ReadonlyArray<number>, seed: number): Float32Array {
  const field = new Float32Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let sum = 0;
      let weight = 1;
      for (let o = 0; o < octaves.length; o++) {
        sum += valueNoise(x, z, octaves[o], seed + o) * weight;
        weight *= 0.5;
      }
      field[z * N + x] = sum;
    }
  }
  return field;
}

/** Remap a field so its values are spread evenly over [0, 1]. */
function equalise(field: Float32Array): void {
  const order = Array.from(field.keys()).sort((a, b) => field[a] - field[b]);
  for (let rank = 0; rank < order.length; rank++) field[order[rank]] = rank / (order.length - 1);
}

function normalise(field: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of field) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) / (hi - lo);
}

// Big shapes: cells of about 43, 21 and 11 tiles.  Fine detail: 8 and 4.
const shape = fractal([6, 12, 24], 3);
const detail = fractal([32, 64], 11);
equalise(shape);
normalise(detail);

function buildWeatherMap(): THREE.DataTexture {
  const data = new Uint8Array(N * N * 2);
  for (let i = 0; i < N * N; i++) {
    data[i * 2] = Math.round(shape[i] * 255);
    data[i * 2 + 1] = Math.round(detail[i] * 255);
  }
  const texture = new THREE.DataTexture(data, N, N, THREE.RGFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  // Reflections sample the map from a long way off; without mipmaps they
  // would sparkle.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Uniforms shared by every shader that reads the weather. */
export const cloudUniforms = {
  uClouds: { value: buildWeatherMap() },
  /** xy: offset of the shape channel, zw: of the detail channel, in tiles. */
  uCloudWind: { value: new THREE.Vector4() },
};

/** Move the weather on.  `time` is in seconds. */
export function updateClouds(time: number): void {
  cloudUniforms.uCloudWind.value.set(
    (WIND_SHAPE[0] * time) % N,
    (WIND_SHAPE[1] * time) % N,
    (WIND_DETAIL[0] * time) % N,
    (WIND_DETAIL[1] * time) % N,
  );
}

const g = (value: number): string => value.toFixed(5);

// Horizontal distance the sun's rays cover per unit of height: the amount
// by which a shadow is displaced from the cloud that casts it.
const SLANT_X = SUN_LIGHT_DIR.x / SUN_LIGHT_DIR.y;
const SLANT_Z = SUN_LIGHT_DIR.z / SUN_LIGHT_DIR.y;

/**
 * GLSL for reading the weather.  Needs the two uniforms above.
 *
 *   cloudCover(p)    raw coverage at scene (x, z); cloud forms where it is high
 *   cloudDensity(p)  0 (clear) .. 1 (solid) through the fullest part of the layer
 *   cloudShade(w)    fraction of direct sun reaching world point w
 */
export const CLOUD_GLSL = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec4 uCloudWind;

  float cloudCover(vec2 p) {
    float shape = texture2D(uClouds, (p + uCloudWind.xy) / ${g(N)}).r;
    float detail = texture2D(uClouds, (p + uCloudWind.zw) / ${g(N)}).g;
    return shape - (detail - 0.5) * ${g(EROSION)};
  }

  float cloudDensity(vec2 p) {
    return smoothstep(${g(COVER_LO)}, ${g(COVER_HI)}, cloudCover(p));
  }

  float cloudShade(vec3 world) {
    // Follow the sun's ray up from this point to where it crosses the layer.
    vec2 p = world.xz + vec2(${g(SLANT_X)}, ${g(SLANT_Z)}) * (${g(CLOUD_BELLY)} - world.y);
    return 1.0 - ${g(SHADOW_STRENGTH)} * cloudDensity(p);
  }
`;

// --- The same lookup on the CPU ---------------------------------------------

function sample(field: Float32Array, x: number, z: number): number {
  const fx = ((x % N) + N) % N;
  const fz = ((z % N) + N) % N;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const x1 = (ix + 1) & 255;
  const z1 = (iz + 1) & 255;
  const a = field[iz * N + ix];
  const b = field[iz * N + x1];
  const c = field[z1 * N + ix];
  const d = field[z1 * N + x1];
  return a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * tz;
}

/** cloudDensity() for scene point (x, z), as the shaders compute it. */
export function cloudDensityAt(x: number, z: number): number {
  const wind = cloudUniforms.uCloudWind.value;
  // Texel centres sit half a tile in from where the shader's UVs put them.
  const cover =
    sample(shape, x + wind.x - 0.5, z + wind.y - 0.5) -
    (sample(detail, x + wind.z - 0.5, z + wind.w - 0.5) - 0.5) * EROSION;
  return THREE.MathUtils.smoothstep(cover, COVER_LO, COVER_HI);
}

// --- Cloud shadow on lit materials ------------------------------------------

/**
 * Make a lit (Lambert) material take cloud shadow: its direct light is
 * scaled by cloudShade() at each pixel, leaving sky light and emission
 * alone.  Returns the same material.
 *
 * Note that Material.clone() does not carry shader patches across, so a
 * cloned material has to be passed through here again.
 */
export function shadeWithClouds<T extends THREE.Material>(material: T): T {
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.uniforms.uClouds = cloudUniforms.uClouds;
    shader.uniforms.uCloudWind = cloudUniforms.uCloudWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 cloudWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cloudWorld = instanceMatrix * cloudWorld;
        #endif
        vCloudWorld = (modelMatrix * cloudWorld).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCloudWorld;\n${CLOUD_GLSL}`)
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.directDiffuse *= cloudShade(vCloudWorld);`,
      );
  };
  // Three keys compiled programs on the patch function's source text, which
  // is identical for every material that comes through here; say what
  // actually differs.
  material.customProgramCacheKey = () => `${previousKey}|cloud-shadow`;
  return material;
}

// --- The layer itself -------------------------------------------------------

const SLICES = 12;
/** Opacity of one slice; a full stack of them comes to solid. */
const SLICE_ALPHA = 0.36;
const LAYER_SPAN = 300;
/** Vertical gap between slices, in tiles and as a fraction of the layer. */
const SLICE_GAP = (CLOUD_TOP - CLOUD_BASE) / (SLICES - 1);

// Each cloud is a flat-bottomed dome: the coverage a point needs before
// there is cloud at a given height is lowest at the belly, a little higher
// toward the base, and much higher toward the top - so only the densest
// cores of the map reach the full height.  (See coverNeeded() in the slice
// shader.)

const SLICE_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying float vViewDepth;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vViewDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SLICE_FRAGMENT = /* glsl */ `
  ${CLOUD_GLSL}
  uniform float uHeight;
  uniform float uFade;
  uniform vec3 uFog;
  varying vec3 vWorld;
  varying float vViewDepth;

  // Coverage needed for cloud to exist at height h (0 base .. 1 top); the
  // same profile as coverNeeded() below.
  float coverNeeded(float h) {
    if (h < ${g(FULLEST)}) {
      float t = (${g(FULLEST)} - h) / ${g(FULLEST)};
      return ${g(COVER_LO)} + 0.06 * t * t;
    }
    float t = (h - ${g(FULLEST)}) / ${g(1 - FULLEST)};
    return ${g(COVER_LO)} + ${g(COVER_HI + 0.07 - COVER_LO)} * pow(t, 1.35);
  }

  void main() {
    vec3 ray = normalize(vWorld - cameraPosition);
    // A slice seen nearly edge-on is a sheet, not a cloud: let it go.
    float steep = abs(ray.y);
    float facing = smoothstep(0.035, 0.16, steep);
    if (facing <= 0.0) discard;

    // A stack of flat slices seen at a slant shows as terraces.  So each
    // pixel samples not on its slice but at a random point along the view
    // ray within half a gap of it - trading the steps for a fine grain that
    // the eye reads as soft volume.
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    float lift = jitter * ${g(SLICE_GAP)};
    vec2 p = vWorld.xz + ray.xz * (lift / ray.y);
    float height = clamp(uHeight + lift / ${g(CLOUD_TOP - CLOUD_BASE)}, 0.0, 1.0);

    float cover = cloudCover(p);
    float need = coverNeeded(height);
    float body = smoothstep(need, need + 0.055, cover);
    if (body < 0.004) discard;

    // Is there less cloud between here and the sun than there is here?
    // Then this is a sunward face.
    float sunward = cloudCover(p + vec2(${g(SLANT_X)}, ${g(SLANT_Z)}) * 3.2);
    float lit = clamp(0.5 + (cover - sunward) * 7.0, 0.0, 1.0);
    // Tops catch the light; the belly sits in the cloud's own shade.
    lit *= 0.22 + 0.78 * height;

    vec3 shade = mix(vec3(0.085, 0.085, 0.190), vec3(0.270, 0.225, 0.400), height);
    vec3 glow = vec3(1.200, 0.690, 0.440);
    vec3 col = mix(shade, glow, lit);
    // Thin edges let the afterglow through.
    col += vec3(0.30, 0.13, 0.10) * (1.0 - body) * (0.4 + 0.6 * height);

    float fog = smoothstep(${g(FOG_NEAR)}, ${g(FOG_FAR)}, vViewDepth);
    col = mix(col, uFog, fog);

    float range = length(cameraPosition.xz - vWorld.xz);
    float alpha = body * ${g(SLICE_ALPHA)} * uFade * facing
      * (1.0 - smoothstep(105.0, 148.0, range));
    gl_FragColor = vec4(col, alpha);
  }
`;

export interface CloudLayer {
  group: THREE.Group;
  /**
   * Place the layer for this frame.  Only slices below the camera are
   * drawn: the view never tilts far enough up to see the underside of one
   * as anything but an edge-on line.
   */
  update(camera: THREE.Vector3): void;
}

/**
 * The cloud you can see: the layer drawn as a stack of horizontal slices,
 * each showing the map wherever coverage clears that height's threshold.
 * Looked down on, the slices fuse into soft domed cumulus.
 */
export function buildCloudLayer(): CloudLayer {
  const group = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(LAYER_SPAN, LAYER_SPAN);
  geometry.rotateX(-Math.PI / 2);

  const slices = Array.from({ length: SLICES }, (_, k) => {
    const height = k / (SLICES - 1);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...cloudUniforms,
        uHeight: { value: height },
        uFade: { value: 0 },
        uFog: { value: FOG_COLOR },
      },
      vertexShader: SLICE_VERTEX,
      fragmentShader: SLICE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * height;
    // Seen from above, so drawn bottom-up: each slice over the ones below.
    mesh.renderOrder = 6 + k * 0.01;
    mesh.visible = false;
    group.add(mesh);
    return { mesh, material };
  });

  return {
    group,
    update(camera) {
      for (const { mesh, material } of slices) {
        // Fade a slice out as the camera comes down through it, so passing
        // through the layer never pops.
        const above = camera.y - mesh.position.y;
        const fade = THREE.MathUtils.smoothstep(above, 0.15, 1.4);
        mesh.visible = fade > 0;
        if (!mesh.visible) continue;
        material.uniforms.uFade.value = fade;
        mesh.position.x = camera.x;
        mesh.position.z = camera.z;
      }
    },
  };
}

/**
 * How deep in cloud a viewpoint is, 0..1: zero outside the layer, rising to
 * the cloud density at that spot once properly inside it.
 */
export function cloudImmersion(position: THREE.Vector3): number {
  const inside =
    THREE.MathUtils.smoothstep(position.y, CLOUD_BASE - 0.5, CLOUD_BASE + 1.5) *
    (1 - THREE.MathUtils.smoothstep(position.y, CLOUD_TOP - 1.5, CLOUD_TOP + 0.5));
  if (inside <= 0) return 0;
  return inside * cloudDensityAt(position.x, position.z);
}
