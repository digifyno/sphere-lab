/**
 * Fracture — a fragile ball hit hard enough breaks into smaller fragment
 * balls (which collide but don't recursively shatter) plus a shower of shard
 * particles and a shatter sound.
 *
 * The criterion is impact ENERGY, not bare speed (Griffith-style):
 *
 *     ½ · m_eff · v_n²  ≥  E_crit(material) · (r / 20)
 *
 * where `m_eff` is the reduced mass of the pair (the ball's own mass against
 * a wall) and E_crit is calibrated so a default r=20 ball breaks against a
 * wall at exactly the material's threshold speed (FRACTURE_V). Consequences,
 * all matching real glass: a light pebble can't crack a boulder at any
 * everyday speed (tiny reduced mass), two equal balls need a harder head-on
 * than a wall hit (the energy is split), and BIGGER balls break EASIER
 * (their KE grows like r², the crack length only like r).
 *
 * Fragment sizes follow a right-skewed power law — a couple of big shards
 * and many small ones — and are normalized so fragment area is 92 % of the
 * original disk (the rest leaves as shard-particle dust). Fragment spread
 * speed scales with the impact speed and the whole shower never carries more
 * kinetic energy than the ball had — fracture consumes energy.
 */

import { TAU, rand } from '../core/math.js';
import { balls, Ball, wakeNear } from '../entities/ball.js';
import { spawnShard } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';

/** Calibration speed (px/s): an r=20 ball of this material shatters against
 *  a wall at exactly this normal velocity. */
const FRACTURE_V = {
  GLASS:    550,
  ICE:      380,
  OBSIDIAN: 320
};

/**
 * If `b` is fragile and the impact carried enough energy, break it and
 * return true. The caller must stop processing the collision (the ball no
 * longer exists).
 *
 * @param {import('../entities/ball.js').Ball} b
 * @param {number} impactV — normal-component speed at contact (px/s)
 * @param {number} [mEff]  — reduced mass of the colliding pair. Defaults to
 *                           b.mass (wall/peg: the other side is immovable).
 * @returns {boolean} true if fractured
 */
export function tryFracture(b, impactV, mEff) {
  // `_dead` guard makes fracture idempotent: a fragile ball can be the a/b of
  // several contacts resolved in one step, and the solver fires events.contact
  // for each. Without this, the second hard contact shatters an already-dead
  // ball again, spawning a duplicate fragment shower (doubled mass + KE).
  if (b._dead || !b.mat.fragile || b.isFragment) return false;
  const V = FRACTURE_V[b.mat.name] ?? 500;
  // E_crit: the r=20 calibration ball's impact energy at V, scaled by r
  // (2D crack length grows linearly with radius). Accumulated damage lowers
  // it — a cracked ball shatters on a hit a fresh one would shrug off.
  const mCal = 400 * b.mat.density * 0.001;
  const dmgF = 1 - (b.damage ?? 0) * 0.65;
  const eCrit = 0.5 * mCal * V * V * (b.r / 20) * dmgF * dmgF;
  const m = mEff ?? b.mass;
  if (0.5 * m * impactV * impactV < eCrit) return false;
  shatter(b, impactV);
  return true;
}

/** Jagged polygon outline for a fragment, in ball-local space — the renderer
 *  draws this instead of a disk. Obsidian cleaves into long angular spikes;
 *  glass/ice into chunky irregular shards. */
function makeShard(spiky) {
  const k = spiky ? 3 + (Math.random() < 0.4 ? 1 : 0) : 4 + Math.floor(Math.random() * 3);
  const pts = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * TAU + rand(-0.35, 0.35);
    const rr = spiky ? (i % 2 ? rand(0.40, 0.65) : rand(1.05, 1.35)) : rand(0.62, 1.12);
    pts.push({ a, r: rr });
  }
  return pts;
}

function shatter(b, impactV) {
  const isObsidian = b.mat.name === 'OBSIDIAN';
  // 7–10 fragments, sizes from a right-skewed power law (u^1.7): a couple of
  // big shards, many small — how brittle materials really fragment.
  const count = 7 + Math.floor(Math.random() * 4);
  const sizes = [];
  let s2 = 0;
  for (let i = 0; i < count; i++) {
    const s = Math.pow(Math.random(), 1.7) + 0.12;
    sizes.push(s); s2 += s * s;
  }
  // normalize: fragment area = 92 % of the disk; the rest is shard dust
  const scale = b.r * Math.sqrt(0.92 / s2);

  // spread comes out of the impact, not from nowhere: ≤ ~30 % of impact
  // speed, so the shower's KE never exceeds what the ball brought in
  const spread = Math.min(300, impactV * 0.25 + 50);
  const baseAngle = Math.atan2(b.vy, b.vx);

  for (let i = 0; i < count; i++) {
    const a = baseAngle + (i / count) * TAU + rand(-0.4, 0.4);
    const fr = Math.max(3.2, sizes[i] * scale);
    const frag = new Ball(
      b.x + Math.cos(a) * b.r * 0.3,
      b.y + Math.sin(a) * b.r * 0.3,
      fr,
      b.mat
    );
    frag.vx = b.vx + Math.cos(a) * spread * rand(0.55, 1);
    frag.vy = b.vy + Math.sin(a) * spread * rand(0.55, 1);
    frag.omega = rand(-18, 18);
    frag.lifespan = 2.8 + Math.random() * 0.9;
    frag.isFragment = true;
    frag.shard = makeShard(isObsidian);
    balls.push(frag);
  }

  // decorative shard particles — more visual density without more physics.
  // Obsidian cleaves into long angular spikes rather than soft shards.
  const shardCount = isObsidian ? 14 : 10;
  for (let i = 0; i < shardCount; i++) {
    const a = Math.random() * TAU;
    const sp = rand(120, 420);
    spawnShard(
      b.x, b.y,
      b.vx * 0.4 + Math.cos(a) * sp,
      b.vy * 0.4 + Math.sin(a) * sp,
      b.mat.color,
      isObsidian
    );
  }

  Snd.shatter(b);

  // remove the original. Mark `_dead` first (the tryFracture guard + step.js
  // cleanup both key off it) so a second contact this step can't re-shatter it;
  // the immediate splice keeps the collideWall/collidePeg return contract.
  // Because of that splice, step.js's dead-ball wake pass never sees a
  // fractured ball — wake the neighbourhood here, or a sleeper stacked on
  // the shattered support hangs frozen in mid-air.
  b._dead = true;
  wakeNear(b.x, b.y, b.r + 50);
  const idx = balls.indexOf(b);
  if (idx >= 0) balls.splice(idx, 1);
}
