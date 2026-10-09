// Post-processing.
//
// The scene is rendered into a floating-point (HDR) buffer in linear light,
// then: bloom picks out whatever is brighter than white - exhaust, tracers,
// pad lights, the virus glow - a grade pass adds a vignette, a whisper of
// lens fringing and the full-screen flashes, and OutputPass finishes with
// filmic tone mapping and the sRGB transfer.  That order matters: bloom and
// grading have to happen on linear HDR values, before tone mapping squashes
// them into display range.
//
// Only the scene itself is multisampled.  It is drawn into its own MSAA
// target, resolved once, and the effect passes then work on plain buffers.
// (Handing the composer a multisampled target instead makes every pass
// that writes to it pay for another full-screen resolve - three a frame,
// which on a high-density display costs more than drawing the scene.)

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * MSAA samples for a given pixel ratio.  A dense display is already
 * supersampling every edge, so it needs fewer.
 */
function samplesFor(pixelRatio: number): number {
  return pixelRatio >= 1.75 ? 2 : 4;
}

const GradeShader = {
  name: 'LanderGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uToxicity: { value: 0 },
    uFlash: { value: new THREE.Vector3() },
    uDanger: { value: 0 },
    uMist: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uToxicity;
    uniform float uDanger;
    uniform float uMist;
    uniform vec3 uFlash;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 centred = vUv - 0.5;
      float r2 = dot(centred, centred);

      // Lens fringing, growing toward the corners.
      vec2 fringe = centred * r2 * 0.012;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + fringe).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - fringe).b
      );

      // Inside a cloud: everything washes out into lit vapour, unevenly,
      // as if the cloud were streaming past.
      if (uMist > 0.001) {
        float drift = sin(vUv.x * 5.0 + uTime * 0.8) * sin(vUv.y * 3.0 - uTime * 0.6);
        float veil = clamp(uMist * (0.92 + 0.08 * drift), 0.0, 1.0);
        col = mix(col, vec3(0.330, 0.280, 0.420), veil * 0.88);
      }

      // Vignette.
      col *= mix(1.0, 0.42, smoothstep(0.1, 0.62, r2));

      // As the planet sickens the edges of the view take on the virus's
      // colour, pulsing once it is nearly lost.
      float sick = smoothstep(0.35, 1.0, uToxicity);
      float throb = 0.75 + 0.25 * sin(uTime * 4.0) * step(0.8, uToxicity);
      col += vec3(0.34, 0.006, 0.03) * sick * throb * smoothstep(0.12, 0.62, r2);
      col += vec3(0.3, 0.012, 0.012) * uDanger * smoothstep(0.16, 0.6, r2);

      col += uFlash;

      // A little grain keeps the dark sky from banding.
      col += (hash(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.012;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface PostFX {
  render(dt: number, time: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** Planet toxicity 0..1, tints the frame edges. */
  setToxicity(value: number): void;
  /** Brief full-screen wash of colour (linear RGB), fading on its own. */
  flash(r: number, g: number, b: number): void;
  /** Sustained red edge, 0..1 (incoming fire, low fuel). */
  setDanger(value: number): void;
  /** How deep in cloud the camera is, 0..1; washes the frame out. */
  setMist(value: number): void;
}

export function buildPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();

  // HDR target with MSAA for the scene, so going through the composer
  // costs neither the highlights nor the antialiasing.
  const sceneTarget = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
    type: THREE.HalfFloatType,
    samples: samplesFor(pixelRatio),
  });
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(size.x, size.y);

  composer.addPass(new TexturePass(sceneTarget.texture));
  // Threshold above anything the sun can do to a surface: only light
  // sources bloom, never lit sand or snow.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.5, 1.3);
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  // Bloom is a blur; it gains nothing from a dense display's extra pixels.
  // Size it from CSS pixels so it costs the same at any pixel ratio.
  bloom.setSize(size.x, size.y);

  const flashLevel = grade.uniforms.uFlash.value as THREE.Vector3;
  let danger = 0;
  let dangerTarget = 0;
  let mist = 0;
  let mistTarget = 0;

  return {
    render(dt, time) {
      grade.uniforms.uTime.value = time;
      flashLevel.multiplyScalar(Math.exp(-7 * dt));
      danger += (dangerTarget - danger) * (1 - Math.exp(-6 * dt));
      grade.uniforms.uDanger.value = danger;
      mist += (mistTarget - mist) * (1 - Math.exp(-5 * dt));
      grade.uniforms.uMist.value = mist;
      renderer.setRenderTarget(sceneTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      composer.render(dt);
    },
    setSize(width, height, ratio) {
      const samples = samplesFor(ratio);
      if (sceneTarget.samples !== samples) {
        sceneTarget.samples = samples;
        sceneTarget.dispose(); // re-created with the new sample count on next use
      }
      sceneTarget.setSize(width * ratio, height * ratio);
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    setToxicity(value) {
      grade.uniforms.uToxicity.value = value;
    },
    flash(r, g, b) {
      flashLevel.set(
        Math.max(flashLevel.x, r),
        Math.max(flashLevel.y, g),
        Math.max(flashLevel.z, b),
      );
    },
    setDanger(value) {
      dangerTarget = value;
    },
    setMist(value) {
      mistTarget = value;
    },
  };
}
