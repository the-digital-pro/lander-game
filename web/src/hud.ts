// Heads-up display.
//
// The HUD is plain DOM laid over the canvas (markup and styles live in
// index.html).  This module is the only thing that touches it.  The render
// loop hands over a snapshot once per frame and every write is guarded by a
// "did it actually change" check, so a steady-state frame costs a handful
// of string compares and no layout.

import * as THREE from 'three';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`HUD element #${id} is missing from index.html`);
  return found as T;
}

/** Set text only when it differs; returns true if it changed. */
function setText(node: HTMLElement, cache: { v: string }, value: string): boolean {
  if (cache.v === value) return false;
  cache.v = value;
  node.textContent = value;
  return true;
}

const fmt = new Intl.NumberFormat('en-US');

export type BannerTone = 'info' | 'good' | 'alert';
export type ChipTone = 'good' | 'warn' | 'bad';
export type DescentCue = 'none' | 'safe' | 'fast';
export type Phase = 'title' | 'playing' | 'paused' | 'gameover';

export interface HudFrame {
  fuel: number;
  lives: number;
  score: number;
  best: number;
  wave: number;
  bots: number;
  toxicity: number;
  /** Height above the surface, tiles. */
  altitude: number;
  /** Rate of descent, tiles/second; positive is downward. */
  descent: number;
  /** Ground speed, tiles/second. */
  speed: number;
  descentCue: DescentCue;
  padName: string;
  padDistance: number;
  chip: string;
  chipTone: ChipTone;
}

export interface GameOverSummary {
  title: string;
  reason: string;
  score: number;
  best: number;
  record: boolean;
  wave: number;
  bots: number;
  landSaved: number;
}

interface Popup {
  node: HTMLDivElement;
  position: THREE.Vector3;
  born: number;
  active: boolean;
}

const POPUP_LIFE = 1.25; // seconds
const projected = new THREE.Vector3();

export class Hud {
  private readonly score = el('score');
  private readonly best = el('best');
  private readonly lives = el('lives');
  private readonly wave = el('wave');
  private readonly toxValue = el('tox-value');
  private readonly toxFill = el('tox-fill');
  private readonly statusPanel = el('status-panel');
  private readonly fuelValue = el('fuel-value');
  private readonly fuelFill = el('fuel-fill');
  private readonly flightPanel = el('flight-panel');
  private readonly alt = el('alt');
  private readonly vs = el('vs');
  private readonly spd = el('spd');
  private readonly threatCount = el('threat-count');
  private readonly padReadout = el('pad-readout');
  private readonly chip = el('chip');
  private readonly banner = el('banner');
  private readonly bannerTitle = el('banner').querySelector('h2') as HTMLElement;
  private readonly bannerText = el('banner').querySelector('p') as HTMLElement;
  private readonly popupLayer = el('popups');
  private readonly botPointer = el('bot-pointer');
  private readonly padPointer = el('pad-pointer');
  private readonly stickKnob = el('stick-knob');
  private readonly stickLine = el('stick-line');
  private readonly muteLabel = el('mute-label');
  private readonly overlays: Record<Exclude<Phase, 'playing'>, HTMLElement> = {
    title: el('title'),
    paused: el('pause'),
    gameover: el('gameover'),
  };

  // Last value written to each node.
  private readonly c = {
    score: { v: '' }, best: { v: '' }, wave: { v: '' }, tox: { v: '' }, fuel: { v: '' },
    alt: { v: '' }, vs: { v: '' }, spd: { v: '' }, threats: { v: '' }, pad: { v: '' },
    chip: { v: '' }, botTag: { v: '' }, padTag: { v: '' },
  };
  private lastLives = -1;
  private lastCue: DescentCue = 'none';
  private lastChipTone = '';
  private bannerTimer = 0;
  private readonly popups: Popup[] = [];

  constructor() {
    for (let i = 0; i < 10; i++) {
      const node = document.createElement('div');
      node.className = 'popup';
      this.popupLayer.appendChild(node);
      this.popups.push({ node, position: new THREE.Vector3(), born: 0, active: false });
    }
  }

  /** Per-frame instrument refresh. */
  update(f: HudFrame): void {
    const c = this.c;
    setText(this.score, c.score, fmt.format(f.score));
    setText(this.best, c.best, `BEST ${fmt.format(f.best)}`);
    setText(this.wave, c.wave, String(f.wave).padStart(2, '0'));

    if (this.lastLives !== f.lives) {
      this.lastLives = f.lives;
      this.lives.replaceChildren();
      for (let i = 0; i < f.lives; i++) {
        const icon = document.createElement('div');
        icon.className = 'icon';
        this.lives.appendChild(icon);
      }
    }

    const tox = Math.round(f.toxicity * 100);
    if (setText(this.toxValue, c.tox, `${tox}%`)) {
      this.toxFill.style.transform = `scaleX(${f.toxicity.toFixed(3)})`;
      this.statusPanel.classList.toggle('critical', f.toxicity >= 0.75);
    }

    const fuel = Math.round(f.fuel * 100);
    if (setText(this.fuelValue, c.fuel, `${fuel}%`)) {
      this.fuelFill.style.transform = `scaleX(${f.fuel.toFixed(3)})`;
      this.flightPanel.classList.toggle('low', f.fuel < 0.2);
    }

    setText(this.alt, c.alt, f.altitude.toFixed(1));
    setText(this.vs, c.vs, f.descent.toFixed(1));
    setText(this.spd, c.spd, String(Math.round(f.speed)));
    if (this.lastCue !== f.descentCue) {
      this.lastCue = f.descentCue;
      this.vs.className = `num ${f.descentCue === 'none' ? '' : f.descentCue}`;
    }

    if (setText(this.threatCount, c.threats, f.bots > 0 ? String(f.bots) : 'CLEAR')) {
      this.threatCount.classList.toggle('clear', f.bots === 0);
    }
    setText(this.padReadout, c.pad, `${f.padName} · ${Math.round(f.padDistance)}`);

    if (setText(this.chip, c.chip, f.chip) || this.lastChipTone !== f.chipTone) {
      this.lastChipTone = f.chipTone;
      this.chip.className = f.chip ? `show ${f.chipTone}` : '';
    }
  }

  /** Big centred announcement that clears itself. */
  showBanner(title: string, text: string, tone: BannerTone, ms = 2600): void {
    this.bannerTitle.textContent = title;
    this.bannerText.textContent = text;
    this.banner.className = `show ${tone}`;
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.banner.className = tone;
    }, ms);
  }

  hideBanner(): void {
    window.clearTimeout(this.bannerTimer);
    this.banner.classList.remove('show');
  }

  /** Float a score (or any short text) up from a point in the world. */
  popup(text: string, position: THREE.Vector3, tone: 'good' | 'hot', time: number): void {
    // Reuse a free slot, or the oldest if all are busy.
    let slot = this.popups[0];
    for (const p of this.popups) {
      if (!p.active) {
        slot = p;
        break;
      }
      if (p.born < slot.born) slot = p;
    }
    slot.active = true;
    slot.born = time;
    slot.position.copy(position);
    slot.node.textContent = text;
    slot.node.className = `popup ${tone}`;
  }

  /** Reposition live popups; call once per rendered frame. */
  updatePopups(camera: THREE.Camera, time: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const p of this.popups) {
      if (!p.active) continue;
      const age = (time - p.born) / POPUP_LIFE;
      if (age >= 1) {
        p.active = false;
        p.node.style.opacity = '0';
        continue;
      }
      projected.copy(p.position).project(camera);
      if (projected.z > 1) {
        p.node.style.opacity = '0';
        continue;
      }
      const x = (projected.x * 0.5 + 0.5) * w;
      const y = (-projected.y * 0.5 + 0.5) * h - age * 70;
      const scale = 0.8 + Math.min(1, age * 6) * 0.3;
      p.node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%) scale(${scale.toFixed(2)})`;
      p.node.style.opacity = (age < 0.6 ? 1 : 1 - (age - 0.6) / 0.4).toFixed(2);
    }
  }

  /**
   * Edge-of-view pointer toward something off screen.  `dx` is east and
   * `dz` is north (ahead) of the ship, in tiles.  The camera always faces
   * north, so that maps straight onto screen right / screen up.
   */
  setPointer(which: 'bot' | 'pad', visible: boolean, dx = 0, dz = 0, label = ''): void {
    const node = which === 'bot' ? this.botPointer : this.padPointer;
    node.classList.toggle('show', visible);
    if (!visible) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const angle = Math.atan2(-dz, dx); // screen-space, y down
    const rx = w * 0.5 - 150;
    const ry = h * 0.5 - 120;
    // Point on an ellipse inset from the edges of the view.
    const k = 1 / Math.hypot(Math.cos(angle) / rx, Math.sin(angle) / ry);
    const x = w / 2 + Math.cos(angle) * k;
    const y = h / 2 + Math.sin(angle) * k;
    node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    const arrow = node.firstElementChild as HTMLElement;
    arrow.style.transform = `rotate(${(angle + Math.PI / 2).toFixed(3)}rad)`;
    const tag = node.lastElementChild as HTMLElement;
    setText(tag, which === 'bot' ? this.c.botTag : this.c.padTag, label);
    // Keep the label on the inboard side of the arrow.
    tag.style.transform = `translate(-50%, -50%) translate(${(-Math.cos(angle) * 34).toFixed(1)}px, ${(-Math.sin(angle) * 24).toFixed(1)}px)`;
  }

  /** Draw the flight stick: a knob at the pointer, tied to dead centre. */
  setStick(clientX: number, clientY: number, thrust: boolean, fire: boolean): void {
    const dx = clientX - window.innerWidth / 2;
    const dy = clientY - window.innerHeight / 2;
    this.stickKnob.style.transform = `translate(${clientX.toFixed(1)}px, ${clientY.toFixed(1)}px)`;
    this.stickKnob.className = thrust ? 'thrust' : fire ? 'fire' : '';
    this.stickLine.style.transform = `rotate(${Math.atan2(dy, dx).toFixed(3)}rad) scaleX(${Math.hypot(dx, dy).toFixed(1)})`;
  }

  /** Switch overlays and body state for a game phase. */
  setPhase(phase: Phase, shipAlive: boolean): void {
    this.overlays.title.classList.toggle('show', phase === 'title');
    this.overlays.paused.classList.toggle('show', phase === 'paused');
    this.overlays.gameover.classList.toggle('show', phase === 'gameover');
    document.body.classList.toggle('in-game', phase !== 'title');
    document.body.classList.toggle('flying', phase === 'playing' && shipAlive);
  }

  showGameOver(s: GameOverSummary): void {
    el('final-title').textContent = s.title;
    el('final-reason').textContent = s.reason;
    el('final-score').textContent = fmt.format(s.score);
    el('final-wave').textContent = String(s.wave);
    el('final-bots').textContent = String(s.bots);
    el('final-land').textContent = `${Math.round(s.landSaved * 100)}%`;
    const best = el('final-best');
    best.textContent = s.record ? 'New best score' : `Best ${fmt.format(s.best)}`;
    best.classList.toggle('record', s.record);
  }

  setMuted(muted: boolean): void {
    this.muteLabel.textContent = muted ? 'unmute' : 'mute';
  }
}
