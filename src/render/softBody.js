/**
 * Soft-body rendering — draw each blob as ONE smooth filled shape (a quadratic
 * spline through the ring nodes) with the material body gradient + a rim,
 * instead of its individual node disks. Translucent for refractive jellies.
 */

import { softBodies } from '../entities/softBody.js';
import { lighten, darken, withAlpha } from '../core/color.js';

export function drawSoftBodies(tx) {
  for (let s = 0; s < softBodies.length; s++) {
    const sb = softBodies[s];
    const nodes = sb.nodes, n = nodes.length;
    if (n < 3) continue;
    const mat = sb.mat;

    // smoothed closed outline: quadratic curves through edge midpoints, with the
    // node centres as control points → a rounded blob, not a faceted polygon.
    const mx = (i) => (nodes[i].x + nodes[(i + 1) % n].x) * 0.5;
    const my = (i) => (nodes[i].y + nodes[(i + 1) % n].y) * 0.5;
    tx.beginPath();
    tx.moveTo(mx(n - 1), my(n - 1));
    for (let i = 0; i < n; i++) tx.quadraticCurveTo(nodes[i].x, nodes[i].y, mx(i), my(i));
    tx.closePath();

    // centroid computed here (render must not assume physics ran this frame)
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += nodes[i].x; cy += nodes[i].y; }
    cx /= n; cy /= n;
    let R = 1;
    for (let i = 0; i < n; i++) R = Math.max(R, Math.hypot(nodes[i].x - cx, nodes[i].y - cy));
    const c = mat.color;
    const g = tx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * 1.15);
    g.addColorStop(0, lighten(c, 0.45));
    g.addColorStop(0.55, c);
    g.addColorStop(1, darken(c, 0.42));

    tx.save();
    tx.globalAlpha = mat.refract ? 0.84 : 1;     // jelly is a little translucent
    tx.fillStyle = g;
    tx.fill();
    // soft inner glow for emissive materials
    if (mat.glow) {
      tx.globalAlpha = Math.min(0.5, mat.glow * 0.4);
      tx.fillStyle = withAlpha(lighten(c, 0.6), 1);
      tx.fill();
    }
    // grazing rim
    tx.globalAlpha = 1;
    tx.lineWidth = 2;
    tx.strokeStyle = withAlpha(lighten(c, 0.55), 0.5);
    tx.stroke();
    tx.restore();
  }
}
