// The game around the flying: attack waves, scoring, and what ends it.
//
// Structure is Zarch's.  Landbots arrive in waves; a wave is cleared by
// destroying every one of them; clearing it pays a bonus for however much
// of the land is still clean, and lets some of what was lost grow back.
// Each wave brings more bots, and from the second the sky starts dropping
// rocks as well.  The run ends when the last ship is lost - or when the
// virus has taken enough of the planet that there is nothing left to save.

import { beginRecovery, infectedFraction } from './infection';
import type { Phase } from './hud';

/** Points.  A landbot is the job; everything else is change. */
export const SCORE = {
  scenery: 10,
  /** A mutated tree: worth more, since shooting it does the planet a favour. */
  mutant: 60,
  landbot: 500,
  rock: 150,
} as const;

const FIRST_WAVE_DELAY = 170; // frames: time to get off the pad
const INTERMISSION = 420; // frames between waves
const MAX_BOTS = 9;
/** Share of infected land that recovers when a wave is cleared. */
const RECOVERY_FRACTION = 0.38;

export function botsForWave(wave: number): number {
  return Math.min(1 + wave, MAX_BOTS);
}

export interface WaveHost {
  botsAlive(): number;
  spawnWave(count: number, wave: number): void;
  onWaveIncoming(wave: number, count: number): void;
  onWaveCleared(wave: number, bonus: number, landClean: number): void;
}

export class Game {
  phase: Phase = 'title';
  /** Current attack wave; 0 before the first one arrives. */
  wave = 0;
  endReason: 'ship' | 'planet' = 'ship';
  readonly stats = { bots: 0, scenery: 0, rocks: 0, landings: 0 };

  private waveActive = false;
  private timer = FIRST_WAVE_DELAY;

  /** Back to the start of a run. */
  reset(): void {
    this.wave = 0;
    this.waveActive = false;
    this.timer = FIRST_WAVE_DELAY;
    this.endReason = 'ship';
    this.stats.bots = this.stats.scenery = this.stats.rocks = this.stats.landings = 0;
  }

  /** Advance the wave cycle by one fixed frame. */
  step(host: WaveHost): void {
    if (this.waveActive) {
      if (host.botsAlive() > 0) return;
      this.waveActive = false;
      this.timer = INTERMISSION;
      const landClean = 1 - infectedFraction();
      const bonus = Math.round(landClean * 100) * 25 * this.wave;
      beginRecovery(RECOVERY_FRACTION, this.wave);
      host.onWaveCleared(this.wave, bonus, landClean);
      return;
    }
    this.timer -= 1;
    if (this.timer > 0) return;
    this.wave += 1;
    this.waveActive = true;
    const count = botsForWave(this.wave);
    host.spawnWave(count, this.wave);
    host.onWaveIncoming(this.wave, count);
  }

  /**
   * Chance per fixed frame that a rock falls.  Original ramps with score
   * (LanderSrc.txt:4570 DropRocksFromTheSky); here it ramps with the wave,
   * from nothing in wave 1 to a steady rain by wave 10.
   */
  rockChance(): number {
    if (!this.waveActive || this.wave < 2) return 0;
    const intensity = Math.min(1, (this.wave - 2) / 8);
    return 0.0006 + intensity * 0.0055;
  }
}
