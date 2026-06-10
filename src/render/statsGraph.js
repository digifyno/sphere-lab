/**
 * Generic sparkline renderer, shared by the FPS / collisions / kinetic-energy
 * graphs in the telemetry panel.
 *
 * - Auto-scales each canvas to its displayed CSS size × devicePixelRatio so
 *   lines stay crisp on hi-DPI displays.
 * - Fills a soft gradient under the line for visual weight.
 * - Optionally clamps Y to a fixed max (FPS capped at 60 for a meaningful band);
 *   otherwise it auto-fits to the data.
 */

import { withAlpha } from '../core/color.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} data
 * @param {{color?: string, max?: number, reference?: number}} [opts]
 */
export function renderSparkline(canvas, data, opts = {}) {
  const color = opts.color ?? '#ffaa33';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // resize backing store to match CSS size * dpr (only when it changes)
  const cssW = canvas.clientWidth  || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (data.length < 2) return;

  // Y scale
  let maxV = opts.max;
  if (maxV === undefined) {
    maxV = 0;
    for (const v of data) if (v > maxV) maxV = v;
    maxV = Math.max(1, maxV * 1.15);
  }

  const stepX = cssW / (data.length - 1);
  const yOf = v => cssH - (Math.min(maxV, v) / maxV) * (cssH - 3) - 1.5;

  // reference line (e.g. 60 fps)
  if (opts.reference !== undefined) {
    const y = yOf(opts.reference);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
    ctx.setLineDash([]);
  }

  // fill area under the line
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, withAlpha(color, 0.33));
  grad.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, cssH);
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX;
    const y = yOf(data[i]);
    if (i === 0) ctx.lineTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(cssW, cssH);
  ctx.closePath();
  ctx.fill();

  // line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX;
    const y = yOf(data[i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // current-value dot
  const last = data[data.length - 1];
  const x = (data.length - 1) * stepX;
  const y = yOf(last);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color + '33';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
}
