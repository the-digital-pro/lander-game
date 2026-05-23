# Lander (1987) — web port

> A faithful browser-based recreation of **Lander** — David Braben's 1987
> launch title for the Acorn Archimedes — reconstructed from
> [Mark Moxon's annotated disassembly](https://lander.bbcelite.com/)
> ([source on GitHub](https://github.com/markmoxon/lander-source-code-acorn-archimedes))
> and rebuilt in TypeScript + Three.js.

![Status](https://img.shields.io/badge/status-playable-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Stack](https://img.shields.io/badge/stack-Three.js%20%2B%20TypeScript%20%2B%20Vite-orange)

---

## What is Lander?

**Lander** shipped on every Acorn Archimedes in 1987 as part of the
*Welcome Pack*, the demo disc bundled with the first 32-bit personal
computer most people had ever seen. It was the very first game written by
[David Braben](https://en.wikipedia.org/wiki/David_Braben) after Elite —
and the world's first game to ship for the ARM processor.

The premise is simple: you pilot a small craft over an alien world. Take
off from the launchpad, fly around, shoot the trees and rockets and
buildings that dot the landscape, and try to land again before you run out
of fuel or crash into anything. There's no story, no campaign, no
multiplayer — just the player, the lander, and one of the first 3D worlds
ever rendered in real-time on a desktop computer.

The original ran at 50 Hz on a 4 MHz ARM with no GPU, no floating-point
unit, and no shaders. Every triangle was rasterised in hand-written
assembly, every height in the landscape was synthesised from six summed
sine waves, every particle was tracked in a 484-entry table. To see Lander
move smoothly in 1987 — over a landscape that scrolled and rotated
beneath the ship — was, for a generation of British schoolchildren, the
moment 3D real-time graphics suddenly felt possible at home.

## What is this project?

This is a **clean-room port of the gameplay mechanics** to the modern web,
written entirely in TypeScript on top of Three.js.

Every system — the Fourier landscape, the ship's flight model, the fuel
curve, the collision rules, the particle behaviour, the scoring, the
gravity ramp, the original 3D meshes for the trees and rockets and
buildings — was reconstructed by reading
[Mark Moxon's annotated disassembly](https://lander.bbcelite.com/) of the
1987 binary and translating the behaviour into modern code. The full
disassembly source lives at
[markmoxon/lander-source-code-acorn-archimedes](https://github.com/markmoxon/lander-source-code-acorn-archimedes)
on GitHub. Most files in this port include comments pointing back to the
exact line in that source they came from (referenced as `LanderSrc.txt`
locally).

It isn't a binary translation or an emulator. It's a from-scratch
implementation of the same game, written so a modern web browser can do
in JavaScript what an Archimedes did in ARM assembly.

### Why?

* **Preservation.** The Archimedes is a museum piece. Mark Moxon's
  disassembly preserves the *code*; this preserves the *experience* —
  playable in one click on any modern device with a browser.
* **Education.** The original is a beautiful piece of engineering. Reading
  the source is a masterclass in mid-80s 3D graphics. Re-implementing it
  forces you to understand it.
* **Joy.** It's a damn fun little game.

## How to play

| Input | Action |
|---|---|
| **Mouse position** | Yaw the ship to face that direction. Distance from canvas centre controls how steeply it leans forward (and therefore how horizontal the thrust becomes). |
| **Left mouse button** | Full thrust along the ship's "up" axis. Burns fuel. |
| **Middle mouse button** | Hover at ¼ thrust. Burns half fuel. Useful for slow descents. |
| **Right mouse button** | Fire a bullet from the ship's nose. Destroys scenery → +1 score. |
| **Space** *(on Game Over)* | Restart with a freshly seeded world. |

### Goal

* Take off from the launchpad without crashing into the three rockets at
  its edge.
* Fly around the procedurally-generated landscape.
* Shoot trees, gazebos, buildings, and the rockets themselves for points.
* Land back on the launchpad slowly enough (sum of velocity components
  under the safe-landing threshold) to **refuel** and try again.
* Survive as long as you can — gravity ramps up with your score, and
  meteors start falling once you pass score 5.
* You have 3 lives. Use them wisely.

The control scheme is the original: the mouse is essentially a virtual
flight stick. Push it toward where you want to go, click to thrust. There
is no keyboard control, no auto-pilot, no aim-assist. The only thing
between you and the rocks is your wrist.

## Getting started

Requires Node 18+.

```bash
cd web
npm install
npm run dev
```

Open the URL Vite prints (usually <http://localhost:5173>) and click on
the canvas to give audio focus. You'll hear the engine drone the moment
you hold LMB.

To build a production bundle:

```bash
npm run build
```

The static output goes to `web/dist/`.

## Project layout

```
.
├── README.md
├── LICENSE                  MIT, applies to all code under web/
└── web/
    ├── index.html           HUD markup, GAME OVER overlay, controls hint
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── main.ts          Scene assembly, fixed-timestep loop, HUD updates
        ├── constants.ts     Constants ported from LanderSrc.txt:34-178
        ├── input.ts         Canvas mouse position + button state
        ├── orientation.ts   Mouse polar → ship yaw + pitch quaternion
        ├── physics.ts       Friction, thrust, gravity, fuel, collision, lives
        ├── particles.ts     Exhaust, explosion, bullet, rock particles
        ├── shadow.ts        Ground-shadow disc that anchors the ship visually
        ├── terrain.ts       Six-sine Fourier altitude function
        ├── terrainMesh.ts   Flat-shaded terrain patch that follows the camera
        ├── scenery.ts       6 ported object meshes + smoking remains + destroy
        ├── ship.ts          objectPlayer mesh (9 verts, 9 faces, original colours)
        └── audio.ts         Synthesised engine drone, fire, explosion, splash
```

## What's faithful, what's adapted

The implementation is held as close to the original as is reasonable for
the medium. A handful of things diverge intentionally:

| System | Port | Notes |
|---|---|---|
| Six-sine Fourier landscape | **Faithful** | Exact formula from `GetLandscapeAltitude` (LanderSrc.txt:1285-1465) |
| Ship mesh (`objectPlayer`) | **Faithful** | 9 verts, 9 faces, original Archimedes 12-bit colours |
| Scenery meshes | **Faithful** | Rocket, small/tall leafy tree, fir tree, gazebo, building, smoking remains — all ported vertex-for-vertex |
| Flight model | **Faithful** | Friction, thrust along ship's up vector, gravity, hover at ¼ thrust |
| Mouse → orientation | **Faithful** | Yaw around vertical from mouse polar angle; forward-lean from polar distance; original damping |
| Fuel | **Faithful** | Source rates of 4/frame thrust, 2/frame hover at 50 fps, refill 32/frame on pad — scaled to 60 fps |
| Collision (objects) | **Faithful** | Within `SAFE_HEIGHT` (1.5 tiles) and on a non-empty tile → crash |
| Collision (terrain) | **Faithful** | Bottom of ship below terrain → crash; on launchpad with low velocity → safe landing |
| Scoring | **Adapted** | Port treats score as kill count (original was bullets remaining). Persistent high-score in `localStorage`. |
| Gravity ramp | **Adapted** | Source ramps at score 1024 / 1488 (ammo-based); port adapts to kill counts of 10 / 25 |
| Camera | **Adapted** | Source clamped Y at sky boundary and used a fixed projection. Port uses a wider Three.js perspective camera, pulled back and slightly above the ship, so the original "small ship in a big world" framing works at modern aspect ratios |
| Gravity rate | **Softened** | Source-matched gravity (≈0.586 tiles/sec²) is brutal at modern monitor sizes; port runs at ~60% so the thrust:gravity margin is more forgiving |
| Audio | **Synthesised** | Engine drone, bullet fire, explosion, sea splash — all generated procedurally via WebAudio. Original used the Archimedes' sample-based sound chip; no audio assets are bundled. |

## Implementation highlights

* **60 Hz fixed-step physics**, decoupled from render rate. Same simulation
  on any refresh-rate monitor.
* **Single-pass particle buffer.** All exhaust, explosions, bullets,
  rocks and wreckage smoke share one `BufferGeometry` and one `Points`
  mesh — colours and positions written to typed-array buffers each
  frame.
* **Per-type wreckage smoke.** Every destroyed object continuously
  emits rising smoke (matching `LanderSrc.txt:4908-4945`), with each
  object type carrying its own profile — trees barely wisp, buildings
  churn out thick persistent plumes, rockets are heaviest (still have
  fuel to burn).
* **Camera-following terrain patch.** Only ~50×40 tiles are meshed at any
  time; the patch rebuilds each frame around the camera. Distance fog
  hides the seam.
* **~1500 instanced scenery meshes** across the 256×256 world map.
  Three.js frustum culling keeps draw counts in the dozens per frame.
* **WebAudio engine drone** — a sawtooth + bandpass-filtered noise
  modulated by thrust amount. No samples.
* **`localStorage` high-score** persists across page reloads.

## Roadmap

The port is playable and complete enough to be enjoyable. Remaining
items are pure polish:

* [ ] Hide mouse cursor when over the canvas
* [ ] Mute toggle (`M`)
* [ ] Reset high-score control
* [ ] Title / pause screen
* [ ] Touch controls for mobile

### Deliberately not pursued

* **3D rotating `objectRock` mesh for falling rocks.** Tried in an
  early iteration; the original octahedron mesh at the size needed for
  collision felt too prominent on screen. The grey-dot particle reads
  better at modern resolutions, so we kept it.

## Credits

* **Lander** is © **David J. Braben**, 1987. Originally shipped on the
  Acorn Archimedes Welcome Pack.
* The annotated disassembly used as reference is © **Mark Moxon** and
  published at <https://lander.bbcelite.com/>. The source code itself —
  buildable on Mac, Linux and Windows — is on GitHub at
  [markmoxon/lander-source-code-acorn-archimedes](https://github.com/markmoxon/lander-source-code-acorn-archimedes)
  ([Mac/Linux build instructions](https://github.com/markmoxon/lander-source-code-acorn-archimedes#mac-and-linux)).
  The site's
  [Deep Dives](https://lander.bbcelite.com/deep_dives/) section is an
  outstanding read for anyone curious about 3D graphics on 1987 hardware.
* This recreation is a clean-room re-implementation written for
  preservation and educational purposes. The original disassembly is
  **not** redistributed in this repo (`LanderSrc.txt` is `.gitignore`d).
  Visit Mark Moxon's repo above for the source.

## Licence

The port's source code — everything under `web/src/`, plus `web/index.html`
and the project tooling — is released under the
[MIT licence](LICENSE).

The original game and its disassembly remain the intellectual property of
their respective copyright holders.
