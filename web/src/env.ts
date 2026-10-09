// Shared look-and-feel constants: where the sun is, what colour the haze is,
// and the one clock every shader animates from.
//
// The scene is lit as late dusk.  The camera in Lander never turns - it
// always faces "north" (scene -Z) - so the sun can be placed deliberately:
// low and ahead-left, where it rakes across the patchwork and throws long
// shadows back toward the viewer.

import * as THREE from 'three';

/** Shared `uTime` uniform (seconds).  main.ts advances it once per frame. */
export const timeUniform = { value: 0 };

/**
 * Shared uniform: how worked-up the nearest volcano is, 0 (quiet) to 1
 * (erupting).  Makes every bit of lava on the terrain burn brighter.
 */
export const lavaSurgeUniform = { value: 0 };

function fromAngles(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  // Azimuth is measured from north (-Z), positive toward west (-X).
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    -Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
}

/**
 * Direction TO the sun used for lighting and shadows.  Deliberately higher
 * than the painted sun: a physically matched 6 degree sun would bury most of
 * a rolling landscape in its own shadow.
 */
export const SUN_LIGHT_DIR = fromAngles(38, 34);

/** Direction TO the sun disc painted in the sky, just above the horizon. */
export const SUN_SKY_DIR = fromAngles(22, 5.5);

/** Linear-space haze colour.  Fog, sky horizon and water all meet on this. */
export const FOG_COLOR = new THREE.Color().setRGB(0.082, 0.078, 0.185);
export const FOG_NEAR = 46;
export const FOG_FAR = 124;

export const SUN_COLOR = new THREE.Color().setRGB(1.0, 0.78, 0.6);

/**
 * GLSL: the colour of the sky in direction `d` - the dusk gradient and the
 * glow around the sun, without the disc, stars or anything else painted on
 * top.  The sky dome draws with it and the sea reflects with it, so the two
 * can never drift apart.
 */
export const SKY_GLSL = /* glsl */ `
  vec3 skyGlow(vec3 d, vec3 sunDir) {
    float h = d.y;

    // How closely this bearing lines up with the sun's, ignoring height.
    vec2 flat2 = normalize(d.xz + vec2(1e-5));
    float toward = max(dot(flat2, normalize(sunDir.xz)), 0.0);

    vec3 zenith = vec3(0.006, 0.010, 0.040);
    vec3 upper = vec3(0.045, 0.040, 0.150);
    vec3 cool = vec3(0.115, 0.100, 0.260);
    vec3 ember = vec3(1.050, 0.400, 0.150);
    vec3 rose = vec3(0.430, 0.150, 0.240);

    // Afterglow: hot at the sun's bearing, rose either side, cool behind.
    vec3 horizon = mix(cool, rose, smoothstep(0.0, 0.85, toward));
    horizon = mix(horizon, ember, pow(toward, 6.0));

    float e = clamp(h, 0.0, 1.0);
    vec3 col = mix(horizon, upper, smoothstep(0.0, 0.2, e));
    col = mix(col, zenith, smoothstep(0.12, 0.7, e));

    // The wide warm halo the sun sits inside.
    float sd = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.42, 0.16) * pow(sd, 14.0) * 0.3;
    col += vec3(1.0, 0.62, 0.32) * pow(sd, 120.0) * 0.8;
    return col;
  }
`;
