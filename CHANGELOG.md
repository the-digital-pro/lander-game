# Changelog

All notable changes to this Lander web port are recorded here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow the date of the change (`YYYY-MM-DD`) since this is a hobby
port without numbered releases.

## [Unreleased]

### Modern edition

A rework of everything around the ported flight model: a new renderer, and
a Zarch-style defence game built on top of the original Lander mechanics.
The flight model itself (friction, thrust, hover, gravity, fuel, landing
speed) is unchanged.

#### Added
- **Landbots** (`web/src/landbots.ts`). Saucers modelled on Zarch's
  seeders that drift over dry land spraying virus. They wander toward
  nearby ground that is still clean rather than chasing the player. Each
  takes several hits; from wave 3 they charge up and fire slow plasma
  bolts at where the ship is heading. Roughly 5.5-6.5 tiles of land are
  lost per bot per second.
- **Virus and toxicity** (`web/src/infection.ts`). A per-tile infection
  level drives the terrain colour (green to brown/crimson/pink, with a
  pulsing glow), mutates trees standing on it, and sums into a planet-wide
  toxicity meter. 100% toxicity (42% of dry land infected) ends the run.
  Pads and their aprons are immune. There is no creep: killing the bots
  stops the spread.
- **Attack waves and scoring** (`web/src/game.ts`). Clearing every landbot
  ends a wave, pays a bonus for clean land, and lets 38% of infected tiles
  recover. Waves grow from 2 bots to 9. Extra ship every 10,000 points.
- **Scanner minimap** (`web/src/minimap.ts`). Whole-world radar, centred
  on the ship and north-up, showing clean/infected land, landbots, landing
  zones and the ship's heading. One pixel per tile; only changed tiles are
  repainted.
- **Five outpost landing zones** (`web/src/terrain.ts`,
  `web/src/landingPads.ts`). Sited automatically on level ground and
  spread across the map by farthest-point sampling. Every pad refuels, and
  the last one touched is the respawn point. Each has a marked deck, edge
  lights that show its state, and a beacon beam.
- **Wrap-around world.** The six-sine landscape is exactly periodic in 256
  tiles, so the map is now a seamless torus.
- **Renderer**: sun and hemisphere lighting with a shadow map that follows
  the ship; dusk sky dome (`sky.ts`); HDR target with MSAA, bloom, grade
  pass and ACES tone mapping (`post.ts`). The scene's multisampled target
  is resolved once per frame and the effect passes run on plain buffers.
- **Volcanoes** (`web/src/volcanoes.ts`, `web/src/terrain.ts`,
  `web/src/terrainMesh.ts`). Three cones with summit craters are stamped
  into the landscape as real terrain, sited on high ground at least 50
  tiles from any landing zone. Crater lakes and three lava streams per
  cone glow from a per-vertex heat value. Each volcano cycles between
  dormant (40-95 s; thin ash plume), rumbling (6 s warning: thicker ash,
  spitting lava, a growl, "Eruption imminent") and erupting (5.5 s: lava
  fountain and about 23 lava bombs). Bombs fly in high arcs out to roughly
  38 tiles, each with a landing marker; one destroys the ship, any scenery
  on the tile it hits, and any landbot it catches, and leaves a glowing
  splash. Flying down into a crater, or anywhere up the column above an
  erupting one, is also fatal. Bullets pass through lava bombs. The
  scanner marks volcanoes and shows when one is stirring. Cones carry no
  scenery and cannot be infected.
- **Wind turbines** (`web/src/turbines.ts`, `web/src/terrain.ts`). Five
  wind farms of three turbines each, sited on firm, level ground at least
  34 tiles from any landing zone and clear of the volcanoes; the first is
  placed as near the home pad as that allows. Each rotor blows a stream of
  air 20 tiles long that widens as it goes, and draws a weaker draught in
  over 6 tiles behind it. The wind is a velocity field, not a force: a
  ship inside a stream is dragged toward the speed of the air there (up to
  18 tiles/s at the rotor), with some turbulence on top, so it is never
  blown faster than the wind. Streams fade toward their edges and can be
  flown over or, close in, under. Each farm swings 34 degrees either side
  of its bearing over 55 s and gusts between 60% and 100%. Tower, nacelle
  and the full swept disc destroy the ship ("Hit a turbine"); rounds ring
  off the tower. The wind is drawn as camera-facing streaks that move at
  the air's speed, plus dust or spray where a stream meets the surface.
  The scanner marks every turbine and the current reach and direction of
  its wind, the status chip reads "Crosswind" or "Gale", and there is a
  wind howl and a blade beat. Turbines are instanced (four draw calls for
  all fifteen) and cast shadows. Nothing grows within three tiles of one.
- **Clouds** (`web/src/clouds.ts`, `web/src/sky.ts`). A layer of broken
  cumulus sits above normal flying height, defined by a 256x256 weather
  map that tiles with the world. Its shadows move across terrain, scenery,
  the ship and the sea (direct light only; sky light and emission are left
  alone), and the sea mirrors its underside. From above, the layer is
  drawn as a stack of translucent slices with per-pixel ray jitter so it
  reads as soft volume; flying into it washes the view out and shows an
  "In cloud" status. Separately, sunset-lit cloud banks are painted along
  the horizon in the sky dome, which is now drawn after solid geometry so
  its shader only runs on visible sky.
- **Sea with real waves** (`web/src/water.ts`). The surface is a vertex
  grid displaced by nine Gerstner (trochoidal) waves, 14 tiles down to 2
  in length, moving at deep-water dispersion speeds. Shading re-evaluates
  the same waves per pixel plus finer ripples and noise chop: Fresnel
  reflection of the sky, sun glitter, light through wave crests, whitecaps
  where the swell pinches. A depth-and-openness chart of the landscape
  damps the swell in shallow and sheltered water (ponds stay calm), and
  drives the colour ramp, seabed caustics, and breakers that run in along
  the depth contours and leave foam at the moving waterline. All wave
  vectors are whole cycles per 256 tiles, so the sea wraps seamlessly with
  the world. Collisions still use the flat mean sea level.
- **Chase camera** (`web/src/camera.ts`) that frames the ship and the
  ground under it together, pulls back with altitude, widens with speed,
  shakes on explosions and lifts over hillsides. Heading stays fixed, as
  in the original, so the mouse still works as a flight stick.
- **Flying aids** (`web/src/shadow.ts`): landing ring that turns green or
  red over a pad, an aim reticle at the predicted point of impact, and
  edge-of-screen pointers to the nearest landbot and (when fuel is low)
  the nearest pad.
- **HUD and screens** (`web/index.html`, `web/src/hud.ts`): scanner,
  wave/toxicity, score/lives, fuel and flight instruments, banners, score
  popups, and title, pause and game-over overlays.
- **Keyboard alternatives** for every mouse button (`W`/`S`/`Space` and
  friends), pause (`P`/`Esc`, and on losing focus) and mute (`M`).
- **Quit to title**: the pause and game-over screens each have a button
  (and `Q`; `Esc` too on game over) that ends the run and returns to the
  title screen with a fresh world.
- **Audio**: landbot proximity hum, plasma, hull hits, wave and landing
  cues, toxicity and low-fuel alarms, ambient wind, volcano rumble,
  turbine wind and blades.
- **Adaptive resolution**: pixel ratio capped at 2, stepping down if frame
  rate can't be held.

#### Changed
- **Terrain** (`web/src/terrainMesh.ts`) is meshed once as static chunks
  instead of being rebuilt and reallocated every frame; virus changes
  update only the affected slice of the colour buffer.
- **Scenery** (`web/src/scenery.ts`) is drawn with one `InstancedMesh` per
  blueprint instead of one `Mesh` per object. Objects now sit at tile
  centres, so what you see lines up with what you can hit.
- **Particles** (`web/src/particles.ts`) are struct-of-arrays GPU point
  sprites in two blend modes, replacing the 384-object additive table.
  Smoke is now dark. Exhaust bounces off the ground and kicks up dust or
  spray.
- **Bullets and rocks** moved out of the particle table into
  `web/src/projectiles.ts`. Bullets fire every 3 frames, reach about 50%
  further, and only destroy scenery they actually come down among.
  Rocks are 3D, can be shot down, start in wave 2, and mark where they
  will land. (This reverses the earlier decision not to use a rock mesh.)
- **Difficulty ramp** follows the wave rather than the kill count:
  gravity 1.2x / 1.4x / 1.6x at waves 4 / 7 / 10.
- **Colour management**: palette colours are now treated as sRGB and
  converted to linear. Previously they were passed through as linear,
  which washed everything out. The darkest original scenery colours are
  lifted so they hold up under lighting.
- **Crash sequence** is longer (so the wreck can be seen) and a fresh
  ship has a short shield.
- **High score** is stored under a new key (`lander-high-score-v2`); the
  score scale changed, so old bests don't carry over.

### Added
- **Continuous rising smoke from destroyed objects, with per-type
  profiles** (`web/src/particles.ts`, `web/src/scenery.ts`,
  `web/src/main.ts`). Faithfully ports the loop at
  `LanderSrc.txt:4908-4945` — every destroyed tile emits smoke spawned
  `SMOKE_HEIGHT` (0.75 tile) above the wreckage. Smoke rises at
  `SMOKE_RISING_SPEED` (scaled to 60 fps), is exempt from gravity, and
  fades over a profile-specific lifetime. Each object type has its own
  emission profile:
  - **Trees** (small leafy, tall leafy, fir): minimal wisps —
    ~7-10% chance per frame, single particle, short life.
  - **Gazebo**: medium — ~22% chance per frame.
  - **Building**: thick plume — ~45% chance per frame, 2 particles per
    burst, ~1.6× lifetime.
  - **Rocket** (live launchpad rocket types 9/10/11): heaviest plume —
    ~55% chance per frame, 2 particles per burst, ~1.8× lifetime (it
    still has fuel to burn).
  Spawning is culled to ~35 tiles around the player so far-away
  wreckage doesn't blow the particle budget. `Scenery.destroyedTiles`
  stores both `smokeOrigin` and `originalType` so the emitter can pick
  the right profile per kill. Smoke is rendered as mid-grey wisps so it
  reads correctly through the existing additive-blended `Points` cloud.
- **Smoking-gazebo and smoking-building variant meshes**
  (`web/src/scenery.ts`). Ported from `objectSmokingBuilding`
  (`LanderSrc.txt:13169-13187`, 6 verts/6 faces — burnt floor with two
  surviving wall sections) and `objectSmokingGazebo`
  (`LanderSrc.txt:13210-13226`, 6 verts/4 faces — leaning posts on a
  footprint). Generic destroyed objects now alternate between
  `objectSmokingRemainsLeft` and `objectSmokingRemainsRight` (mirror)
  by tile parity so neighbouring stumps don't all lean the same way.
  `destroyObject` now uses a `smokingGeomFor(originalType, ...)` picker
  matching the original objectTypes table at `LanderSrc.txt:4640-4666`.

### Changed
- **Gravity softened to 30% of the original** (`web/src/physics.ts`). Previous
  iterations sat at 60% then 40%; both still felt punishing. Hover thrust now
  comfortably exceeds gravity (~2.2× ratio) so the player can hold altitude on
  hover alone with margin to react. Terminal fall speed is now ~13.5
  tiles/sec (was ~37 at the source rate). Score-based gravity ramp still
  applies on top — late-game gravity climbs back toward (but never reaches)
  the original rate.
- **Lander locked upright while on the launchpad** (`web/src/orientation.ts`,
  `web/src/main.ts`). Mouse input previously kept tilting the ship even when
  sitting on the pad, causing the mesh to clip into the pad/scenery. Pitch is
  now forced to 0 whenever `player.onPad && player.alive`; yaw still tracks
  the mouse so the ship is already aimed the moment it lifts off.
- **Terrain colour palette rewritten** (`web/src/terrainMesh.ts`). Replaced
  the four altitude buckets (which produced large monochrome patches) with
  a six-band altitude palette (snow → rock → forest → grass → scrub → coast)
  and dropped the original's bit-noise palette in favour of clearer terrain
  bands. The variegated checkerboard look is preserved via:
  - Per-tile checkerboard parity step (every other tile one shade darker).
  - Deterministic per-channel jitter (±1 on ~12% of tiles per channel).
  - Sparse band-drift (~3% of tiles drift one band paler or earthier).
  All randomness is keyed on a stable hash of `(sceneX, sceneZ)` so the
  same world tile always paints the same colour across terrain rebuilds.
  Slope-based lighting (left-facing tiles brighter) and distance brightening
  from the original `GetLandscapeTileColour` are retained.

## [2026-05-23] — Initial public commit

First version published to https://github.com/the-digital-pro/lander-game.
Pulled from a multi-day porting session; see commit `f55212c` for full
contents. Highlights:

### Added
- Vite + Three.js + TypeScript project scaffold under `web/`.
- Game constants ported from `LanderSrc.txt:34-178`.
- Fourier landscape generator — six summed sine waves, faithful to
  `GetLandscapeAltitude` (`LanderSrc.txt:1285-1465`).
- Flat-shaded terrain mesh with launchpad and sea handling.
- Player ship mesh ported vertex-for-vertex from `objectPlayer`
  (`LanderSrc.txt:12801-12837`), using the Archimedes' 12-bit RGB palette.
- Fixed-timestep 60 Hz physics decoupled from render rate.
- Mouse-polar-coordinate ship orientation matching the original
  `CalculateRotationMatrix` (`LanderSrc.txt:6311-6630`) — yaw around world
  vertical, forward-lean pitch.
- Exhaust particle system (8 particles full thrust, 1 on hover) and
  explosion / bullet / falling-rock particle types.
- Crash animation with `triggerCrash`, 30-frame countdown, respawn from
  lives pool, and game-over overlay.
- Ground shadow that fades and shrinks with altitude.
- Scenery generator (~2048 random objects across 256×256 tile world)
  with launchpad rockets, trees, buildings, gazebos, and smoking-remains
  variants. Object map drives ground-collision and bullet hits.
- Bullets that destroy objects (swap to smoking-remains tile type) and
  score the player.
- Score-based gravity ramp (1.67× at score 10, 2.33× at score 25) and
  falling-rock hazard that ramps with score.
- WebAudio engine drone (sawtooth + bandpass noise) plus fire,
  explosion and splash one-shots. Boots on first user gesture.
- Persistent high-score in `localStorage` and graphical HUD (fuel bar,
  life icons, score readout, status text, game-over overlay).
- Sea splash particles when bullets land in water.
- Far-field fog (28–50) to mask the finite terrain patch's edge.
- Terrain patch biased forward so there's no black gap between the
  camera and the foreground at low altitudes.
- README, LICENSE (MIT), and `.gitignore` (excluding `LanderSrc.txt` —
  copyrighted material kept locally for reference only).

### Notes
- The original 1987 source by D.J. Braben, annotated by Mark Moxon, is
  **not** redistributed in this repository per its copyright. Mark's
  reverse-engineered source is at
  https://github.com/markmoxon/lander-source-code-acorn-archimedes.
- Several constants have been re-scaled for 60 Hz playback and modern
  expectations: fuel burn cross-checked against `LanderSrc.txt:5895,
  11992, 2549`; gravity softened; camera pulled back further than the
  original `CAMERA_PLAYER_Z` for a more cinematic shot; visible terrain
  patch enlarged from the original 13×11 to 41×50 since modern hardware
  has no fillrate constraint.
