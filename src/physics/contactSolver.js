/**
 * Ball-ball contact solver — warm-started sequential impulse.
 *
 * This is the heart of the "realistic" behaviour. Instead of teleporting
 * overlapping balls apart every iteration (which injects energy and makes
 * piles jitter), it:
 *
 *   1. Builds a contact manifold once per step (one geometry pass).
 *   2. **Warm-starts** each contact with the impulse it carried last frame,
 *      keyed by ball-id pair — a resting stack converges in ~1 iteration
 *      because the supporting impulses are already (almost) correct.
 *   3. Solves velocity with a proper **Coulomb friction cone**: the friction
 *      impulse is clamped to ±μ·Pₙ against the *accumulated* normal impulse,
 *      not the single-iteration value, so stacks don't creep or buzz.
 *   4. Corrects penetration with **split-impulse / NGS** — a position-only
 *      relaxation pass (Baumgarte β with a slop band). Because it never
 *      touches velocity, it removes overlap without adding kinetic energy.
 *
 * Restitution uses a velocity *slop*: contacts approaching slower than
 * `REST_SLOP` get a zero rebound target, which kills resting micro-bounce
 * while leaving real drops lively.
 *
 * The solver is intentionally free of audio/DOM/FX imports so it can run
 * head-less in a Node test harness. All side effects (sound, sparks,
 * fracture, fluid merge, heat) are delegated to an `events` object passed
 * in by `step.js`.
 */

import { PHYS } from '../core/config.js';
import { W } from '../core/world.js';
import { balls, wake } from '../entities/ball.js';
import { buildPairs } from './broadphase.js';
import { matVelRestScale, heatRestMod, heatFricMod, combineFriction } from './materialMods.js';

/** Approach speed (px/s) below which a contact gets no restitution rebound. */
const REST_SLOP = 10;
/** Approach speed (px/s) that counts as a genuine impact — wakes sleepers and
 *  fires impact FX/sound. Below it, a contact is a resting lean: a sleeping
 *  ball stays asleep and acts as immovable support, so the pile can settle
 *  bottom-up without a wake cascade. */
const WAKE_V = 10;
/** Penetration (px) tolerated before position correction kicks in. */
const POS_SLOP = 0.5;
/** Fraction of excess penetration removed per position iteration. */
const POS_BETA = 0.22;
/** Speculative margin (px) for wall/peg support contacts, so a ball resting
 *  exactly on a surface still has a support constraint ready to engage. */
const STATIC_MARGIN = 1.5;
/** Inward approach speed (px/s) above which a ball that is still *outside* a
 *  surface (within the speculative margin, not yet touching) is treated as a
 *  genuine impact and left for collideWall to bounce — NOT braked by the
 *  no-restitution support contact. Without this gate a free-falling ball that
 *  lands in the [r, r+margin] band has its approach velocity killed to zero
 *  with no rebound, so it "bounces once then sticks". Resting / loaded balls
 *  (slower than this) still get support, so high-mass-ratio stacks stay stable. */
const STATIC_SUPPORT_VN = 15;

/** @typedef {{pn:number, pt:number}} CachedImpulse */
/** Warm-start cache, keyed `"<loId>_<hiId>"`. Swapped each frame. */
let cache = /** @type {Map<string, CachedImpulse>} */ (new Map());
let nextCache = /** @type {Map<string, CachedImpulse>} */ (new Map());

/** Reused contact lists — avoids per-step allocation. */
const contacts = [];
const staticContacts = [];

/** Drop all warm-start state (call on scene load so stale pairs don't haunt). */
export function clearContactCache() { cache.clear(); nextCache.clear(); }

function clampv(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Resolve every ball-ball contact for this step.
 * @param {number} dt
 * @param {{merge?:(a,b)=>boolean, contact?:(c)=>void}} events
 */
export function solveBallContacts(dt, events) {
  contacts.length = 0;
  nextCache.clear();

  const pairs = buildPairs();
  for (let p = 0; p < pairs.length; p++) {
    const a = pairs[p][0], b = pairs[p][1];
    if (a._dead || b._dead) continue;

    // Two sleeping balls in contact are a settled island — skip entirely.
    if (a.sleeping && b.sleeping) continue;

    // Nodes of the SAME soft body overlap by design (the perimeter is a closed
    // ring of touching disks) — their shape is held by the soft springs, so the
    // rigid solver must NOT fight them apart. No-op for non-soft balls (a.soft
    // is undefined). Cross-body and node-vs-rigid contacts still resolve.
    if (a.soft && a.soft === b.soft) continue;

    let dx = b.x - a.x, dy = b.y - a.y;
    const rsum = a.r + b.r;
    let d2 = dx * dx + dy * dy;
    // Swept CCD: if the pair started this step SEPARATED and had real relative
    // motion, find the earliest time-of-impact (solve |P + t·V|² = rsum²) and,
    // if they reached contact during the step, snap both to that entry contact.
    // This catches BOTH a clean pass-through (separated at the end sample) and a
    // "crossed but overlapping on the wrong side at the end" — which the static
    // end-sample would misread as separating and let tunnel through.
    let swept = false;
    {
      const aSx = (a.pinned || a.sleeping) ? a.x : a.px;
      const aSy = (a.pinned || a.sleeping) ? a.y : a.py;
      const bSx = (b.pinned || b.sleeping) ? b.x : b.px;
      const bSy = (b.pinned || b.sleeping) ? b.y : b.py;
      const Px = bSx - aSx, Py = bSy - aSy;
      const C = Px * Px + Py * Py - rsum * rsum;
      if (C > 0) {                                 // started separated
        const aex = a.x - aSx, aey = a.y - aSy;
        const bex = b.x - bSx, bey = b.y - bSy;
        const Vx = bex - aex, Vy = bey - aey;
        const A = Vx * Vx + Vy * Vy;
        if (A > 1e-6) {
          const B = 2 * (Px * Vx + Py * Vy);
          const disc = B * B - 4 * A * C;
          if (disc >= 0) {
            const t = (-B - Math.sqrt(disc)) / (2 * A);
            if (t >= 0 && t <= 1) {                // contact reached this step
              a.x = aSx + aex * t; a.y = aSy + aey * t;
              b.x = bSx + bex * t; b.y = bSy + bey * t;
              dx = b.x - a.x; dy = b.y - a.y; d2 = dx * dx + dy * dy;
              swept = true;
            }
          }
        }
      }
    }
    if (!swept && d2 >= rsum * rsum) continue;
    // Coincident balls (e.g. two spawned on the same pixel) have no defined
    // normal — synthesize a deterministic one so they actually separate
    // instead of dividing by ~0 and getting a (0,0) normal that does nothing.
    let nx, ny, d;
    if (d2 < 1e-6) {
      const ang = (a.id + b.id) * 2.3999632;   // golden angle spreads clusters
      nx = Math.cos(ang); ny = Math.sin(ang); d = 1e-3;
    } else {
      d = Math.sqrt(d2); nx = dx / d; ny = dy / d;
    }

    // Fluid merge is a structural change — handle before building a contact.
    if (events.merge && events.merge(a, b)) continue;

    const tx = -ny, ty = nx;
    const vnInit = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;  // <0 = approaching
    const approach = vnInit < 0 ? -vnInit : 0;
    const impact = approach >= WAKE_V;
    // EXPERIMENT: tangential restitution slip captured at build time
    const _surfVA0 = -a.omega * a.r, _surfVB0 = b.omega * b.r;
    const vtInit = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty + (_surfVA0 - _surfVB0);
    const etRaw = Math.min(a.mat.tanRest ?? 0, b.mat.tanRest ?? 0);
    const et = etRaw > 1 ? 1 : etRaw < 0 ? 0 : etRaw;

    // Only a genuine impact wakes a sleeper. A gentle rest-contact leaves it
    // frozen, where it acts as immovable support — so the ball leaning on it
    // can itself settle and sleep instead of being perpetually re-woken.
    if (impact) { if (a.sleeping) wake(a); if (b.sleeping) wake(b); }

    const aDyn = !a.pinned && !a.sleeping;
    const bDyn = !b.pinned && !b.sleeping;
    const invMa = aDyn ? 1 / a.mass : 0;
    const invMb = bDyn ? 1 / b.mass : 0;
    const invSum = invMa + invMb;
    if (invSum === 0) continue;            // both immovable — nothing to solve

    // Restitution + friction are evaluated once, exactly as the old contact
    // code did, so impact FX/sound stay identical.
    const baseE = Math.min(a.mat.restitution, b.mat.restitution);
    const softer = a.mat.restitution < b.mat.restitution ? a.mat : b.mat;
    // Clamp to a physical ceiling of 1. Two passive bodies can't separate
    // faster than they approached without an external energy source — and the
    // factors above can exceed 1 (hot plasma's heatRestMod up to 1.2 each, or
    // a >1.0 Bounce slider), which would inject KE every bounce and break the
    // "KE+PE never rises" invariant. Active energy sources (pinball bumpers,
    // bouncy walls) live in collisions.js / flippers.js and stay uncapped.
    const e = Math.min(1, baseE * PHYS.restitutionMul * matVelRestScale(approach, softer)
            * heatRestMod(a) * heatRestMod(b));
    const mu = combineFriction(a.mat.friction, b.mat.friction) * PHYS.frictionMul
             * heatFricMod(a) * heatFricMod(b);

    const angA = aDyn ? a.r * a.r / a.inertia : 0;
    const angB = bDyn ? b.r * b.r / b.inertia : 0;

    const key = a.id < b.id ? a.id + '_' + b.id : b.id + '_' + a.id;
    const warm = PHYS.warmStart ? cache.get(key) : undefined;

    contacts.push({
      a, b, nx, ny, tx, ty,
      aDyn, bDyn, invMa, invMb, invSum,
      tanInvSum: invSum + angA + angB,
      e, mu, vnInit, impact,
      // velocity slop: gentle/resting contacts don't try to rebound
      vnTarget: approach < REST_SLOP ? 0 : e * approach,
      vtTarget: (impact && et > 0) ? -et * vtInit : 0,
      pn: warm ? warm.pn : 0,
      pt: warm ? warm.pt : 0,
      key
    });
  }

  // --- static (wall/peg) support contacts ---
  // collideWall (CCD) already owns wall bounce, friction, conveyor + FX. These
  // are normal-only, no-restitution support constraints that stop the ball-ball
  // solve from shoving a ball *into* geometry, so a heavy ball's support
  // impulse flows to the immovable wall instead of being dumped as a light
  // neighbour's velocity — that's what makes high-mass-ratio stacks on the
  // floor stable.
  buildStaticContacts();

  // --- warm start: replay last frame's solution ---
  if (PHYS.warmStart) {
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const px = c.pn * c.nx + c.pt * c.tx;
      const py = c.pn * c.ny + c.pt * c.ty;
      const a = c.a, b = c.b;
      if (c.aDyn) { a.vx -= px * c.invMa; a.vy -= py * c.invMa; a.omega -= c.pt * a.r / a.inertia; }
      if (c.bDyn) { b.vx += px * c.invMb; b.vy += py * c.invMb; b.omega -= c.pt * b.r / b.inertia; }
    }
    for (let i = 0; i < staticContacts.length; i++) {
      const s = staticContacts[i];
      s.b.vx += s.pn * s.nx * s.invM;
      s.b.vy += s.pn * s.ny * s.invM;
    }
  }

  // --- velocity iterations ---
  const vIters = Math.max(1, PHYS.solverVel | 0);
  for (let it = 0; it < vIters; it++) {
    for (let i = 0; i < staticContacts.length; i++) {
      const s = staticContacts[i];
      const vn = s.b.vx * s.nx + s.b.vy * s.ny;     // <0 = moving into the wall
      let dpn = -vn / s.invM;
      const pn = s.pn + dpn < 0 ? 0 : s.pn + dpn;
      dpn = pn - s.pn; s.pn = pn;
      s.b.vx += dpn * s.nx * s.invM;
      s.b.vy += dpn * s.ny * s.invM;
    }
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const a = c.a, b = c.b;

      // normal: drive relative normal velocity toward +vnTarget (separating)
      const vn = (b.vx - a.vx) * c.nx + (b.vy - a.vy) * c.ny;
      let dpn = -(vn - c.vnTarget) / c.invSum;
      const pn = c.pn + dpn;
      const clampedPn = pn < 0 ? 0 : pn;       // contacts only push
      dpn = clampedPn - c.pn; c.pn = clampedPn;
      if (c.aDyn) { a.vx -= dpn * c.nx * c.invMa; a.vy -= dpn * c.ny * c.invMa; }
      if (c.bDyn) { b.vx += dpn * c.nx * c.invMb; b.vy += dpn * c.ny * c.invMb; }

      // friction: tangential slip at the contact point, clamped to the Coulomb
      // cone against the *accumulated* normal impulse. The spin terms are
      // -ω_a·r_a - ω_b·r_b so the measured slip matches the `omega -= dpt·r/I`
      // torque convention below — the opposite sign makes friction *add* energy
      // to spinning contacts (the rolling-energy test guards this).
      const surfVA = -a.omega * a.r;
      const surfVB = b.omega * b.r;
      const vt = (b.vx - a.vx) * c.tx + (b.vy - a.vy) * c.ty + (surfVA - surfVB);
      let dpt = -(vt - c.vtTarget) / c.tanInvSum;
      const maxPt = c.mu * c.pn;
      const pt = clampv(c.pt + dpt, -maxPt, maxPt);
      dpt = pt - c.pt; c.pt = pt;
      if (c.aDyn) { a.vx -= dpt * c.tx * c.invMa; a.vy -= dpt * c.ty * c.invMa; a.omega -= dpt * a.r / a.inertia; }
      if (c.bDyn) { b.vx += dpt * c.tx * c.invMb; b.vy += dpt * c.ty * c.invMb; b.omega -= dpt * b.r / b.inertia; }
    }
  }

  // --- position correction (NGS, velocity-free) ---
  const pIters = Math.max(0, PHYS.solverPos | 0);
  for (let it = 0; it < pIters; it++) {
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const a = c.a, b = c.b;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dsq = dx * dx + dy * dy;
      let dd, cnx, cny;
      if (dsq < 1e-6) { dd = 1e-3; cnx = c.nx; cny = c.ny; }   // coincident → cached normal
      else { dd = Math.sqrt(dsq); cnx = dx / dd; cny = dy / dd; }
      const pen = (a.r + b.r) - dd;
      if (pen <= POS_SLOP) continue;
      const corr = POS_BETA * (pen - POS_SLOP);
      const ra = c.invMa / c.invSum, rb = c.invMb / c.invSum;
      if (c.aDyn) { a.x -= cnx * corr * ra; a.y -= cny * corr * ra; }
      if (c.bDyn) { b.x += cnx * corr * rb; b.y += cny * corr * rb; }
    }
    // keep balls out of static walls/pegs after they've been shoved around
    clampStatics();
  }

  // --- persist impulses for next frame + fire side-effects ---
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    nextCache.set(c.key, { pn: c.pn, pt: c.pt });
    if (events.contact) events.contact(c);
  }
  for (let i = 0; i < staticContacts.length; i++) {
    const s = staticContacts[i];
    nextCache.set(s.key, { pn: s.pn, pt: 0 });
  }

  const tmp = cache; cache = nextCache; nextCache = tmp;
}

/**
 * Build normal-only support contacts for every awake, free ball overlapping a
 * wall or peg. Warm-started from the cache (keyed by ball id + surface index).
 */
function buildStaticContacts() {
  staticContacts.length = 0;
  const walls = W.walls, pegs = W.pegs, warm = PHYS.warmStart;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pinned || b.sleeping) continue;
    // Particle-fluid drops are a soft model — rigid wall support stiffens their
    // flow (a pool stops levelling). CCD + clampStatics still keep them in
    // bounds, so they skip the rigid support contacts.
    if (b.mat.fluidSim) continue;
    // Speculative margin: a ball resting on a surface sits at exactly dl == r
    // (CCD places it there), so without a margin it would never get a support
    // contact and a heavy neighbour could push it through. The margin makes the
    // support ready the moment something shoves it inward.
    const r = b.r, rw = r + STATIC_MARGIN, invM = 1 / b.mass;
    for (let w = 0; w < walls.length; w++) {
      const wl = walls[w];
      const wx = wl.x2 - wl.x1, wy = wl.y2 - wl.y1;
      const wlen2 = wx * wx + wy * wy || 1e-4;
      let t = ((b.x - wl.x1) * wx + (b.y - wl.y1) * wy) / wlen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = b.x - (wl.x1 + wx * t), dy = b.y - (wl.y1 + wy * t);
      const dsq = dx * dx + dy * dy;
      if (dsq >= rw * rw) continue;
      const dl = Math.sqrt(dsq) || 1e-4;
      const nx = dx / dl, ny = dy / dl;
      // Ball not yet penetrating and approaching fast → a real impact, not a
      // rest. Don't brake it here; collideWall bounces it once it penetrates.
      // (≥ with epsilon: a ball arriving EXACTLY at dl == r — possible when
      // v·dt divides the gap — must not get its impact velocity zeroed.)
      if (dl >= r - 0.01 && (b.vx * nx + b.vy * ny) < -STATIC_SUPPORT_VN) continue;
      const key = b.id + 'w' + w;
      const c = warm ? cache.get(key) : undefined;
      staticContacts.push({ b, nx, ny, invM, pn: c ? c.pn : 0, key });
    }
    for (let p = 0; p < pegs.length; p++) {
      const pg = pegs[p];
      const dx = b.x - pg.x, dy = b.y - pg.y;
      const surf = r + pg.r, rs = surf + STATIC_MARGIN;
      const dsq = dx * dx + dy * dy;
      if (dsq >= rs * rs) continue;
      const dl = Math.sqrt(dsq) || 1e-4;
      const nx = dx / dl, ny = dy / dl;
      // Same gate as walls: a fast approacher not yet into the peg surface is
      // an impact for collidePeg to bounce, not a rest to support.
      if (dl >= surf - 0.01 && (b.vx * nx + b.vy * ny) < -STATIC_SUPPORT_VN) continue;
      const key = b.id + 'p' + p;
      const c = warm ? cache.get(key) : undefined;
      staticContacts.push({ b, nx, ny, invM, pn: c ? c.pn : 0, key });
    }
  }
}

/**
 * Position-only projection of balls out of walls + pegs. Runs inside the
 * NGS loop so the ball-ball pass can't quietly bury balls in geometry.
 * Velocity is untouched (the CCD pass in step.js owns wall bounce).
 */
function clampStatics() {
  const walls = W.walls, pegs = W.pegs;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pinned || b.sleeping) continue;
    for (let w = 0; w < walls.length; w++) {
      const wl = walls[w];
      const wx = wl.x2 - wl.x1, wy = wl.y2 - wl.y1;
      const wlen2 = wx * wx + wy * wy || 1e-4;
      let t = ((b.x - wl.x1) * wx + (b.y - wl.y1) * wy) / wlen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = wl.x1 + wx * t, cy = wl.y1 + wy * t;
      const dx = b.x - cx, dy = b.y - cy;
      const dsq = dx * dx + dy * dy;
      if (dsq >= b.r * b.r) continue;
      const dl = Math.sqrt(dsq) || 1e-4;
      b.x = cx + dx / dl * b.r;
      b.y = cy + dy / dl * b.r;
    }
    for (let p = 0; p < pegs.length; p++) {
      const pg = pegs[p];
      const dx = b.x - pg.x, dy = b.y - pg.y;
      const rs = b.r + pg.r;
      const dsq = dx * dx + dy * dy;
      if (dsq >= rs * rs) continue;
      const dl = Math.sqrt(dsq) || 1e-4;
      b.x = pg.x + dx / dl * rs;
      b.y = pg.y + dy / dl * rs;
    }
  }
}
