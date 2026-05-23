# Changelog

All notable changes to this Lander web port are recorded here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow the date of the change (`YYYY-MM-DD`) since this is a hobby
port without numbered releases.

## [Unreleased]

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
