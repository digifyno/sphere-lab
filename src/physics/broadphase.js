/**
 * Uniform-grid broadphase with swept insertion.
 *
 * Each ball is hashed into every cell its SWEPT axis-aligned bounding box (the
 * box around its start `px,py` and end `x,y` positions, padded by `r`) covers.
 * Two balls in contact have overlapping AABBs, so they always share at least one
 * cell — same-cell pairing (deduped) catches every contact without the old
 * forward-neighbor scheme. The swept box is the prerequisite for ball-ball CCD:
 * a fast ball still shares a cell with anything along its path, so the solver's
 * time-of-impact test can catch a pass-through it would otherwise tunnel.
 * Cell size adapts to the largest ball (2.2× its radius).
 */

import { balls } from '../entities/ball.js';
import { stats } from './stats.js';

const _gridMap = /** @type {Map<string, import('../entities/ball.js').Ball[]>} */ (new Map());
const _key = (cx, cy) => cx + ':' + cy;

/**
 * @returns {[import('../entities/ball.js').Ball, import('../entities/ball.js').Ball][]}
 * Candidate pairs for narrow-phase testing.
 */
export function buildPairs() {
  let maxR = 20;
  for (const b of balls) if (b.r > maxR) maxR = b.r;
  const cell = Math.max(40, maxR * 2.2);

  _gridMap.clear();
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    const r = b.r;
    // Sleeping/pinned balls hold stale px/py (they skip integration), so treat
    // them as motionless for the swept box.
    const sx = (b.sleeping || b.pinned) ? b.x : b.px;
    const sy = (b.sleeping || b.pinned) ? b.y : b.py;
    const cx0 = Math.floor((Math.min(sx, b.x) - r) / cell);
    const cx1 = Math.floor((Math.max(sx, b.x) + r) / cell);
    const cy0 = Math.floor((Math.min(sy, b.y) - r) / cell);
    const cy1 = Math.floor((Math.max(sy, b.y) + r) / cell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = _key(cx, cy);
      let list = _gridMap.get(k);
      if (!list) { list = []; _gridMap.set(k, list); }
      list.push(b);
    }
  }

  /** @type {[import('../entities/ball.js').Ball, import('../entities/ball.js').Ball][]} */
  const pairs = [];
  // A ball spanning several cells appears in each, so dedupe pairs by id.
  const seen = new Set();
  for (const list of _gridMap.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const key = a.id < b.id ? a.id + '_' + b.id : b.id + '_' + a.id;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }
  }

  stats.pairs = pairs.length;
  return pairs;
}
