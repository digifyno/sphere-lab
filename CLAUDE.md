# SPHERE LAB — project map for AI agents

This is an HTML5 canvas 2D physics sandbox. 22 interactive scenes, 22 materials,
realistic rigid-body dynamics built on a **warm-started sequential-impulse
contact solver** (Coulomb friction cone + energy-free NGS position correction),
plus Newtonian N-body gravity and a particle fluid. **Run with a static server**
(see `serve.sh`) because ES modules can't load over `file://`. A head-less Node
test harness lives in `tests/` — run `npm test` (no dependencies).

## Quick task → file map

| "I want to change…"                | Edit                                      |
| ---------------------------------- | ----------------------------------------- |
| A material's density / bounciness  | `src/entities/materials.js`               |
| A scene's layout                   | `src/scenes/<name>.js`                    |
| Add a new scene                    | new file in `src/scenes/` + register in `src/scenes/index.js` + new `<button class="tab">` in `index.html` + tagline in `src/ui/sceneTitle.js` |
| Ball-ball solver (warm start, friction cone, NGS, rolling moment) | `src/physics/contactSolver.js` |
| Contact side-effects (FX, sound, fracture, heat)  | `src/physics/collisions.js::ballContactEvent` |
| Ball/wall + ball/peg collision math | `src/physics/collisions.js::collideWall / collidePeg` |
| Soft bodies (jelly/slime lattice)  | `src/entities/softBody.js` (build/cull) + `src/physics/softForces.js` (pressure + shape matching) + `src/render/softBody.js` |
| Brittle fracture (energy criterion, shards) | `src/physics/fracture.js` |
| Water/honey particle fluid (PBF)   | `src/physics/sph.js` (per-material `sphVisc`) |
| Mercury splash / lava crust / balloon pop | `src/physics/collisions.js::tryFluidSplit / tryFluidMerge / tryPop` |
| N-body gravity                     | `src/physics/forces.js::applyNbody`       |
| Antimatter annihilation            | `src/physics/collisions.js::annihilate`   |
| Helium lift (balloons)             | `src/physics/step.js` (`mat.lift`)        |
| Solver iterations / warm-start     | `src/core/config.js` (`solverVel/solverPos/warmStart`) + UI `s-solver`/`t-warm` |
| Head-less physics tests            | `tests/` (`npm test`)                     |
| Pinball flippers (angle + kick)    | `src/physics/flippers.js`                 |
| Magnetism between balls            | `src/physics/forces.js::applyMagnetism`   |
| Water ripples (spawn + decay)      | `src/physics/forces.js` + `src/render/world.js::drawWater` |
| Conveyor-belt walls                | `src/physics/collisions.js::collideWall` (`wall.conveyorV`) |
| Solver loop / field forces         | `src/physics/step.js` + `src/physics/forces.js` |
| Attract / Push tool forces         | `src/physics/step.js` (in-loop per-ball) |
| Broadphase (pair generation)       | `src/physics/broadphase.js`               |
| How a ball is drawn                | `src/render/ball.js`                      |
| Backgrounds / vortex / water / sun | `src/render/background.js`, `src/render/world.js` |
| Bloom, grain, chromatic aberration | `src/render/postfx.js`                    |
| Impact rings (expanding FX)        | `src/entities/particles.js::spawnImpact` + `src/render/effects.js` |
| Telemetry mini-graphs              | `src/render/statsGraph.js` (generic sparkline) |
| Mouse-tool behaviour               | `src/input/mouse.js` + `src/input/tools.js` |
| Keyboard shortcuts                 | `src/input/keyboard.js` (arrows → flippers, Ctrl-Z → undo) |
| Undo stack                         | `src/core/undo.js`                        |
| Ball inspector panel               | `src/ui/inspector.js`                     |
| Scene title fade overlay           | `src/ui/sceneTitle.js` (taglines live here) |
| Save / Load / Screenshot           | `src/ui/save.js`                          |
| Theme swaps (amber/cyan/violet/…)  | `src/core/theme.js` + `[data-theme]` CSS blocks |
| Pref persistence (toggles, volume) | `src/core/persistence.js`                 |
| HUD buttons / sliders              | `src/ui/*`                                |
| Design tokens (color/spacing/font) | `styles/main.css` `:root` block           |
| Ball stats (mass, heat, trail)     | `src/entities/ball.js`                    |
| Audio synthesis (modal)            | `src/audio/sound.js` (MODAL table + `emitMaterialSound`) |
| Global physics knobs (gravity etc) | `src/core/config.js` (the `PHYS` object)  |
| Camera behaviour                   | `src/core/world.js` (the `cam` object)    |
| Tick rate / main loop order        | `src/loop.js`                             |

## Architecture (top-down)

```
index.html
  └── src/main.js                   bootstraps UI, input, loads default scene
        └── src/loop.js             requestAnimationFrame driver
              ├── src/physics/step.js               integrate + orchestrate
              │     ├── physics/forces.js           gravity, vortex, buoyancy, N-body, fluid
              │     ├── physics/broadphase.js       grid → candidate pairs
              │     ├── physics/contactSolver.js    warm-started ball-ball solver (+ NGS)
              │     ├── physics/collisions.js       wall/peg math + per-contact side-effects
              │     └── physics/materialMods.js     heat / velocity effects
              └── src/render/*
                    ├── canvas.js                   setup + resize + offscreen buffers
                    ├── background.js               gradient, stars, grid, vignette
                    ├── world.js                    walls, pegs, water, vortex, sun
                    ├── ball.js                     per-ball shading + refraction
                    ├── effects.js                  AO, particles, lens flare
                    ├── postfx.js                   bloom, chromatic aberration, grain
                    └── fpsGraph.js                 HUD sparkline
```

## Audio (modal synthesis)

`src/audio/sound.js` generates material-realistic impact sounds using
**modal synthesis** — the physical way real objects make noise:

- **Attack transient** — a short filtered-noise burst modelling the contact
  click. Material-specific: highpass for metals (`STEEL` @5 kHz, `GLASS`
  @7 kHz, `ICE` @8.5 kHz), lowpass for rubbery thuds (`RUBBER` @680 Hz,
  `BOWLING` @360 Hz), bandpass for mercury.
- **Modal stack** — sine oscillators at each material's natural frequencies,
  each with its own amplitude and decay. Steel rings 9 inharmonic modes, the
  fundamental for ~1.3 s; rubber's 120 Hz fundamental dies in ~110 ms.
- **Cross-material damping** — a collision call `emitMaterialSound(mat, str,
  otherSoftness)` dampens the modes by `(1 - otherSoftness · 0.75)`. Rubber
  (`deform = 1.0`) hitting steel absorbs most of the impulse, so the steel
  barely rings and the dominant sound is the rubber thud.
- **Detune** — each mode gets a small (±0.75 %) random detune per hit so
  repeats aren't identical.
- **Reverb bus** — modes above 1.5 kHz route a little signal to a short
  convolver; low modes don't (rooms reverb high frequencies).

Fragile shatter uses `Snd.shatter(mat)` which plays the material's voice at
full power plus extra high sine partials and a broad noise wash.

## Material realism

Each material in `src/entities/materials.js` is tuned to feel physically
distinct. Densities are real-world values in g/cm³ — gold (19.3) is ≈17× the
mass of rubber at the same radius; a sand grain is quartz (2.65). Bounce +
friction are kinetic literature values; the orderings (rubber out-bounces
steel, diamond out-bounces glass, sand grips harder than rubber, …) are
asserted by `tests/sim.test.mjs::testMaterialOrderings` — if you retune a
constant, that test is the contract.

| Material | Density | Bounce | Friction | Special |
| -------- | ------- | ------ | -------- | ------- |
| Steel    | 7.85    | 0.75   | 0.42     | Sharp ping + warm sparks + metallic ring |
| Rubber   | 1.15    | 0.88   | 0.90     | `deform=1` (big squash, slow recovery), muffled thud |
| Glass    | 2.5     | 0.93   | 0.32     | **Fragile** above 550 px/s, sparkle FX, tink sound |
| Bowling  | 1.35    | 0.32   | 0.35     | Deep thud, dust puff, absorbs energy (real 7.26 kg/Ø22 cm) |
| Neon     | 0.9     | 0.78   | 0.40     | Emissive, colored sparkle (stylized) |
| Gold     | 19.3    | 0.38   | 0.47     | Very heavy, `deform=0.55` (dents), warm ding |
| Plasma   | 0.3     | 0.70   | 0.18     | Detuned buzz, bright sparkle, lots of glow (stylized) |
| Ice      | 0.92    | 0.32   | 0.04     | **Fragile** above 380 px/s, `chip=0.25` (chips every hit), floats |
| Magnet   | 7.5     | 0.62   | 0.42     | Mutual `1/r²` attraction, force ∝ both magnets' volumes (NdFeB density) |
| Mercury  | 13.55   | 0.22   | 0.08     | `fluid=true` — merges with other mercury at low relative speed |
| Wood     | 0.62    | 0.42   | 0.62     | Floats (ρ < water); anisotropic — slides easier along its grain (`fricAniso`) |
| Sand     | 2.65    | 0.14   | 0.70     | `granular` quartz grains — interlock + solver rolling moment, heaps at repose |
| Balloon  | 0.16    | 0.74   | 0.65     | `lift=1` rises (`dragMul=2` caps rise below `popV`); a membrane — `pops` on slams (>520 px/s), hot or sharp contact |
| Antimatter | 1.0   | 0.50   | 0.20     | `antimatter` — annihilates ordinary matter on contact |
| Honey    | 1.42    | 0.05   | 0.06     | `fluidSim` at ~9× water's viscosity (`sphVisc`) — oozes, `cling`s to walls; LOW friction like every liquid (no dry-friction yield stress) |
| Water    | 1.0     | 0.04   | 0.02     | `fluidSim=true` — particle fluid: cohesion + viscosity, flows + levels |

(Also defined in `materials.js`: diamond 3.52/0.96, obsidian 2.55/0.80 — a
true glass, elastic until it cleaves — TNT 1.65, lava, rock 2.90 basalt,
slime, jelly — a real soft body, see `entities/softBody.js`.)

Key behaviours:
- **Squash amplitude + recovery** scale with `material.deform`. Rubber compresses heavily and stays compressed for ~150 ms; steel snaps back within one frame.
- **Jelly + slime are real soft bodies** when spawned: a ring of node balls held
  by perimeter springs + shape matching + gas pressure (`entities/softBody.js`,
  `physics/softForces.js`). Jelly wobbles (light damping), slime oozes
  (overdamped) and its nodes keep `adhesive` so the blob glues onto things.
- **Fragile materials** (glass, ice, obsidian) shatter on an impact-ENERGY
  criterion (½·m_eff·vn² vs a crack energy ∝ r — `physics/fracture.js`): a
  pebble can't crack a boulder, big balls break easier. 7-10 power-law-sized
  fragment balls (~3 s lifespan) rendered as jagged shards + particle dust +
  a shatter sound. Fragment area ≈ 92 % of the disk; KE never increases.
- **Fragments** (`b.isFragment === true`) don't recursively shatter and fade out in their last 0.8 s.
- **Chip materials** emit a debris chip every collision (not just at fracture) — ice perpetually sheds as it rolls.
- **Fluid materials** (`material.fluid`) of the same kind merge on slow contact, conserving mass (area in 2D) — and split back into beads when slammed (`tryFluidSplit`). Molten lava only merges/splashes while hot; a crusted blob (heat < 0.25) stacks until it solidifies to rock.
- **Gold dents above a yield velocity** (170 px/s) and each dent is plastic
  work — 18 % of the separating velocity is consumed (momentum-conserving).
  Heat anneals dents away.

## Core concepts

- **`PHYS`** (`core/config.js`) holds mutable sim parameters. Every frame reads
  from it. UI sliders and toggles mutate it live.
- **`W`** (`core/world.js`) is the current scene's geometry + state. Reset on
  every `loadScene(name)`.
- **`cam`** (`core/world.js`) has `{x, y, zoom}` (current) and `{tx, ty, tz}`
  (target). `loop.js` smooths current toward target each frame.
- **`balls`** (`entities/ball.js`) is the global ball pool. Scenes push into
  it; `physicsStep` iterates it; the solver culls escaped entries.
- **`particles`** (`entities/particles.js`) is the transient FX pool, mutated
  by collision code + the step loop cleans it.
- **Fixed timestep:** physics ticks at 240 Hz via an accumulator in
  `loop.js`. Rendering runs at display rate.
- **Modules are singletons.** We don't do DI — a module's top-level state IS
  the shared state. Import, use.

## Physics model (crib notes)

- **Ball-ball contacts use a warm-started sequential-impulse solver**
  (`contactSolver.js`), not a one-shot impulse. Per step it builds the contact
  manifold once, replays each contact's cached impulse (warm start, keyed by
  ball-id pair), runs `PHYS.solverVel` velocity iterations (normal then friction,
  the friction clamped to ±μ·Pₙ on the *accumulated* normal impulse — a true
  Coulomb cone), then `PHYS.solverPos` **NGS** position iterations that remove
  penetration with no velocity change (no energy injection). Restitution uses a
  velocity slop (`REST_SLOP`) so resting contacts don't micro-bounce. **Sleeping
  islands:** a sleeping ball is immovable for gentle contacts and only wakes on
  an impact above `WAKE_V`, so piles settle bottom-up without a wake cascade.
- **Walls / pegs / flippers stay in the CCD path** (`collideWall/collidePeg/
  collideFlipper`) — static single-shot projection. A position-only
  `clampStatics()` keeps balls out of geometry after the ball-ball push.
- **Contact side-effects** (sparks, modal sound, fracture, TNT, slime, dents,
  cracks, squash, heat conduction, annihilation) are fired **once per contact**
  by `collisions.js::ballContactEvent`, which the solver calls via an `events`
  hook. The legacy impulse magnitude `(1+e)·|vn|/Σ(1/m)` is reconstructed there
  so every FX/sound threshold is unchanged — the solver itself is pure and
  head-less-testable (no audio/DOM imports). Heat conduction there is
  per-SECOND (`dh·condA·condB·dt` — τ ≈ 0.6 s for a steel pair, effectively
  never for insulators), so it reads on screen and survives tick-rate changes.
- `I = ½ m r²` (solid disk) feeds rotational response to friction.
- **Restitution combines as `min(eA, eB)`** — the softer material dominates,
  matches experiment better than an arithmetic average. **Tangential**
  restitution (`tanRest`, super-ball slip reversal) combines as **max** — the
  COMPLIANT body's contact patch stores the shear — and is capped by the
  Coulomb cone, so it redirects energy into spin, never injects any. Passive
  restitution is capped at 1 everywhere (solver, walls, pegs); active sources
  (bouncy wall ×1.4, bumper ×1.8, flipper ×1.05) ride on top, uncapped.
- **Velocity-dependent restitution** (`materialMods.js::velRestScale`) makes
  hard impacts lose more energy than gentle ones.
- **Temperature effects** (`materialMods.js::heatRestMod / heatFricMod`) —
  hot rubber mushes, ice melts, steel goes plastic, plasma gets bouncier.
- **Friction combination** uses geometric mean (`√(μa·μb)`). Material μ values
  are real kinetic coefficients and `PHYS.frictionMul` defaults to **1.0**
  (the slider multiplies physical truth, not a hidden 0.5 haircut).
- **Wood is anisotropic** (`materialMods.js::anisoFric`): μ·(1−fricAniso·cos²θ)
  between the slip tangent and the grain axis (rotates with the ball; same
  axis as the brushed highlight). Slides ~45 % easier along the grain.
- **Granular contacts get a rolling-resistance moment** in the solver: capped
  by `μr·Pₙ·r` (DEM rolling friction) for pairs where both have the explicit
  `mat.granular` flag (`roll` supplies μr but is a damping coefficient — honey's
  0.25 must not inherit sand physics), plus an impact-gated interlock (μ×2.2 on
  genuine hits) — round disks otherwise skate/roll and a sand pile can't hold
  its angle of repose.
- **Static friction is cone-aware** (`step.js`): the low-speed stick only
  holds while `|nx| ≤ μ·|ny|` — on steeper contacts gravity wins and the ball
  keeps sliding (this is what stops sand welding into vertical towers).
- **Rolling enhancement** — wall friction is 1.6× when |vₙ| < 80 to damp
  jitter so balls settle instead of buzzing.
- **CCD:** each ball's motion is substepped so |Δx per step| < 0.6·r.
- **Magnus** uses a velocity snapshot; the sideways acceleration is `∝ ω·v/ρ`
  — radius-free (Magnus force and mass both scale with cross-section), density-
  aware (a balloon swerves, gold barely bends), saturating with the spin
  parameter S = ω·r/|v|, and **airborne-only** (`groundT ≤ 0`): lift needs a
  free stream, and in-pile "lift" measurably propped up heap slopes.
- **Drag** deceleration is `(k_lin + k_quad·|v|) / (ρ·r)` — frontal exposure
  grows one power of r slower than mass, so shards flutter, boulders plough,
  and dense materials coast (normalised at ρ=1, r=20: the default ball keeps
  the tuned feel).
- **Broadphase:** uniform spatial hash with cell = max(40, 2.2·maxR). Each
  ball is hashed into every cell its swept AABB covers; same-cell pairs are
  deduped by id (the swept box is what feeds ball-ball CCD).
- **Buoyancy:** Archimedes — `F = ρ_fluid · V_sub · g`, with `ρ_fluid = 1.0`
  and the float line at exactly ρ = 1: wood floats high, ice rides ~90 %
  submerged, rubber (1.15) and jelly (1.05) sink slowly. Balloons additionally
  get `mat.lift` anti-gravity in `step.js` and rise. A ball suspended in plane
  water with no contact support never sleeps (near-neutral buoyancy would
  otherwise freeze it mid-water).
- **N-body gravity** (`forces.js::applyNbody`, gated on `W.nbody`): mutual
  softened 1/r² attraction between all balls. Pinned bodies (the star) attract
  without drifting; air drag is suppressed when `W.nbody` so orbits persist.
  `scenes/orbits.js` seeds circular orbits at `v = √(NBODY_G·M / R)`.
- **Particle fluid** (`physics/sph.js`, materials with `fluidSim`): PBF density
  projection + XSPH viscosity, grouped **per material** — each fluid reads its
  own `sphVisc` (water 0.08, honey 0.70), so honey visibly oozes where water
  sloshes. Liquids carry near-zero Coulomb friction — their thickness lives in
  viscosity + `roll` damping + `cling`, which resist motion, not load, so a
  honey heap creeps flat instead of standing at the friction cone. Neither merges (that's the separate `fluid` flag used by
  mercury/lava, which also `tryFluidSplit` into beads when slammed).
- **Soft bodies** (`mat.soft`, built by `buildSoftBall`): a ring of ≤12 node
  balls (no centre ball) held by perimeter springs + **shape matching**
  (best-fit rotation of the rest ring, `softShape` of the error closed per
  step) + area-preserving gas pressure, damped only in its non-rigid motion.
  Intra-blob pairs are skipped by the solver. Jelly wobbles; slime oozes and
  sticks.
- **Antimatter** (`mat.antimatter`): touching ordinary matter triggers
  `collisions.js::annihilate` — both balls die in a mass-scaled blast.
- **Sleeping:** balls with `|v| < 9` and `|ω| < 1.2` for `0.45 s` go to sleep
  (skip force integration + CCD). Woken by an impact contact, tool interaction,
  spring force, magnetism, N-body pull, or gravity toggle.

## Render pipeline (per frame, in order)

1. `canvas.clear + drawBackground` (or motion-blur translucent fill).
2. Apply camera transform.
3. `drawSolarCenter → drawWalls → drawPegs → drawFlippers → drawConstraints
    → drawSprings → drawVortex → drawBallShadows`.
4. If any refractive ball is onscreen: snapshot the current paint into
   `sceneCanvas` — used as the glass lens texture.
5. `drawTrail → drawAO → drawBall (per ball) → drawWater → drawParticles
    → drawLensFlares`.
6. Tool previews (slingshot, wall draft, link ghost, push / attract radius).
7. Pop camera transform.
8. `doBloomPass` — **two-pass** (bright threshold → H blur → V blur →
   additive composite).
9. `doPostFX` (chromatic aberration + film grain).
10. HUD text + inspector + scene title update.

### Ball shader
- Chromatic refraction (R/G/B sampled at slightly different scales) for glass.
- Radial body gradient, branched by `material.metallic`.
- Fresnel-style concentric rim highlight (edge brighter, metals stronger).
- Faux metallic env — horizontal sky/horizon/ground bands for `metallic > 0.5`.
- Primary + secondary specular highlights driven by light direction.
- Rotation markers (twin dots) so spin is visible.
- Sleeping balls show a small `z` when `PHYS.showVec` is on.

### Shadows
- Three-layer blurred ground shadow (umbra / mid / penumbra) via canvas
  `filter: blur(3px)` — reads as real penumbra instead of a sharp ellipse.

## Conventions

- **ES modules only.** Imports spell out the dependency graph — no globals.
- **One concept per file.** Files stay under ~300 lines so they fit in a
  single AI read.
- **JSDoc types** on public exports — especially `Ball`, `Material`, `Wall`,
  `Peg`, `Spring`, `Particle`.
- **`'use strict'` is implicit** in modules. Don't add it.
- **No comments for "what"** — the code says that. Comments are for "why".
- **Mutate, don't rebuild.** Ball/particle pools use `length = 0` to clear,
  not reassignment, so other modules' references stay valid.

## Gotchas

- **`file://` won't work.** Browsers block ES modules over the file protocol.
  Run `./serve.sh` (or `python3 -m http.server 8000`) and open
  `http://localhost:8000/`.
- **DOM globals are only safe after `DOMContentLoaded`.** Modules declared
  with `type="module"` are deferred, so this is automatically handled for
  top-level DOM queries in `render/canvas.js` etc.
- **Order of imports matters visually, not semantically.** ES modules hoist
  all top-level bindings; circular imports resolve lazily. Avoid circles —
  if you hit one, extract the shared piece into `src/core/`.
- **`setGravityUI` writes DOM.** Scenes call it, so they must be loaded
  after the DOM is ready (they will be — see above).
- **Ball cap is 260.** Enforced in `spawnBall` to keep the solver tractable.
- **Action buttons have a label span + a kbd span.** Swap the label by writing
  to `span:not(.kbd)`, not `textContent` (see `ui/hud.js::setActionLabel`).
- **Mode pill's text is inside `#mode-text`,** not `#mode-indicator` — the
  outer element also contains the pulsing dot.
- **Tools are selected via `getTool()` each step** — do not cache the value
  across frames. Changing tools mid-hold safely ends the previous hold.
- **Prefs persist automatically** for toggles, theme, volume, and selected
  material. Sim state (balls, walls) is saved only on explicit Save click.
- **Impact rings are `type: 'ring'` particles** — rendered differently and
  skipped by the step integrator's position update.
- **Conveyor direction:** `wall.conveyorV > 0` drags toward (x2, y2).
- **The solver is pure on purpose.** `contactSolver.js` imports no audio/DOM —
  keep it that way so `tests/` can run it head-less. New per-contact effects go
  in `collisions.js::ballContactEvent`, not the solver.
- **Warm-start cache keys on ball ids** (`a.id+'_'+b.id`). Ids never repeat, so
  no stale-pair aliasing; the cache is cleared on `loadScene`.

## Tests

Head-less Node harness in `tests/` — `npm test` (no dependencies). A browser
shim (`tests/shim.mjs`) stubs `document`/`window`/canvas so the **real**
`physicsStep` and the full app boot run under Node (audio is a safe no-op
because `Snd.ctx` stays null).

- `tests/sim.test.mjs` — ~310 physics invariant asserts: momentum conservation,
  no energy injection (total KE+PE never rises), resting stacks settle + sleep,
  no tunnelling, Newton's-cradle transfer, bound N-body orbit, buoyancy by
  density, balloon lift + pop, antimatter annihilation, soft-body shape
  recovery/settling/area/budget, material-constant orderings (AA — the
  contract when retuning `materials.js`), mercury splash, honey-vs-water
  rheology, lava crusting, fracture energy criterion + mass conservation,
  granular slope bounds, gold plasticity, slime adhesion, wood grain,
  heat-conduction rate + conservation (BA), the ρ=1 float line (BB), Magnus
  density/radius scaling (BC), size-aware drag (BD), magnet moment scaling
  (BE), tangential slip reversal off stiff partners (BF), and the passive
  wall/peg restitution cap (BG).
- `tests/scenes.test.mjs` — every registered scene steps 3 s with no NaN/throw.
- `tests/boot.test.mjs` — imports `main.js` (runs `init()`): UI, prefs, scene,
  loop wiring must resolve cleanly.

When you change the solver, forces, materials, or a scene, run `npm test`. Add a
new invariant when you add a new physical behaviour — assert the *property*
(conservation, boundedness, settling), not exact numbers.
