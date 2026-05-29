/**
 * Mutable global physics + render toggles + audio/UX settings.
 * Every frame reads from `PHYS`. UI sliders/toggles and persistence mutate it live.
 */

/**
 * @typedef {Object} PhysConfig
 * Sim parameters:
 * @property {number} gravity
 * @property {number} drag
 * @property {number} restitutionMul
 * @property {number} frictionMul
 * @property {number} magnus
 * @property {number} wind
 * @property {number} spawnRadius
 * @property {boolean} gravityOn
 * @property {number} slowmo
 * @property {boolean} paused
 * Contact solver (sequential-impulse, warm-started):
 * @property {number} solverVel  — velocity (impulse) iterations per step
 * @property {number} solverPos  — position-correction (NGS) iterations per step
 * @property {boolean} warmStart — reuse last frame's accumulated impulses
 * Render toggles:
 * @property {boolean} motionBlur  @property {boolean} trails     @property {boolean} showVec
 * @property {boolean} bloom       @property {boolean} shadow     @property {boolean} sound
 * @property {boolean} refract     @property {boolean} heatFx     @property {boolean} ao
 * @property {boolean} aberration  @property {boolean} grain      @property {boolean} streaks
 * @property {boolean} flare
 * Audio:
 * @property {number} volume   — 0..1 master gain
 */

/** @type {PhysConfig} */
export const PHYS = {
  gravity: 900, drag: 0.05, restitutionMul: 1.0, frictionMul: 0.5, magnus: 0.6, wind: 0,
  spawnRadius: 20,
  gravityOn: true, slowmo: 1, paused: false,
  solverVel: 8, solverPos: 3, warmStart: true,
  motionBlur: false, trails: false, showVec: false,
  bloom: true, shadow: true, sound: true, refract: true, heatFx: true,
  ao: true, aberration: true, grain: true, streaks: true, flare: true,
  fire: true,
  volume: 0.45
};

/** Keyboard → tool id (matches the tool grid in index.html). */
export const TOOL_KEYS = {
  q: 'spawn',   w: 'grab',   e: 'draw',   r: 'erase',
  t: 'link',    y: 'pin',    u: 'push',   o: 'attract',
  i: 'heat'
};
