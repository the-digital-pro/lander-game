import * as THREE from 'three';

import { buildTerrainMesh } from './terrainMesh';
import { buildShip } from './ship';
import { buildShipShadow, placeShipShadow } from './shadow';
import { buildScenery, destroyObject, populateObjectMap } from './scenery';
import { attachInput } from './input';
import {
  applyOrientation,
  createShipOrientation,
  updateOrientation,
} from './orientation';
import {
  addScore,
  createPlayer,
  restartGame,
  triggerCrash,
  updatePhysics,
} from './physics';
import {
  bootAudio,
  resumeAudio,
  setEngineThrust,
  playFire,
  playExplosion,
  playSplash,
} from './audio';
import { SEA_LEVEL } from './constants';
import { getLandscapeAltitude } from './terrain';
import {
  particleSystem,
  particleCount,
  spawnExhaustBurst,
  spawnExplosion,
  spawnBullet,
  spawnFallingRock,
  getParticles,
  killParticle,
  updateParticles,
} from './particles';
import { CAMERA_PLAYER_Z } from './constants';

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05030f);
// Fog has two jobs: atmospheric depth, and hiding the far edge of the
// finite terrain patch so distant scenery never appears against the void.
// We tune the far distance to fade everything BEFORE it can outrun the
// patch.
scene.fog = new THREE.Fog(0x05030f, 28, 50);

const camera = new THREE.PerspectiveCamera(
  42, // narrower FOV gives the world a flatter, more distant feel
  window.innerWidth / window.innerHeight,
  0.05,
  200,
);

// --- Player + ship ----------------------------------------------------------
const player = createPlayer();
const ship = buildShip();
scene.add(ship);
const shipShadow = buildShipShadow();
scene.add(shipShadow);

// --- Static scenery ---------------------------------------------------------
let objectMap = populateObjectMap();
let scenery = buildScenery(objectMap);
scene.add(scenery.group);

function regenerateWorld(): void {
  scene.remove(scenery.group);
  // Dispose meshes' shared geom/material is shared, so don't dispose; just drop
  // the group.
  objectMap = populateObjectMap();
  scenery = buildScenery(objectMap);
  scene.add(scenery.group);
}

const input = attachInput(renderer.domElement);
const shipOrient = createShipOrientation();
applyOrientation(ship, shipOrient);

// --- Audio ------------------------------------------------------------------
// Browsers block audio until a user gesture; boot on the first click/key.
function startAudio(): void {
  bootAudio();
  resumeAudio();
}
renderer.domElement.addEventListener('mousedown', startAudio, { once: true });
window.addEventListener('keydown', startAudio, { once: true });

// --- Exhaust particles ------------------------------------------------------
scene.add(particleSystem);
const tmpUp = new THREE.Vector3();
const tmpNose = new THREE.Vector3();
const UP_LOCAL = new THREE.Vector3(0, 1, 0);
const NOSE_LOCAL = new THREE.Vector3(1, 0, 0);

const MAP_SIZE = 256;
const OBJECT_NONE = 0xff;

function processBulletHits(): void {
  const ps = getParticles();
  const bullets = ps.filter((p) => p.kind === 'bullet');
  for (const b of bullets) {
    const tileX = Math.floor(b.pos.x);
    const tileZ = Math.floor(-b.pos.z);

    // 1. Object hit?
    if (tileX >= 0 && tileX < MAP_SIZE && tileZ >= 0 && tileZ < MAP_SIZE) {
      const type = objectMap[tileZ * MAP_SIZE + tileX];
      if (type !== OBJECT_NONE && type < 12) {
        const objPos = destroyObject(scenery, tileX, tileZ);
        if (objPos) {
          spawnExplosion(objPos, 25);
          playExplosion(0.6);
          addScore(player, 1);
        }
        killParticle(b);
        continue;
      }
    }

    // 2. Sea hit?  Bullet has fallen below sea level.
    if (b.pos.y < -SEA_LEVEL + 0.1) {
      const groundAlt = getLandscapeAltitude(b.pos.x, -b.pos.z);
      if (groundAlt >= SEA_LEVEL - 1e-3) {
        // Bullet landed in water — spawn upward splash particles + sound.
        const splashAt = b.pos.clone();
        splashAt.y = -SEA_LEVEL + 0.05;
        spawnExplosion(splashAt, 8);
        playSplash();
        killParticle(b);
      }
    }
  }
}

const ROCK_HIT_RADIUS = 0.6;
const tmpDelta = new THREE.Vector3();

/**
 * Rock-vs-ship collision.  Falling rocks crash the ship if they get within
 * ROCK_HIT_RADIUS.  Rocks that hit the terrain (Y below ground) just expire.
 */
function processRockCollisions(): void {
  if (!player.alive) return;
  const ps = getParticles();
  const rocks = ps.filter((p) => p.kind === 'rock');
  for (const r of rocks) {
    tmpDelta.copy(r.pos).sub(player.position);
    if (tmpDelta.lengthSq() < ROCK_HIT_RADIUS * ROCK_HIT_RADIUS) {
      spawnExplosion(player.position);
      playExplosion(1.2);
      triggerCrash(player);
      killParticle(r);
      return;
    }
  }
}

// Falling-rock spawn cadence.  Original ramps with score; we mimic with a
// per-frame probability that grows past a threshold.
const ROCK_SCORE_THRESHOLD = 5;
function maybeDropRock(): void {
  if (!player.alive || player.score < ROCK_SCORE_THRESHOLD) return;
  // Probability ramps from 0 at the threshold to ~3%/frame at score 40+.
  const intensity = Math.min(1, (player.score - ROCK_SCORE_THRESHOLD) / 35);
  const probPerFrame = 0.0005 + intensity * 0.025;
  if (Math.random() > probPerFrame) return;
  // Drop somewhere ahead-ish of the player.
  const dx = (Math.random() - 0.5) * 12;
  const dz = -Math.random() * 18;
  spawnFallingRock(
    player.position.x + dx,
    player.position.z + dz,
    Math.max(player.position.y, 0) + 10,
  );
}

// Debugging hooks (visible from preview eval).
(window as unknown as { __diag: unknown }).__diag = {
  player,
  input,
  orient: shipOrient,
  particles: particleSystem,
  particleCount,
  spawnExplosion,
};

// --- Terrain ----------------------------------------------------------------
// Place the terrain patch's near edge a couple of tiles *behind* the
// camera so there's no black gap between the foreground and the camera,
// even at low altitudes when we're looking nearly level.  The patch
// extends forward (-Z) into the distance from there.
const TERRAIN_PATCH_BIAS_Z = 15; // a bit past CAMERA_BACK

let terrain = buildTerrainMesh(player.position.x, player.position.z + TERRAIN_PATCH_BIAS_Z);
scene.add(terrain);

function refreshTerrain(): void {
  const fresh = buildTerrainMesh(
    player.position.x,
    player.position.z + TERRAIN_PATCH_BIAS_Z,
  );
  scene.remove(terrain);
  terrain.geometry.dispose();
  (terrain.material as THREE.Material).dispose();
  terrain = fresh;
  scene.add(terrain);
}

// --- Camera follow ----------------------------------------------------------
// The original Lander view feels distant — the ship is small in the frame
// and the world extends ahead.  CAMERA_PLAYER_Z (= 5 tiles) is the
// gameplay-physics constant from the original; the visual camera sits
// further back than that for a wider, more cinematic shot.
const CAMERA_BACK = 13;       // tiles behind the ship
const CAMERA_RISE = 1.6;      // tiles above the ship
const LOOK_AHEAD = 6;         // aim this far past the ship
const LOOK_Y_OFFSET = -0.1;   // slight below ship → horizon lifts a touch

function updateCamera(): void {
  camera.position.set(
    player.position.x,
    player.position.y + CAMERA_RISE,
    player.position.z + CAMERA_BACK,
  );
  camera.lookAt(
    player.position.x,
    player.position.y + LOOK_Y_OFFSET,
    player.position.z - LOOK_AHEAD,
  );
}
updateCamera();

// --- HUD --------------------------------------------------------------------
const fuelFill = document.getElementById('fuel-fill') as HTMLDivElement | null;
const livesEl = document.getElementById('lives') as HTMLDivElement | null;
const readoutEl = document.getElementById('readout') as HTMLSpanElement | null;
const scoreEl = document.getElementById('score') as HTMLSpanElement | null;
const statusEl = document.getElementById('status') as HTMLSpanElement | null;
const overlayEl = document.getElementById('overlay') as HTMLDivElement | null;

let lastLives = -1;
function renderLives(): void {
  if (!livesEl) return;
  if (lastLives === player.lives) return;
  lastLives = player.lives;
  livesEl.replaceChildren();
  for (let i = 0; i < player.lives; i++) {
    const icon = document.createElement('div');
    icon.className = 'icon';
    livesEl.appendChild(icon);
  }
}

function updateHud(): void {
  if (fuelFill) fuelFill.style.width = `${(player.fuel * 100).toFixed(1)}%`;
  renderLives();
  const speed =
    Math.abs(player.velocity.x) +
    Math.abs(player.velocity.y) +
    Math.abs(player.velocity.z);
  const altitude = -player.position.y;
  if (scoreEl) {
    scoreEl.textContent = `score ${player.score}  high ${player.highScore}`;
  }
  if (readoutEl) {
    readoutEl.textContent = `  speed ${speed.toFixed(3)}  alt ${altitude.toFixed(2)}`;
  }
  if (statusEl) {
    if (player.gameOver) {
      statusEl.textContent = '';
    } else if (!player.alive) {
      statusEl.textContent = 'CRASHED';
      statusEl.className = 'status';
    } else if (player.onPad) {
      statusEl.textContent = 'LANDED';
      statusEl.className = 'status landed';
    } else {
      statusEl.textContent = '';
    }
  }
  if (overlayEl) overlayEl.classList.toggle('show', player.gameOver);
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && player.gameOver) {
    ev.preventDefault();
    restartGame(player);
    regenerateWorld();
  }
});

// --- Animation loop ---------------------------------------------------------
// Fixed-timestep physics: 60 Hz logic regardless of display refresh rate.
const FIXED_DT_MS = 1000 / 60;
let lastFrameMs = performance.now();
let accumulatorMs = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  let dt = now - lastFrameMs;
  lastFrameMs = now;
  if (dt > 250) dt = 250; // clamp after tab inactivity
  accumulatorMs += dt;

  while (accumulatorMs >= FIXED_DT_MS) {
    updateOrientation(shipOrient, input.x, input.y);
    applyOrientation(ship, shipOrient);
    updatePhysics(player, ship.quaternion, input, objectMap);

    // Crash explosion (LanderSrc.txt:2606-2617).
    if (player.justCrashed) {
      spawnExplosion(player.position);
      playExplosion(1.2);
    }

    // Exhaust plume — 8 particles on full thrust, 1 on hover (LanderSrc.txt:2329-2365).
    const hasFuel = player.fuel > 0 && player.alive;
    if (hasFuel && input.thrust) {
      tmpUp.copy(UP_LOCAL).applyQuaternion(ship.quaternion);
      spawnExhaustBurst(8, player.position, player.velocity, tmpUp);
    } else if (hasFuel && input.hover) {
      tmpUp.copy(UP_LOCAL).applyQuaternion(ship.quaternion);
      spawnExhaustBurst(1, player.position, player.velocity, tmpUp);
    }
    // Engine drone tracks thrust amount.
    setEngineThrust(
      hasFuel ? (input.thrust ? 1 : input.hover ? 0.35 : 0) : 0,
    );

    // Bullets — one per frame while RMB held (LanderSrc.txt:2377-2463).
    if (player.alive && input.fire) {
      tmpNose.copy(NOSE_LOCAL).applyQuaternion(ship.quaternion);
      spawnBullet(player.position, player.velocity, tmpNose);
      playFire();
    }

    updateParticles();
    processBulletHits();
    maybeDropRock();
    processRockCollisions();
    accumulatorMs -= FIXED_DT_MS;
  }

  ship.position.copy(player.position);
  // Hide the ship during the crash animation.
  ship.visible = player.alive;
  shipShadow.visible = player.alive;
  if (player.alive) placeShipShadow(shipShadow, player.position);
  updateCamera();
  refreshTerrain();
  updateHud();
  renderer.render(scene, camera);
});
