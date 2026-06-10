/**
 * Scene-specific field forces:
 *   applyVortex     — tangential + inward attraction toward W.vortex{X,Y}
 *   applySolar      — 1/r² attraction toward the canvas center (SOLAR scene)
 *   applyBuoyancy   — Archimedes lift + viscous drag + entry splash + ripple spawn
 *   applyMagnetism  — mutual attraction between magnetic materials (MAGNETS scene)
 *
 * Single-ball functions are no-ops when their feature is disabled, so `step.js`
 * can call them unconditionally per ball.
 */

import { W } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { clamp, len, rand } from '../core/math.js';
import { balls, wake } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';

export function applyVortex(b, dt) {
  if (W.scene !== 'vortex') return;
  const dx = W.vortexX - b.x, dy = W.vortexY - b.y;
  const d2 = dx * dx + dy * dy;
  const d = Math.sqrt(d2) || 0.001;
  const f = 50000 / (d2 + 1000);
  b.vx += (dx / d) * f * dt;
  b.vy += (dy / d) * f * dt;
  b.vx += (-dy / d) * f * dt * 0.7;
  b.vy += (dx / d) * f * dt * 0.7;
}

export function applySolar(b, dt) {
  if (!W.solar) return;
  const cx = W.cw / 2, cy = W.ch / 2;
  const dx = cx - b.x, dy = cy - b.y;
  const d2 = dx * dx + dy * dy;
  const d = Math.sqrt(d2) || 0.001;
  if (d < 50) return;
  const f = 120000 / (d2 + 100);
  b.vx += (dx / d) * f * dt;
  b.vy += (dy / d) * f * dt;
}

/**
 * Archimedes buoyancy + viscous drag + entry splash.
 * Spawns a surface ripple when a ball breaks the water plane.
 */
export function applyBuoyancy(b, dt) {
  if (W.waterY === undefined) return;
  const submerged = Math.min(b.r * 2, (b.y + b.r) - W.waterY);
  if (submerged <= 0) return;
  const frac = clamp(submerged / (b.r * 2), 0, 1);

  const fluidDensity = 1.0;
  // Displaced "volume" uses the SAME r²·k convention as ball mass
  // (ball.js: mass = r²·density·0.001) — no π. Mixing a πr² volume against a
  // π-less mass would scale buoyancy by π (~3.1×), making everything up to
  // ρ≈3.8 float (glass, rock, sand…). With the matching convention (and no
  // extra fudge factor) the float line sits at exactly ρ = 1.0: wood and ice
  // rise, rubber (1.15) and jelly (1.05) genuinely sink — slowly, as they
  // should — and a fully submerged ρ=1 ball is neutral. Ice floats almost
  // fully submerged (8 % net lift), which is what real ice does.
  // Soft-body nodes read their blob's per-node displacement share instead:
  // the ring disks overlap by design, so each node's own r² would sum to
  // ~1.76× the blob's volume and float ρ>1 jelly half out of the water.
  const ballVol = (b.soft ? b.soft.nodeDispR2 : b.r * b.r) * 0.001;
  // Buoyancy rides on gravity — with gravity off (toggled via G or
  // button), a submerged ball should just drift, not spontaneously
  // shoot upward. Drag + splash still apply so water keeps its feel.
  const gActive = PHYS.gravityOn ? Math.max(0, PHYS.gravity) : 0;
  const buoyForce = fluidDensity * ballVol * frac * gActive;
  b.vy -= buoyForce / b.mass * dt;

  const v = len(b.vx, b.vy);
  const drag = (2 + v * 0.002) * frac;
  b.vx *= Math.max(0, 1 - drag * dt);
  b.vy *= Math.max(0, 1 - drag * dt);
  b.omega *= Math.max(0, 1 - drag * dt * 1.5);

  if (b.py + b.r < W.waterY && b.y + b.r >= W.waterY && b.vy > 60) {
    const mag = Math.min(10, b.vy * 0.03);
    for (let i = 0; i < mag * 3; i++) {
      const a = -Math.PI / 2 + rand(-0.9, 0.9);
      particles.push({
        x: b.x + rand(-b.r, b.r), y: W.waterY,
        vx: Math.cos(a) * rand(60, 180), vy: Math.sin(a) * rand(80, 220),
        life: 0.9, maxLife: 0.9,
        color: '#6fb0e0', size: rand(1.5, 3.2), type: 'spark'
      });
    }
    W.ripples.push({
      x: b.x,
      amp: clamp(b.vy * 0.05, 4, 22),
      phase: 0,
      life: 1.6
    });
    Snd.noise(0.10, Math.min(0.12, b.vy * 0.0005), 3000);          // spray hiss
    Snd.plop(b.x, clamp(b.vy * 0.0006, 0.05, 0.35));               // bubble "ploop"
  }
}

/**
 * Mutual attraction between magnetic balls. Called once per physics step from
 * `step.js`. Force is capped + softened at short range so magnet pairs don't
 * stick at infinite energy.
 *   F_on_a_toward_b = k · (m_a·m_b / m_ref²) / (d² + ε)   along the (b-a) axis.
 *
 * Magnetic moment scales with the magnet's VOLUME, so the pair force scales
 * with the product of the two masses — two big magnets snap together hard,
 * two small ones tug gently. (Without this, F was size-blind and a = F/m made
 * SMALL magnets the violent ones — backwards.) Normalised to the MAGNETS
 * scene's r=14 magnet so the stock scene keeps its tuned pull. The 1/r² range
 * law is a deliberate stylisation (real dipoles fall off as 1/r⁴ — too
 * short-range to read on screen).
 *
 * If `W.magnetic` is false (not in the MAGNETS scene), still works so the
 * user can drop magnet balls into any scene.
 */
export function applyMagnetism(dt) {
  const mags = balls.filter(b => b.mat.magnetic);
  if (mags.length < 2) return;
  const k = 80000;
  const eps = 900;
  const mRef = 14 * 14 * 7.5 * 0.001;          // the MAGNETS scene's r=14 magnet
  for (let i = 0; i < mags.length; i++) {
    const a = mags[i];
    for (let j = i + 1; j < mags.length; j++) {
      const b = mags[j];
      if (a.pinned && b.pinned) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      // Polarity: opposite signs attract (f positive), same signs repel
      // (f negative). Falls back to attraction if polarity isn't set (old
      // saved balls). Force sign reversal is the whole point of real magnets.
      const pa = a.polarity || 1;
      const pb = b.polarity || 1;
      const moment = (a.mass * b.mass) / (mRef * mRef);
      const f = (k * moment / (d2 + eps)) * (-pa * pb);
      // wake on meaningful ACCELERATION, not raw force (a big magnet needs a
      // proportionally bigger force to be disturbed)
      if (Math.abs(f) > 10 * Math.min(a.mass, b.mass)) { wake(a); wake(b); }
      // Apply the force to each non-pinned partner. Pinned balls act as
      // anchors — they exert force on free partners but don't drift
      // themselves. Previously, a pinned `a` was skipped entirely,
      // meaning a free `b` never felt its anchor. Now it does.
      if (!a.pinned) {
        a.vx += nx * f / a.mass * dt;
        a.vy += ny * f / a.mass * dt;
      }
      if (!b.pinned) {
        b.vx -= nx * f / b.mass * dt;
        b.vy -= ny * f / b.mass * dt;
      }
    }
  }
}

/** Gravitational constant for the in-sim N-body field. Tuned so a ~r40 star
 *  holds ~r12 planets in stable orbits at screen scale (see scenes/orbits.js,
 *  which sets each planet's tangential speed to √(G·M_star / R)). */
export const NBODY_G = 130000;
/** Softening length² — keeps the 1/r² force finite as bodies get close, so a
 *  near-miss slingshots instead of launching to infinity. */
export const NBODY_SOFT2 = 90 * 90;

/**
 * Newtonian mutual attraction between every pair of balls. O(n²), but the
 * Orbits scene keeps n modest. Pinned bodies (the central star) attract
 * others without drifting themselves. Called once per step from `step.js`
 * when `W.nbody` is set.
 */
export function applyNbody(dt) {
  if (!W.nbody) return;
  const n = balls.length;
  for (let i = 0; i < n; i++) {
    const a = balls[i];
    for (let j = i + 1; j < n; j++) {
      const b = balls[j];
      if (a.pinned && b.pinned) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const inv = 1 / (d2 + NBODY_SOFT2);
      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, ny = dy / d;
      if (!a.pinned) {
        a.vx += nx * NBODY_G * b.mass * inv * dt;
        a.vy += ny * NBODY_G * b.mass * inv * dt;
        if (a.sleeping) wake(a);
      }
      if (!b.pinned) {
        b.vx -= nx * NBODY_G * a.mass * inv * dt;
        b.vy -= ny * NBODY_G * a.mass * inv * dt;
        if (b.sleeping) wake(b);
      }
    }
  }
}


/** Age water ripples + cull dead ones. Called each step from step.js. */
export function stepRipples(dt) {
  for (const r of W.ripples) {
    r.phase += dt * 8;
    r.life  -= dt;
    r.amp   *= Math.max(0, 1 - dt * 0.8);
  }
  for (let i = W.ripples.length - 1; i >= 0; i--) {
    if (W.ripples[i].life <= 0) W.ripples.splice(i, 1);
  }
}
