/**
 * Fracture — a fragile ball hit hard enough breaks apart into smaller
 * fragment balls (which collide but don't recursively shatter) plus a
 * shower of shard particles and a shatter sound.
 *
 * Velocity threshold is per-material. Glass is stiffer (harder to break),
 * ice is brittle (breaks on moderate impacts).
 */

import { TAU, rand } from '../core/math.js';
import { balls, Ball } from '../entities/ball.js';
import { spawnShard } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';

/** Threshold normal-velocity (px/s) for fracture, by material name. */
const FRACTURE_V = {
  GLASS:    550,
  ICE:      380,
  OBSIDIAN: 320
};

/**
 * If `b` is fragile and was hit at > threshold, break it and return true.
 * The caller must stop processing the collision (the ball no longer exists).
 *
 * @param {import('../entities/ball.js').Ball} b
 * @param {number} impactV — normal-component speed at contact (px/s)
 * @returns {boolean} true if fractured
 */
export function tryFracture(b, impactV) {
  // `_dead` guard makes fracture idempotent: a fragile ball can be the a/b of
  // several contacts resolved in one step, and the solver fires events.contact
  // for each. Without this, the second hard contact shatters an already-dead
  // ball again, spawning a duplicate fragment shower (doubled mass + KE).
  if (b._dead || !b.mat.fragile || b.isFragment) return false;
  const base = FRACTURE_V[b.mat.name] ?? 500;
  // Accumulated damage lowers the effective threshold — a cracked glass
  // ball shatters on a hit that a fresh one would shrug off.
  const dmg = b.damage ?? 0;
  const threshold = base * (1 - dmg * 0.65);
  if (impactV < threshold) return false;
  shatter(b);
  return true;
}

function shatter(b) {
  // 6–9 fragment balls, each 25–45% of the original radius
  const count = 6 + Math.floor(Math.random() * 4);
  // energy (approx) stays flat: total new mass ≈ original mass; velocity spreads
  const spread = 140 + Math.random() * 120;
  const baseAngle = Math.atan2(b.vy, b.vx);

  for (let i = 0; i < count; i++) {
    const a = baseAngle + (i / count) * TAU + rand(-0.4, 0.4);
    const fr = b.r * (0.28 + Math.random() * 0.18);
    const frag = new Ball(
      b.x + Math.cos(a) * b.r * 0.3,
      b.y + Math.sin(a) * b.r * 0.3,
      fr,
      b.mat
    );
    frag.vx = b.vx + Math.cos(a) * spread;
    frag.vy = b.vy + Math.sin(a) * spread;
    frag.omega = rand(-18, 18);
    frag.lifespan = 2.8 + Math.random() * 0.9;
    frag.isFragment = true;
    balls.push(frag);
  }

  // 10 decorative shard particles — more visual density without more physics.
  // Obsidian cleaves into long angular spikes rather than soft shards.
  const isObsidian = b.mat.name === 'OBSIDIAN';
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
  b._dead = true;
  const idx = balls.indexOf(b);
  if (idx >= 0) balls.splice(idx, 1);
}
