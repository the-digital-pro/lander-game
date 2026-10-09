import * as THREE from 'three';

import {
  bootAudio,
  isMuted,
  playAlarm,
  playBlip,
  playBotHit,
  playExplosion,
  playExtraLife,
  playFire,
  playGameOver,
  playLanded,
  playPlasma,
  playRicochet,
  playRumble,
  playSplash,
  playWaveClear,
  playWaveStart,
  resumeAudio,
  setEngineThrust,
  setLandbotProximity,
  setMuted,
  setWind,
  suspendAudio,
} from './audio';
import { ChaseCamera } from './camera';
import { buildCloudLayer, cloudDensityAt, cloudImmersion, updateClouds } from './clouds';
import { SEA_LEVEL, UNDERCARRIAGE_Y } from './constants';
import { FOG_COLOR, FOG_FAR, FOG_NEAR, SUN_COLOR, SUN_LIGHT_DIR, timeUniform } from './env';
import { Game, SCORE } from './game';
import { Hud, type ChipTone, type DescentCue } from './hud';
import {
  drainChangedTiles,
  infectedFraction,
  resetInfection,
  toxicity,
  updateInfection,
} from './infection';
import { attachInput, type InputState } from './input';
import { buildLandingPads } from './landingPads';
import { Landbots, SPRAY_RADIUS } from './landbots';
import { Scanner } from './minimap';
import { applyOrientation, createShipOrientation, updateOrientation } from './orientation';
import {
  clearParticles,
  particleCount,
  particleSystem,
  setParticleView,
  shiftParticles,
  spawnExhaustBurst,
  spawnExplosion,
  spawnGroundWash,
  spawnHullSparks,
  spawnLavaSplash,
  spawnShockRing,
  spawnSplash,
  spawnVirusBurst,
  updateParticles,
} from './particles';
import {
  addScore,
  createPlayer,
  gravityScaleForWave,
  LANDING_SPEED,
  landingSpeed,
  restartGame,
  triggerCrash,
  updatePhysics,
  type CrashCause,
} from './physics';
import { buildPostFX } from './post';
import {
  clearProjectiles,
  dropRock,
  fireBullet,
  firePlasma,
  launchLavaBomb,
  plasmaInFlight,
  predictImpact,
  renderProjectiles,
  rockGroup,
  shiftProjectiles,
  updateProjectiles,
} from './projectiles';
import {
  buildScenery,
  destroyObject,
  emitWreckSmoke,
  noteInfectionChange,
  objectTopAt,
  resetScenery,
  updateScenery,
} from './scenery';
import { buildGroundMarkers } from './shadow';
import { buildShip, setShipEngine } from './ship';
import { buildSky } from './sky';
import {
  groundY,
  isSea,
  meshAltitude,
  nearestPad,
  padAt,
  PADS,
  wrapDelta,
  type LandingPad,
} from './terrain';
import { buildTerrain } from './terrainMesh';
import { Turbines } from './turbines';
import { Volcanoes } from './volcanoes';
import { buildWater, followWater } from './water';

// --- Renderer ---------------------------------------------------------------
// Antialiasing comes from the post-processing chain's multisampled HDR
// target, so the default framebuffer doesn't need its own.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// Never render above 2x: past that the extra pixels cost far more than
// they show.  The cap comes down further if the machine can't keep up (see
// watchFrameRate below).
let pixelRatioCap = 2;
const pixelRatio = (): number => Math.min(window.devicePixelRatio || 1, pixelRatioCap);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
// Plain PCF: about half the shadow-map samples per pixel of the "soft"
// variant, for edges that are hard to tell apart at this scale.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.domElement.classList.add('view');
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
// Fog has two jobs: atmospheric depth, and dissolving the landscape into
// the sky's horizon colour well before the far side of the torus world
// could come into view.
scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
scene.background = FOG_COLOR;

const chase = new ChaseCamera(window.innerWidth / window.innerHeight);
const camera = chase.camera;

// --- Light ------------------------------------------------------------------
// A low sun for shape and shadow, a sky/ground hemisphere so nothing in
// shade goes black, and a faint cool fill from behind the camera to lift
// the faces turned toward the player.
scene.add(new THREE.HemisphereLight(0x97a6e8, 0x45364a, 1.75));
const fill = new THREE.DirectionalLight(0xa9bcff, 1.15);
fill.position.set(0.3, 0.6, 1);
scene.add(fill);

const sun = new THREE.DirectionalLight(SUN_COLOR, 3.1);
sun.castShadow = true;
const SHADOW_HALF = 50;
const SHADOW_MAP = 2048;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.left = -SHADOW_HALF;
sun.shadow.camera.right = SHADOW_HALF;
sun.shadow.camera.top = SHADOW_HALF;
sun.shadow.camera.bottom = -SHADOW_HALF;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 240;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.07;
scene.add(sun, sun.target);

// The shadow frustum rides along with the ship.  Snap it to whole shadow
// texels in light space, or every shadow edge crawls as it moves.
const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_LIGHT_DIR).normalize();
const lightUp = new THREE.Vector3().crossVectors(SUN_LIGHT_DIR, lightRight).normalize();
const SHADOW_TEXEL = (SHADOW_HALF * 2) / SHADOW_MAP;
const shadowFocus = new THREE.Vector3();
function aimSun(x: number, z: number): void {
  // Centre a little ahead of the ship: that is where the camera looks.
  shadowFocus.set(x, -3.5, z - 24);
  const r = Math.round(shadowFocus.dot(lightRight) / SHADOW_TEXEL) * SHADOW_TEXEL;
  const u = Math.round(shadowFocus.dot(lightUp) / SHADOW_TEXEL) * SHADOW_TEXEL;
  const d = shadowFocus.dot(SUN_LIGHT_DIR);
  sun.target.position
    .copy(lightRight).multiplyScalar(r)
    .addScaledVector(lightUp, u)
    .addScaledVector(SUN_LIGHT_DIR, d);
  sun.position.copy(sun.target.position).addScaledVector(SUN_LIGHT_DIR, 120);
}

// --- World ------------------------------------------------------------------
const sky = buildSky();
const terrain = buildTerrain();
const water = buildWater();
const scenery = buildScenery();
const pads = buildLandingPads(renderer.capabilities.getMaxAnisotropy());
const markers = buildGroundMarkers();
const landbots = new Landbots();
const cloudLayer = buildCloudLayer();
const volcanoes = new Volcanoes();
const turbines = new Turbines();
scene.add(sky, terrain.group, water, scenery.group, pads.group, markers.group, landbots.group, rockGroup);
scene.add(cloudLayer.group, volcanoes.group, turbines.group);

// --- Player + ship ----------------------------------------------------------
const player = createPlayer();
const ship = buildShip();
scene.add(ship);
scene.add(particleSystem);

const canvas = renderer.domElement;
const input = attachInput(canvas);
// What the ship sees when the player isn't flying it (menus, game over).
const idleInput: InputState = { ...input, thrust: false, hover: false, fire: false };
const shipOrient = createShipOrientation();
applyOrientation(ship, shipOrient);

const game = new Game();
const hud = new Hud();
const scanner = new Scanner(document.getElementById('scanner') as HTMLCanvasElement);
const post = buildPostFX(renderer, scene, camera);
hud.setMuted(isMuted());
hud.setPhase('title', true);
pads.setState(player.anchorPad.id, 'landed');

const tmpUp = new THREE.Vector3();
const tmpNose = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const renderPos = new THREE.Vector3();
const impact = new THREE.Vector3();
const UP_LOCAL = new THREE.Vector3(0, 1, 0);
const NOSE_LOCAL = new THREE.Vector3(1, 0, 0);

/** Fixed frames since the page loaded; drives cadences (fire rate, alarms). */
let tick = 0;
/** Seconds of rendered time; drives shaders and HUD animation. */
let time = 0;

/** Scene-space X of world x, at the copy nearest the ship. */
function nearX(wx: number): number {
  return player.position.x + wrapDelta(wx - player.position.x);
}
/** Scene-space Z of world (forward-positive) z, at the copy nearest the ship. */
function nearZ(wz: number): number {
  return player.position.z - wrapDelta(wz + player.position.z);
}

// --- Things getting hit -----------------------------------------------------

const CRASH_TEXT: Record<CrashCause, string> = {
  terrain: 'Crashed',
  sea: 'Lost at sea',
  object: 'Collision',
  'hard-landing': 'Hard landing',
  rock: 'Rock strike',
  plasma: 'Shot down',
  landbot: 'Rammed a landbot',
  lava: 'Lost to lava',
  turbine: 'Hit a turbine',
  toxicity: 'Planet lost',
};

/**
 * The ship has just been destroyed: the bang, and everything that goes with
 * it.  `pad` is the pad it was sitting on at the time, if it was.
 */
function shipDestroyed(pad: LandingPad | null): void {
  // Crash explosion (LanderSrc.txt:2606-2617).
  if (player.crashCause === 'sea') {
    tmpPos.copy(player.position).setY(-SEA_LEVEL);
    spawnSplash(tmpPos, 70);
    playSplash();
  }
  spawnExplosion(player.position, 1.25);
  playExplosion(1.2);
  chase.addTrauma(1);
  post.flash(0.5, 0.28, 0.16);
  if (pad) pads.setState(pad.id, 'anchor');
  hud.setPhase(game.phase, false);
}

/**
 * Destroy the ship from outside the flight model (a rock, a bolt, lava, a
 * blade...).  Ignored while the respawn shield is up, unless `force` is set.
 * Returns true if the ship was lost.
 */
function crashShip(cause: CrashCause, force = false): boolean {
  const pad = player.pad;
  if (!triggerCrash(player, cause, force)) return false;
  shipDestroyed(pad);
  return true;
}

/**
 * Blow up a landbot that has just been destroyed.  The player is paid for
 * it only if it was their doing (`earned`) - a volcano gets no bounty.
 */
function landbotDestroyed(x: number, y: number, z: number, earned = true): void {
  tmpPos.set(x, y, z);
  spawnExplosion(tmpPos, 1.5);
  spawnShockRing(tmpPos);
  spawnVirusBurst(tmpPos);
  playExplosion(1.3);
  chase.addTrauma(0.45);
  post.flash(0.35, 0.12, 0.1);
  if (!earned) return;
  game.stats.bots += 1;
  const points = SCORE.landbot + 50 * (game.wave - 1);
  addScore(player, points);
  hud.popup(`+${points}`, tmpPos, 'hot', time);
}

const projectileHost = {
  bulletAt(x: number, y: number, z: number): boolean {
    // 1. A turbine?  Too much steel to hurt: the round just rings off it.
    if (turbines.blocks(x, y, -z)) {
      spawnHullSparks(x, y, z, 4);
      playRicochet();
      return true;
    }

    // 2. Landbot?
    const bot = landbots.hitTest(x, y, z);
    if (bot) {
      const sx = nearX(bot.wx);
      const sz = nearZ(bot.wz);
      const by = bot.y;
      if (landbots.damage(bot, 1, x, y, z)) landbotDestroyed(sx, by, sz);
      else playBotHit();
      return true;
    }

    // 3. Scenery?  Only if the round is actually down among it, not
    // passing overhead.
    const tileX = Math.floor(x);
    const tileZ = Math.floor(-z);
    const top = objectTopAt(scenery, tileX, tileZ);
    if (top > 0 && y < -meshAltitude(tileX + 0.5, tileZ + 0.5) + top + 0.3) {
      const hit = destroyObject(scenery, tileX, tileZ);
      if (hit) {
        tmpPos.set(nearX(hit.wx), hit.y + 0.6, nearZ(hit.wz));
        const big = hit.type >= 8; // buildings and rockets go up properly
        spawnExplosion(tmpPos, big ? 0.9 : 0.42);
        playExplosion(big ? 0.9 : 0.55);
        if (big) chase.addTrauma(0.18);
        game.stats.scenery += 1;
        const points = hit.mutated ? SCORE.mutant : SCORE.scenery;
        addScore(player, points);
        hud.popup(`+${points}`, tmpPos, hit.mutated ? 'hot' : 'good', time);
        return true;
      }
    }
    return false;
  },

  hazardAt(
    x: number,
    y: number,
    z: number,
    radius: number,
    kind: 'rock' | 'plasma' | 'lava',
  ): boolean {
    if (!player.alive) return false;
    const reach = radius + 0.55;
    if (player.position.distanceToSquared(tmpPos.set(x, y, z)) > reach * reach) return false;
    return crashShip(kind);
  },

  rockShot(x: number, y: number, z: number): void {
    playExplosion(0.8);
    game.stats.rocks += 1;
    addScore(player, SCORE.rock);
    hud.popup(`+${SCORE.rock}`, tmpPos.set(x, y, z), 'good', time);
  },

  rockLanded(x: number, _y: number, z: number): void {
    const distance = Math.hypot(x - player.position.x, z - player.position.z);
    if (isSea(x, -z)) playSplash();
    else playExplosion(Math.max(0.3, 0.9 - distance / 40));
    chase.addTrauma(Math.max(0, 0.35 - distance / 60));
  },

  lavaLanded(x: number, y: number, z: number): void {
    const distance = Math.hypot(x - player.position.x, z - player.position.z);
    tmpPos.set(x, y + 0.25, z);
    if (isSea(x, -z)) {
      // Quenched: a burst of spray and nothing left behind.
      spawnSplash(tmpPos, 36);
      if (distance < 50) playSplash();
    } else {
      spawnLavaSplash(tmpPos);
      volcanoes.addPuddle(x, z, time);
      if (distance < 60) playExplosion(Math.max(0.3, 0.85 - distance / 55));
      // Whatever was standing there burns.
      const tileX = Math.floor(x);
      const tileZ = Math.floor(-z);
      if (objectTopAt(scenery, tileX, tileZ) > 0) destroyObject(scenery, tileX, tileZ);
    }
    chase.addTrauma(Math.max(0, 0.3 - distance / 60));
    // Landbots are no more lava-proof than the ship is.
    const bot = landbots.hitTest(x, y + 1.3, z, 0.7);
    if (bot) {
      const sx = nearX(bot.wx);
      const sz = nearZ(bot.wz);
      const by = bot.y;
      if (landbots.damage(bot, 99, sx, by, sz)) landbotDestroyed(sx, by, sz, false);
    }
  },
};

const volcanoHost = {
  playerX: 0,
  playerZ: 0,
  playerY: 0,
  playerAlive: false,
  launchBomb(wx: number, y: number, wz: number, vx: number, vy: number, vz: number): void {
    // World axes -> scene axes (z flips), at the copy nearest the ship.
    launchLavaBomb(nearX(wx), y, nearZ(wz), vx, vy, -vz);
  },
  scorch(): void {
    crashShip('lava');
  },
  onRumble(_volcano: unknown, distance: number): void {
    playRumble(1 - distance / 110);
    if (distance < 75) chase.addTrauma(0.2);
  },
  onErupt(_volcano: unknown, distance: number): void {
    if (distance < 120) playExplosion(Math.max(0.35, 1.5 - distance / 70));
    if (distance < 80) {
      chase.addTrauma(Math.max(0.2, 0.75 - distance / 110));
      post.flash(0.3, 0.1, 0.02);
    }
  },
};

const landbotHost = {
  playerX: 0,
  playerZ: 0,
  playerY: 0,
  playerVX: 0,
  playerVZ: 0,
  playerVY: 0,
  playerTargetable: false,
  firePlasma(wx: number, y: number, wz: number, vx: number, vy: number, vz: number): void {
    // World axes -> scene axes (z flips), at the copy nearest the ship.
    firePlasma(nearX(wx), y, nearZ(wz), vx, vy, -vz);
    playPlasma();
  },
};

const waveHost = {
  botsAlive: (): number => landbots.bots.length,
  spawnWave(count: number, wave: number): void {
    landbots.spawnWave(count, wave, player.position.x, -player.position.z);
  },
  onWaveIncoming(wave: number, count: number): void {
    hud.showBanner(`Wave ${wave}`, `${count} landbots inbound · check the scanner`, 'alert', 3200);
    playWaveStart();
  },
  onWaveCleared(_wave: number, bonus: number, landClean: number): void {
    addScore(player, bonus);
    hud.showBanner(
      'Wave cleared',
      `${Math.round(landClean * 100)}% of the land saved · bonus ${bonus.toLocaleString('en-US')}`,
      'good',
      4200,
    );
    playWaveClear();
  },
};

// --- Phases -----------------------------------------------------------------

function newRun(): void {
  restartGame(player);
  resetScenery(scenery);
  resetInfection();
  landbots.clear();
  clearProjectiles();
  clearParticles();
  volcanoes.reset();
  game.reset();
  chase.snap(player.position);
  for (const pad of PADS) pads.setState(pad.id, 'idle');
  pads.setState(player.anchorPad.id, 'landed');
  hud.hideBanner();
}

function startPlaying(): void {
  if (game.phase === 'gameover') newRun();
  game.phase = 'playing';
  hud.setPhase('playing', player.alive);
  bootAudio();
  resumeAudio();
  playBlip();
}

function setPaused(paused: boolean): void {
  if (paused && game.phase === 'playing') {
    game.phase = 'paused';
    setEngineThrust(0);
    suspendAudio();
  } else if (!paused && game.phase === 'paused') {
    game.phase = 'playing';
    resumeAudio();
    lastFrameMs = performance.now();
  } else {
    return;
  }
  hud.setPhase(game.phase, player.alive);
}

function endRun(): void {
  game.phase = 'gameover';
  const record = player.score > 0 && player.score >= player.highScore;
  hud.showGameOver({
    title: game.endReason === 'planet' ? 'Planet lost' : 'Game over',
    reason:
      game.endReason === 'planet'
        ? 'The virus has taken the land'
        : `${CRASH_TEXT[player.crashCause]} · no ships left`,
    score: player.score,
    best: player.highScore,
    record,
    wave: Math.max(1, game.wave),
    bots: game.stats.bots,
    landSaved: 1 - infectedFraction(),
  });
  hud.setPhase('gameover', false);
  setEngineThrust(0);
  playGameOver();
}

/**
 * Abandon the run (from the pause screen) or leave the game-over screen,
 * and go back to the title with a fresh world behind it.
 */
function quitToTitle(): void {
  if (game.phase !== 'paused' && game.phase !== 'gameover') return;
  newRun();
  game.phase = 'title';
  hud.setPhase('title', true);
  setEngineThrust(0);
  // The title is silent, as it is when the page first loads; launching
  // again wakes the sound up.
  suspendAudio();
  lastFrameMs = performance.now();
}

canvas.addEventListener('mousedown', () => {
  if (game.phase === 'paused') setPaused(false);
});
for (const id of ['title', 'gameover', 'pause']) {
  document.getElementById(id)!.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    if (game.phase === 'paused') setPaused(false);
    else if (game.phase !== 'playing') startPlaying();
  });
  document.getElementById(id)!.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
for (const id of ['pause-quit', 'gameover-quit']) {
  const button = document.getElementById(id)!;
  // Keep the press from the overlay behind, which would resume or relaunch.
  button.addEventListener('mousedown', (ev) => ev.stopPropagation());
  button.addEventListener('click', () => {
    button.blur();
    quitToTitle();
  });
}

window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  switch (ev.code) {
    case 'Space':
    case 'Enter':
      if (game.phase === 'title' || game.phase === 'gameover') {
        ev.preventDefault();
        startPlaying();
      } else if (game.phase === 'paused' && ev.code === 'Enter') {
        setPaused(false);
      }
      break;
    case 'KeyP':
    case 'Escape':
      if (ev.code === 'Escape' && game.phase === 'gameover') quitToTitle();
      else setPaused(game.phase === 'playing');
      break;
    case 'KeyQ':
      // Only from the pause and game-over screens: Q sits next to W.
      quitToTitle();
      break;
    case 'KeyM':
      setMuted(!isMuted());
      hud.setMuted(isMuted());
      break;
  }
});
// Don't let the ship fall out of the sky behind another tab.
window.addEventListener('blur', () => setPaused(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPaused(true);
});

function applyViewSize(): void {
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight, pixelRatio());
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  scanner.resize();
}
window.addEventListener('resize', applyViewSize);

// Adaptive resolution.  If frames are consistently slow, step the render
// resolution down a notch; a slightly softer picture at full speed beats a
// sharp one that stutters.  It only ever steps down, so it can't oscillate.
const PIXEL_RATIO_STEPS = [1.5, 1.25, 1];
let frameTimeMs = 16;
let framesSinceCheck = 0;
function watchFrameRate(dtMs: number): void {
  frameTimeMs += (dtMs - frameTimeMs) * 0.05;
  framesSinceCheck += 1;
  if (framesSinceCheck < 150) return;
  framesSinceCheck = 0;
  if (frameTimeMs < 18.4) return; // holding 60 fps, give or take the odd frame
  const next = PIXEL_RATIO_STEPS.find((step) => step < pixelRatio());
  if (next === undefined) return;
  pixelRatioCap = next;
  applyViewSize();
  frameTimeMs = 16;
}

// --- Simulation -------------------------------------------------------------
// Fixed-timestep physics: 60 Hz logic regardless of display refresh rate.
const FIXED_DT_MS = 1000 / 60;
const FIRE_INTERVAL = 3; // fixed frames between rounds while fire is held
/** Height under the ship within which the plume disturbs the surface. */
const WASH_HEIGHT = 3.6;

function step(): void {
  tick += 1;
  const playing = game.phase === 'playing';
  const controls = playing ? input : idleInput;
  idleInput.x = input.x;
  idleInput.y = input.y;

  // Lock the ship upright while it's sitting on the pad so the mesh
  // can't tilt into the launchpad or surrounding scenery.
  updateOrientation(shipOrient, controls.x, controls.y, player.onPad && player.alive);
  applyOrientation(ship, shipOrient);
  const wasOnPad = player.pad;

  // The turbines turn whether anyone is flying or not; their wind leans on
  // the ship before the flight model moves it.
  turbines.step(tick, player.position.x, -player.position.z);
  windStrength = 0;
  if (player.alive && !player.onPad) {
    windStrength = turbines.blow(player.position, player.velocity, tick).strength;
    // A gale is felt as well as seen.
    if (windStrength > 0.3 && tick % 14 === 0) chase.addTrauma(0.1 * windStrength);
  }

  updatePhysics(player, ship.quaternion, controls, scenery.map, gravityScaleForWave(game.wave));

  // The world wrapped under the ship: bring everything in scene space along.
  if (player.wrapX !== 0 || player.wrapZ !== 0) {
    shiftParticles(player.wrapX, player.wrapZ);
    shiftProjectiles(player.wrapX, player.wrapZ);
    chase.shift(player.wrapX, player.wrapZ);
  }

  if (player.justCrashed) shipDestroyed(wasOnPad);
  // Tower, nacelle or blades: all as solid as the ground.
  if (player.alive && turbines.strikes(player.position, player.previous)) crashShip('turbine');
  if (player.justRespawned) {
    chase.snap(player.position);
    pads.setState(player.anchorPad.id, 'landed');
    hud.setPhase(game.phase, true);
  }
  if (player.justLanded && player.pad) {
    for (const pad of PADS) pads.setState(pad.id, 'idle');
    pads.setState(player.pad.id, 'landed');
    game.stats.landings += 1;
    playLanded();
  }
  if (wasOnPad && !player.pad && player.alive) pads.setState(wasOnPad.id, 'anchor');
  if (player.justGainedLife) {
    hud.showBanner('Extra ship', 'Keep it up', 'info', 2200);
    playExtraLife();
  }

  // Exhaust plume - 8 particles on full thrust, 1 on hover (LanderSrc.txt:2329-2365).
  const hasFuel = player.fuel > 0 && player.alive;
  const throttle = hasFuel ? (controls.thrust ? 1 : controls.hover ? 0.35 : 0) : 0;
  if (throttle > 0) {
    tmpUp.copy(UP_LOCAL).applyQuaternion(ship.quaternion);
    spawnExhaustBurst(controls.thrust ? 8 : 1, player.position, player.velocity, tmpUp);
    // Where the plume meets the surface it throws up dust, or spray.
    const floor = groundY(player.position.x, player.position.z);
    const height = player.position.y - floor;
    if (height < WASH_HEIGHT && (controls.thrust || tick % 3 === 0)) {
      spawnGroundWash(
        player.position.x - tmpUp.x * height,
        floor,
        player.position.z - tmpUp.z * height,
        isSea(player.position.x, -player.position.z),
      );
    }
  }
  // Engine drone tracks thrust amount.
  setEngineThrust(throttle);
  engineThrottle = throttle;

  // Bullets while fire is held (LanderSrc.txt:2377-2463).
  if (player.alive && controls.fire && tick % FIRE_INTERVAL === 0) {
    tmpNose.copy(NOSE_LOCAL).applyQuaternion(ship.quaternion);
    fireBullet(player.position, player.velocity, tmpNose);
    playFire();
  }

  // Landbots.
  landbotHost.playerX = player.position.x;
  landbotHost.playerZ = -player.position.z;
  landbotHost.playerY = player.position.y;
  landbotHost.playerVX = player.velocity.x;
  landbotHost.playerVZ = -player.velocity.z;
  landbotHost.playerVY = player.velocity.y;
  landbotHost.playerTargetable = player.alive && !player.onPad && player.shield === 0;
  landbots.step(landbotHost);

  // Flying into one is as bad as it sounds - for both parties.
  if (player.alive) {
    const bot = landbots.hitTest(player.position.x, player.position.y, player.position.z, 0.4);
    if (bot && crashShip('landbot')) {
      const sx = nearX(bot.wx);
      const sz = nearZ(bot.wz);
      const by = bot.y;
      if (landbots.damage(bot, 3, sx, by, sz)) landbotDestroyed(sx, by, sz);
    }
  }

  updateProjectiles(projectileHost);
  updateParticles();
  emitWreckSmoke(scenery, player.position.x, -player.position.z);
  updateInfection();

  if (!playing) return;

  game.step(waveHost);

  // Volcanoes.
  volcanoHost.playerX = player.position.x;
  volcanoHost.playerZ = -player.position.z;
  volcanoHost.playerY = player.position.y;
  volcanoHost.playerAlive = player.alive;
  volcanoes.step(volcanoHost, tick);
  // Standing near an eruption, the ground doesn't keep still.
  const eruption = volcanoes.threatNear(player.position.x, -player.position.z, 45);
  if (eruption?.phase === 'erupting') chase.addTrauma(0.012);

  // Falling rocks, somewhere ahead-ish of the player.
  if (player.alive && Math.random() < game.rockChance()) {
    dropRock(
      player.position.x + (Math.random() - 0.5) * 16,
      Math.max(player.position.y, groundY(player.position.x, player.position.z)) + 18,
      player.position.z - Math.random() * 20 + 3,
    );
  }

  // Alarms.
  const tox = toxicity();
  if (tox >= 0.75 && tick % (tox >= 0.9 ? 55 : 110) === 0) playAlarm(tox >= 0.9);
  if (player.alive && !player.onPad && player.fuel < 0.2 && tick % 80 === 40) playAlarm(false);

  // The planet is lost: the run ends whatever ships are left.
  if (tox >= 1 && player.alive && game.endReason !== 'planet') {
    game.endReason = 'planet';
    player.lives = 0;
    crashShip('toxicity', true);
  }
  if (player.gameOver) endRun();
}

// --- Frame ------------------------------------------------------------------

/** Debug state.  `freeze` holds the simulation still without the pause overlay. */
const debug: { freeze: boolean } & Record<string, unknown> = { freeze: false };

let engineThrottle = 0;
/** How hard the turbines' wind is blowing the ship, 0..1, as of the last step. */
let windStrength = 0;
let lastFrameMs = performance.now();
let accumulatorMs = 0;

function chipFor(cue: DescentCue, altitude: number, inCloud: number): [string, ChipTone] {
  if (!player.alive) return [CRASH_TEXT[player.crashCause], 'bad'];
  if (player.onPad && player.pad) {
    return [player.fuel < 0.999 ? `Refuelling · ${player.pad.name}` : `Ready · ${player.pad.name}`, 'good'];
  }
  if (player.fuel <= 0) return ['Out of fuel', 'bad'];
  if (cue === 'safe' && altitude < 9) return ['Clear to land', 'good'];
  if (cue === 'fast' && altitude < 9) return ['Too fast to land', 'bad'];
  if (plasmaInFlight()) return ['Incoming fire', 'bad'];
  const stirring = volcanoes.threatNear(player.position.x, -player.position.z, 70);
  if (stirring) {
    return stirring.phase === 'erupting' ? ['Eruption', 'bad'] : ['Eruption imminent', 'warn'];
  }
  if (windStrength > 0.1) return [windStrength > 0.55 ? 'Gale' : 'Crosswind', 'warn'];
  if (player.fuel < 0.2) return ['Low fuel', 'bad'];
  if (player.position.y >= 52) return ['Ceiling · engine cut', 'warn'];
  if (player.shield > 0) return ['Shield', 'warn'];
  if (inCloud > 0.35) return ['In cloud', 'warn'];
  return ['', 'good'];
}

function frame(): void {
  const now = performance.now();
  let dtMs = now - lastFrameMs;
  lastFrameMs = now;
  if (dtMs > 250) dtMs = 250; // clamp after tab inactivity
  const dt = dtMs / 1000;
  time += dt;
  timeUniform.value = time;
  updateClouds(time);
  if (game.phase === 'playing' && !document.hidden) watchFrameRate(dtMs);

  if (game.phase !== 'paused' && !debug.freeze) {
    accumulatorMs += dtMs;
    let steps = 0;
    while (accumulatorMs >= FIXED_DT_MS && steps < 5) {
      step();
      accumulatorMs -= FIXED_DT_MS;
      steps += 1;
    }
    // Hopelessly behind (a long hitch): drop the debt rather than spiral.
    if (accumulatorMs >= FIXED_DT_MS) accumulatorMs = 0;
  }

  // Render between the last two sim states, so motion is smooth whatever
  // the display's refresh rate.
  const alpha = game.phase === 'paused' ? 1 : accumulatorMs / FIXED_DT_MS;
  const backstep = 1 - alpha;
  renderPos.lerpVectors(player.previous, player.position, alpha);
  const worldX = renderPos.x;
  const worldZ = -renderPos.z;

  // Virus changes since last frame fan out to everything that draws them.
  const changed = drainChangedTiles();
  if (changed.length > 0) {
    terrain.recolour(changed);
    scanner.recolour(changed);
    noteInfectionChange(scenery, changed);
  }

  ship.position.copy(renderPos);
  // Hide the ship during the crash animation; blink it while shielded.
  ship.visible = player.alive && (player.shield === 0 || Math.floor(time * 14) % 2 === 0);
  setShipEngine(ship, player.alive ? engineThrottle : 0, time);

  terrain.follow(worldX, worldZ);
  updateScenery(scenery, worldX, worldZ);
  pads.update(worldX, worldZ, time, camera.position);
  landbots.render(worldX, worldZ, backstep, time);
  volcanoes.render(worldX, worldZ, time, dt);
  turbines.render(worldX, worldZ, backstep, time);
  renderProjectiles(backstep, time);
  followWater(water, renderPos.x, renderPos.z);

  // Ground markers and landing cue.
  const floor = groundY(renderPos.x, renderPos.z);
  const altitude = Math.max(0, renderPos.y - UNDERCARRIAGE_Y - floor);
  const overPad = padAt(worldX, worldZ);
  let cue: DescentCue = 'none';
  if (player.alive && overPad && !player.onPad) {
    cue = landingSpeed(player) < LANDING_SPEED * 0.9 ? 'safe' : 'fast';
  }
  const flying = game.phase === 'playing' && player.alive;
  markers.setVisible(player.alive);
  if (player.alive) {
    markers.placeUnderShip(renderPos, cue);
    let aim: THREE.Vector3 | null = null;
    let onTarget = false;
    if (flying && !player.onPad) {
      tmpNose.copy(NOSE_LOCAL).applyQuaternion(ship.quaternion);
      if (predictImpact(renderPos, player.velocity, tmpNose, impact)) {
        aim = impact;
        const near = landbots.nearest(impact.x, -impact.z);
        onTarget = near !== null && near.distance < SPRAY_RADIUS * 0.75;
      }
    }
    markers.placeReticle(aim, onTarget, time);
  }

  chase.update(renderPos, player.alive ? player.velocity.length() : 0, dt, time);
  sky.position.copy(camera.position);
  cloudLayer.update(camera.position);
  const inCloud = cloudImmersion(camera.position);
  post.setMist(inCloud);
  aimSun(renderPos.x, renderPos.z);
  setParticleView(backstep, chase.pixelScale(renderer.domElement.height));

  // --- HUD ---
  const tox = toxicity();
  const pad = nearestPad(worldX, worldZ);
  const threat = landbots.nearest(worldX, worldZ);
  const [chip, chipTone] = chipFor(cue, altitude, inCloud);
  hud.update({
    fuel: player.fuel,
    lives: player.lives,
    score: player.score,
    best: player.highScore,
    wave: Math.max(1, game.wave),
    bots: landbots.bots.length,
    toxicity: tox,
    altitude,
    descent: -player.velocity.y * 60,
    speed: Math.hypot(player.velocity.x, player.velocity.z) * 60,
    descentCue: cue,
    padName: pad.pad.name,
    padDistance: pad.distance,
    chip: game.phase === 'title' ? '' : chip,
    chipTone,
  });
  hud.updatePopups(camera, time);
  hud.setStick(input.clientX, input.clientY, input.thrust, input.fire);

  // Edge pointers: the nearest landbot whenever it is out of view, and the
  // nearest pad once fuel is getting short.
  let botPointer = false;
  if (flying && threat) {
    const dx = wrapDelta(threat.bot.wx - worldX);
    const dz = wrapDelta(threat.bot.wz - worldZ);
    if (dz < -6 || dz > 58 || Math.abs(dx) > 16 + Math.max(0, dz) * 0.55) {
      botPointer = true;
      hud.setPointer('bot', true, dx, dz, `${Math.round(threat.distance)}`);
    }
  }
  if (!botPointer) hud.setPointer('bot', false);
  let padPointer = false;
  if (flying && !player.onPad && player.fuel < 0.4) {
    const dx = wrapDelta(pad.pad.cx - worldX);
    const dz = wrapDelta(pad.pad.cz - worldZ);
    if (dz < -6 || dz > 58 || Math.abs(dx) > 16 + Math.max(0, dz) * 0.55) {
      padPointer = true;
      hud.setPointer('pad', true, dx, dz, `${pad.pad.name} ${Math.round(pad.distance)}`);
    }
  }
  if (!padPointer) hud.setPointer('pad', false);

  scanner.draw(
    worldX,
    worldZ,
    shipOrient.direction,
    player.alive,
    landbots.bots,
    volcanoes.activity,
    turbines.states,
    player.anchorPad.id,
    time,
  );

  setLandbotProximity(flying && threat ? 1 - threat.distance / 45 : 0);
  setWind(flying ? windStrength : 0, flying ? 1 - turbines.nearest(worldX, worldZ) / 30 : 0);
  post.setToxicity(tox);
  post.setDanger(flying && (plasmaInFlight() || (player.fuel < 0.12 && !player.onPad)) ? 1 : 0);
  post.render(dt, time);
}

// Compile every shader up front - including the ones for things that only
// turn up later - so the first landbot doesn't arrive with a hitch.
landbots.spawnWave(1, 1, player.position.x, -player.position.z);
dropRock(0, -50, 0);
launchLavaBomb(0, -50, 0, 0, 0, 0);
volcanoes.addPuddle(0, 0, 0);
terrain.follow(player.position.x, -player.position.z);
chase.snap(player.position);
chase.update(player.position, 0, 0, 0);
cloudLayer.update(new THREE.Vector3(0, 1000, 0)); // from far above, every slice is in play
renderer.compile(scene, camera);
landbots.clear();
clearProjectiles();
volcanoes.reset();

// Debugging hooks (visible from preview eval).
Object.assign(debug, {
  player,
  input,
  game,
  landbots,
  orient: shipOrient,
  renderer,
  scene,
  water,
  camera,
  cloudLayer,
  volcanoes,
  turbines,
  cloudDensityAt,
  particleCount,
  toxicity,
  groundY,
  infectedFraction,
  plasmaInFlight,
  dropRock,
  launchLavaBomb,
  /** Run the simulation flat out for `frames` fixed steps, without drawing. */
  fastForward(frames: number): void {
    for (let i = 0; i < frames; i++) step();
  },
  /**
   * Draw one frame by hand, optionally jumping the shader clock forward
   * first.  For when the tab is in the background and the browser has
   * stopped calling the animation loop.
   */
  renderFrame(skipSeconds = 0): void {
    time += skipSeconds;
    frame();
  },
  /** Drop a landbot `east` / `north` tiles from the ship, for testing. */
  spawnBotNear(east: number, north: number, wave = 1): void {
    const swarm = landbots as unknown as {
      spawn(wx: number, wz: number, wave: number, delay: number): void;
    };
    swarm.spawn(player.position.x + east, -player.position.z + north, wave, 0);
  },
});
(window as unknown as { __diag: unknown }).__diag = debug;

renderer.setAnimationLoop(frame);
