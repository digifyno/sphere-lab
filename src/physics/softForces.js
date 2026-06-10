/**
 * Soft-body gas pressure.
 *
 * For each blob, push the ring nodes outward proportional to
 * (restArea − currentArea) — the force of an ideal-gas potential
 * U(A) = ½·k·(A0 − A)², which is conservative (no net work over a deformation
 * cycle) — plus a dissipative radial damper so the blob wobbles a few times and
 * rests. Acceleration is hard-clamped, so it is 240 Hz-stable and NaN-proof.
 *
 * Runs WITH the spring/constraint block (post-integration, before the rigid
 * solve) so pressure + the structural springs act on the same velocities — they
 * are the two halves of the same shape constraint and must not be split across
 * the position integration.
 */

import { softBodies, polyArea } from '../entities/softBody.js';
import { wake } from '../entities/ball.js';

/** Hard cap on pressure acceleration (px/s²) — a clamp can only REDUCE force,
 *  so a degenerate (folded / near-zero-area) polygon can't produce a blow-up. */
const MAX_PRESS_ACCEL = 5000;

/** @param {number} dt */
export function applySoftPressure(dt) {
  for (let s = 0; s < softBodies.length; s++) {
    const sb = softBodies[s];
    const nodes = sb.nodes, n = nodes.length;
    if (n < 3) continue;
    // Skip a fully-settled blob (all nodes + centre asleep) — like the fluid cull.
    let awake = sb.center && !sb.center.sleeping;
    for (let i = 0; i < n && !awake; i++) if (!nodes[i].sleeping) awake = true;
    if (!awake) continue;

    const area = polyArea(nodes);
    const cur = Math.abs(area) || 1e-4;
    const comp = (sb.restArea - cur) / sb.restArea;        // + when compressed
    const P = (sb.mat.softPressure ?? 1) * 14000 * comp;   // accel scale
    const sign = area >= 0 ? 1 : -1;                       // outward regardless of winding
    const cdamp = sb.mat.softDamp ?? 0.06;
    const cx = sb.center.x, cy = sb.center.y;
    for (let i = 0; i < n; i++) {
      const b = nodes[i];
      if (b.pinned) continue;
      // outward edge normal from the two adjacent edges (gas model)
      const prev = nodes[(i - 1 + n) % n], next = nodes[(i + 1) % n];
      let ex = (next.y - prev.y) * sign, ey = -(next.x - prev.x) * sign;
      const el = Math.hypot(ex, ey) || 1e-4; ex /= el; ey /= el;
      let ax = ex * P, ay = ey * P;
      const am = Math.hypot(ax, ay);
      if (am > MAX_PRESS_ACCEL) { const kk = MAX_PRESS_ACCEL / am; ax *= kk; ay *= kk; }
      b.vx += ax * dt; b.vy += ay * dt;
      // radial breathing damper: −c·(v·r̂)·r̂ — strictly dissipative (removes the
      // pressure/spring breathing KE so the blob settles instead of ringing).
      const rx = b.x - cx, ry = b.y - cy, rl = Math.hypot(rx, ry) || 1e-4;
      const radv = (b.vx * rx + b.vy * ry) / rl;
      b.vx -= cdamp * radv * rx / rl;
      b.vy -= cdamp * radv * ry / rl;
      if (P !== 0 || Math.abs(radv) > 1) wake(b);
    }
    sb._prevArea = cur;
  }
}
