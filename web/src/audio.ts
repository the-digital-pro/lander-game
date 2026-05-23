// Synthesized sound effects using the WebAudio API.  No external sample
// files — every sound is generated procedurally so the port stays
// self-contained.
//
// Sound design rationale:
//
//   * Engine drone — a continuously-running low sawtooth + bandpass-filtered
//     white noise.  Gain is modulated by thrust amount, so silence is free
//     and the drone smoothly fades in/out as the player throttles.
//
//   * Fire (bullet) — short white-noise pop with rapid decay.
//
//   * Explosion — longer white-noise burst with downward-swept low-pass.
//
//   * Splash — pitched water-like hiss for sea impacts (unused yet).
//
// Browsers block audio until a user gesture (click, key), so we lazy-init
// the AudioContext on the first relevant event.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

let engineGain: GainNode | null = null;
let engineOsc: OscillatorNode | null = null;
let engineNoise: AudioBufferSourceNode | null = null;
let noiseLoopBuffer: AudioBuffer | null = null;

const MASTER_VOLUME = 0.55;
const ENGINE_MAX = 0.18;
const ENGINE_RAMP = 0.05;

function makeNoiseBuffer(c: AudioContext, durationSec: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * durationSec), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function setupEngineDrone(c: AudioContext, master: GainNode): void {
  // Mix bus for the engine sound.
  engineGain = c.createGain();
  engineGain.gain.value = 0;
  engineGain.connect(master);

  // Low growl: sawtooth at ~70 Hz.
  engineOsc = c.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.value = 72;
  engineOsc.connect(engineGain);
  engineOsc.start();

  // Combustion noise: looped white noise through a bandpass filter.
  noiseLoopBuffer = makeNoiseBuffer(c, 2);
  engineNoise = c.createBufferSource();
  engineNoise.buffer = noiseLoopBuffer;
  engineNoise.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 600;
  filter.Q.value = 0.8;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.5;
  engineNoise.connect(filter).connect(noiseGain).connect(engineGain);
  engineNoise.start();
}

/** Initialise audio context.  Safe to call multiple times. */
export function bootAudio(): void {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  } catch {
    return;
  }
  masterGain = ctx.createGain();
  masterGain.gain.value = MASTER_VOLUME;
  masterGain.connect(ctx.destination);
  setupEngineDrone(ctx, masterGain);
}

/** Resume an auto-suspended context. Browsers suspend audio without a user gesture. */
export function resumeAudio(): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
}

/** Sets engine throttle, 0..1.  Smoothly fades to the target. */
export function setEngineThrust(amount: number): void {
  if (!ctx || !engineGain) return;
  const clamped = Math.max(0, Math.min(1, amount));
  engineGain.gain.setTargetAtTime(clamped * ENGINE_MAX, ctx.currentTime, ENGINE_RAMP);
}

/** Short noise pop for bullet fire. */
export function playFire(): void {
  if (!ctx || !masterGain) return;
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(ctx, 0.08);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 800;
  src.connect(hp).connect(gain).connect(masterGain);
  src.start();
}

/**
 * Explosion: low-pass-swept noise burst.  `intensity` 0.5–1.5 scales loudness
 * and duration.
 */
export function playExplosion(intensity = 1.0): void {
  if (!ctx || !masterGain) return;
  const dur = 0.55 * intensity;
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(ctx, dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(900, ctx.currentTime);
  lp.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.28 * intensity, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(lp).connect(gain).connect(masterGain);
  src.start();
}

/** Soft splash for impacts on the sea. */
export function playSplash(): void {
  if (!ctx || !masterGain) return;
  const dur = 0.3;
  const src = ctx.createBufferSource();
  src.buffer = makeNoiseBuffer(ctx, dur);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(1200, ctx.currentTime);
  hp.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(hp).connect(gain).connect(masterGain);
  src.start();
}
