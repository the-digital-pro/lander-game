// Synthesized sound effects using the WebAudio API.  No external sample
// files - every sound is generated procedurally so the port stays
// self-contained.
//
// Sound design rationale:
//
//   * Engine drone - a continuously-running low sawtooth + bandpass-filtered
//     white noise.  Gain is modulated by thrust amount, so silence is free
//     and the drone smoothly fades in/out as the player throttles.
//
//   * Fire (bullet) - a short falling square-wave chirp over a noise tick.
//
//   * Explosion - noise burst with downward-swept low-pass, over a sub thump.
//
//   * Splash - pitched water-like hiss for sea impacts.
//
//   * Landbots - an uneasy two-oscillator hum that swells as one gets close,
//     so the player hears a bot before seeing it.
//
//   * Volcano - a long low growl of filtered noise that swells before an
//     eruption; the eruption itself borrows the explosion.
//
//   * Wind turbines - two more layers of the same noise: a howl that opens
//     up with how hard the ship is being blown, and a low beat under it at
//     the rate blades go by, which comes up as a turbine gets close.
//
//   * Cues - short tonal stings for wave start / clear, landing, extra ship,
//     and the alarms.  All from the same handful of oscillators.
//
// Browsers block audio until a user gesture (click, key), so we lazy-init
// the AudioContext on the first relevant event.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

let engineGain: GainNode | null = null;
let engineOsc: OscillatorNode | null = null;
let engineFilter: BiquadFilterNode | null = null;
let humGain: GainNode | null = null;
let gustGain: GainNode | null = null;
let gustFilter: BiquadFilterNode | null = null;
let bladeGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

const MASTER_VOLUME = 0.55;
const ENGINE_MAX = 0.18;
const ENGINE_RAMP = 0.05;
const MUTE_KEY = 'lander-muted';

let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // Storage unavailable; start unmuted.
}

function makeNoiseBuffer(c: AudioContext, durationSec: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * durationSec), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** A slice of the shared noise buffer, started at a random offset. */
function noiseSource(c: AudioContext, durationSec: number): AudioBufferSourceNode {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  const offset = Math.random() * Math.max(0, noiseBuffer!.duration - durationSec);
  src.start(c.currentTime, offset, durationSec);
  return src;
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
  const engineNoise = c.createBufferSource();
  engineNoise.buffer = noiseBuffer;
  engineNoise.loop = true;
  engineFilter = c.createBiquadFilter();
  engineFilter.type = 'bandpass';
  engineFilter.frequency.value = 600;
  engineFilter.Q.value = 0.8;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.5;
  engineNoise.connect(engineFilter).connect(noiseGain).connect(engineGain);
  engineNoise.start();
}

function setupAmbience(c: AudioContext, master: GainNode): void {
  // Wind: looped noise under a slowly wandering low-pass.
  const wind = c.createBufferSource();
  wind.buffer = noiseBuffer;
  wind.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoDepth = c.createGain();
  lfoDepth.gain.value = 170;
  lfo.connect(lfoDepth).connect(filter.frequency);
  const gain = c.createGain();
  gain.gain.value = 0.035;
  wind.connect(filter).connect(gain).connect(master);
  wind.start();
  lfo.start();

  // Landbot hum: two detuned saws beating against each other, under a
  // tremolo.  Silent until setLandbotProximity() opens it up.
  humGain = c.createGain();
  humGain.gain.value = 0;
  const humFilter = c.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 520;
  const tremolo = c.createGain();
  tremolo.gain.value = 0.7;
  const tremoloLfo = c.createOscillator();
  tremoloLfo.frequency.value = 6.5;
  const tremoloDepth = c.createGain();
  tremoloDepth.gain.value = 0.3;
  tremoloLfo.connect(tremoloDepth).connect(tremolo.gain);
  for (const frequency of [98, 103.5]) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequency;
    osc.connect(humFilter);
    osc.start();
  }
  humFilter.connect(tremolo).connect(humGain).connect(master);
  tremoloLfo.start();

  // Turbine wind.  The howl: noise through a band that setWind() slides up
  // as the gale builds.  Silent until then.
  gustGain = c.createGain();
  gustGain.gain.value = 0;
  const gust = c.createBufferSource();
  gust.buffer = noiseBuffer;
  gust.loop = true;
  gustFilter = c.createBiquadFilter();
  gustFilter.type = 'bandpass';
  gustFilter.frequency.value = 380;
  gustFilter.Q.value = 1.1;
  gust.connect(gustFilter).connect(gustGain).connect(master);
  gust.start(0, 0.7);

  // The blades: low noise, chopped at about the rate three of them pass.
  bladeGain = c.createGain();
  bladeGain.gain.value = 0;
  const blades = c.createBufferSource();
  blades.buffer = noiseBuffer;
  blades.loop = true;
  const bladeFilter = c.createBiquadFilter();
  bladeFilter.type = 'lowpass';
  bladeFilter.frequency.value = 190;
  const chop = c.createGain();
  chop.gain.value = 0.5;
  const chopLfo = c.createOscillator();
  chopLfo.frequency.value = 2.7;
  const chopDepth = c.createGain();
  chopDepth.gain.value = 0.5;
  chopLfo.connect(chopDepth).connect(chop.gain);
  blades.connect(bladeFilter).connect(chop).connect(bladeGain).connect(master);
  blades.start(0, 1.3);
  chopLfo.start();
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
  masterGain.gain.value = muted ? 0 : MASTER_VOLUME;
  masterGain.connect(ctx.destination);
  noiseBuffer = makeNoiseBuffer(ctx, 2);
  setupEngineDrone(ctx, masterGain);
  setupAmbience(ctx, masterGain);
}

/** Resume an auto-suspended context. Browsers suspend audio without a user gesture. */
export function resumeAudio(): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
}

/** Silence everything while the game is paused, without losing the mix. */
export function suspendAudio(): void {
  if (ctx && ctx.state === 'running') void ctx.suspend();
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // Preference just won't persist.
  }
  if (ctx && masterGain) {
    masterGain.gain.setTargetAtTime(value ? 0 : MASTER_VOLUME, ctx.currentTime, 0.02);
  }
}

/** Sets engine throttle, 0..1.  Smoothly fades to the target. */
export function setEngineThrust(amount: number): void {
  if (!ctx || !engineGain || !engineOsc || !engineFilter) return;
  const clamped = Math.max(0, Math.min(1, amount));
  engineGain.gain.setTargetAtTime(clamped * ENGINE_MAX, ctx.currentTime, ENGINE_RAMP);
  // Open the throat up as the throttle comes in.
  engineOsc.frequency.setTargetAtTime(64 + clamped * 22, ctx.currentTime, 0.08);
  engineFilter.frequency.setTargetAtTime(420 + clamped * 520, ctx.currentTime, 0.08);
}

/** How close the nearest landbot is, 0 (out of earshot) .. 1 (on top of you). */
export function setLandbotProximity(amount: number): void {
  if (!ctx || !humGain) return;
  const clamped = Math.max(0, Math.min(1, amount));
  humGain.gain.setTargetAtTime(clamped * clamped * 0.11, ctx.currentTime, 0.25);
}

/**
 * Turbine wind.  `strength` is how hard the ship is being blown, 0..1;
 * `nearness` is how close the nearest turbine is, 0 (out of earshot) .. 1.
 */
export function setWind(strength: number, nearness: number): void {
  if (!ctx || !gustGain || !gustFilter || !bladeGain) return;
  const blown = Math.max(0, Math.min(1, strength));
  const near = Math.max(0, Math.min(1, nearness));
  gustGain.gain.setTargetAtTime(Math.sqrt(blown) * 0.3, ctx.currentTime, 0.12);
  gustFilter.frequency.setTargetAtTime(340 + blown * 620, ctx.currentTime, 0.2);
  bladeGain.gain.setTargetAtTime(near * near * 0.26, ctx.currentTime, 0.3);
}

// ---------------------------------------------------------------------------
// One-shots.
// ---------------------------------------------------------------------------

interface ToneOptions {
  type?: OscillatorType;
  /** Frequency to glide to by the end of the note. */
  slideTo?: number;
  /** Seconds from now to start. */
  delay?: number;
  attack?: number;
}

function tone(frequency: number, duration: number, gain: number, options: ToneOptions = {}): void {
  if (!ctx || !masterGain) return;
  const start = ctx.currentTime + (options.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = options.type ?? 'sine';
  osc.frequency.setValueAtTime(frequency, start);
  if (options.slideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.slideTo), start + duration);
  }
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + (options.attack ?? 0.008));
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(envelope).connect(masterGain);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

let lastFireAt = 0;

/** Bullet fire.  Rate-limited: the gun cycles faster than is pleasant to hear. */
export function playFire(): void {
  if (!ctx || !masterGain) return;
  if (ctx.currentTime - lastFireAt < 0.055) return;
  lastFireAt = ctx.currentTime;
  tone(820 + Math.random() * 80, 0.07, 0.035, { type: 'square', slideTo: 190 });
  const src = noiseSource(ctx, 0.05);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.05, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1400;
  src.connect(hp).connect(gain).connect(masterGain);
}

/**
 * Explosion: low-pass-swept noise burst over a sub thump.  `intensity`
 * 0.5-1.5 scales loudness and duration.
 */
export function playExplosion(intensity = 1.0): void {
  if (!ctx || !masterGain) return;
  const dur = 0.55 * intensity;
  const src = noiseSource(ctx, Math.min(dur, 1.9));
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(1100, ctx.currentTime);
  lp.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3 * intensity, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(lp).connect(gain).connect(masterGain);
  tone(110, dur * 0.9, 0.3 * intensity, { slideTo: 34 });
}

/** Soft splash for impacts on the sea. */
export function playSplash(): void {
  if (!ctx || !masterGain) return;
  const dur = 0.3;
  const src = noiseSource(ctx, dur);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(1200, ctx.currentTime);
  hp.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  src.connect(hp).connect(gain).connect(masterGain);
}

let lastHitAt = 0;

/** A round ringing off a landbot's hull. */
export function playBotHit(): void {
  if (!ctx) return;
  if (ctx.currentTime - lastHitAt < 0.04) return;
  lastHitAt = ctx.currentTime;
  tone(1500 + Math.random() * 500, 0.12, 0.06, { type: 'triangle', slideTo: 700 });
}

/** A round glancing off something it can't hurt. */
export function playRicochet(): void {
  if (!ctx) return;
  if (ctx.currentTime - lastHitAt < 0.04) return;
  lastHitAt = ctx.currentTime;
  tone(880 + Math.random() * 260, 0.1, 0.05, { type: 'square', slideTo: 380 });
}

/** A landbot releasing a plasma bolt. */
export function playPlasma(): void {
  tone(620, 0.34, 0.09, { type: 'sawtooth', slideTo: 110 });
  tone(1240, 0.2, 0.03, { type: 'sine', slideTo: 300 });
}

/**
 * A volcano working itself up: a low growl that swells over a few seconds.
 * `nearness` 0..1 scales it; a far-off one is felt more than heard.
 */
export function playRumble(nearness: number): void {
  if (!ctx || !masterGain || nearness <= 0.02) return;
  const dur = 1.9; // as long as the shared noise buffer allows
  const level = 0.5 * Math.min(1, nearness);
  for (let k = 0; k < 3; k++) {
    // Three overlapping swells make one long, uneven growl.
    const start = ctx.currentTime + k * 1.5;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 95 + k * 25;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level * (0.6 + k * 0.2), start + dur * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(lp).connect(gain).connect(masterGain);
    src.start(start, 0, dur);
  }
  tone(41, 5.2, 0.16 * Math.min(1, nearness), { type: 'sine', slideTo: 33, attack: 1.2 });
}

/** Touchdown on a pad. */
export function playLanded(): void {
  tone(523, 0.22, 0.07, { type: 'triangle' });
  tone(784, 0.36, 0.07, { type: 'triangle', delay: 0.11 });
}

/** A new wave coming in: a rising two-tone klaxon. */
export function playWaveStart(): void {
  for (let i = 0; i < 3; i++) {
    tone(310, 0.2, 0.07, { type: 'sawtooth', slideTo: 520, delay: i * 0.3 });
  }
}

/** Wave cleared: a short rising arpeggio. */
export function playWaveClear(): void {
  [523, 659, 784, 1047].forEach((frequency, i) => {
    tone(frequency, 0.34, 0.07, { type: 'triangle', delay: i * 0.1 });
  });
}

export function playExtraLife(): void {
  [784, 988, 1175, 1568].forEach((frequency, i) => {
    tone(frequency, 0.2, 0.06, { type: 'square', delay: i * 0.07 });
  });
}

export function playGameOver(): void {
  [392, 330, 262, 196].forEach((frequency, i) => {
    tone(frequency, 0.6, 0.08, { type: 'triangle', delay: i * 0.26 });
  });
}

/** Single alarm pip; the caller sets the cadence. */
export function playAlarm(urgent: boolean): void {
  tone(urgent ? 980 : 660, 0.11, 0.05, { type: 'square' });
  if (urgent) tone(980, 0.11, 0.05, { type: 'square', delay: 0.16 });
}

/** Menu / pause blip. */
export function playBlip(): void {
  tone(880, 0.07, 0.04, { type: 'triangle' });
}
