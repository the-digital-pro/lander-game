// Landing zone dressing.
//
// terrain.ts decides where the pads are and flattens the ground for them;
// this puts something worth landing on there: a marked deck, a ring of edge
// lights, and a beacon beam tall enough to steer by once a pad is inside
// the haze.  Lights change colour with the pad's state - cyan when idle,
// amber for the pad you will respawn on, green while you are on it taking
// fuel.

import * as THREE from 'three';

import { shadeWithClouds } from './clouds';
import { PADS, wrapDelta, type LandingPad } from './terrain';

export type PadState = 'idle' | 'anchor' | 'landed';

const STATE_COLOURS: Record<PadState, THREE.Color> = {
  idle: new THREE.Color().setRGB(0.2, 1.25, 1.9),
  anchor: new THREE.Color().setRGB(2.0, 1.05, 0.2),
  landed: new THREE.Color().setRGB(0.25, 2.0, 0.65),
};

const DECK_LIFT = 0.035;
const BEAM_HEIGHT = 34;

/** Paint a pad deck.  Canvas "up" ends up pointing north, away from the camera. */
function buildDeckTexture(pad: LandingPad, maxAnisotropy: number): THREE.Texture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const tile = size / pad.size;

  ctx.fillStyle = '#272b33';
  ctx.fillRect(0, 0, size, size);

  // Worn panels: every tile a slightly different slab, echoing the patchwork.
  for (let j = 0; j < pad.size; j++) {
    for (let i = 0; i < pad.size; i++) {
      const v = ((i * 7 + j * 13 + pad.id * 5) % 9) / 9;
      ctx.fillStyle = `rgba(255,255,255,${0.015 + v * 0.05})`;
      ctx.fillRect(i * tile + 2, j * tile + 2, tile - 4, tile - 4);
    }
  }

  // Hazard border.
  const border = tile * 0.42;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.rect(border, border, size - border * 2, size - border * 2);
  ctx.clip('evenodd');
  ctx.fillStyle = '#16181d';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#e8b42a';
  ctx.lineWidth = border * 0.55;
  for (let k = -size; k < size * 2; k += border * 1.9) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + size, size);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(240,244,250,0.85)';
  ctx.lineWidth = 5;
  ctx.strokeRect(border, border, size - border * 2, size - border * 2);

  // Touchdown circle and designator.
  const c = size / 2;
  ctx.strokeStyle = 'rgba(240,244,250,0.9)';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.27, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.arc(c, c, size * 0.335, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(244,247,252,0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${Math.round(size * 0.3)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
  ctx.fillText(pad.home ? 'H' : pad.name[0], c, c + size * 0.012);

  ctx.font = `700 ${Math.round(size * 0.05)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = 'rgba(232,180,42,0.95)';
  const label = pad.home ? 'B A S E' : pad.name.split('').join(' ');
  ctx.fillText(label, c, size - border - tile * 0.34);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // The deck is always seen at a shallow angle; without this it smears.
  texture.anisotropy = maxAnisotropy;
  return texture;
}

/** A column that is bright at its foot and gone by its top. */
function buildBeamGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, BEAM_HEIGHT, 10, 1, true);
  geometry.translate(0, BEAM_HEIGHT / 2, 0);
  const position = geometry.attributes.position;
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const fade = 1 - position.getY(i) / BEAM_HEIGHT;
    colours[i * 3] = colours[i * 3 + 1] = colours[i * 3 + 2] = fade * fade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

/** One small lamp per tile around the pad's edge, merged into one mesh. */
function buildEdgeLights(size: number): THREE.BufferGeometry {
  const lamp = new THREE.BoxGeometry(0.16, 0.1, 0.16);
  const positions: number[] = [];
  const index: number[] = [];
  const half = size / 2;
  let base = 0;
  const place = (x: number, z: number): void => {
    const p = lamp.attributes.position;
    for (let i = 0; i < p.count; i++) positions.push(p.getX(i) + x, p.getY(i) + 0.05, p.getZ(i) + z);
    const idx = lamp.index!;
    for (let i = 0; i < idx.count; i++) index.push(idx.getX(i) + base);
    base += p.count;
  };
  for (let k = 0; k <= size; k++) {
    const t = -half + k;
    place(t, -half);
    place(t, half);
    if (k > 0 && k < size) {
      place(-half, t);
      place(half, t);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

interface PadVisual {
  pad: LandingPad;
  group: THREE.Group;
  lights: THREE.MeshBasicMaterial;
  beam: THREE.MeshBasicMaterial;
  halo: THREE.MeshBasicMaterial;
  state: PadState;
  colour: THREE.Color;
}

export interface LandingPads {
  group: THREE.Group;
  /**
   * Keep each pad at its copy nearest the player and animate its lights.
   * `camera` is the viewpoint, so a beacon can fade out rather than fill
   * the screen when the view passes close to it.
   */
  update(worldX: number, worldZ: number, time: number, camera: THREE.Vector3): void;
  setState(padId: number, state: PadState): void;
}

export function buildLandingPads(maxAnisotropy: number): LandingPads {
  const group = new THREE.Group();
  const beamGeometry = buildBeamGeometry(0.09);
  const haloGeometry = buildBeamGeometry(0.32);

  const visuals: PadVisual[] = PADS.map((pad) => {
    const padGroup = new THREE.Group();

    const deckGeometry = new THREE.PlaneGeometry(pad.size, pad.size);
    deckGeometry.rotateX(-Math.PI / 2);
    const deck = new THREE.Mesh(
      deckGeometry,
      shadeWithClouds(new THREE.MeshLambertMaterial({ map: buildDeckTexture(pad, maxAnisotropy) })),
    );
    deck.position.y = DECK_LIFT;
    deck.receiveShadow = true;

    const lights = new THREE.MeshBasicMaterial({ color: STATE_COLOURS.idle.clone() });
    const lamps = new THREE.Mesh(buildEdgeLights(pad.size), lights);
    lamps.position.y = DECK_LIFT;

    const beamOptions = {
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    };
    const beam = new THREE.MeshBasicMaterial({ ...beamOptions, color: STATE_COLOURS.idle.clone() });
    const halo = new THREE.MeshBasicMaterial({ ...beamOptions, opacity: 0.1 });
    // Beacon stands on the pad's north-west corner, clear of the approach.
    const beamMesh = new THREE.Mesh(beamGeometry, beam);
    const haloMesh = new THREE.Mesh(haloGeometry, halo);
    const corner = pad.size / 2 + 0.6;
    beamMesh.position.set(-corner, 0, -corner);
    haloMesh.position.copy(beamMesh.position);
    beamMesh.renderOrder = haloMesh.renderOrder = 9;

    padGroup.add(deck, lamps, beamMesh, haloMesh);
    group.add(padGroup);
    return {
      pad,
      group: padGroup,
      lights,
      beam,
      halo,
      state: 'idle' as PadState,
      colour: STATE_COLOURS.idle.clone(),
    };
  });

  return {
    group,
    update(worldX, worldZ, time, camera) {
      for (const v of visuals) {
        const x = worldX + wrapDelta(v.pad.cx - worldX);
        const z = worldZ + wrapDelta(v.pad.cz - worldZ);
        v.group.position.set(x, -v.pad.altitude, -z);

        // Ease toward the state colour, then breathe.
        v.colour.lerp(STATE_COLOURS[v.state], 0.08);
        const rate = v.state === 'landed' ? 5 : 1.6;
        const breathe = 0.7 + 0.3 * Math.sin(time * rate + v.pad.id * 1.7);
        v.lights.color.copy(v.colour).multiplyScalar(breathe);
        const corner = v.pad.size / 2 + 0.6;
        const range = Math.hypot(x - corner - camera.x, -z - corner - camera.z);
        const near = THREE.MathUtils.smoothstep(range, 7, 26);
        v.beam.color.copy(v.colour).multiplyScalar((0.3 + 0.12 * breathe) * near);
        v.halo.color.copy(v.colour);
        v.halo.opacity = (0.022 + 0.018 * breathe) * near;
      }
    },
    setState(padId, state) {
      const v = visuals[padId];
      if (v) v.state = state;
    },
  };
}
