/**
 * Contact resolution. Three entry points:
 *   collideBalls(a, b) — ball/ball, impulse-based
 *   collideWall(b, w)  — ball/line (incl. conveyor-belt drag)
 *   collidePeg(b, p)   — ball/disc (incl. pinball bumper kick)
 *
 * Material-aware behaviour:
 *   • Restitution combines as `min(eA, eB)` — softer wins.
 *   • Squash depth + angle set from `material.deform` (rubber big, glass zero).
 *   • Impact FX are dispatched per material (sparks / sparkle / chip / dust).
 *   • Fragile materials (glass, ice) fracture above a velocity threshold.
 *   • `chip` materials emit debris every hit (ice always sheds chips).
 *   • `fluid` materials of the same kind merge on slow contact (mercury).
 */

import { clamp, rand, TAU } from '../core/math.js';
import { PHYS } from '../core/config.js';
import {
  particles, spawnImpact, spawnSparkle, spawnChip, spawnDust, spawnSmoke
} from '../entities/particles.js';
import { Snd } from '../audio/sound.js';
import { explode } from './explode.js';
import { matVelRestScale, heatRestMod, heatFricMod, combineFriction, anisoFric, invMass } from './materialMods.js';
import { stats } from './stats.js';
import { wake, balls, Ball } from '../entities/ball.js';
import { tryFracture } from './fracture.js';
import { lightFuse } from './tnt.js';
import { tryAdhere } from './adhesion.js';

/** How many dents a gold ball can carry before new ones replace the oldest. */
const MAX_DENTS = 9;
/** Minimum impulse magnitude that leaves a dent on a dentable ball. */
const DENT_THRESHOLD = 55;
/** Yield velocity (px/s): contact pressure scales with impact speed, so a
 *  slow heavy roll polishes gold but never dents it — only real hits do. */
const DENT_VN = 170;
/** Fraction of the separating velocity the plastic dent work consumes. */
const DENT_BITE = 0.18;
/** How many cracks a fragile ball can show. */
const MAX_CRACKS = 7;
/** Minimum *normal-velocity* that registers as damage on a fragile ball. */
const CRACK_VN_THRESHOLD = 80;

/**
 * Accumulate invisible damage + a visible hairline crack on a fragile ball.
 * Enough damage shifts the effective fracture threshold downward, so a
 * battered glass ball can shatter on a hit that wouldn't have touched it
 * fresh. Cracks are stored in ball-local angle space so they rotate.
 *
 * If `hitterMat` is diamond, damage is dramatically amplified — diamond
 * is the hardest natural material and genuinely scores / cracks softer
 * materials on contact.
 *
 * @param {import('../entities/ball.js').Ball} ball
 * @param {number} worldAngle — angle from ball center to impact point
 * @param {number} vn         — impact normal velocity (px/s)
 * @param {import('../entities/materials.js').Material} [hitterMat]
 */
function addCrack(ball, worldAngle, vn, hitterMat) {
  if (!ball.mat.fragile || ball.isFragment) return;
  const diamondHit = hitterMat && hitterMat.name === 'DIAMOND';
  // Diamond cracks glass / ice on much softer contact — lower threshold,
  // steeper damage curve, guaranteed visible crack.
  const localThresh = diamondHit ? 25 : CRACK_VN_THRESHOLD;
  if (vn < localThresh) return;
  let impact = (vn - localThresh) / 400;
  if (diamondHit) impact *= 2.4;
  ball.damage = clamp(ball.damage + impact * 0.25, 0, 1);
  // Only draw a new crack every so often — avoid cluttering. Diamond hits
  // always leave a visible mark.
  if (!diamondHit && Math.random() > 0.35 + impact * 0.5) return;
  if (!ball.cracks) ball.cracks = [];
  if (ball.cracks.length >= MAX_CRACKS) ball.cracks.shift();
  ball.cracks.push({
    localAngle: worldAngle - ball.angle,
    length: clamp(0.35 + impact * 0.9, 0.3, 1.0),
    angle: (Math.random() - 0.5) * 1.2    // ±35° wander from radial
  });
}

/**
 * Accumulate a permanent dent on a dentable ball (currently only gold).
 * The dent is stored in ball-local rotation space so it rotates with the
 * ball instead of floating at a fixed world angle. Nearby impact angles
 * merge into the existing dent (deepening it) rather than stacking.
 *
 * @param {import('../entities/ball.js').Ball} ball
 * @param {number} worldAngle — angle from ball center to impact point (world)
 * @param {number} magnitude  — impulse magnitude
 * @param {number} vn         — impact normal velocity (px/s); below the yield
 *                              speed the contact stays elastic, no dent
 * @returns {boolean} true if a dent was added or deepened — the caller takes
 *                    the plastic work out of the rebound
 */
function addDent(ball, worldAngle, magnitude, vn) {
  if (!ball.mat.dentable || ball.isFragment) return false;
  if (magnitude < DENT_THRESHOLD || vn < DENT_VN) return false;
  if (!ball.dents) ball.dents = [];
  const local = worldAngle - ball.angle;
  for (const d of ball.dents) {
    let diff = Math.abs(((d.localAngle - local) % TAU + TAU) % TAU);
    if (diff > Math.PI) diff = TAU - diff;
    if (diff < 0.32) {
      d.depth = Math.min(1, d.depth + 0.10);
      return true;
    }
  }
  if (ball.dents.length >= MAX_DENTS) ball.dents.shift();
  ball.dents.push({
    localAngle: local,
    depth: clamp(0.28 + magnitude * 0.0015, 0.28, 0.9)
  });
  return true;
}

/** Dispatch material-specific visual debris for one contact. */
function spawnImpactFor(mat, x, y, nx, ny, magnitude) {
  switch (mat.name) {
    case 'GLASS':
      return spawnSparkle(x, y, nx, ny, magnitude, '#cfeaff');
    case 'ICE':
      return spawnChip(x, y, nx, ny, magnitude, '#d6ecff');
    case 'BOWLING':
      return spawnDust(x, y, magnitude, '#857970');
    case 'GOLD':
      return spawnImpact(x, y, nx, ny, magnitude * 0.5, '#ffd970');
    case 'STEEL':
      return spawnImpact(x, y, nx, ny, magnitude, '#ffe0a0');
    case 'PLASMA':
      return spawnSparkle(x, y, nx, ny, magnitude, '#e0a0ff');
    case 'NEON':
      return spawnSparkle(x, y, nx, ny, magnitude, mat.color);
    case 'RUBBER': {
      // Rubber doesn't fling debris — what you see instead is the sudden
      // release of air compressed between the deforming surfaces on
      // impact. Bigger hits get a second back-pressure cloud moving the
      // other way, which reads as "the ball just smacked something hard."
      if (magnitude > 120) {
        spawnSmoke(x + nx * 3, y + ny * 3, nx * 42, ny * 42, 'rgba(205,170,175,0.40)', 0.42);
        spawnSmoke(x, y,                   -nx * 16, -ny * 16, 'rgba(180,130,140,0.28)', 0.55);
      } else if (magnitude > 40) {
        spawnSmoke(x, y, 0, 0, 'rgba(120,60,70,0.30)', 0.35);
      }
      return;
    }
    case 'MERCURY':
      // silky liquid — no visible chips
      return;
    case 'MAGNET':
      return spawnImpact(x, y, nx, ny, magnitude * 0.5, '#ff8080');
    case 'DIAMOND': {
      // Diamond disperses light — impact sparkles split into colored fringes.
      spawnSparkle(x, y, nx, ny, magnitude,        '#ffffff');
      spawnSparkle(x, y, nx, ny, magnitude * 0.55, '#ffc4ff');   // pink
      spawnSparkle(x, y, nx, ny, magnitude * 0.55, '#a4e8ff');   // cyan
      spawnSparkle(x, y, nx, ny, magnitude * 0.35, '#fff0b0');   // warm yellow
      return;
    }
    case 'OBSIDIAN':
      // Dark volcanic glass — small dim sparkle + black dust flecks.
      spawnSparkle(x, y, nx, ny, magnitude * 0.6, '#6a5070');
      if (magnitude > 40) spawnDust(x, y, magnitude * 0.7, '#2a1a30');
      return;
    default:
      return spawnImpact(x, y, nx, ny, magnitude);
  }
}

/**
 * Mercury-style merge. Two fluid balls of the same material at low relative
 * velocity combine into one: area (∝ r²) conserved, mass conserved, velocity
 * is mass-weighted. Prevents them from stacking as discrete balls.
 *
 * Exported as the contact solver's `events.merge` hook — it runs in the
 * narrow-phase build pass, before any contact impulse is computed.
 */
export function tryFluidMerge(a, b) {
  if (!a.mat.fluid || a.mat.name !== b.mat.name) return false;
  if (a.pinned || b.pinned) return false;
  // A crusted-over molten blob (cooling skin, heat below ~0.25) is no longer
  // liquid enough to coalesce — it stacks until it solidifies into rock.
  if (a.mat.molten && (a.heat < 0.25 || b.heat < 0.25)) return false;
  const dvx = b.vx - a.vx, dvy = b.vy - a.vy;
  const relSpeed = Math.sqrt(dvx * dvx + dvy * dvy);
  const combinedR = Math.sqrt(a.r * a.r + b.r * b.r);
  if (relSpeed > 60 || combinedR > 42) return false;

  const total = a.mass + b.mass;
  const nx = (a.mass * a.x + b.mass * b.x) / total;
  const ny = (a.mass * a.y + b.mass * b.y) / total;
  const nvx = (a.mass * a.vx + b.mass * b.vx) / total;
  const nvy = (a.mass * a.vy + b.mass * b.vy) / total;

  // grow `a` into the merged ball; mark `b` dead for this-step cleanup.
  // Splicing out of `balls` mid-step would leave stale references in the
  // current frame's pair list (broadphase.js runs once per step, solver
  // iterates 3× on that snapshot). `_dead` is cleaned up at end of step.
  a.x = nx; a.y = ny;
  a.vx = nvx; a.vy = nvy;
  a.r = combinedR;
  a.area = Math.PI * combinedR * combinedR;
  a.mass = combinedR * combinedR * a.mat.density * 0.001;
  a.inertia = 0.5 * a.mass * combinedR * combinedR;
  a.omega *= 0.5;
  wake(a);

  b._dead = true;

  Snd.noise(0.08, 0.14, 1800);
  stats.collisions++;
  return true;
}

/**
 * Membrane burst (balloon). A pop is sudden: bang, a fan of rubber shreds,
 * a one-shot air-puff ring, and the ball is gone — no fragments, the helium
 * just leaves.
 * @param {import('../entities/ball.js').Ball} b
 */
function pop(b) {
  if (b._dead) return;
  b._dead = true;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * TAU;
    spawnChip(b.x + Math.cos(a) * b.r * 0.5, b.y + Math.sin(a) * b.r * 0.5,
              Math.cos(a), Math.sin(a), rand(120, 320), b.mat.color);
  }
  spawnSmoke(b.x, b.y, 0, -20, 'rgba(255,235,245,0.35)', 0.9);
  particles.push({
    x: b.x, y: b.y, vx: 0, vy: 0, life: 0.35, maxLife: 0.35,
    color: b.mat.color, size: 2, type: 'ring', ringR0: b.r * 0.5, ringR1: b.r * 3.2
  });
  // bang: a broadband crack + a low thump of the released air
  Snd.noise(0.05, 0.5, 2800);
  Snd.bonk(130, 0.25, 0.09, 'sine');
  stats.collisions++;
}

/**
 * Burst check for membrane materials: a hard slam, contact with a hot ball,
 * or any decent hit from a sharp/hard material (diamond scores rubber).
 * @returns {boolean} true if it popped (b is dead)
 */
export function tryPop(b, impactV, other) {
  if (!b.mat.pops || b._dead) return false;
  const hot = other && other.heat > 0.55;
  const sharp = other && (other.mat.hardness ?? 0) > 0.85 && impactV > 160;
  if (!(impactV > (b.mat.popV ?? 520) || hot || sharp)) return false;
  pop(b);
  return true;
}

/**
 * Liquid splash: a `fluid` blob hit hard enough breaks into 2–3 beads, area
 * (mass) conserved, beads thrown symmetrically (momentum conserved) — the
 * other half of the merge behaviour. Slammed mercury sprays into beads that
 * crawl back together once they slow below the merge threshold; molten lava
 * splatters, but a crusted-over blob (low heat) holds like the merge gate.
 *
 * @param {import('../entities/ball.js').Ball} b
 * @param {number} impactV — normal-component speed at contact (px/s)
 * @returns {boolean} true if it splashed (b is dead — stop processing it)
 */
export function tryFluidSplit(b, impactV) {
  if (b._dead || !b.mat.fluid || b.pinned || b.isFragment) return false;
  if (b.mat.molten && b.heat < 0.25) return false;
  if (b.r < 14 || impactV < 420) return false;
  const n = Math.random() < 0.5 ? 2 : 3;
  if (balls.length + n > 260) return false;
  const nr = b.r / Math.sqrt(n);              // n beads of equal area
  const base = Math.random() * TAU;
  const sp = Math.min(260, impactV * 0.22);   // splash speed ≪ impact speed
  for (let i = 0; i < n; i++) {
    const a = base + (i / n) * TAU;           // symmetric fan — Σv cancels
    const d = new Ball(b.x + Math.cos(a) * b.r * 0.6, b.y + Math.sin(a) * b.r * 0.6, nr, b.mat);
    d.vx = b.vx + Math.cos(a) * sp;
    d.vy = b.vy + Math.sin(a) * sp;
    d.heat = b.heat;
    balls.push(d);
  }
  b._dead = true;
  Snd.noise(0.07, 0.12, 2200);
  stats.collisions++;
  return true;
}

/**
 * Matter + antimatter mutual annihilation. Both balls are converted to energy:
 * a radial blast (reusing the explosion impulse + FX), a bright gamma-flash
 * ring, and a high-frequency burst. Blast strength scales with combined mass.
 */
function annihilate(a, b) {
  if (a._dead || b._dead) return;
  a._dead = true; b._dead = true;
  const x = (a.x + b.x) * 0.5, y = (a.y + b.y) * 0.5;
  const energy = a.mass + b.mass;
  const radius = 200 + energy * 12;
  explode(x, y, 2400 + energy * 220, radius);
  particles.push({
    x, y, vx: 0, vy: 0, life: 0.5, maxLife: 0.5,
    color: '#ffffff', size: 2, type: 'ring', ringR0: 6, ringR1: radius
  });
  Snd.noise(0.3, 0.32, 6500);
  stats.collisions++;
}

/**
 * Side-effects for one resolved ball-ball contact. Invoked once per contact
 * per step by the solver (`events.contact`) *after* impulses are applied.
 *
 * The contact `c` carries everything the old in-line resolver computed —
 * normal, restitution `e`, accumulated normal/tangent impulse, and the
 * initial approach velocity. We rebuild the legacy "impact impulse"
 * `mag = (1+e)·|vn| / Σ(1/m)` so every downstream FX / sound / dent / crack
 * threshold behaves exactly as before — only the *solver* changed.
 *
 * Split into a continuous part (contact bookkeeping, heat conduction,
 * electrostatics — runs for resting contacts too) and an impact-gated part
 * (sparks, sound, fracture, TNT, slime — only on genuine hits).
 *
 * @param {{a, b, nx:number, ny:number, e:number, pt:number, vnInit:number, invSum:number}} c
 */
export function ballContactEvent(c) {
  const a = c.a, b = c.b;

  // Matter + antimatter annihilate the instant they touch — at any speed.
  if (!!a.mat.antimatter !== !!b.mat.antimatter) { annihilate(a, b); return; }

  const nx = c.nx, ny = c.ny;
  const absVn = c.vnInit < 0 ? -c.vnInit : 0;

  // ---- continuous: every frame the contact exists ----
  // heat conduction — hotter body bleeds into colder, scaled by the product
  // of conductivities (metal↔metal fast, insulator↔insulator negligible).
  const dh = b.heat - a.heat;
  if (Math.abs(dh) > 0.01) {
    const flow = dh * (a.mat.cond ?? 0.3) * (b.mat.cond ?? 0.3) * 0.22;
    a.heat = clamp(a.heat + flow, 0, 1);
    b.heat = clamp(b.heat - flow, 0, 1);
  }

  // membrane burst — a hot neighbour pops a balloon at ANY speed, a slam or
  // a sharp/hard hitter at impact speed. Handles both balls; a popped ball
  // is gone, so skip the rest of the contact bookkeeping.
  if (tryPop(a, absVn, b) || tryPop(b, absVn, a)) return;

  // ball-ball contact registers as a rolling surface for the sound mix +
  // rolling-resistance damping in step.js.
  a.groundT = 0.08; a.contactNx = nx;  a.contactNy = ny;
  b.groundT = 0.08; b.contactNx = -nx; b.contactNy = -ny;

  // ---- impact-gated: genuine hits only (shares the solver's wake threshold
  // so resting piles neither chatter nor inflate the collisions/sec graph) ----
  if (!c.impact) return;
  stats.collisions++;
  wake(a); wake(b);
  const mag = (1 + c.e) * absVn / c.invSum;     // legacy impulse magnitude

  // frictional / impact heating (resting piles never reach here, so they
  // don't slowly warm up)
  const heatGain = absVn * 0.00002 + Math.abs(c.pt) * 0.00005;
  a.heat = Math.min(1, a.heat + heatGain);
  b.heat = Math.min(1, b.heat + heatGain);

  // per-hit chip emission for probabilistic-chip materials (ice)
  if (a.mat.chip && Math.random() < a.mat.chip) spawnChip(a.x + nx * a.r * 0.8, a.y + ny * a.r * 0.8, nx, ny, 40, a.mat.color);
  if (b.mat.chip && Math.random() < b.mat.chip) spawnChip(b.x - nx * b.r * 0.8, b.y - ny * b.r * 0.8, -nx, -ny, 40, b.mat.color);

  // fracture / splash — impulses are already applied, so the partner still
  // got its kick; a dead (shattered or splashed) ball skips FX below.
  // The pair's reduced mass feeds the energy criterion: a pebble can't
  // crack a boulder however fast it taps.
  const mEff = 1 / c.invSum;
  const aFractured = tryFracture(a, absVn, mEff) || tryFluidSplit(a, absVn);
  const bFractured = tryFracture(b, absVn, mEff) || tryFluidSplit(b, absVn);

  if (!aFractured && a.mat.explosive && absVn > (a.mat.detonateV || 260)) lightFuse(a);
  if (!bFractured && b.mat.explosive && absVn > (b.mat.detonateV || 260)) lightFuse(b);

  if (!aFractured && !bFractured && (a.mat.adhesive || b.mat.adhesive)) {
    tryAdhere(a, b, absVn);
  }

  const hx = (a.x + b.x) * 0.5;
  const hy = (a.y + b.y) * 0.5;
  let dentA = false, dentB = false;
  if (!aFractured) {
    spawnImpactFor(a.mat, hx, hy, nx, ny, mag);
    const dA = (a.mat.deform ?? 0.4);
    const sqMaxA = a.mat.squashMax ?? 0.35;
    a.squash = 1 - Math.min(sqMaxA * dA, mag * 0.0025 * dA);
    a.squashAng = Math.atan2(ny, nx);
    dentA = addDent(a, Math.atan2(ny, nx), mag, absVn);
    addCrack(a, Math.atan2(ny, nx), absVn, b.mat);
  }
  if (!bFractured) {
    spawnImpactFor(b.mat, hx, hy, -nx, -ny, mag);
    const dB = (b.mat.deform ?? 0.4);
    const sqMaxB = b.mat.squashMax ?? 0.35;
    b.squash = 1 - Math.min(sqMaxB * dB, mag * 0.0025 * dB);
    b.squashAng = Math.atan2(-ny, -nx);
    dentB = addDent(b, Math.atan2(-ny, -nx), mag, absVn);
    addCrack(b, Math.atan2(-ny, -nx), absVn, a.mat);
  }
  // Plastic work: a freshly-made dent comes out of the rebound. Equal/opposite
  // impulse along the normal — momentum conserved, energy strictly removed.
  if (dentA || dentB) {
    const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;   // >0 separating
    if (vrel > 0 && c.invSum > 0) {
      const k = (dentA && dentB) ? DENT_BITE * 2 : DENT_BITE;
      const j = vrel * Math.min(0.5, k) / c.invSum;
      a.vx += j * c.invMa * nx; a.vy += j * c.invMa * ny;
      b.vx -= j * c.invMb * nx; b.vy -= j * c.invMb * ny;
    }
  }
  // Hertzian contact-time brightness: a short contact (stiff/light/fast) gives
  // a bright tick, a long one (soft/heavy/slow) a dull thunk — f_c ∝ 1/τ,
  // τ ∝ (mEff/kEff)^(2/5)·v^(-1/5). Reduced mass + combined stiffness come
  // straight off the contact; audio-only, mutates nothing.
  const kEff = 1 / ((a.mat.deform ?? 0.4) + (b.mat.deform ?? 0.4) + 0.05);
  const tau = Math.pow(mEff / kEff, 0.4) * Math.pow(Math.max(absVn, 1), -0.2);
  const brightness = clamp(1 / (1 + tau * 3), 0.2, 1);
  if (!aFractured && !bFractured) Snd.collision(a, b, mag, absVn, brightness);
}

export function collideWall(b, wall) {
  const { x1, y1, x2, y2 } = wall;
  const wx = x2 - x1, wy = y2 - y1;
  const wlen2 = wx * wx + wy * wy;
  let t = ((b.x - x1) * wx + (b.y - y1) * wy) / wlen2;
  t = clamp(t, 0, 1);
  const cx = x1 + wx * t, cy = y1 + wy * t;
  const dx = b.x - cx, dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= b.r * b.r) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;

  b.x = cx + nx * b.r;
  b.y = cy + ny * b.r;

  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;

  const baseE = b.mat.restitution * (wall.bouncy ? 1.4 : 1);
  const e = baseE * PHYS.restitutionMul * matVelRestScale(Math.abs(vn), b.mat) * heatRestMod(b);
  const tx = -ny, ty = nx;
  const vt = b.vx * tx + b.vy * ty;
  // Tangential surface velocity at the contact point from angular motion.
  // Contact is at position (-nx·r, -ny·r) from the ball center, so
  // `ω × contact` dotted with (tx,ty) works out to -ω·r. Using the wrong
  // sign here made rolling balls appear to spin *against* their motion.
  const surfV = -b.omega * b.r;
  const relT = vt + surfV;

  b.vx -= vn * nx * (1 + e);
  b.vy -= vn * ny * (1 + e);

  const restFactor = Math.abs(vn) < 80 ? 1.6 : 1;
  // Sticky/viscous liquids have much higher effective friction on walls, so
  // they cling before sliding off. `cling` is the explicit per-material knob
  // (honey); merge-fluids (mercury, lava) default to 2.6 — except molten lava,
  // whose grip grows as it cools and crusts (runny hot → tacky cold).
  const fluidPull = b.mat.cling
    ?? (b.mat.molten ? 1.4 + (1 - b.heat) * 2
      : b.mat.fluid ? 2.6 : 1);
  const mu = b.mat.friction * PHYS.frictionMul * heatFricMod(b) * restFactor * fluidPull
           * anisoFric(b, tx, ty);
  const denom = 1 + b.r * b.r / b.inertia * b.mass;
  // Tangential restitution (super-ball off a wall): an elastic material stores
  // shear in the contact patch and rebounds with reversed slip v_t' = −e_t·v_t.
  // Capped to |e_t|≤1 and still clamped to the Coulomb cone below, so it can
  // only ever redirect tangential energy into spin — never inject any.
  let et = b.mat.tanRest ?? 0; et = et > 1 ? 1 : et < 0 ? 0 : et;
  const relTtarget = (et > 0 && Math.abs(vn) >= 10) ? -et * relT : 0;
  let jt = -(relT - relTtarget) * b.mass * (1 + baseE * 0.08) / denom;
  const maxJt = Math.abs(vn) * mu * b.mass;
  if (jt > maxJt) jt = maxJt; else if (jt < -maxJt) jt = -maxJt;
  b.vx += jt * tx / b.mass; b.vy += jt * ty / b.mass;
  // Torque from the friction impulse at the contact — the cross product
  // gives -r·jt, i.e. omega should *decrease* when jt is positive. (Was
  // `+=` which is the pair of the surfV sign error above.)
  b.omega -= jt * b.r / b.inertia;

  if (wall.conveyorV) {
    const wlen = Math.sqrt(wlen2);
    const btx = wx / wlen, bty = wy / wlen;
    const vAlong = b.vx * btx + b.vy * bty;
    const diff = wall.conveyorV - vAlong;
    const grip = clamp(0.05 + b.mat.friction * 0.5, 0.05, 0.6);
    b.vx += btx * diff * grip;
    b.vy += bty * diff * grip;
    b.omega += diff * grip * 0.01;
    wake(b);
  }

  const heatGain = Math.abs(jt) * 0.00007;
  b.heat = Math.min(1, b.heat + heatGain);

  wake(b);

  // Rolling-resistance contact: every wall touch refreshes the contact
  // timer so step.js can apply per-material tangential damping while the
  // ball is rolling. Fluids get a longer grace — they cling.
  b.groundT = (b.mat.fluid || b.mat.cling) ? 0.20 : 0.08;
  b.contactNx = nx;
  b.contactNy = ny;

  // chip emission on wall hits too
  if (b.mat.chip && Math.random() < b.mat.chip) spawnChip(cx, cy, nx, ny, 40, b.mat.color);

  // wall fracture / liquid splash / membrane burst check
  if (tryFracture(b, Math.abs(vn))) return;
  if (tryFluidSplit(b, Math.abs(vn))) return;
  if (tryPop(b, Math.abs(vn))) return;

  // TNT — wall slam can also trigger the fuse if the hit is hard enough.
  if (b.mat.explosive && Math.abs(vn) > (b.mat.detonateV || 260)) lightFuse(b);

  const mag = Math.abs(vn) * b.mass;
  if (mag > 5) {
    spawnImpactFor(b.mat, cx, cy, nx, ny, mag * 0.8);
    const dF = (b.mat.deform ?? 0.4);
    const sqMaxW = b.mat.squashMax ?? 0.4;
    b.squash = 1 - Math.min(sqMaxW * dF, Math.abs(vn) * 0.0008 * dF);
    b.squashAng = Math.atan2(ny, nx);
    // Dent / crack sit on the side of the ball that actually touched the
    // wall — that's the direction from ball center to contact point,
    // which is opposite the outward normal (`-nx, -ny`).
    if (addDent(b, Math.atan2(-ny, -nx), mag, Math.abs(vn))) {
      // plastic work: the dent eats part of the rebound
      const vno = b.vx * nx + b.vy * ny;
      if (vno > 0) { b.vx -= vno * DENT_BITE * nx; b.vy -= vno * DENT_BITE * ny; }
    }
    addCrack(b, Math.atan2(-ny, -nx), Math.abs(vn));
    Snd.wall(b, mag, Math.abs(vn));
  }
  stats.collisions++;
}

export function collidePeg(b, peg) {
  const dx = b.x - peg.x, dy = b.y - peg.y;
  const d2 = dx * dx + dy * dy;
  const rsum = b.r + peg.r;
  if (d2 >= rsum * rsum) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;

  b.x = peg.x + nx * rsum;
  b.y = peg.y + ny * rsum;

  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;

  const e = b.mat.restitution * PHYS.restitutionMul * (peg.bumper ? 1.8 : 1)
          * matVelRestScale(Math.abs(vn), b.mat) * heatRestMod(b);
  b.vx -= vn * nx * (1 + e);
  b.vy -= vn * ny * (1 + e);

  const tx = -ny, ty = nx;
  const vt = b.vx * tx + b.vy * ty;
  // Same sign convention as wall — tangential surface velocity at contact
  // is -ω·r (contact sits opposite the outward normal on the ball).
  const surfV = -b.omega * b.r;
  let jt = -(vt + surfV) * 0.3;
  const maxJ = Math.abs(vn) * b.mat.friction * PHYS.frictionMul * 3;
  jt = clamp(jt, -maxJ, maxJ);
  b.vx += jt * tx; b.vy += jt * ty;
  b.omega -= jt * b.r / b.inertia * b.mass;

  wake(b);

  // Pegs also count as rolling contact.
  b.groundT = 0.08;
  b.contactNx = nx;
  b.contactNy = ny;

  if (tryFracture(b, Math.abs(vn))) return;
  if (tryFluidSplit(b, Math.abs(vn))) return;
  if (tryPop(b, Math.abs(vn))) return;

  // TNT detonation from a hard peg hit as well (bumpers count).
  if (b.mat.explosive && Math.abs(vn) > (b.mat.detonateV || 260)) lightFuse(b);

  const mag = Math.abs(vn) * b.mass;
  if (mag > 4) {
    spawnImpactFor(b.mat, peg.x + nx * peg.r, peg.y + ny * peg.r, nx, ny, mag);
    // Contact side of the ball is opposite the outward normal from the peg.
    if (addDent(b, Math.atan2(-ny, -nx), mag, Math.abs(vn))) {
      const vno = b.vx * nx + b.vy * ny;
      if (vno > 0) { b.vx -= vno * DENT_BITE * nx; b.vy -= vno * DENT_BITE * ny; }
    }
    addCrack(b, Math.atan2(-ny, -nx), Math.abs(vn));
    if (peg.bumper) {
      b.vx += nx * 500 * invMass(b);
      b.vy += ny * 500 * invMass(b);
      Snd.bonk(800 + rand(-100, 100), 0.2, 0.1, 'square');
    } else {
      Snd.wall(b, mag, Math.abs(vn));
    }
  }
  stats.collisions++;
}
