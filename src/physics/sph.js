/**
 * Position Based Fluids (Macklin & Müller 2013) for `fluidSim` materials (water).
 *
 * This is real incompressible-fluid behaviour — a density constraint
 * C_i = ρ_i/ρ0 − 1 = 0 enforced by position corrections, then XSPH viscosity
 * for coherent flow and an anti-clustering surface-tension term — replacing the
 * old attractive cohesion that "balled the water up".
 *
 * Adapted to SphereLab's velocity-REFLECTION engine (the design's naive PBF
 * velocity-overwrite would erase wall bounces + freeze airborne drops). So:
 *   • the density projection moves POSITIONS (like the rigid NGS pass), and we
 *     add ONLY the resulting correction velocity to the existing (post-gravity,
 *     post-CCD) velocity — the fall speed and wall bounce are preserved;
 *   • a dedicated uniform grid (cell = H, full 3×3 scan) supplies neighbours,
 *     because the rigid broadphase's same-cell reach is shorter than H;
 *   • H + rest density derive from the actual water radius each scene.
 *
 * Energy-safe: the projection only relieves over-density (a separating, not
 * amplifying, response), every Δp + Δv is clamped, and XSPH viscosity is a
 * convex velocity blend that can only remove relative KE. Pure module (no
 * audio/DOM) so it runs head-less. Runs AFTER integration/CCD/springs and just
 * before the rigid contact solve.
 */

import { balls, wake } from '../entities/ball.js';

const PBF_ITERS = 3;
/** Constraint-force-mixing — regularises λ so the denominator is never ~0. */
const EPS_CFM = 100;
/** XSPH viscosity strength (strictly dissipative). */
const VISC = 0.08;
/** Anti-clustering surface tension (Macklin s_corr). */
const SCORR_K = 0.0009, SCORR_N = 4, SCORR_DQ = 0.2;

/* Kernels + rest density depend on H; recomputed when the water radius changes. */
let H = 36, H2 = H * H, POLY6 = 1, SPIKY = 1, REST_RHO = 1, WDQ = 1, lastR = -1;

function poly6(r2) { const d = H2 - r2; return d > 0 ? POLY6 * d * d * d : 0; }
function spikyGrad(r) { const d = H - r; return d > 0 ? SPIKY * d * d : 0; }   // scalar |∇W|

function setH(pr) {
  H = 3.6 * pr; H2 = H * H;
  POLY6 = 4 / (Math.PI * Math.pow(H, 8));
  SPIKY = 30 / (Math.PI * Math.pow(H, 5));
  // Numeric rest density from a hex lattice at rest spacing s = 2·pr (drops just
  // touching). Computed so ρ0 always matches H — never a magic constant.
  const s = 2 * pr;
  let rho = poly6(0);
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    if (i === 0 && j === 0) continue;
    const x = (i + (j & 1) * 0.5) * s, y = j * s * 0.8660254;
    const r2 = x * x + y * y;
    if (r2 < H2) rho += poly6(r2);
  }
  REST_RHO = rho || 1;
  WDQ = poly6((SCORR_DQ * H) * (SCORR_DQ * H)) || 1e-9;
  lastR = pr;
}

const fp = [];                 // water particles this step (reused)
const nb = [];                 // nb[i] = flat [j0,r0, j1,r1, ...] (reused)
const grid = new Map();
const key = (cx, cy) => cx + ':' + cy;

/** Drop neighbour scratch on scene load (defensive; rebuilt every step). */
export function clearSPH() { fp.length = 0; nb.length = 0; grid.clear(); }

/**
 * Apply PBF density projection + viscosity + surface tension to water drops.
 * @param {number} dt
 */
export function applySPH(dt) {
  fp.length = 0;
  let pr = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.mat.fluidSim || b.pinned) continue;
    fp.push(b);
    pr = b.r;
    b._sxT = b.x; b._syT = b.y;          // post-integration snapshot (additive-Δv base)
  }
  const n = fp.length;
  if (n < 2) return;
  if (pr !== lastR) setH(pr);

  // --- dedicated grid (cell = H) + symmetric neighbour lists (3×3 scan) ---
  grid.clear();
  for (let i = 0; i < n; i++) {
    const b = fp[i];
    const cx = Math.floor(b.x / H), cy = Math.floor(b.y / H);
    b._gx = cx; b._gy = cy;
    const k = key(cx, cy);
    let l = grid.get(k); if (!l) { l = []; grid.set(k, l); }
    l.push(i);
  }
  nb.length = n;
  for (let i = 0; i < n; i++) nb[i] = [];
  for (let i = 0; i < n; i++) {
    const a = fp[i];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = grid.get(key(a._gx + dx, a._gy + dy));
      if (!l) continue;
      for (let q = 0; q < l.length; q++) {
        const j = l[q];
        if (j <= i) continue;
        const o = fp[j];
        const ex = a.x - o.x, ey = a.y - o.y;
        const r2 = ex * ex + ey * ey;
        if (r2 < H2) {
          const r = Math.sqrt(r2) || 1e-4;
          nb[i].push(j, r); nb[j].push(i, r);
        }
      }
    }
  }

  // --- PBF density-constraint iterations (position only) ---
  for (let it = 0; it < PBF_ITERS; it++) {
    for (let i = 0; i < n; i++) {
      const a = fp[i], L = nb[i];
      let rho = poly6(0);
      for (let k = 1; k < L.length; k += 2) { const r = L[k]; rho += poly6(r * r); }
      const C = rho / REST_RHO - 1;
      let gax = 0, gay = 0, sum = 0;
      for (let k = 0; k < L.length; k += 2) {
        const o = fp[L[k]], r = L[k + 1];
        const w = spikyGrad(r) / REST_RHO;
        const gx = w * (a.x - o.x) / r, gy = w * (a.y - o.y) / r;
        gax += gx; gay += gy; sum += gx * gx + gy * gy;
      }
      sum += gax * gax + gay * gay;
      a._lam = -C / (sum + EPS_CFM);
    }
    for (let i = 0; i < n; i++) { fp[i]._dpx = 0; fp[i]._dpy = 0; }
    for (let i = 0; i < n; i++) {
      const a = fp[i], L = nb[i];
      for (let k = 0; k < L.length; k += 2) {
        const o = fp[L[k]], r = L[k + 1];
        const ratio = poly6(r * r) / WDQ;
        const scorr = -SCORR_K * Math.pow(ratio, SCORR_N);
        const c = (a._lam + o._lam + scorr) * spikyGrad(r) / REST_RHO;
        a._dpx += c * (a.x - o.x) / r;
        a._dpy += c * (a.y - o.y) / r;
      }
    }
    const DPMAX = 0.4 * (H / 3.6);        // ≈ 0.4·radius per iteration
    for (let i = 0; i < n; i++) {
      const a = fp[i]; if (a.sleeping) continue;
      let dpx = a._dpx, dpy = a._dpy;
      const dm = Math.hypot(dpx, dpy);
      if (dm > DPMAX) { const s = DPMAX / dm; dpx *= s; dpy *= s; }
      a.x += dpx; a.y += dpy;
    }
  }

  // --- additive velocity correction (only the projection delta) ---
  const DVMAX = 4000;
  for (let i = 0; i < n; i++) {
    const a = fp[i]; if (a.sleeping) continue;
    let dvx = (a.x - a._sxT) / dt, dvy = (a.y - a._syT) / dt;
    const dm = Math.hypot(dvx, dvy);
    if (dm > DVMAX) { const s = DVMAX / dm; dvx *= s; dvy *= s; }
    a.vx += dvx; a.vy += dvy;
    if (dm > 5) wake(a);
  }

  // --- XSPH viscosity: blend toward neighbour mean velocity (dissipative) ---
  for (let i = 0; i < n; i++) {
    const a = fp[i]; if (a.sleeping) continue;
    const L = nb[i]; let ax = 0, ay = 0;
    for (let k = 0; k < L.length; k += 2) {
      const o = fp[L[k]], r = L[k + 1];
      const wv = poly6(r * r);
      ax += (o.vx - a.vx) * wv; ay += (o.vy - a.vy) * wv;
    }
    a.vx += VISC * ax / REST_RHO; a.vy += VISC * ay / REST_RHO;
  }
}
