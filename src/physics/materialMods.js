/**
 * Impact-time material modifiers — velocity-dependent restitution and
 * temperature-dependent elasticity/friction. Keeps `collisions.js` focused
 * on vector math.
 */

import { PHYS } from '../core/config.js';
import { clamp } from '../core/math.js';

/** Reference speed (px/s) where the velocity-restitution multiplier reaches
 *  ~0.85. Below it the curve is near-elastic; above it restitution decays. */
const REF_V = 250;

/**
 * Restitution falls smoothly with impact speed. Real viscoelastic/Hertzian
 * contacts roll off as a gentle power law `e ∝ v^(-1/4)` (Hunt–Crossley /
 * Tabor), NOT a quadratic cliff — doubling the speed costs only ~16 % of e, so
 * even hard hits stay lively (a dropped steel ball keeps bouncing many times).
 * The curve runs from 1 (gentle) toward the 0.35 floor (violent), monotone.
 */
export function velRestScale(vMag) {
  return clamp(0.35 + 0.65 * Math.pow(REF_V / (vMag + REF_V), 0.25), 0.35, 1);
}

/**
 * Material-aware velocity-restitution shape.
 *
 * Most materials use the default monotonic curve above (gentle hits near 1,
 * hard hits plasticize toward 0.35). Rubber is genuinely different — it's
 * viscoelastic, which means:
 *
 *   very slow impacts:  polymer chains have time to relax → low restitution
 *   moderate speeds:    elastic rebound dominates        → high restitution
 *   very fast impacts:  hysteresis dumps energy to heat  → low restitution
 *
 * So rubber gets a *bell* curve (dead-soft at v=0, peak ~v=300, rolls off
 * above ~v=1000). The visible behaviour: a rubber ball rested on another
 * rubber ball doesn't bounce (viscous release), but dropped from height it
 * bounces lively, then a cannon-velocity hit deadens again.
 */
export function matVelRestScale(vMag, mat) {
  if (mat && mat.name === 'RUBBER') {
    const onset   = 1 - Math.exp(-vMag / 70);            // 0 → 1 as v rises
    const rolloff = 1 / (1 + vMag * vMag * 0.0000008);   // 1 → 0 at high v
    return 0.45 + 0.55 * onset * rolloff;
  }
  return velRestScale(vMag);
}

/**
 * Per-ball elasticity modifier from heat. Different materials respond
 * differently to being hot:
 *   rubber → mushy (harder to bounce)
 *   ice    → melts, almost dead bounce
 *   steel  → plasticizes
 *   plasma → more bouncy (dramatic, not physical)
 */
export function heatRestMod(b) {
  if (!PHYS.heatFx) return 1;
  const h = b.heat;
  if (h < 0.1) return 1;
  const n = b.mat.name;
  if (n === 'RUBBER') return clamp(1 - (h - 0.1) * 0.9, 0.25, 1);
  if (n === 'ICE')    return clamp(1 - (h - 0.1) * 1.8, 0.1,  1);
  if (n === 'STEEL')  return clamp(1 - (h - 0.3) * 0.6, 0.4,  1);
  if (n === 'PLASMA') return 1 + (h * 0.2);
  return 1 - h * 0.15;
}

/** Friction goes up with heat on rubber + ice (both get sticky). */
export function heatFricMod(b) {
  if (!PHYS.heatFx) return 1;
  if (b.mat.name === 'RUBBER') return 1 + b.heat * 0.5;
  if (b.mat.name === 'ICE')    return 1 + b.heat * 0.8;
  return 1 + b.heat * 0.2;
}

/**
 * Combine two friction coefficients. Geometric mean is a closer match to
 * real behaviour than an arithmetic average — a low-friction surface tends
 * to dominate the pair.
 */
export function combineFriction(muA, muB) { return Math.sqrt(muA * muB); }

/** Inverse mass, with pinned balls returning 0 so impulses don't move them. */
export function invMass(b) { return b.pinned ? 0 : 1 / b.mass; }
