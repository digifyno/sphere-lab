/**
 * Screen-space effects:
 *   drawAO        — soft occlusion wedge between close balls (multiply blend)
 *   drawParticles — sparks + smoke + expanding impact rings
 *   drawLensFlares— additive cross-rays on bright sources
 *
 * Particles now use `withAlpha` for the fade endpoint — the old
 * `color.replace(/..$/, '00')` trick silently corrupted 6-char hex inputs.
 */

import { W } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { TAU, clamp, lerp } from '../core/math.js';
import { withAlpha } from '../core/color.js';
import { balls } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { isBallOnScreen } from './ball.js';

/**
 * Screen-space contact shadow. Darkens the narrow region between two close
 * balls (but not touching) along the midpoint axis — reads as AO in stacks.
 * O(n²) but bounded by the 260-ball cap.
 */
export function drawAO(tx) {
  if (!PHYS.ao || balls.length < 2) return;
  tx.save();
  tx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    // Soft-body nodes are hidden lattice parts of one painted blob — pair
    // AO against them bleeds contact shading through the translucent body.
    if (a.isSoftNode) continue;
    // If `a` is entirely off-screen, every pair it's in is too — skip
    // the whole inner loop. This turns the nominal O(n²) into something
    // closer to O(visible²) which is much smaller when zoomed in.
    if (!isBallOnScreen(a, 80)) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.isSoftNode) continue;
      if (!isBallOnScreen(b, 80)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const rsum = a.r + b.r;
      const near = rsum * 1.7;
      if (d2 > near * near) continue;
      const d = Math.sqrt(d2) || 0.001;
      if (d < rsum * 0.98) continue;
      // occlusion strength smoothly falls off as balls move apart
      const t = clamp(1 - (d - rsum) / (near - rsum), 0, 1);
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const rr = Math.min(a.r, b.r) * 1.1;
      const alpha = 0.6 * t * t;   // t² = softer falloff, less harsh at fringes
      const grad = tx.createRadialGradient(mx, my, 0, mx, my, rr * 1.4);
      grad.addColorStop(0,   `rgba(0,0,0,${alpha})`);
      grad.addColorStop(0.6, `rgba(0,0,0,${alpha * 0.3})`);
      grad.addColorStop(1,   'rgba(0,0,0,0)');
      tx.fillStyle = grad;
      tx.beginPath(); tx.arc(mx, my, rr * 1.4, 0, TAU); tx.fill();
    }
  }
  tx.restore();
}

export function drawParticles(tx) {
  for (const p of particles) {
    if (p.life <= 0) continue;
    const a = p.life / p.maxLife;
    tx.globalAlpha = a;

    if (p.type === 'spark') {
      // Real sparks trail behind their hot core — draw a short line in the
      // direction the spark is coming from, with a bright fillet at the tip.
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      const trailLen = Math.min(18, sp * 0.025) * (0.5 + 0.5 * a);
      const ux = -p.vx / sp, uy = -p.vy / sp;
      tx.strokeStyle = p.color;
      tx.lineWidth = Math.max(0.8, p.size * a * 0.85);
      tx.lineCap = 'round';
      tx.beginPath();
      tx.moveTo(p.x, p.y);
      tx.lineTo(p.x + ux * trailLen, p.y + uy * trailLen);
      tx.stroke();
      // bright tip
      tx.fillStyle = p.color;
      tx.beginPath();
      tx.arc(p.x, p.y, Math.max(0.7, p.size * a * 0.55), 0, TAU);
      tx.fill();
    } else if (p.type === 'smoke') {
      // Off-center inner blob keeps the cloud from looking like a perfect
      // disc — cheap turbulence illusion.
      const phase = p.life * 4 + p.x * 0.013;
      const ox = Math.cos(phase) * p.size * 0.22;
      const oy = Math.sin(phase * 1.3) * p.size * 0.22;
      const g = tx.createRadialGradient(p.x + ox, p.y + oy, 0, p.x, p.y, p.size);
      g.addColorStop(0,    p.color);
      g.addColorStop(0.35, withAlpha(p.color, 0.6));
      g.addColorStop(1,    withAlpha(p.color, 0));
      tx.fillStyle = g;
      tx.beginPath();
      tx.arc(p.x, p.y, p.size, 0, TAU);
      tx.fill();
    } else if (p.type === 'ring') {
      const rr = lerp(p.ringR0 ?? 0, p.ringR1 ?? 40, 1 - a);
      tx.globalAlpha = a * 0.9;
      tx.strokeStyle = p.color;
      tx.lineWidth = 2 * a + 0.5;
      tx.beginPath(); tx.arc(p.x, p.y, rr, 0, TAU); tx.stroke();
    } else if (p.type === 'sparkle') {
      // bright cross-shaped twinkle — glass + plasma impacts
      tx.globalAlpha = a;
      tx.strokeStyle = p.color;
      tx.lineWidth = 0.8;
      const s = p.size * (1 + 2 * (1 - a));
      tx.beginPath();
      tx.moveTo(p.x - s, p.y); tx.lineTo(p.x + s, p.y);
      tx.moveTo(p.x, p.y - s); tx.lineTo(p.x, p.y + s);
      tx.stroke();
      tx.fillStyle = p.color;
      tx.beginPath(); tx.arc(p.x, p.y, 0.9, 0, TAU); tx.fill();
    } else if (p.type === 'chip') {
      // small angular shard — pointed stroke
      tx.fillStyle = p.color;
      tx.strokeStyle = withAlpha(p.color, a * 0.5);
      tx.beginPath();
      const s = p.size;
      tx.moveTo(p.x - s, p.y);
      tx.lineTo(p.x, p.y - s);
      tx.lineTo(p.x + s * 0.6, p.y + s * 0.3);
      tx.closePath();
      tx.fill();
    } else if (p.type === 'dust') {
      // wide soft cloud
      const g = tx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 1.4);
      g.addColorStop(0, withAlpha(p.color, 0.35 * a));
      g.addColorStop(1, withAlpha(p.color, 0));
      tx.fillStyle = g;
      tx.globalAlpha = 1;
      tx.beginPath(); tx.arc(p.x, p.y, p.size * 1.4, 0, TAU); tx.fill();
    } else if (p.type === 'shard') {
      // tumbling fragment — thin triangle that rotates. Obsidian's jagged
      // variant draws a long asymmetric spike with a rim highlight.
      tx.save();
      tx.translate(p.x, p.y);
      tx.rotate(p.rot ?? 0);
      tx.fillStyle = p.color;
      tx.strokeStyle = 'rgba(255,255,255,0.35)';
      tx.lineWidth = 0.6;
      const s = p.size;
      tx.beginPath();
      if (p.jagged) {
        // elongated cleaved spike with an extra kink on the trailing edge
        tx.moveTo(-s * 1.8, -s * 0.12);
        tx.lineTo( s * 2.0, -s * 0.25);
        tx.lineTo( s * 0.2,  s * 0.18);
        tx.lineTo(-s * 0.3,  s * 0.08);
        tx.lineTo(-s * 0.1, -s * 0.04);
      } else {
        tx.moveTo(-s, -s * 0.4);
        tx.lineTo( s, -s * 0.1);
        tx.lineTo( s * 0.3, s * 0.8);
      }
      tx.closePath();
      tx.fill();
      tx.stroke();
      // Jagged shards get a bright specular streak along their leading edge
      if (p.jagged) {
        tx.strokeStyle = 'rgba(255,255,255,0.55)';
        tx.lineWidth = 0.5;
        tx.beginPath();
        tx.moveTo(-s * 1.6, -s * 0.10);
        tx.lineTo( s * 1.7, -s * 0.22);
        tx.stroke();
      }
      tx.restore();
    }
  }
  tx.globalAlpha = 1;
}

/**
 * Plasma-to-plasma electric arcs. Every pair of plasma balls within
 * `ARC_RANGE` draws a jagged additive bolt between them, intensity
 * falling off with distance. New jitter per frame so the arcs flicker.
 */
const ARC_RANGE = 140;
export function drawPlasmaArcs(tx) {
  // collect plasma balls once. Off-screen plasma balls can still be in
  // a visible arc-pair if their partner is on-screen, so we only cull
  // when BOTH ends of a pair are off-screen (done in the inner loop).
  /** @type {import('../entities/ball.js').Ball[]} */
  const src = [];
  for (const b of balls) if (b.mat.name === 'PLASMA') src.push(b);
  if (src.length < 2) return;

  tx.save();
  tx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < src.length; i++) {
    const a = src[i];
    const aOn = isBallOnScreen(a, ARC_RANGE);
    for (let j = i + 1; j < src.length; j++) {
      const b = src[j];
      // Skip pair only if both are off-screen (an arc can span into view
      // from an off-screen source).
      if (!aOn && !isBallOnScreen(b, ARC_RANGE)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > ARC_RANGE * ARC_RANGE) continue;
      const d = Math.sqrt(d2) || 0.001;
      const rsum = a.r + b.r;
      if (d < rsum * 1.05) continue;   // overlapping balls — skip
      const t = 1 - d / ARC_RANGE;       // 0..1 strength

      // jagged path perpendicular to the A-B axis
      const nx = -dy / d, ny = dx / d;
      const ax = a.x + (dx / d) * a.r;
      const ay = a.y + (dy / d) * a.r;
      const bx = b.x - (dx / d) * b.r;
      const by = b.y - (dy / d) * b.r;
      const len = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
      const segs = Math.max(4, Math.min(10, Math.floor(len / 14)));
      const amp = Math.min(18, len * 0.18);

      // outer halo
      tx.strokeStyle = `rgba(220,160,255,${0.20 * t})`;
      tx.lineWidth = 6;
      tx.lineCap = 'round';
      tx.beginPath();
      tx.moveTo(ax, ay);
      const path = [];
      for (let s = 1; s < segs; s++) {
        const u = s / segs;
        const jitter = (Math.random() - 0.5) * amp * (1 - Math.abs(u - 0.5) * 1.6);
        const px = ax + (bx - ax) * u + nx * jitter;
        const py = ay + (by - ay) * u + ny * jitter;
        path.push([px, py]);
        tx.lineTo(px, py);
      }
      tx.lineTo(bx, by);
      tx.stroke();

      // mid body
      tx.strokeStyle = `rgba(240,200,255,${0.55 * t})`;
      tx.lineWidth = 2.2;
      tx.beginPath();
      tx.moveTo(ax, ay);
      for (const [px, py] of path) tx.lineTo(px, py);
      tx.lineTo(bx, by);
      tx.stroke();

      // bright core
      tx.strokeStyle = `rgba(255,255,255,${0.9 * t})`;
      tx.lineWidth = 0.9;
      tx.beginPath();
      tx.moveTo(ax, ay);
      for (const [px, py] of path) tx.lineTo(px, py);
      tx.lineTo(bx, by);
      tx.stroke();

      // occasional branch — a short forked offshoot
      if (Math.random() < 0.15 * t) {
        const [bpx, bpy] = path[Math.floor(path.length / 2)] || [ax, ay];
        const bLen = rsum * (0.6 + Math.random() * 0.8);
        const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * Math.PI * 0.9;
        const ex = bpx + Math.cos(ang) * bLen;
        const ey = bpy + Math.sin(ang) * bLen;
        tx.strokeStyle = `rgba(220,180,255,${0.45 * t})`;
        tx.lineWidth = 1.2;
        tx.beginPath();
        tx.moveTo(bpx, bpy); tx.lineTo(ex, ey); tx.stroke();
      }
    }
  }
  tx.restore();
  tx.globalAlpha = 1;
}

export function drawLensFlares(tx) {
  if (!PHYS.flare) return;
  tx.save();
  tx.globalCompositeOperation = 'lighter';
  const sources = [];
  for (const b of balls) {
    const glow = Math.max(b.mat.glow || 0, b.heat * 0.9);
    if (glow <= 0.6) continue;
    // Flares project outward past the ball's footprint, so a generous
    // margin — otherwise we'd pop rays as a glowing ball exits the view.
    if (!isBallOnScreen(b, b.r * 4)) continue;
    sources.push({ x: b.x, y: b.y, r: b.r, color: b.effectiveColor(), strength: glow });
  }
  if (W.solar) sources.push({ x: W.cw / 2, y: W.ch / 2, r: 60, color: '#ffdc80', strength: 1.4 });

  for (const s of sources) {
    const gcore = tx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 2.5);
    gcore.addColorStop(0,    withAlpha(s.color, 1));
    gcore.addColorStop(0.25, withAlpha(s.color, 0.33));
    gcore.addColorStop(1,    withAlpha(s.color, 0));
    tx.globalAlpha = Math.min(1, s.strength * 0.5);
    tx.fillStyle = gcore;
    tx.beginPath(); tx.arc(s.x, s.y, s.r * 2.5, 0, TAU); tx.fill();

    tx.globalAlpha = Math.min(0.6, s.strength * 0.35);
    tx.strokeStyle = s.color;
    const rays = 4;
    const rayLen = s.r * 5;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI + performance.now() * 0.00003;
      tx.lineWidth = 1.3;
      tx.beginPath();
      tx.moveTo(s.x - Math.cos(a) * rayLen, s.y - Math.sin(a) * rayLen);
      tx.lineTo(s.x + Math.cos(a) * rayLen, s.y + Math.sin(a) * rayLen);
      tx.stroke();
    }
  }
  tx.restore();
  tx.globalAlpha = 1;
}
