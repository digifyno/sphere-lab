/**
 * Ball entity — the principal simulation object.
 *
 * Mass scales with area (r²·density). Moment of inertia uses the disk formula
 * I = ½·m·r² (we treat each ball as a 2D disk, which is what gets rendered).
 *
 * Sleeping: balls with near-zero kinetic energy for longer than `SLEEP_DELAY`
 * get `sleeping = true` and are skipped by the integrator. Contact wakes them
 * via `wake(b)` in collisions; any user tool also wakes on grab/pin/heat.
 */

import { TAU, rand, len } from '../core/math.js';
import { mix } from '../core/color.js';
import { PHYS } from '../core/config.js';
import { MATERIALS } from './materials.js';
import { buildSoftBall } from './softBody.js';

let BID = 0;

/** After this many seconds of near-stillness + gravity-resting, sleep. */
export const SLEEP_DELAY = 0.45;
/** Linear speed below which a ball counts as "resting" for sleep purposes.
 *  Bumped up from 6 so stacks settle instead of jittering. */
export const SLEEP_V  = 9;
/** Angular speed below which a ball counts as "resting" for sleep purposes. */
export const SLEEP_W  = 1.2;

export class Ball {
  /** @param {number} x @param {number} y @param {number} r @param {import('./materials.js').Material} mat */
  constructor(x, y, r, mat) {
    this.id = ++BID;
    this.x = x; this.y = y;
    this.px = x; this.py = y;
    this.vx = 0; this.vy = 0;
    this.r = r;
    this.mat = mat;
    this.mass = r * r * mat.density * 0.001;
    this.inertia = 0.5 * this.mass * r * r;
    this.angle = rand(0, TAU);
    this.omega = 0;
    this.grabbed = false;
    this.pinned = false;
    this.life = 0;
    this.squash = 1;
    this.squashAng = 0;
    this.trailT = 0;
    /** @type {{x:number,y:number}[]} */ this.trail = [];
    /** Some materials start hot (LAVA at spawn). Everything else is cold. */
    this.heat = mat.initHeat ?? 0;
    this.charge = 0;
    this.sparkT = 0;

    /** TNT fuse countdown. 0 = not lit, >0 = detonates when it reaches 0. */
    this.fuseT = 0;
    /** How many slime bonds this ball is currently part of — capped so
     *  a single slime ball can't sprout a hundred springs in a pile. */
    this.slimeBonds = 0;

    /** Sleep state. `sleeping === true` skips most of the per-step work. */
    this.sleeping = false;
    /** Accumulator — how long we've been "resting". Reset on meaningful motion. */
    this.restTime = 0;
    /** Optional — seconds remaining before auto-removal. Used by fragments
     *  spawned by `physics/fracture.js`. Undefined = lives forever. */
    /** @type {number | undefined} */
    this.lifespan = undefined;
    /** If the ball was spawned from a fracture, carry a separate flag so it
     *  doesn't recursively shatter and so the renderer can fade it out. */
    this.isFragment = false;

    /** Rolling-resistance contact tracker — set to ~0.08 on every wall
     *  collision, decays in step.js. Nonzero ⇒ apply per-material drag. */
    this.groundT = 0;
    /** Normal of the last contact surface. Rolling resistance damps only the
     *  tangential component of velocity (the normal is gravity / bounce). */
    this.contactNx = 0;
    this.contactNy = 0;

    /** Gold accumulates permanent dents from hard impacts. Each dent is
     *  `{ localAngle, depth }` in ball-local rotation space, so dents rotate
     *  with the ball. Lazily created on first hard hit; null until then. */
    /** @type {{localAngle:number, depth:number}[] | null} */
    this.dents = null;

    /** Viscoelastic squash velocity — rubber / elastomer materials oscillate
     *  back to 1 instead of a simple exponential recovery. Non-elastic
     *  materials just use the direct lerp in step.js. */
    this.squashVel = 0;

    /** Fragile materials (glass, ice) accumulate damage from sub-threshold
     *  hits; visible as hairline cracks before the main fracture event. */
    this.damage = 0;
    /** @type {{localAngle:number, length:number, angle:number}[] | null} */
    this.cracks = null;

    /** Magnetic polarity — +1 or -1. Opposite poles attract, same-sign
     *  poles repel. Set at construction for magnetic balls, 0 for the
     *  rest (they're ignored by the magnetism code anyway). */
    this.polarity = mat.magnetic ? (Math.random() < 0.5 ? -1 : 1) : 0;
  }

  kineticEnergy() {
    return 0.5 * this.mass * (this.vx * this.vx + this.vy * this.vy)
         + 0.5 * this.inertia * this.omega * this.omega;
  }

  /** Is this ball momentarily "resting" by velocity alone (regardless of sleep state). */
  isResting() {
    return len(this.vx, this.vy) < SLEEP_V && Math.abs(this.omega) < SLEEP_W;
  }

  effectiveColor() {
    let c = this.mat.color;
    if (PHYS.heatFx && this.heat > 0.05) {
      if (this.mat.name === 'RUBBER') {
        // Rubber bloom — as rubber heats, internal waxes migrate to the
        // surface and desaturate it toward a pale waxy gray. Not glowing
        // embers (that's metal); rubber can't forge-glow at these temps.
        c = mix(c, '#c4b4a8', Math.min(0.72, this.heat * 0.78));
      } else {
        c = mix(c, '#ffc040', Math.min(1, this.heat));
        if (this.heat > 0.5) c = mix(c, '#ff4020', (this.heat - 0.5) * 2);
      }
    }
    return c;
  }
}

/** Wake a sleeping ball. Cheap no-op for awake balls. */
export function wake(b) {
  if (b.sleeping) {
    b.sleeping = false;
    b.restTime = 0;
  }
}

/** Wake every ball in the pool. Use when global physics state changes
 *  (gravity toggled, scene reloaded, big slider change). */
export function wakeAll() {
  for (const b of balls) wake(b);
}

/** Wake sleepers within `r` of a point. Call when something is STRUCTURALLY
 *  removed (merge / fracture / annihilation / melt / pop) — it can pull the
 *  support out from under a sleeping ball, which must fall instead of
 *  hanging frozen in mid-air. */
export function wakeNear(x, y, r) {
  const r2 = r * r;
  for (const o of balls) {
    if (!o.sleeping) continue;
    const dx = o.x - x, dy = o.y - y;
    if (dx * dx + dy * dy < r2) wake(o);
  }
}

/** Launch a ball — or, when the handle is a soft-body node (what spawnBall
 *  returns for soft materials), the WHOLE blob. A blob's mass is split
 *  across N ring nodes, so kicking the single returned node gives the body
 *  ~1/N of the intended momentum and shape matching swallows the rest. */
export function kickBall(b, vx, vy) {
  const targets = b.soft ? b.soft.nodes : [b];
  for (const t of targets) { t.vx = vx; t.vy = vy; wake(t); }
}

/** @type {Ball[]} */
export const balls = [];

export const selectedMat = { id: /** @type {import('./materials.js').MaterialId} */ ('rubber') };

export function spawnBall(x, y) {
  if (balls.length >= 260) return null;
  const mat = MATERIALS[selectedMat.id];
  // Soft materials (jelly) spawn as a deformable blob, not a single disk.
  if (mat.soft) {
    const sb = buildSoftBall(x, y, PHYS.spawnRadius, mat);
    if (!sb) return null;
    const vx = rand(-30, 30), vy = rand(-30, 30);
    for (const nde of sb.nodes) { nde.vx = vx; nde.vy = vy; }
    return sb.nodes[0];
  }
  const b = new Ball(x, y, PHYS.spawnRadius, mat);
  b.vx = rand(-30, 30); b.vy = rand(-30, 30);
  b.omega = rand(-2, 2);
  balls.push(b);
  return b;
}
