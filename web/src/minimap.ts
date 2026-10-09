// The scanner.
//
// Zarch put a radar in the top-left corner showing the whole landscape -
// green where the land was clean, red where the virus had it - with the
// lander and the enemy craft marked on it.  This is that, for a world that
// wraps: the map is drawn centred on the ship and north-up, so "the bot is
// up and to the right on the scanner" always means "fly up and to the
// right".  (The camera never turns, so north on the scanner is also
// straight ahead on screen.)
//
// The base map is a 256x256 image, one pixel per tile, built once.  When
// the virus changes a tile only that pixel is repainted.  Each frame the
// image is blitted four times to cover the wrap, then the markers go on top.

import { SEA_LEVEL } from './constants';
import { infection } from './infection';
import type { Landbot } from './landbots';
import { tileColour } from './terrainMesh';
import { PADS, cornerHeight, wrapDelta, WORLD_SIZE } from './terrain';
import { WIND_REACH, WIND_SPREAD, type TurbineState } from './turbines';
import type { VolcanoActivity } from './volcanoes';

const VIRUS_R = 255;
const VIRUS_G = 44;
const VIRUS_B = 66;

function toByte(linear: number): number {
  // Linear -> display, with a lift: a scanner should read at a glance.
  return Math.round(255 * Math.min(1, Math.pow(Math.max(0, linear) * 1.25, 1 / 2.2)));
}

export class Scanner {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  /** Each tile's clean colour, so recovery can restore it without recomputing. */
  private readonly clean: Uint8ClampedArray;
  private readonly land: Uint8Array;
  private size = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = WORLD_SIZE;
    this.baseCtx = this.base.getContext('2d')!;
    this.image = this.baseCtx.createImageData(WORLD_SIZE, WORLD_SIZE);
    this.clean = new Uint8ClampedArray(WORLD_SIZE * WORLD_SIZE * 3);
    this.land = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
    this.paintBase();
    this.resize();
  }

  /** Match the backing store to the element's CSS size and the display density. */
  resize(): void {
    const css = this.canvas.clientWidth || 216;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.size = Math.round(css * ratio);
    this.canvas.width = this.canvas.height = this.size;
  }

  private paintBase(): void {
    const data = this.image.data;
    for (let iz = 0; iz < WORLD_SIZE; iz++) {
      for (let ix = 0; ix < WORLD_SIZE; ix++) {
        const h00 = cornerHeight(ix, iz);
        const h10 = cornerHeight(ix + 1, iz);
        const h01 = cornerHeight(ix, iz + 1);
        const h11 = cornerHeight(ix + 1, iz + 1);
        const mean = (h00 + h10 + h01 + h11) / 4;
        const tile = (iz << 8) | ix;

        let r: number;
        let g: number;
        let b: number;
        if (mean >= SEA_LEVEL) {
          const depth = Math.min(1, (mean - SEA_LEVEL) / 2);
          r = 20 - depth * 12;
          g = 62 - depth * 34;
          b = 104 - depth * 44;
        } else {
          this.land[tile] = 1;
          const c = tileColour(ix, iz, true);
          // Relief: light from the north-west, as on a paper map.  (Inverse
          // altitude - a smaller value is higher ground.)
          const shade = 1 + Math.max(-0.35, Math.min(0.45, (h00 - h10 + (h01 - h00)) * 0.5));
          r = toByte(c.r * shade);
          g = toByte(c.g * shade);
          b = toByte(c.b * shade);
        }
        this.clean[tile * 3] = r;
        this.clean[tile * 3 + 1] = g;
        this.clean[tile * 3 + 2] = b;
        this.paintTile(tile);
      }
    }
    this.baseCtx.putImageData(this.image, 0, 0);
  }

  /** Write one tile's pixel into the image (north is up, so rows flip). */
  private paintTile(tile: number): void {
    const ix = tile & 255;
    const iz = tile >> 8;
    const level = this.land[tile] ? infection[tile] : 0;
    const o = ((WORLD_SIZE - 1 - iz) * WORLD_SIZE + ix) * 4;
    const data = this.image.data;
    const c = tile * 3;
    // Infection shows early and saturates quickly: a faint stain matters.
    const f = level <= 0 ? 0 : Math.min(1, 0.25 + level * 0.9);
    data[o] = this.clean[c] + (VIRUS_R - this.clean[c]) * f;
    data[o + 1] = this.clean[c + 1] + (VIRUS_G - this.clean[c + 1]) * f;
    data[o + 2] = this.clean[c + 2] + (VIRUS_B - this.clean[c + 2]) * f;
    data[o + 3] = 255;
  }

  /** Repaint tiles whose infection level changed. */
  recolour(changedTiles: readonly number[]): void {
    if (changedTiles.length === 0) return;
    let minX = WORLD_SIZE;
    let maxX = -1;
    let minY = WORLD_SIZE;
    let maxY = -1;
    for (let k = 0; k < changedTiles.length; k++) {
      const tile = changedTiles[k];
      this.paintTile(tile);
      const x = tile & 255;
      const y = WORLD_SIZE - 1 - (tile >> 8);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.baseCtx.putImageData(
      this.image, 0, 0,
      minX, minY, maxX - minX + 1, maxY - minY + 1,
    );
  }

  /** Repaint everything (new game). */
  reset(): void {
    for (let tile = 0; tile < WORLD_SIZE * WORLD_SIZE; tile++) this.paintTile(tile);
    this.baseCtx.putImageData(this.image, 0, 0);
  }

  /**
   * Draw the scanner.  (playerX, playerZ) are world coords; `heading` is
   * the ship's yaw as orientation.ts holds it (0 = facing east, positive
   * turning toward the camera / south).
   */
  draw(
    playerX: number,
    playerZ: number,
    heading: number,
    playerVisible: boolean,
    bots: readonly Landbot[],
    volcanoes: readonly VolcanoActivity[],
    turbines: readonly TurbineState[],
    anchorPadId: number,
    time: number,
  ): void {
    const { ctx, size } = this;
    if (size === 0) return;
    const scale = size / WORLD_SIZE;
    const half = WORLD_SIZE / 2;

    // Base map, tiled so the wrap is seamless around the ship.
    ctx.imageSmoothingEnabled = false;
    let ox = (half - playerX) % WORLD_SIZE;
    let oy = (half - (WORLD_SIZE - playerZ)) % WORLD_SIZE;
    if (ox > 0) ox -= WORLD_SIZE;
    if (oy > 0) oy -= WORLD_SIZE;
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        ctx.drawImage(
          this.base,
          (ox + tx * WORLD_SIZE) * scale,
          (oy + ty * WORLD_SIZE) * scale,
          WORLD_SIZE * scale,
          WORLD_SIZE * scale,
        );
      }
    }

    const mapX = (wx: number): number => (half + wrapDelta(wx - playerX)) * scale;
    const mapY = (wz: number): number => (half - wrapDelta(wz - playerZ)) * scale;
    const unit = size / 216; // marker sizes authored for a 216px scanner

    // What the camera can see: a wedge ahead of the ship.
    const cx = half * scale;
    const cy = half * scale;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath();
    ctx.moveTo(cx - 8 * scale, cy + 10 * scale);
    ctx.lineTo(cx - 52 * scale, cy - 78 * scale);
    ctx.lineTo(cx + 52 * scale, cy - 78 * scale);
    ctx.lineTo(cx + 8 * scale, cy + 10 * scale);
    ctx.closePath();
    ctx.fill();

    // Wind farms.  First the wind itself: a pale fan from each turbine, as
    // long and as wide as its stream and pointing the way it is blowing
    // now.  Then the turbines on top, as little spinning rotors.
    ctx.fillStyle = 'rgba(190,232,255,0.3)';
    for (const { site, heading } of turbines) {
      const x = mapX(site.x);
      const y = mapY(site.z);
      // North is up on the scanner, so world +z runs up the canvas.
      const ax = Math.cos(heading);
      const ay = -Math.sin(heading);
      const near = 2.6 * scale;
      const far = (2.6 + WIND_REACH * WIND_SPREAD) * scale;
      const reach = WIND_REACH * scale;
      ctx.beginPath();
      ctx.moveTo(x - ay * near, y + ax * near);
      ctx.lineTo(x + ax * reach - ay * far, y + ay * reach + ax * far);
      ctx.lineTo(x + ax * reach + ay * far, y + ay * reach - ax * far);
      ctx.lineTo(x + ay * near, y - ax * near);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineCap = 'round';
    for (const { site, gust } of turbines) {
      const x = mapX(site.x);
      const y = mapY(site.z);
      const arm = 3.4 * unit;
      const angle = time * 5 * gust + site.id;
      for (const [colour, width] of [['rgba(8,14,26,0.9)', 2.6], ['#eaf6ff', 1.2]] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width * unit;
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = angle + (k * Math.PI * 2) / 3;
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(a) * arm, y + Math.sin(a) * arm);
        }
        ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';

    // Volcanoes: a small orange peak, which flashes while one is working
    // up to an eruption and throws out rings while it is erupting.
    for (const { volcano, phase } of volcanoes) {
      const x = mapX(volcano.cx);
      const y = mapY(volcano.cz);
      if (phase === 'erupting') {
        for (let k = 0; k < 2; k++) {
          const ping = (time * 1.4 + k * 0.5) % 1;
          ctx.strokeStyle = `rgba(255,150,40,${(1 - ping) * 0.9})`;
          ctx.lineWidth = 1.5 * unit;
          ctx.beginPath();
          // Out to roughly the distance lava bombs carry.
          ctx.arc(x, y, 4 * unit + ping * 38 * scale, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const alert = phase !== 'dormant';
      const lit = !alert || Math.floor(time * 5) % 2 === 0;
      ctx.fillStyle = lit ? (alert ? '#ffd24a' : '#ff8a2a') : '#7a2a10';
      ctx.strokeStyle = 'rgba(20,6,2,0.9)';
      ctx.lineWidth = 1.1 * unit;
      ctx.beginPath();
      ctx.moveTo(x, y - 5.2 * unit);
      ctx.lineTo(x + 5 * unit, y + 3.8 * unit);
      ctx.lineTo(x - 5 * unit, y + 3.8 * unit);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Landing zones.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(8.5 * unit)}px ui-sans-serif, system-ui, sans-serif`;
    for (const pad of PADS) {
      const x = mapX(pad.cx);
      const y = mapY(pad.cz);
      const anchor = pad.id === anchorPadId;
      const s = 6.2 * unit;
      ctx.fillStyle = 'rgba(6,10,22,0.85)';
      ctx.strokeStyle = anchor ? '#ffc24a' : '#7fe9ff';
      ctx.lineWidth = 1.4 * unit;
      ctx.beginPath();
      ctx.rect(x - s, y - s, s * 2, s * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = anchor ? '#ffc24a' : '#7fe9ff';
      ctx.fillText(pad.home ? 'H' : pad.name[0], x, y + 0.6 * unit);
    }

    // Landbots: a solid dot with a ring that pings outward.
    for (const bot of bots) {
      const x = mapX(bot.wx);
      const y = mapY(bot.wz);
      const ping = (time * 0.9 + bot.id * 0.37) % 1;
      const arriving = bot.phase === 'arriving';
      ctx.strokeStyle = `rgba(255,70,100,${(1 - ping) * 0.8})`;
      ctx.lineWidth = 1.3 * unit;
      ctx.beginPath();
      ctx.arc(x, y, (3 + ping * 9) * unit, 0, Math.PI * 2);
      ctx.stroke();
      if (!arriving || Math.floor(time * 6) % 2 === 0) {
        ctx.fillStyle = '#ff2f55';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1 * unit;
        ctx.beginPath();
        ctx.arc(x, y, 3.1 * unit, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // The ship: an arrowhead pointing where the nose points.
    if (playerVisible) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(heading);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 1.2 * unit;
      ctx.beginPath();
      ctx.moveTo(6.5 * unit, 0);
      ctx.lineTo(-4.5 * unit, 4.2 * unit);
      ctx.lineTo(-2 * unit, 0);
      ctx.lineTo(-4.5 * unit, -4.2 * unit);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
