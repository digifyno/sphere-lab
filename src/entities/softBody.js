/**
 * Soft body — a genuine deformable blob, not the cosmetic squash scalar.
 *
 * A soft ball is a closed ring of node `Ball`s joined by perimeter springs
 * (the membrane), held in shape by **shape matching** (Müller 2005) and an
 * area-preserving gas pressure (softForces.js). The nodes are ORDINARY balls
 * in the pool, so they collide with walls + rigid balls through the untouched
 * rigid solver — two-way coupling for free. The blob flattens on impact,
 * stores elastic energy in its shape, and wobbles back.
 *
 * There is no centre ball: the centroid is computed from the ring, so a blob
 * costs exactly N balls (N ≤ 12 against the 260 cap). Intra-blob node pairs
 * are skipped by the rigid solver (contactSolver.js) — internal structure is
 * entirely the job of springs + shape matching + pressure.
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
  /** @param {Ball[]} nodes @param {import('./materials.js').Material} mat */
  constructor(nodes, mat) {
    this.id = ++SBID;
    this.nodes = nodes;        // ring Balls, CCW — real balls in balls[]
    this.mat = mat;            // the parent (visual) material
    this.restArea = Math.abs(polyArea(nodes));
    /** Rest shape in centroid-local coords — the shape-matching target. */
    this.restShape = [];
    /** Current centroid — refreshed by applySoftForces each step. */
    this.cx = 0; this.cy = 0;
    /** Effective radius (centroid → node centre) for shadows/FX. */
    this.R = 1;
    /** @type {Spring[]} */ this.springs = [];
    this.dead = false;
    this.refreshCentroid();
    for (const b of nodes) {
      this.restShape.push({ x: b.x - this.cx, y: b.y - this.cy });
      this.R = Math.max(this.R, Math.hypot(b.x - this.cx, b.y - this.cy));
    }
  }

  refreshCentroid() {
    let cx = 0, cy = 0;
    const n = this.nodes.length;
    for (let i = 0; i < n; i++) { cx += this.nodes[i].x; cy += this.nodes[i].y; }
    this.cx = cx / n; this.cy = cy / n;
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
  const N = Math.min(12, mat.softNodes ?? 10);
  if (balls.length + N > 260) return null;
  const nmat = nodeMaterial(mat);
  const nodeR = Math.max(4, R * 0.42);           // nodes overlap → a closed surface
  // The blob's total mass equals an equivalent rigid disk of radius R (same
  // r²·ρ·0.001 convention as ball.js), split evenly across the ring — so a
  // jelly blob weighs the same as a rubber ball its size, not N× more.
  const nodeMass = Math.max(1e-4, R * R * mat.density * 0.001 / N);
  const nodes = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * TAU;
    const b = new Ball(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, nodeR, nmat);
    b.mass = nodeMass;
    b.inertia = 0.5 * nodeMass * nodeR * nodeR;
    b.isSoftNode = true;
    balls.push(b); nodes.push(b);
  }
  const sb = new SoftBody(nodes, mat);
  for (const b of nodes) b.soft = sb;

  // Perimeter springs only — the membrane. Internal structure (spokes/braces)
  // is replaced by shape matching, which has no facet-buckling modes.
  const k = mat.softStiff ?? 0.35;
  for (let i = 0; i < N; i++) {
    const a = nodes[i], b = nodes[(i + 1) % N];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const s = new Spring(a, b, d, k, 0.05); s.tag = 'soft';
    W.springs.push(s); sb.springs.push(s);
  }
  softBodies.push(sb);
  return sb;
}

/** Remove dead soft bodies (a node escaped/popped) — kill the whole blob so no
 *  orphan springs/nodes linger. Springs are spliced from W.springs. Called once
 *  per step from step.js after the dead-ball cleanup. */
export function cullSoftBodies() {
  for (let i = softBodies.length - 1; i >= 0; i--) {
    const sb = softBodies[i];
    let lost = false;
    for (let k = 0; k < sb.nodes.length && !lost; k++) {
      if (sb.nodes[k]._dead || !balls.includes(sb.nodes[k])) lost = true;
    }
    if (!lost) continue;
    for (const b of sb.nodes) b._dead = true;
    for (const s of sb.springs) {
      const idx = W.springs.indexOf(s);
      if (idx >= 0) W.springs.splice(idx, 1);
    }
    softBodies.splice(i, 1);
  }
}
