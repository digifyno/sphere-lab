/**
 * Soft body — a genuine deformable blob, not the cosmetic squash scalar.
 *
 * A soft ball is a centre node + a ring of node `Ball`s joined by perimeter /
 * spoke / brace springs, plus a gas-pressure force (softForces.js) that
 * preserves area. The nodes are ORDINARY balls in the pool, so they collide
 * with walls + rigid balls through the untouched rigid solver — two-way
 * coupling for free. The blob flattens on impact, stores elastic energy in its
 * shape, and wobbles back.
 *
 * Gated by `mat.soft`: a soft material is still a plain disk when created via
 * `new Ball(...)` (so existing scenes/tests are byte-identical) — only
 * `buildSoftBall` produces the lattice.
 */

import { TAU } from '../core/math.js';
import { Ball, balls } from './ball.js';
import { Spring } from './spring.js';
import { W } from '../core/world.js';

let SBID = 0;
/** @type {SoftBody[]} */
export const softBodies = [];

/** Signed polygon area (shoelace) over the ring nodes — CCW positive. */
export function polyArea(nodes) {
  let a = 0;
  for (let i = 0, n = nodes.length; i < n; i++) {
    const p = nodes[i], q = nodes[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a * 0.5;
}

export class SoftBody {
  /** @param {Ball[]} nodes @param {Ball} center @param {import('./materials.js').Material} mat */
  constructor(nodes, center, mat) {
    this.id = ++SBID;
    this.nodes = nodes;        // ring Balls, CCW — real balls in balls[]
    this.center = center;      // centre Ball
    this.mat = mat;            // the parent (visual) material
    this.restArea = Math.abs(polyArea(nodes));
    this._prevArea = this.restArea;
    /** @type {Spring[]} */ this.springs = [];
    this.dead = false;
  }
}

/** Node material: the parent's look + bounce, but with per-node side-effects
 *  (adhesion, fracture, merge, annihilation, chips, spin-restitution, magnetism)
 *  stripped — so a blob doesn't fountain slime bonds, shatter, or merge against
 *  its own nodes. Cloned once per blob and shared by its nodes. */
function nodeMaterial(mat) {
  return {
    ...mat,
    adhesive: false, fragile: false, fluid: false, fluidSim: false,
    antimatter: false, explosive: false, chip: 0, tanRest: 0, magnetic: false,
  };
}

/**
 * Build a soft blob of radius `R` at (cx,cy). Returns the SoftBody, or null if
 * it would exceed the ball cap.
 * @param {number} cx @param {number} cy @param {number} R
 * @param {import('./materials.js').Material} mat
 */
export function buildSoftBall(cx, cy, R, mat) {
  const N = mat.softNodes ?? 12;
  if (balls.length + N + 1 > 260) return null;
  const nmat = nodeMaterial(mat);
  const nodeR = Math.max(4, R * 0.42);           // nodes overlap → a closed surface
  const center = new Ball(cx, cy, Math.max(4, R * 0.4), nmat);
  center.isSoftNode = center.isSoftCenter = true;
  balls.push(center);
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * TAU;
    const b = new Ball(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, nodeR, nmat);
    b.isSoftNode = true;
    balls.push(b); nodes.push(b);
  }
  const sb = new SoftBody(nodes, center, mat);
  center.soft = sb;
  for (const b of nodes) b.soft = sb;

  const k = mat.softStiff ?? 0.7, dmp = 0.05;
  const mk = (a, b, kk) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const s = new Spring(a, b, d, kk, dmp); s.tag = 'soft';
    W.springs.push(s); sb.springs.push(s);
  };
  for (let i = 0; i < N; i++) {
    mk(nodes[i], nodes[(i + 1) % N], k);         // perimeter (the surface)
    mk(center, nodes[i], k * 0.5);               // spoke
    mk(nodes[i], nodes[(i + 2) % N], k * 0.4);   // short brace (anti-shear)
  }
  sb.restArea = Math.abs(polyArea(nodes));
  sb._prevArea = sb.restArea;
  softBodies.push(sb);
  return sb;
}

/** Remove dead soft bodies (a node escaped/popped) — kill the whole blob so no
 *  orphan springs/nodes linger. Springs are spliced from W.springs. Called once
 *  per step from step.js after the dead-ball cleanup. */
export function cullSoftBodies() {
  for (let i = softBodies.length - 1; i >= 0; i--) {
    const sb = softBodies[i];
    let lost = sb.center._dead || !balls.includes(sb.center);
    for (let k = 0; k < sb.nodes.length && !lost; k++) {
      if (sb.nodes[k]._dead || !balls.includes(sb.nodes[k])) lost = true;
    }
    if (!lost) continue;
    for (const b of sb.nodes) b._dead = true;
    sb.center._dead = true;
    for (const s of sb.springs) {
      const idx = W.springs.indexOf(s);
      if (idx >= 0) W.springs.splice(idx, 1);
    }
    softBodies.splice(i, 1);
  }
}
