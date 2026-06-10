/**
 * Active tool + hit-testing helpers. Exposed via `getTool()` so callers
 * always see the latest value.
 */

import { clamp } from '../core/math.js';
import { balls } from '../entities/ball.js';
import { softBodies } from '../entities/softBody.js';
import { W } from '../core/world.js';
import { canvas } from '../render/canvas.js';

/** @typedef {'spawn'|'grab'|'draw'|'erase'|'link'|'pin'|'push'|'attract'|'heat'} ToolId */

/** @type {ToolId} */
let TOOL = 'spawn';

const LABELS = {
  spawn: 'Spawn', grab: 'Grab', draw: 'Draw', erase: 'Erase',
  link: 'Link', pin: 'Pin', push: 'Push', attract: 'Attract', heat: 'Heat'
};

export function getTool() { return TOOL; }

export function setTool(t) {
  TOOL = t;
  document.querySelectorAll('#tool-row .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('stat-tool').textContent = LABELS[t] || t;
  document.getElementById('mode-text').textContent = (LABELS[t] || t) + ' mode';
  canvas.style.cursor =
    t === 'grab'    ? 'grab'        :
    t === 'draw'    ? 'crosshair'   :
    t === 'erase'   ? 'not-allowed' :
    t === 'attract' ? 'cell'        :
                      'crosshair';
}

export function ballAt(x, y) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if ((b.x - x) ** 2 + (b.y - y) ** 2 < b.r * b.r) return b;
  }
  // A soft blob is painted as one solid body, but its centre has no node
  // disk (the ring leaves a hole of ~0.58·R) — treat a click anywhere inside
  // the blob's outer radius as hitting the nearest node, so grab / erase /
  // link / pin / inspect work on the whole visible blob.
  for (let i = softBodies.length - 1; i >= 0; i--) {
    const sb = softBodies[i];
    sb.refreshCentroid();
    const R = sb.outerRadius();
    if ((sb.cx - x) ** 2 + (sb.cy - y) ** 2 >= R * R) continue;
    let best = null, bd = Infinity;
    for (const nd of sb.nodes) {
      const d = (nd.x - x) ** 2 + (nd.y - y) ** 2;
      if (d < bd) { bd = d; best = nd; }
    }
    return best;
  }
  return null;
}

export function wallAt(x, y, tol = 8) {
  for (let i = 0; i < W.walls.length; i++) {
    const w = W.walls[i];
    const wx = w.x2 - w.x1, wy = w.y2 - w.y1;
    const l2 = wx * wx + wy * wy;
    let t = ((x - w.x1) * wx + (y - w.y1) * wy) / l2;
    t = clamp(t, 0, 1);
    const cx = w.x1 + wx * t, cy = w.y1 + wy * t;
    if ((x - cx) ** 2 + (y - cy) ** 2 < tol * tol) return i;
  }
  return -1;
}
