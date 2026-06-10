/**
 * Soft-body internal forces: gas pressure + shape matching + rigid-mode damping.
 *
 * Pressure — push the ring nodes outward proportional to (restArea − area),
 * the force of an ideal-gas potential U(A) = ½·k·(A0 − A)², which is
 * conservative (no net work over a deformation cycle). Preserves volume.
 *
 * Shape matching (Müller et al. 2005) — find the best-fit rigid transform of
 * the rest ring onto the current nodes (centroid + optimal rotation θ from
 * θ = atan2(Σ q×p, Σ q·p)), then pull every node toward its goal position at
 * stiffness `softShape` (fraction of the error closed per step). Unlike the
 * old spoke/brace springs this has only smooth global deformation modes — no
 * facet buckling — and is torque- and momentum-free by construction
 * (Σq = 0 about the centroid, and the optimal θ zeroes the net torque).
 *
 * Rigid-mode damping — decompose node velocities into the blob's rigid motion
 * (mean velocity + best-fit angular velocity Ω) and damp only the deviation.
 * Strictly dissipative, conserves linear + angular momentum, and leaves a
 * bouncing/spinning blob untouched while killing wobble over a few cycles.
 *
 * Accelerations are hard-clamped, so a degenerate (folded / near-zero-area)
 * polygon can't blow up — 240 Hz-stable and NaN-proof.
 *
 * Runs WITH the spring/constraint block (post-integration, before the rigid
 * solve) so all shape forces act on the same velocities.
 */

import { softBodies, polyArea } from '../entities/softBody.js';
import { wake } from '../entities/ball.js';

/** Hard cap on pressure/shape acceleration (px/s²) — a clamp can only REDUCE
 *  force, so a degenerate polygon can't produce a blow-up. */
const MAX_ACCEL = 5000;

/** @param {number} dt */
export function applySoftForces(dt) {
  for (let s = 0; s < softBodies.length; s++) {
    const sb = softBodies[s];
    const nodes = sb.nodes, n = nodes.length;
    if (n < 3) continue;
    // Skip a fully-settled blob (all nodes asleep) — like the fluid cull.
    let awake = false;
    for (let i = 0; i < n && !awake; i++) if (!nodes[i].sleeping) awake = true;
    if (!awake) continue;

    sb.refreshCentroid();
    const cx = sb.cx, cy = sb.cy;

    // --- gas pressure (area preservation) ---
    const area = polyArea(nodes);
    const cur = Math.abs(area) || 1e-4;
    const comp = (sb.restArea - cur) / sb.restArea;        // + when compressed
    const P = (sb.mat.softPressure ?? 1) * 14000 * comp;   // accel scale
    const sign = area >= 0 ? 1 : -1;                       // outward regardless of winding

    // --- shape matching: optimal rotation of the rest ring onto the nodes ---
    let dot = 0, crs = 0;
    for (let i = 0; i < n; i++) {
      const q = sb.restShape[i];
      const px = nodes[i].x - cx, py = nodes[i].y - cy;
      dot += q.x * px + q.y * py;
      crs += q.x * py - q.y * px;
    }
    const th = Math.atan2(crs, dot);
    const co = Math.cos(th), si = Math.sin(th);
    const alpha = sb.mat.softShape ?? 0.08;                // error fraction/step
    // per-step correction cap — a folded/degenerate shape recovers over many
    // steps instead of teleporting (and can't launch a node ballistically)
    const CMAX = 0.15 * sb.R;

    // --- rigid-mode decomposition for the damper ---
    let mvx = 0, mvy = 0;
    for (let i = 0; i < n; i++) { mvx += nodes[i].vx; mvy += nodes[i].vy; }
    mvx /= n; mvy /= n;
    let Lnum = 0, Lden = 1e-6;
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      const px = b.x - cx, py = b.y - cy;
      Lnum += px * (b.vy - mvy) - py * (b.vx - mvx);
      Lden += px * px + py * py;
    }
    const Om = Lnum / Lden;                                // best-fit spin
    const cdamp = sb.mat.softDamp ?? 0.08;                 // deviation fraction/step

    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.pinned) continue;

      // pressure along the outward edge normal from the two adjacent edges
      const prev = nodes[(i - 1 + n) % n], next = nodes[(i + 1) % n];
      let ex = (next.y - prev.y) * sign, ey = -(next.x - prev.x) * sign;
      const el = Math.hypot(ex, ey) || 1e-4; ex /= el; ey /= el;
      let ax = ex * P, ay = ey * P;
      const am = Math.hypot(ax, ay);
      if (am > MAX_ACCEL) { const kk = MAX_ACCEL / am; ax *= kk; ay *= kk; }
      b.vx += ax * dt; b.vy += ay * dt;

      // shape matching: close `alpha` of the goal-position error this step
      // (position + matching velocity — Müller's stiff update, α ≤ 1 stable)
      const q = sb.restShape[i];
      const gx = cx + co * q.x - si * q.y;
      const gy = cy + si * q.x + co * q.y;
      let dxp = alpha * (gx - b.x), dyp = alpha * (gy - b.y);
      const dm = Math.hypot(dxp, dyp);
      if (dm > CMAX) { const kk = CMAX / dm; dxp *= kk; dyp *= kk; }
      b.x += dxp; b.y += dyp;
      b.vx += dxp / dt; b.vy += dyp / dt;

      // damp only the non-rigid part of the velocity — strictly dissipative,
      // momentum/spin-preserving (the blob still flies + rotates freely).
      const px = b.x - cx, py = b.y - cy;
      const rvx = mvx - Om * py, rvy = mvy + Om * px;
      b.vx -= cdamp * (b.vx - rvx);
      b.vy -= cdamp * (b.vy - rvy);

      if (P !== 0 || am > 1) wake(b);
    }
  }
}
