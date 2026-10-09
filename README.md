# Lander (1987) — html web port

> A faithful browser-based recreation of **Lander** — David Braben's 1987 launch title for the Acorn Archimedes — reconstructed from Mark Moxon's annotated disassembly(source on GitHub) and rebuilt in TypeScript + Three.js.
>
> It now goes a step further: a modern renderer, and on top of the ported flight model the game Lander was a demo *for* — **Zarch** — with virus-spraying landbots to hunt, a scanner, attack waves and six landing zones.

**▶ Play it now: https://lander-game.netlify.app/**

---

## What is Lander?

**Lander** shipped on every Acorn Archimedes in 1987 as part of the *Welcome Pack*, the demo disc bundled with the first 32-bit personal computer most people had ever seen. It was the very first game written by David Braben after Elite — and the world's first game to ship for the ARM processor.

The premise is simple: you pilot a small craft over an alien world. Take off from the launchpad, fly around, shoot the trees and rockets and buildings that dot the landscape, and try to land again before you run out of fuel or crash into anything. There's no story, no campaign, no multiplayer — just the player, the lander, and one of the first 3D worlds ever rendered in real-time on a desktop computer.

The original ran at 50 Hz on a 4 MHz ARM with no GPU, no floating-point unit, and no shaders. Every triangle was rasterised in hand-written assembly, every height in the landscape was synthesised from six summed sine waves, every particle was tracked in a 484-entry table. To see Lander move smoothly in 1987 — over a landscape that scrolled and rotated beneath the ship — was, for a generation of British schoolchildren, the moment 3D real-time graphics suddenly felt possible at home.

## What is this project?

This is a **clean-room port of the gameplay mechanics** to the modern web, written entirely in TypeScript on top of Three.js.

Every system — the Fourier landscape, the ship's flight model, the fuel curve, the collision rules, the particle behaviour, the scoring, the gravity ramp, the original 3D meshes for the trees and rockets and buildings — was reconstructed by reading Mark Moxon's annotated disassembly of the 1987 binary and translating the behaviour into modern code. The full disassembly source lives at markmoxon/lander-source-code-acorn-archimedeson GitHub. Most files in this port include comments pointing back to the exact line in that source they came from (referenced as `LanderSrc.txt`locally).

It isn't a binary translation or an emulator. It's a from-scratch implementation of the same game, written so a modern web browser can do in JavaScript what an Archimedes did in ARM assembly.

### Why?

- **Preservation.** The Archimedes is a museum piece. Mark Moxon's disassembly preserves the *code*; this preserves the *experience* — playable in one click on any modern device with a browser.
- **Education.** The original is a beautiful piece of engineering. Reading the source is a masterclass in mid-80s 3D graphics. Re-implementing it forces you to understand it.
- **Joy.** It's a damn fun little game.

## The modern edition

This started as a like-for-like recreation. It has since grown into a reimagining: the flight model, the landscape and every original mesh are still the ported ones, but what you do with them — and how it all looks — has moved on. The new game is modelled on **Zarch** (1987), the full release Braben built on the Lander engine.

**The game**

- **Landbots.** Rogue saucers, after Zarch's seeders, drift low over the land spraying virus. Where it falls the patchwork turns brown and crimson and the trees mutate. They don't chase you; they wander toward clean ground, so left alone a swarm quietly takes the planet. From wave 3 they shoot back.
- **Toxicity.** Every infected tile adds to a planet-wide toxicity meter. If it reaches 100% the planet is lost and the run is over, however many ships you have left.
- **Waves.** Destroy every landbot to clear a wave. You are paid a bonus for the land still clean, and some of what was lost grows back. Each wave brings more bots; later ones bring falling rocks and heavier gravity too.
- **Scanner.** A radar in the top-left shows the whole world — green where it is clean, red where the virus has it — with the landbots, the landing zones and your ship marked. It is centred on you and north-up, and the camera never turns, so "up and to the right on the scanner" always means "fly up and to the right".
- **Volcanoes.** Three cones stand on the map, each with a lava lake in its crater and lava running down its flanks. They sleep most of the time. When one starts to rumble — the ash thickens, the lava brightens, it spits — you have about six seconds before it erupts and throws lava bombs up to forty tiles in every direction. A bomb destroys whatever it lands on: the ship, scenery, even a landbot.
- **Wind farms.** Five rows of three turbines stand about the map, and they don't harvest wind — they make it. Each rotor throws a stream of air twenty tiles out in front of it and pulls a weaker draught in from behind. Stray into either and the ship is carried along with the air. The farms swing slowly from side to side and gust as they go, so the wind is never quite where it was. The machines are solid, too: tower, housing and blades will all destroy a ship that touches them.
- **Six landing zones.** The original launchpad plus five outposts spread across the map. Any of them refuels you, and the last one you touched is where your next ship appears.
- **A world that wraps.** The six-sine landscape repeats exactly every 256 tiles, so the map is now a seamless torus: fly off one edge and you arrive at the other.

**The look**

- Real lighting and sun shadows on the flat-shaded patchwork, with a dusk sky, a ringed neighbour on the horizon and haze that the landscape dissolves into.
- A sea with real waves: a rolling swell that physically moves the surface, breakers that run in along the shore and leave foam behind, sun glitter, and light rippling on the shallow seabed. Open water rolls; sheltered ponds stay calm.
- Clouds: a layer of broken cumulus drifts over the world, trailing soft shadows across land and sea and mirrored in calm water. Climb and you go up into it — the view mists over — and out of the top, to look down on it. Further off, banks of cloud along the horizon catch the last of the sun.
- HDR rendering with bloom, filmic tone mapping, a vignette and MSAA.
- Soft GPU particles: exhaust that bounces and kicks up dust, dark smoke, sparks, tracers, virus spray.
- A chase camera that keeps both the ship and the ground beneath it in frame, pulls back as you climb and shakes when things blow up.
- A proper HUD, title, pause and game-over screens, and synthesised sound for everything.

## How to play

| Input | Action |
| --- | --- |
| **Mouse position** | The flight stick. The direction from screen centre yaws the ship to face that way; the distance from centre sets how steeply it leans forward (and therefore how horizontal the thrust becomes). |
| **Left mouse** · `W` · `↑` | Full thrust along the ship's "up" axis. Burns fuel. |
| **Middle mouse** · `S` · `Shift` · `↓` | Hover at ¼ thrust. Burns half the fuel. Useful for slow descents. |
| **Right mouse** · `Space` · `F` | Fire from the ship's nose. |
| `P` · `Esc` | Pause. (The game also pauses itself when the tab loses focus.) |
| `Q` | Quit to the title screen — from the pause screen or the game-over screen, where there is also a button for it. It ends the run. |
| `M` | Mute / unmute. |
| `Space` · `Enter` · click | Start, and fly again after game over. |

### Goal

- Take off from the launchpad without crashing into the three rockets at its edge.
- Find the **landbots** on the scanner, fly to them, and shoot them down before they turn the land red. Destroy them all to clear the wave.
- Keep the **toxicity** meter below 100%. Shooting mutated (pink) trees is worth extra.
- Watch your fuel. Set down on any **landing zone** slowly enough (sum of velocity components under the safe-landing threshold) to refuel. The last pad you touched is where you respawn.
- Give the **volcanoes** room. Never fly down into a crater, never fly over one that is erupting, and when one starts to rumble, leave. The landing zones are all out of range.
- Mind the **wind farms**. The pale streaks show where the air is moving and which way; fly over a stream, under it close to the turbine, or around it. If you are caught, thrust across the wind to get out of the side of it rather than fighting it head-on. Never drift in behind a rotor — the draught there leads into the blades. No stream reaches a landing zone.
- Cloud hangs above normal flying height. Fly up into it and you are flying blind; the scanner still works.
- From wave 2, dodge — or shoot — the rocks falling out of the sky. A pulsing ring on the ground shows where each will land. From wave 3, landbots in range fire plasma back at you.
- You have 3 ships, and earn another every 10,000 points.

### Reading the screen

- **Ring under the ship** — your position over the ground. It closes in on the shadow as you descend, and over a pad turns **green** if your descent is survivable or **red** if you are coming in too fast.
- **Aim reticle** — where rounds fired right now would strike the ground. It turns red when a landbot is under it.
- **Edge arrows** — red points to the nearest landbot when it is out of view; cyan points to the nearest pad once fuel runs low.
- **Warning rings** — a pulsing ring on the ground marks where each falling rock or lava bomb is about to land.
- **Scanner marks** — orange peaks are volcanoes. One that is flashing is about to erupt; one throwing out rings is erupting, and the rings reach about as far as its lava does. Small white rotors are wind turbines, and the pale fan in front of each is its wind: as long as the stream, and pointing the way it is blowing right now.
- **Wind streaks** — pale lines in the air are a turbine's wind, moving at the speed of the air. The status chip reads **Crosswind** when it has hold of you and **Gale** when it has you badly.
- **Beacons** — every landing zone throws a beam of light upward. Amber marks the pad you will respawn on.

The control scheme is the original: the mouse is essentially a virtual flight stick. Push it toward where you want to go, click to thrust. There is still no auto-pilot and nothing aims for you — the reticle only shows where the rounds are already going. The only thing between you and the rocks is your wrist.

## Getting started

> **No setup needed?** A live build is hosted at https://lander-game.netlify.app/ — just open it in any modern desktop browser, click the canvas, and play.

To run locally requires Node 18+.

```bash
cd web
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173) and click on the canvas to give audio focus. You'll hear the engine drone the moment you hold LMB.

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
    ├── index.html           HUD markup + styles, title / pause / game-over overlays
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── main.ts          Scene assembly, fixed-timestep loop, collisions, glue
        ├── game.ts          Attack waves, scoring, what ends a run
        ├── constants.ts     Constants ported from LanderSrc.txt:34-178
        ├── input.ts         Mouse position + buttons, keyboard alternatives
        ├── orientation.ts   Mouse polar → ship yaw + pitch quaternion
        ├── physics.ts       Friction, thrust, gravity, fuel, collision, lives
        ├── terrain.ts       Six-sine Fourier altitude, world wrap, landing zones, volcano cones, wind farm sites
        ├── terrainMesh.ts   Lit patchwork terrain as static chunks; virus recolouring
        ├── infection.ts     Per-tile virus level, toxicity, post-wave recovery
        ├── landbots.ts      The saucers: wandering, spraying, plasma, meshes
        ├── projectiles.ts   Bullets, plasma bolts, falling rocks, lava bombs
        ├── volcanoes.ts     Eruption cycle, lava fountains and bombs, crater hazards
        ├── turbines.ts      Wind turbines: the wind field, streaks, meshes, collisions
        ├── particles.ts     Soft GPU point sprites: exhaust, sparks, smoke, spray
        ├── scenery.ts       6 ported object meshes, instanced; mutation; wreck smoke
        ├── ship.ts          objectPlayer mesh (9 verts, 9 faces) + engine light
        ├── shadow.ts        Ground markers: shadow, landing ring, aim reticle
        ├── landingPads.ts   Pad decks, edge lights, beacons
        ├── sky.ts           Dusk sky dome shader, with cloud banks on the horizon
        ├── clouds.ts        The cloud layer: weather map, shadows, the cloud itself
        ├── water.ts         The sea: Gerstner swell, breakers, foam, reflection
        ├── camera.ts        Chase camera
        ├── post.ts          HDR → bloom → grade → tone mapping
        ├── minimap.ts       The scanner
        ├── hud.ts           Everything that touches the DOM overlay
        ├── env.ts           Sun direction, haze colour, shared shader clock
        └── audio.ts         Synthesised engine, weapons, alarms, cues
```

## What's faithful, what's adapted

The flight is held as close to the original as is reasonable for the medium. The game built around it is new, and a few things diverge intentionally:

| System | Port | Notes |
| --- | --- | --- |
| Six-sine Fourier landscape | **Faithful** | Exact formula from `GetLandscapeAltitude` (LanderSrc.txt:1285-1465). The mesh now continues below the waterline as seabed instead of clamping flat |
| Ship mesh (`objectPlayer`) | **Faithful** | 9 verts, 9 faces, original Archimedes 12-bit colours — now lit rather than drawn flat |
| Scenery meshes | **Faithful** | Rocket, small/tall leafy tree, fir tree, gazebo, building, smoking remains — all ported vertex-for-vertex. Trees get a little per-tile variety in size and facing |
| Flight model | **Faithful** | Friction, thrust along ship's up vector, gravity, hover at ¼ thrust |
| Mouse → orientation | **Faithful** | Yaw around vertical from mouse polar angle; forward-lean from polar distance; original damping |
| Fuel | **Faithful** | Source rates of 4/frame thrust, 2/frame hover at 50 fps, refill 32/frame on pad — scaled to 60 fps |
| Collision (objects) | **Faithful** | Within `SAFE_HEIGHT` (1.5 tiles) and on a non-empty tile → crash |
| Collision (terrain) | **Faithful** | Bottom of ship below terrain → crash; on a pad with low velocity → safe landing |
| Bullets | **Adapted** | Fired from the nose inheriting the ship's velocity, as in the source. One round every 3 frames rather than every frame, ~50% more range, and a round must be down among an object to hit it rather than merely pass over its tile |
| World | **Adapted** | The landscape is periodic in 256 tiles, as the original's object map was; the port now uses that to wrap the whole world. Five outpost pads join the original launchpad |
| Scoring | **Adapted** | Landbots 500+, mutated trees 60, rocks 150, scenery 10, plus a clean-land bonus per wave. Persistent high score in `localStorage` |
| Gravity ramp | **Adapted** | Source ramps at score 1024 / 1488 (ammo-based); port ramps by wave — 1.2× / 1.4× / 1.6× at waves 4 / 7 / 10 |
| Falling rocks | **Adapted** | Start in wave 2 and thicken with each wave. They are tumbling 3D lumps that can be shot down, and each marks its landing point |
| Colours | **Adapted** | The original palette was authored to be shown unlit. Its darkest entries are lifted so a sunlit face lands about where the original drew it |
| Camera | **Adapted** | Source clamped Y at sky boundary and used a fixed projection. Port keeps the fixed heading (which is what makes the mouse a flight stick) but follows on a spring, frames ship and ground together, and pulls back with altitude |
| Gravity rate | **Softened** | Source-matched gravity (≈0.586 tiles/sec²) is brutal at modern monitor sizes; port runs at ~30% so the thrust:gravity margin is more forgiving |
| Landbots, virus, waves, scanner | **New** | Not in Lander at all — modelled on Zarch's seeders, virus, attack waves and radar |
| Volcanoes | **New** | In neither game. Three cones are stamped into the Fourier landscape as real terrain; eruptions throw lava bombs that share the falling rocks' flight and landing markers |
| Wind turbines | **New** | In neither game. Five farms blow streams of air that drag the ship along; the wind is applied to the ship's velocity before the ported flight model runs, which is itself untouched |
| Rendering | **New** | Lighting, shadows, sky, sea, particles and post-processing replace the original's flat-filled polygons |
| Audio | **Synthesised** | Engine drone, weapons, explosions, landbot hum, volcano rumble, turbine wind, alarms and cues — all generated procedurally via WebAudio. Original used the Archimedes' sample-based sound chip; no audio assets are bundled |

## Implementation highlights

- **60 Hz fixed-step physics**, decoupled from render rate, with rendering interpolated between the last two sim states — so motion is smooth on a 120 Hz or 144 Hz display too. The whole simulation step costs a few microseconds.
- **Static terrain, nothing rebuilt per frame.** The full 256×256 map is meshed once as an 8×8 grid of chunks. Each frame the chunks are simply slid to whichever copy of themselves is nearest the ship, which is all it takes to make the world wrap. When the virus changes a tile, only that tile's colour is rewritten and only that slice of the buffer is re-sent to the GPU.
- **Instanced scenery.** Every tree, building and wreck on the map is drawn with about a dozen `InstancedMesh` draw calls, one per blueprint.
- **Struct-of-arrays particles.** Thousands of sprites in flat typed arrays — no per-particle objects, no garbage — drawn as two `Points` clouds (additive glow, alpha-blended haze) with a shader that also interpolates each sprite between sim steps.
- **Linear HDR pipeline.** The scene renders to a multisampled half-float target that is resolved once; bloom and grading then run on plain buffers in linear HDR; tone mapping and the sRGB transfer happen last. Emissive things (exhaust, tracers, pad lights, the virus glow) are authored brighter than white so only they bloom.
- **One shadow map that follows the ship**, with its frustum snapped to whole texels so shadow edges don't crawl.
- **A sea made of Gerstner waves.** Nine trochoidal waves displace a vertex grid that is dense near the ship and thins toward the haze; the same equations are re-evaluated per pixel, with shorter ripples added, so the lighting stays smooth however coarse the mesh. Every wave vector is a whole number of cycles per 256 tiles, so the sea is exactly periodic over the map and nothing jumps when the world wraps. A 256×256 chart of depth and "openness" damps the swell as water shoals, keeps ponds calm, and drives colour, caustics and the breakers that follow the depth contours in to shore.
- **Sky and sea share one colour function**, so what the water reflects is exactly what is drawn overhead. The sky is a single dome whose horizon resolves to exactly the fog colour; it is pinned to the far plane and drawn after everything solid, so its shader only runs for the strip of sky actually in view.
- **One weather map drives all the cloud.** A 256×256 texture, built once and tiling exactly with the world, is read by the terrain, scenery and sea shaders for cloud shadow, by the sea again for reflections, and by a stack of translucent slices that draw the cloud itself. Because they all read the same map they always agree, and the weather moves simply by sliding two channels of it at different speeds. Each pixel of a slice samples at a random point along its view ray, which turns what would be visible terraces into soft volume.
- **Adaptive resolution.** Pixel ratio is capped at 2 and steps down automatically if the machine can't hold frame rate.
- **Synthesised audio** — every sound is oscillators and filtered noise. No samples.
- `localStorage` **high score and mute preference** persist across page reloads.

## Roadmap

- \[x\] Hide mouse cursor when over the canvas (it becomes a flight-stick indicator)
- \[x\] Mute toggle (`M`)
- \[x\] Title / pause screen
- \[ \] Reset high-score control
- \[ \] Touch controls for mobile
- \[ \] More of Zarch's bestiary: bombers, fighters, the things that live in the sea

## Credits

- **Lander** is © **David J. Braben**, 1987. Originally shipped on the Acorn Archimedes Welcome Pack.
- The landbots, virus, attack waves and scanner are modelled on **Zarch** (released as *Virus* on other platforms), also © **David J. Braben**, 1987 — the full game Lander was the demo for. No code or assets from either game are used.
- The annotated disassembly used as reference is © **Mark Moxon** and published at https://lander.bbcelite.com/. The source code itself — buildable on Mac, Linux and Windows — is on GitHub at markmoxon/lander-source-code-acorn-archimedes(Mac/Linux build instructions). The site's Deep Dives section is an outstanding read for anyone curious about 3D graphics on 1987 hardware.
- This recreation is a clean-room re-implementation written for preservation and educational purposes. The original disassembly is **not** redistributed in this repo (`LanderSrc.txt` is `.gitignore`d). Visit Mark Moxon's repo above for the source.

## Licence

The port's source code — everything under `web/src/`, plus `web/index.html`and the project tooling — is released under the MIT licence.

The original game and its disassembly remain the intellectual property of their respective copyright holders.