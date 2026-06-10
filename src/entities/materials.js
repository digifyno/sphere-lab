/**
 * Ball materials — physically-motivated properties.
 *
 * Densities are real-world values relative to water (g/cm³) — gold is 19.3,
 * mercury 13.55, a quartz sand grain 2.65. They produce realistic mass ratios:
 * a gold ball is ~17× heavier than a rubber ball of the same size (19.3/1.15).
 * Restitution + friction are kinetic literature values, cross-checked so the
 * orderings are right (rubber out-bounces steel; diamond out-bounces glass;
 * sand grips harder than rubber) — tests/sim.test.mjs::testMaterialOrderings
 * asserts them.
 *
 * `deform` (0..1) drives impact visuals + squash recovery speed:
 *   0   — fully rigid (glass, ice). Squash is bypassed; fracture may occur.
 *   0.3 — stiff (bowling, magnet, steel). Brief flicker of compression.
 *   0.6 — malleable (gold). Holds the dent a while.
 *   1.0 — elastomer (rubber, mercury). Big compression, slow recovery.
 *
 * `fragile` materials break apart above a velocity threshold (see
 * `physics/fracture.js`).
 *
 * `chip` materials leave a small debris particle on every collision.
 *
 * `fluid` materials try to merge with each other at low relative speed
 * (mercury, intended).
 */

/**
 * @typedef {'steel'|'rubber'|'glass'|'bowling'|'neon'|'gold'|'plasma'|'ice'|'magnet'|'mercury'|'diamond'|'obsidian'|'tnt'|'lava'|'rock'|'slime'|'jelly'|'wood'|'sand'|'balloon'|'antimatter'|'honey'|'water'} MaterialId
 */

/**
 * @typedef {Object} Material
 * @property {string} name
 * @property {string} color
 * @property {number} density
 * @property {number} restitution
 * @property {number} friction
 * @property {number} metallic
 * @property {number} glow
 * @property {number} refract
 * @property {number}  [ior]        — refractive index n (refractive materials only);
 *                                    grounds chromatic dispersion + Fresnel reflectance
 * @property {number} pitch
 * @property {OscillatorType} timbre
 * @property {number}  [deform]     — 0 rigid .. 1 elastomer (squash amount + hold)
 * @property {boolean} [fragile]    — can shatter on hard impact
 * @property {number}  [chip]       — probability of a debris chip per collision (0..1)
 * @property {boolean} [magnetic]   — attracts other magnetic balls
 * @property {boolean} [fluid]      — tries to merge with similar fluid on contact
 * @property {number}  [roll]       — rolling resistance (0 = glides forever, 0.2 = grinds to halt fast)
 * @property {number}  [heatKeep]   — per-step heat retention factor at 240 Hz (higher = holds heat longer)
 * @property {boolean} [dentable]   — accumulates permanent dents from hard impacts
 * @property {number}  [cond]       — thermal conductivity (0 insulator .. 1 fast heat flow)
 * @property {number}  [bounceBack] — 0 overdamped (snaps back) .. 1 lightly damped (jiggles visibly)
 * @property {number}  [hardness]   — 0..1 Mohs-ish. Harder material damages softer in asymmetric hits
 * @property {number}  [anisotropy] — 0..1 strength of directional (brushed) highlight
 * @property {number}  [brushAxis]  — brush direction in ball-local frame, radians
 * @property {number}  [clearcoat]  — 0..1 thin glossy top layer on metals (sharp specular lobe)
 * @property {number}  [squashMax]  — peak compression depth (0..1). Default 0.35 for balls / 0.40 for walls
 * @property {boolean} [explosive]  — detonates when hit above `detonateV`; radial blast
 * @property {number}  [detonateV]  — impact normal-velocity that lights the fuse (px/s)
 * @property {boolean} [molten]     — spawns hot, radiates heat, cools into `solidifiesTo`
 * @property {MaterialId} [solidifiesTo] — material the ball becomes when cool (below 0.08 heat)
 * @property {number}  [initHeat]   — heat at spawn (0..1). Default 0.
 * @property {boolean} [adhesive]   — forms temporary springs with anything it touches
 * @property {number}  [lift]       — upward anti-gravity factor (helium balloon). Net lift = g·(1.4·lift − 1)
 * @property {boolean} [antimatter] — annihilates on contact with ordinary matter, releasing energy
 * @property {boolean} [fluidSim]   — particle-fluid: surface-tension cohesion + viscosity among like balls (water)
 * @property {boolean} [soft]       — deformable soft body when built via buildSoftBall (inert for a plain disk)
 * @property {number}  [softNodes]  — ring node count of the soft lattice (≤ 12)
 * @property {number}  [softStiff]  — perimeter (membrane) spring stiffness (0..~1)
 * @property {number}  [softPressure] — gas-pressure scale (area preservation)
 * @property {number}  [softShape]  — shape-matching stiffness: fraction of shape error closed per step (0..~0.3)
 * @property {number}  [softDamp]   — non-rigid-motion damping per step (higher = settles faster, less wobble)
 */

/** @type {Record<MaterialId, Material>} */
export const MATERIALS = {
  steel:   { name: 'STEEL',   color: '#c2cedc', density: 7.85, restitution: 0.75, friction: 0.42, metallic: 0.98, glow: 0,    refract: 0,    pitch: 680,  timbre: 'triangle', deform: 0.05, roll: 0.003, heatKeep: 0.9985, cond: 0.90, bounceBack: 0.00, hardness: 0.88, anisotropy: 0.65, brushAxis: 0, clearcoat: 0.40 },
  rubber:  { name: 'RUBBER',  color: '#e84a66', density: 1.15, restitution: 0.88, friction: 0.90, metallic: 0.03, glow: 0,    refract: 0,    pitch: 260,  timbre: 'sine',     deform: 1.0 , roll: 0.180, heatKeep: 0.9930, cond: 0.05, bounceBack: 0.85, hardness: 0.10, squashMax: 0.48, tanRest: 0.45 },
  glass:   { name: 'GLASS',   color: '#8fd0ff', density: 2.5,  restitution: 0.93, friction: 0.32, metallic: 0.20, glow: 0,    refract: 0.9,  pitch: 1500, timbre: 'sine',     deform: 0.0,  roll: 0.008, heatKeep: 0.9955, cond: 0.25, bounceBack: 0.00, fragile: true, ior: 1.5 },
  bowling: { name: 'BOWLING', color: '#1a1f28', density: 1.35, restitution: 0.32, friction: 0.35, metallic: 0.12, glow: 0,    refract: 0,    pitch: 120,  timbre: 'square',   deform: 0.30, roll: 0.035, heatKeep: 0.9955, cond: 0.15, bounceBack: 0.15, hardness: 0.55 },
  neon:    { name: 'NEON',    color: '#4affb4', density: 0.9,  restitution: 0.78, friction: 0.40, metallic: 0,    glow: 1.0,  refract: 0,    pitch: 900,  timbre: 'sine',     deform: 0.55, roll: 0.070, heatKeep: 0.9960, cond: 0.35, bounceBack: 0.55 },
  gold:    { name: 'GOLD',    color: '#f7c15a', density: 19.3, restitution: 0.38, friction: 0.47, metallic: 1.0,  glow: 0.15, refract: 0,    pitch: 440,  timbre: 'triangle', deform: 0.55, roll: 0.040, heatKeep: 0.9988, cond: 0.95, bounceBack: 0.10, dentable: true, hardness: 0.25, anisotropy: 0.30, brushAxis: 0, clearcoat: 0.28 },
  plasma:  { name: 'PLASMA',  color: '#c878ff', density: 0.3,  restitution: 0.70, friction: 0.18, metallic: 0,    glow: 1.2,  refract: 0,    pitch: 1700, timbre: 'sawtooth', deform: 0.85, roll: 0.030, heatKeep: 0.9975, cond: 0.70, bounceBack: 0.70 },
  ice:     { name: 'ICE',     color: '#c8e8ff', density: 0.92, restitution: 0.32, friction: 0.04, metallic: 0.10, glow: 0.15, refract: 0.55, pitch: 1100, timbre: 'sine',     deform: 0.0,  roll: 0.004, heatKeep: 0.9993, cond: 0.50, bounceBack: 0.00, fragile: true, chip: 0.25, ior: 1.31 },
  magnet:  { name: 'MAGNET',  color: '#c84848', density: 7.5,  restitution: 0.62, friction: 0.42, metallic: 0.85, glow: 0.18, refract: 0,    pitch: 320,  timbre: 'square',   deform: 0.10, roll: 0.010, heatKeep: 0.9980, cond: 0.80, bounceBack: 0.08, magnetic: true, hardness: 0.78, anisotropy: 0.40, brushAxis: 0, clearcoat: 0.30 },
  mercury: { name: 'MERCURY', color: '#d6dfe8', density: 13.55, restitution: 0.22, friction: 0.08, metallic: 1.0,  glow: 0.05, refract: 0.15, pitch: 260,  timbre: 'triangle', deform: 0.95, roll: 0.040, heatKeep: 0.9960, cond: 0.82, bounceBack: 0.45, fluid: true, hardness: 0, anisotropy: 0.10, brushAxis: 0, clearcoat: 0.30 },
  // Diamond — hardest natural material, peak refractive index, best thermal
  // conductor on the periodic table. Extremely rigid (no squash), very
  // elastic bounce, exceptional "fire" (chromatic dispersion), crystalline
  // ring that outlasts glass. Effectively unbreakable in normal use — it
  // doesn't get the `fragile` flag, so it never cracks or shatters.
  diamond: { name: 'DIAMOND', color: '#e8f4ff', density: 3.52, restitution: 0.96, friction: 0.06, metallic: 0.20, glow: 0.10, refract: 1.00, pitch: 2200, timbre: 'sine',     deform: 0.0,  roll: 0.004, heatKeep: 0.9976, cond: 0.99, bounceBack: 0.00, ior: 2.42 },
  // Obsidian — volcanic glass. Dark polished surface, brittle core: cleaves
  // easier than glass (lower fracture threshold) and breaks into jagged
  // angular spikes instead of soft shards. Because it IS a glass it bounces
  // elastically right up until it cleaves; low thermal conductivity, glossy
  // metallic sheen.
  obsidian: { name: 'OBSIDIAN', color: '#1f1824', density: 2.55, restitution: 0.80, friction: 0.30, metallic: 0.70, glow: 0,    refract: 0.20, pitch: 900,  timbre: 'sine',     deform: 0.0,  roll: 0.010, heatKeep: 0.9960, cond: 0.18, bounceBack: 0.00, fragile: true },
  // TNT — dynamite-red with a fuse. Detonates when hit hard enough, applying
  // a radial impulse + heat pulse to everything in range. Chain-reacts with
  // other TNT in the blast radius via a short fuse delay so cascades read
  // as a visible sweep, not one instantaneous flash.
  tnt:     { name: 'TNT',     color: '#d13838', density: 1.65, restitution: 0.28, friction: 0.65, metallic: 0,    glow: 0.12, refract: 0,    pitch: 180,  timbre: 'sawtooth', deform: 0.22, roll: 0.05,  heatKeep: 0.9960, cond: 0.30, bounceBack: 0.05, hardness: 0.20, explosive: true, detonateV: 500 },
  // Lava — molten fluid at spawn; heat decays normally (heatKeep 1.0 is
  // still < 1 after frame-rate compounding) and below 0.08 the ball swaps
  // material to ROCK. Fluid so lava pools merge like mercury. Heat
  // conducts to neighbors via the existing conduction path in collisions.
  lava:    { name: 'LAVA',    color: '#ff6a1a', density: 2.80, restitution: 0.15, friction: 0.48, metallic: 0.08, glow: 1.00, refract: 0,    pitch: 150,  timbre: 'triangle', deform: 0.80, roll: 0.04,  heatKeep: 0.9992, cond: 0.60, bounceBack: 0.25, fluid: true, molten: true, initHeat: 1.0, solidifiesTo: 'rock' },
  // Rock — cooled lava. Dense basalt; not fluid, no glow. Selectable on
  // its own too so you can drop heavy rocks into any scene.
  rock:    { name: 'ROCK',    color: '#3d322a', density: 2.90, restitution: 0.20, friction: 0.78, metallic: 0,    glow: 0,    refract: 0,    pitch: 200,  timbre: 'square',   deform: 0.15, roll: 0.05,  heatKeep: 0.9960, cond: 0.25, bounceBack: 0.05, hardness: 0.50 },
  // Slime — soft, clingy. On collision it forms a short-lived spring with
  // the contacted ball (see `tryAdhere` in collisions). Bonds break above
  // a stretch + force threshold so a hard hit rips free. Translucent body.
  slime:   { name: 'SLIME',   color: '#7de65a', density: 0.95, restitution: 0.30, friction: 0.75, metallic: 0,    glow: 0.06, refract: 0.42, pitch: 340,  timbre: 'sine',     deform: 0.95, roll: 0.10,  heatKeep: 0.9950, cond: 0.10, bounceBack: 0.75, squashMax: 0.55, adhesive: true, ior: 1.4 },
  // Jelly — a true deformable blob (soft-body lattice): flattens on impact,
  // stores elastic energy in its shape, and wobbles back. Translucent, lively.
  jelly:   { name: 'JELLY',   color: '#5ad0c8', density: 1.05, restitution: 0.55, friction: 0.50, metallic: 0,    glow: 0.08, refract: 0.30, pitch: 300,  timbre: 'sine',     deform: 0.95, roll: 0.08,  heatKeep: 0.9945, cond: 0.18, bounceBack: 0.85, squashMax: 0.55, soft: true, softNodes: 10, softStiff: 0.35, softPressure: 1.0, softShape: 0.05, softDamp: 0.03, ior: 1.35 },
  // Wood — light enough to float (density < water = 1.0), matte, dead-ish
  // bounce, grippy. A dropped log bobs on the Water scene surface.
  wood:    { name: 'WOOD',    color: '#a9742f', density: 0.62, restitution: 0.42, friction: 0.62, metallic: 0,    glow: 0,    refract: 0,    pitch: 420,  timbre: 'triangle', deform: 0.25, roll: 0.06,  heatKeep: 0.9950, cond: 0.08, bounceBack: 0.18, hardness: 0.40 },
  // Sand — granular grain. Almost no bounce, very high friction, heavy rolling
  // resistance: a pile of sand grains heaps and holds a slope (the warm-started
  // solver makes the granular pile actually stable instead of jittering apart).
  sand:    { name: 'SAND',    color: '#d8c084', density: 2.65, restitution: 0.14, friction: 0.95, metallic: 0,    glow: 0,    refract: 0,    pitch: 240,  timbre: 'square',   deform: 0.12, roll: 0.42,  heatKeep: 0.9955, cond: 0.20, bounceBack: 0.05, hardness: 0.30 },
  // Balloon — helium-light. `lift` overcomes gravity so it rises, bobs, and
  // collects against the ceiling; soft and very bouncy.
  balloon: { name: 'BALLOON', color: '#ff5da2', density: 0.16, restitution: 0.74, friction: 0.65, metallic: 0,    glow: 0.08, refract: 0,    pitch: 620,  timbre: 'sine',     deform: 0.70, roll: 0.12,  heatKeep: 0.9920, cond: 0.04, bounceBack: 0.70, squashMax: 0.50, lift: 1 },
  // Antimatter — touch any ordinary matter and both annihilate in a burst of
  // energy (radial blast + gamma flash + heat). Two antimatter balls coexist.
  antimatter:{ name:'ANTIMATTER', color:'#d9a8ff', density: 1.00, restitution: 0.50, friction: 0.20, metallic: 0,    glow: 1.35, refract: 0,    pitch: 1500, timbre: 'sawtooth', deform: 0.30, roll: 0.03,  heatKeep: 0.9970, cond: 0.50, bounceBack: 0.30, antimatter: true },
  // Honey — viscous fluid. Merges into pools like mercury but clings, drags,
  // and barely bounces. A heavy amber blob.
  honey:   { name: 'HONEY',   color: '#e0a423', density: 1.42, restitution: 0.05, friction: 0.85, metallic: 0.05, glow: 0.05, refract: 0,    pitch: 150,  timbre: 'sine',     deform: 0.95, roll: 0.25,  heatKeep: 0.9940, cond: 0.20, bounceBack: 0.35, fluid: true, squashMax: 0.55 },
  // Water — particle fluid. Doesn't merge; instead each drop feels surface-
  // tension cohesion + viscosity from its neighbours (see applyFluidSim), and
  // the rigid solver enforces incompressibility. Very slippery + dead bounce,
  // so a body of water flows, sloshes, and finds its level like a real liquid.
  water:   { name: 'WATER',   color: '#3aa6e6', density: 1.00, restitution: 0.04, friction: 0.02, metallic: 0.05, glow: 0.05, refract: 0,    pitch: 520,  timbre: 'sine',     deform: 0.90, roll: 0.04,  heatKeep: 0.9930, cond: 0.40, bounceBack: 0.40, fluidSim: true, squashMax: 0.40 }
};

/** @type {MaterialId[]} */
export const MAT_KEYS = /** @type {MaterialId[]} */ (Object.keys(MATERIALS));
