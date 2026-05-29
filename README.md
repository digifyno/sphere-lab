# Sphere Lab

**Live demo: [spherelab.clickdeeper.com](https://spherelab.clickdeeper.com/)**

A browser-based 2D physics sandbox where twenty-two materials — steel, rubber,
glass, bowling, neon, gold, plasma, ice, magnet, mercury, diamond, obsidian,
TNT, lava, rock, slime, wood, sand, balloon, antimatter, honey, water — interact
across twenty-two scenes. A **warm-started sequential-impulse solver** (proper
Coulomb friction cone + energy-free position correction) keeps stacks and
granular piles rock-solid; on top of it sit Newtonian **N-body gravity** and a
**particle fluid**. Built on HTML5 canvas with zero dependencies, modal
impact-sound synthesis, and per-material surface detail (brushed metal,
crystalline ice, iron-filing magnets, dented gold).

## Running it

Fastest way: open the [live demo](https://spherelab.clickdeeper.com/).

To run locally, any static file server works — ES modules won't load over
`file://`:

```bash
git clone <this-repo>
cd sphere-lab
./serve.sh       # or:  python3 -m http.server 8000
```

Open `http://localhost:8000/`.

## What's in it

### Physics

- **Warm-started sequential-impulse contact solver** for ball/ball collisions:
  each contact reuses last frame's accumulated impulse, friction is clamped to a
  proper **Coulomb cone** against the accumulated normal impulse, and overlap is
  removed by an energy-free **split-impulse (NGS)** position pass — so stacks and
  granular piles settle solid instead of jittering apart. Settled contacts sleep
  as islands.
- Continuous collision detection against walls, pegs, and pinball flippers
  (substep count derived from velocity); fixed-timestep at 240 Hz.
- **Newtonian N-body gravitation** (Orbits scene): every ball attracts every
  other with a softened 1/r² force; planets orbit at v = √(G·M / R).
- **Particle fluid** (water): surface-tension cohesion + viscosity between drops,
  with the rigid solver supplying incompressibility — water flows, sloshes, and
  finds its level instead of merging into blobs.
- Per-material density, friction, restitution, rolling resistance, thermal
  conductivity, and squash behaviour (viscoelastic rubber jiggles back over
  ~150 ms; steel snaps back instantly).
- Thermal conduction on contact; fragile materials crack then shatter; gold
  dents permanently and anneals when re-heated; mercury/honey/lava pool by
  merging.
- Buoyancy by density (wood floats, steel sinks), **helium lift** (balloons rise
  and bob on taut tethers), granular **sand** that holds its angle of repose, and
  **antimatter** that annihilates ordinary matter in a mass-scaled blast.
- Magnetic polarity (opposite poles attract, like poles repel), Magnus curve on
  spinning balls, conveyor drag, vortex + solar fields, TNT chain detonation.

### Sound

- Procedural modal synthesis: each material has its own inharmonic mode
  stack, attack transient, and reverb send. Cross-material damping lets a
  soft body quiet a hard one (rubber hitting steel muffles the ring).
- Continuous per-material rolling / sliding voice — rubber squeaks, ice
  hisses, steel whines, bowling rumbles — with size-dependent pitch and
  stereo panning weighted by ball position.
- Plasma-to-plasma arcs produce transient crackle pops over a sustained
  electric buzz that fades in with proximity.
- Voice budget, per-ball cooldowns, and sliding-velocity gates keep dense
  collision bursts from turning into mush.

### Visuals

- Per-material body shader: chromatic refraction for glass, Fresnel edge
  bias, metallic environment bands, primary + secondary specular.
- Procedural surface micro-textures — brushed steel, rubber grain, gold
  glitter, plasma filaments, iron-filing magnets, frosted ice — baked
  once per material and rotating with the ball.
- Heat-reactive effects: ice melts with shrinking radius and water droplets,
  hot rubber smokes, metals throw embers and gain an inner forge glow that
  breathes.
- Magnetic hemispheres (red north / blue south) rotate with the ball.
- Sparks draw as velocity-aligned streaks, smoke clouds have off-center
  turbulent shapes.
- Post-FX pass: bloom, chromatic aberration, film grain, motion streaks.

## Scenes

Avalanche · Balloons · Billiards · Chaos · Cloth · Conveyor · Cradle · Domino ·
Fluid · Galton · Jelly · Magnets · Orbits · Pinball · Plinko · Rain · Sandbox ·
Sandpile · Solar · Tower · Vortex · Water

## Controls

Tools are bound to the top row of the keyboard:

| Key | Tool    | Action                                    |
|-----|---------|-------------------------------------------|
| Q   | Spawn   | Drag from a ball to launch it             |
| W   | Grab    | Pick up and drag a ball                   |
| E   | Draw    | Draw a wall segment                       |
| R   | Erase   | Remove walls                              |
| T   | Link    | Connect two balls with a spring           |
| Y   | Pin     | Fix a ball in place                       |
| U   | Push    | Radial push force at the cursor           |
| O   | Attract | Radial pull force at the cursor           |
| I   | Heat    | Heat balls near the cursor                |

Arrow keys fire the pinball flippers. `Ctrl-Z` undoes. The HUD exposes live
sliders for gravity, drag, restitution, friction, Magnus, wind, spawn radius,
and **solver iterations**, plus toggles for bloom, shadows, refraction, trails,
chromatic aberration, film grain, motion streaks, and solver **warm-starting**
(turn it off to feel the difference in a stack).

## Tests

A head-less harness runs the *real* simulation under a tiny browser shim — no
browser or dependencies required:

```bash
npm test
```

- `tests/sim.test.mjs` — physics invariants: momentum conservation, no energy
  injection, resting stacks settle + sleep, no tunnelling, Newton's-cradle
  transfer, bound N-body orbits, buoyancy, helium lift, annihilation, fluid flow.
- `tests/scenes.test.mjs` — every scene steps for 3 s with no NaN/throw.
- `tests/boot.test.mjs` — boots the whole app (UI, prefs, scene, loop) headless.

## Architecture

Single-page ES modules, no build step. See `CLAUDE.md` for the full file
map. Layer overview:

- `src/core/` — shared state, math, theme, undo, persistence.
- `src/entities/` — ball, particle, and material definitions.
- `src/physics/` — integrator (`step.js`), broadphase, the warm-started contact
  solver (`contactSolver.js`), contact side-effects (`collisions.js`), forces
  (gravity, N-body, fluid, magnetism, buoyancy), flippers, fracture, TNT.
- `src/render/` — canvas setup, ball shader, world geometry, effects,
  post-FX.
- `src/audio/` — modal sound synthesis and rolling-voice mix.
- `src/scenes/` — the twenty-two scene constructors.
- `src/ui/` — HUD, sliders, inspector, save/load, scene title overlay.
- `tests/` — head-less Node harness (browser shim + invariant/scene/boot tests).

## License

MIT — see [LICENSE](LICENSE).
