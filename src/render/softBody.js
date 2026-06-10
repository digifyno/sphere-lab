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

    // live centroid + extent — refreshCentroid is a pure recompute, so the
    // render needn't assume physics ran this frame; outerRadius is the same
    // measure the shadow pass + hit-testing use, so the three can't drift.
    sb.refreshCentroid();
    const cx = sb.cx, cy = sb.cy;
    const R = sb.outerRadius();

    // The painted skin is the node SURFACE, not the node centres: push each
    // ring point outward by its node radius, else the blob renders one
    // node-radius smaller than it collides — visibly hovering above its own
    // shadow and contacts.
    const px = [], py = [];
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const dx = nd.x - cx, dy = nd.y - cy;
      const dl = Math.hypot(dx, dy) || 1e-4;
      px.push(nd.x + dx / dl * nd.r);
      py.push(nd.y + dy / dl * nd.r);
    }
    // smoothed closed outline: quadratic curves through edge midpoints, with
    // the surface points as control points → a rounded blob, not a polygon.
    const mx = (i) => (px[i] + px[(i + 1) % n]) * 0.5;
    const my = (i) => (py[i] + py[(i + 1) % n]) * 0.5;
    tx.beginPath();
    tx.moveTo(mx(n - 1), my(n - 1));
    for (let i = 0; i < n; i++) tx.quadraticCurveTo(px[i], py[i], mx(i), my(i));
    tx.closePath();

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
