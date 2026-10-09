// Sky dome.
//
// The original drew nothing above the horizon: a black screen with the
// landscape floating in it.  This keeps that sense of a small world under a
// big dark sky, but paints it - a late-dusk gradient that is nearly black
// overhead, a band of afterglow where the sun has just gone, stars, a ringed
// neighbour hanging over the northern horizon, and banks of cloud along the
// horizon catching the last of the light.
//
// Those banks are far weather - painted, in compass-and-elevation space,
// and out of reach - as distinct from the layer of cloud over the map
// itself, which is real and lives in clouds.ts.
//
// It is one inside-out sphere, centred on the camera every frame.  It is
// pinned to the far plane and drawn after everything solid, so the shader
// only runs for the strip of sky that is actually in view rather than for
// the whole screen.  The horizon line resolves to exactly the fog colour,
// which is what lets distant terrain dissolve into it without a seam.

import * as THREE from 'three';

import { FOG_COLOR, SKY_GLSL, SUN_SKY_DIR, timeUniform } from './env';

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // z = w puts every vertex exactly on the far plane.
    gl_Position = (projectionMatrix * modelViewMatrix * vec4(position, 1.0)).xyww;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uFog;
  uniform float uTime;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Value noise that repeats every 'period' cells in x: wrapped round the
  // compass it has no seam.
  float ringNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 t = fract(p);
    t = t * t * (3.0 - 2.0 * t);
    float x0 = mod(i.x, period);
    float x1 = mod(i.x + 1.0, period);
    return mix(
      mix(hash12(vec2(x0, i.y)), hash12(vec2(x1, i.y)), t.x),
      mix(hash12(vec2(x0, i.y + 1.0)), hash12(vec2(x1, i.y + 1.0)), t.x),
      t.y
    );
  }

  // Cloud-bank density at q = (compass cells, height cells).
  float bank(vec2 q) {
    return ringNoise(q, 48.0) * 0.55
      + ringNoise(q * 2.0 + 17.0, 96.0) * 0.28
      + ringNoise(q * 4.0 + 5.0, 192.0) * 0.17;
  }

  ${SKY_GLSL}

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Gradient and glow (shared with the sea's reflection), then the sun
    // itself: a soft disc sitting on the horizon.
    vec3 col = skyGlow(d, uSunDir);
    float sd = max(dot(d, uSunDir), 0.0);
    col += vec3(3.0, 2.1, 1.3) * smoothstep(0.99955, 0.99985, sd);

    // Stars, fading in above the glow and twinkling a little.
    vec3 cell = floor(d * 190.0);
    float seed = hash13(cell);
    vec3 local = fract(d * 190.0) - 0.5;
    float star = step(0.9955, seed) * smoothstep(0.42, 0.0, length(local));
    float twinkle = 0.65 + 0.35 * sin(uTime * (1.5 + seed * 4.0) + seed * 60.0);
    col += vec3(0.9, 0.95, 1.2) * star * twinkle * smoothstep(0.05, 0.3, h) * 2.2;

    // The neighbour: a banded gas giant low in the north-east, lit from the
    // sun's side, with a tilted ring.  Hazed back toward the sky colour so
    // it sits far behind the atmosphere rather than on top of it.
    vec3 pc = normalize(vec3(0.2, 0.1, -0.97));
    vec3 pr = normalize(cross(vec3(0.0, 1.0, 0.0), pc));
    vec3 pu = cross(pc, pr);
    float radius = 0.082;
    vec2 q = vec2(dot(d, pr), dot(d, pu)) / radius;
    if (dot(d, pc) > 0.0) {
      float r2 = dot(q, q);
      // Ring, tilted and foreshortened.
      float tilt = -0.42;
      vec2 rq = vec2(q.x * cos(tilt) - q.y * sin(tilt), q.x * sin(tilt) + q.y * cos(tilt));
      float ringR = length(vec2(rq.x, rq.y / 0.24));
      float ring = smoothstep(1.36, 1.44, ringR) * smoothstep(2.2, 2.1, ringR);
      ring *= 0.55 + 0.45 * sin(ringR * 38.0);
      bool behind = rq.y > 0.0 && r2 < 1.0;
      vec3 haze = col;
      if (r2 < 1.0) {
        vec3 n = vec3(q, sqrt(1.0 - r2));
        vec3 lightDir = normalize(vec3(-0.75, 0.25, 0.5));
        float lit = smoothstep(-0.15, 0.6, dot(n, lightDir));
        float bands = 0.82 + 0.18 * sin(q.y * 15.0 + sin(q.x * 3.0) * 0.6);
        vec3 surface = mix(vec3(0.42, 0.32, 0.42), vec3(0.74, 0.56, 0.5), bands) * (0.06 + lit);
        float edge = smoothstep(1.0, 0.94, r2);
        col = mix(col, mix(haze, surface, 0.72), edge);
      }
      if (!behind) {
        col = mix(col, mix(haze, vec3(0.8, 0.64, 0.58), 0.6), ring * 0.7);
      }
    }

    // Cloud banks along the horizon, in front of all of the above.  Worked
    // in compass-and-elevation space: 48 cells round the horizon, squashed
    // so the clouds come out several times wider than they are tall.
    float rise = d.y / max(length(d.xz), 1e-4); // tan(elevation)
    if (rise > -0.03 && rise < 0.45) {
      float compass = atan(d.x, -d.z) / 6.28318530718 + 0.5;
      vec2 q = vec2(compass * 48.0 + uTime * 0.012, rise * 20.0);
      float n = bank(q);
      // Thick on the horizon, thinning out with height.
      float need = 0.47 + rise * 1.6;
      float cloud = smoothstep(need, need + 0.13, n);

      // Light them from where the sun is: a point is on a sunward face if
      // there is less cloud a little way toward the sun than there is here.
      float sunCompass = atan(uSunDir.x, -uSunDir.z) / 6.28318530718 + 0.5;
      float sunRise = uSunDir.y / length(uSunDir.xz);
      vec2 toSun = vec2((sunCompass - compass) * 48.0, (sunRise - rise) * 20.0);
      toSun /= max(length(toSun), 1e-3);
      float lit = clamp(0.5 + (n - bank(q + toSun * 0.4)) * 3.2, 0.0, 1.0);

      // Gold near the sun, rose further round, slate in their own shade.
      float near = max(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)), 0.0);
      near *= near;
      vec3 shade = mix(vec3(0.085, 0.075, 0.165), vec3(0.230, 0.120, 0.190), near);
      vec3 glow = mix(vec3(0.520, 0.300, 0.400), vec3(1.550, 0.720, 0.300), near);
      vec3 cloudColour = mix(shade, glow, lit);
      // Silver lining: thin cloud right across the sun burns.
      cloudColour += vec3(1.8, 1.0, 0.5) * pow(sd, 24.0) * (1.0 - cloud) * 1.2;
      col = mix(col, cloudColour, cloud * 0.94);
    }

    // Everything at and below the horizon is haze - exactly the fog colour.
    col = mix(uFog, col, smoothstep(-0.012, 0.075, h));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function buildSky(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(100, 48, 24);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: SUN_SKY_DIR },
      uFog: { value: FOG_COLOR },
      uTime: timeUniform,
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(geometry, material);
  // Last of the solid objects: by then the depth buffer knows which pixels
  // are still open sky.
  sky.renderOrder = 1000;
  sky.frustumCulled = false;
  return sky;
}
