/**
 * World-geometry drawing: walls (incl. conveyor belts with animated chevrons),
 * pegs, constraints, springs, flippers, vortex FX, water (with ripples),
 * solar sun glow, ball ground shadows.
 */

import { W } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { TAU, clamp } from '../core/math.js';
import { mix, withAlpha } from '../core/color.js';
import { balls } from '../entities/ball.js';
import { isBallOnScreen } from './ball.js';
import { light } from './canvas.js';

export function drawWalls(tx) {
  tx.shadowColor = '#8fd0ff'; tx.shadowBlur = 4;
  tx.lineWidth = 3; tx.lineCap = 'round';
  for (const w of W.walls) {
    if (w.conveyorV)    tx.strokeStyle = '#56d4ff';
    else if (w.bouncy)  tx.strokeStyle = '#ff7aa8';
    else if (w.flipper) tx.strokeStyle = '#ffb340';
    else                tx.strokeStyle = '#4a607c';
    tx.beginPath(); tx.moveTo(w.x1, w.y1); tx.lineTo(w.x2, w.y2); tx.stroke();
  }
  tx.shadowBlur = 0;
  tx.strokeStyle = 'rgba(255,255,255,0.18)';
  tx.lineWidth = 1;
  for (const w of W.walls) {
    tx.beginPath(); tx.moveTo(w.x1, w.y1); tx.lineTo(w.x2, w.y2); tx.stroke();
  }

  // animated conveyor chevrons — > > > crawling along the belt in the direction of motion
  const t = performance.now() * 0.001;
  for (const w of W.walls) {
    if (!w.conveyorV) continue;
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const L = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / L, uy = dy / L;       // along-belt unit
    const nx = -uy, ny = ux;              // belt-offset unit
    const sign = Math.sign(w.conveyorV);
    const crawl = ((t * Math.abs(w.conveyorV) * 0.01) % 30);
    tx.strokeStyle = 'rgba(200, 240, 255, 0.55)';
    tx.lineWidth = 1.2;
    // Crawl toward (x2,y2) when conveyorV>0 (the drag direction): crawl grows
    // with t, so a positive belt needs an INCREASING start offset (+u toward
    // x2), a negative one a decreasing offset (-u toward x1).
    const phase = sign > 0 ? crawl - 30 : -crawl;
    for (let d = phase; d < L; d += 30) {
      if (d < 5 || d > L - 5) continue;
      const cx = w.x1 + ux * d, cy = w.y1 + uy * d;
      const tipX = cx + ux * 6 * sign,   tipY = cy + uy * 6 * sign;
      const a1X  = cx - ux * 2 * sign + nx * 4, a1Y = cy - uy * 2 * sign + ny * 4;
      const a2X  = cx - ux * 2 * sign - nx * 4, a2Y = cy - uy * 2 * sign - ny * 4;
      tx.beginPath();
      tx.moveTo(a1X, a1Y); tx.lineTo(tipX, tipY); tx.lineTo(a2X, a2Y);
      tx.stroke();
    }
  }
}

export function drawFlippers(tx) {
  for (const f of W.flippers) {
    const x2 = f.px + Math.cos(f.angle) * f.length;
    const y2 = f.py + Math.sin(f.angle) * f.length;

    tx.save();
    tx.shadowColor = '#ffb340';
    tx.shadowBlur = f.active ? 14 : 6;
    tx.strokeStyle = f.active ? '#ffd080' : '#ffb340';
    tx.lineWidth = 9;
    tx.lineCap = 'round';
    tx.beginPath(); tx.moveTo(f.px, f.py); tx.lineTo(x2, y2); tx.stroke();
    tx.restore();

    tx.fillStyle = '#2a1a08';
    tx.beginPath(); tx.arc(f.px, f.py, 5, 0, TAU); tx.fill();
    tx.strokeStyle = '#ffb340'; tx.lineWidth = 1;
    tx.beginPath(); tx.arc(f.px, f.py, 5, 0, TAU); tx.stroke();
  }
}

export function drawPegs(tx) {
  for (const p of W.pegs) {
    const bumper = p.bumper;
    tx.fillStyle = 'rgba(0,0,0,0.45)';
    tx.beginPath();
    tx.ellipse(p.x + 2, p.y + 4, p.r * 1.1, p.r * 0.35, 0, 0, TAU);
    tx.fill();

    const g = tx.createRadialGradient(p.x - p.r * 0.4, p.y - p.r * 0.4, 0, p.x, p.y, p.r);
    if (bumper) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.004);
      g.addColorStop(0,   '#fff');
      g.addColorStop(0.5, '#ffcc40');
      g.addColorStop(1,   '#804000');
      tx.fillStyle = g;
      tx.beginPath(); tx.arc(p.x, p.y, p.r, 0, TAU); tx.fill();
      tx.strokeStyle = `rgba(255,200,80,${0.5 + pulse * 0.5})`;
      tx.lineWidth = 2 + pulse * 2;
      tx.beginPath(); tx.arc(p.x, p.y, p.r + 3, 0, TAU); tx.stroke();
    } else {
      g.addColorStop(0,   '#fff8c8');
      g.addColorStop(0.6, '#ffc048');
      g.addColorStop(1,   '#604000');
      tx.fillStyle = g;
      tx.beginPath(); tx.arc(p.x, p.y, p.r, 0, TAU); tx.fill();
      tx.strokeStyle = '#3a2200'; tx.lineWidth = 1;
      tx.stroke();
    }
  }
}

export function drawConstraints(tx) {
  tx.strokeStyle = 'rgba(200,220,255,0.6)';
  tx.lineWidth = 1;
  for (const c of W.constraints) {
    if (!c.a) continue;
    tx.beginPath(); tx.moveTo(c.ax, c.ay); tx.lineTo(c.a.x, c.a.y); tx.stroke();
    tx.fillStyle = '#8a9fba';
    tx.beginPath(); tx.arc(c.ax, c.ay, 3, 0, TAU); tx.fill();
  }
}

export function drawSprings(tx) {
  for (const s of W.springs) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = (d - s.rest) / s.rest;
    const col = stretch > 0
      ? mix('#ffffff', '#ff4060', Math.min(1,  stretch * 2))
      : mix('#ffffff', '#4080ff', Math.min(1, -stretch * 2));
    tx.strokeStyle = col;
    tx.globalAlpha = 0.55;
    tx.lineWidth = clamp(1.5 - Math.abs(stretch) * 0.5, 0.4, 2);

    // Endpoints: center-to-center for scene-built springs (no offset set),
    // surface-to-surface at an offset angle for reinforced Link-tool
    // springs. The offset rotates with the ball because it's stored in
    // ball-local frame — reinforced links keep their fan pattern.
    let ax = s.a.x, ay = s.a.y, bx = s.b.x, by = s.b.y;
    if (s.offA !== undefined) {
      const aa = s.a.angle + s.offA;
      ax = s.a.x + Math.cos(aa) * s.a.r;
      ay = s.a.y + Math.sin(aa) * s.a.r;
    }
    if (s.offB !== undefined) {
      const ab = s.b.angle + s.offB;
      bx = s.b.x + Math.cos(ab) * s.b.r;
      by = s.b.y + Math.sin(ab) * s.b.r;
    }

    tx.beginPath();
    tx.moveTo(ax, ay);
    tx.lineTo(bx, by);
    tx.stroke();
  }
  tx.globalAlpha = 1;
}

export function drawWater(tx) {
  if (W.waterY === undefined) return;
  const y = W.waterY;

  const g = tx.createLinearGradient(0, y, 0, W.ch);
  g.addColorStop(0, 'rgba(80,160,220,0.4)');
  g.addColorStop(1, 'rgba(30,80,140,0.65)');
  tx.fillStyle = g;
  tx.fillRect(0, y, W.cw, W.ch - y);

  const t = performance.now() * 0.0012;
  const sample = x => {
    let dy = Math.sin(x * 0.015 + t * 2) * 4 + Math.sin(x * 0.04 + t * 3.1) * 2;
    for (const r of W.ripples) {
      const dist = Math.abs(x - r.x);
      const leading = r.phase * 160;
      const env = Math.max(0, 1 - Math.abs(dist - leading) / 140);
      dy += Math.sin(dist * 0.08 - r.phase * 6) * r.amp * env;
    }
    return dy;
  };

  tx.strokeStyle = 'rgba(180,220,255,0.75)';
  tx.lineWidth = 2;
  tx.beginPath();
  for (let x = 0; x <= W.cw; x += 4) {
    const dy = sample(x);
    if (x === 0) tx.moveTo(x, y + dy); else tx.lineTo(x, y + dy);
  }
  tx.stroke();

  tx.strokeStyle = 'rgba(255,255,255,0.25)';
  tx.lineWidth = 1;
  tx.beginPath();
  for (let x = 0; x <= W.cw; x += 6) {
    const dy = Math.sin(x * 0.022 + t * 1.6) * 3;
    if (x === 0) tx.moveTo(x, y - 2 + dy); else tx.lineTo(x, y - 2 + dy);
  }
  tx.stroke();

  tx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 6; i++) {
    const cx = ((i * 223 + t * 80) % W.cw);
    const g2 = tx.createRadialGradient(cx, y + 30, 0, cx, y + 30, 90);
    g2.addColorStop(0, 'rgba(180,220,255,0.14)');
    g2.addColorStop(1, 'rgba(180,220,255,0)');
    tx.fillStyle = g2;
    tx.fillRect(cx - 90, y, 180, 120);
  }
  tx.globalCompositeOperation = 'source-over';
}

export function drawVortex(tx) {
  if (W.scene !== 'vortex') return;
  const t = performance.now() * 0.0004;
  for (let r = 40; r < 520; r += 40) {
    tx.strokeStyle = `rgba(200,120,255,${0.14 * (1 - r / 520)})`;
    tx.lineWidth = 1;
    tx.beginPath();
    for (let a = 0; a < TAU + 0.1; a += 0.08) {
      const rr = r + Math.sin(a * 3 + t + r * 0.01) * 10;
      const x = W.vortexX + Math.cos(a) * rr;
      const y = W.vortexY + Math.sin(a) * rr;
      if (a === 0) tx.moveTo(x, y); else tx.lineTo(x, y);
    }
    tx.closePath(); tx.stroke();
  }
  const g = tx.createRadialGradient(W.vortexX, W.vortexY, 0, W.vortexX, W.vortexY, 80);
  g.addColorStop(0, 'rgba(200,120,255,0.6)');
  g.addColorStop(1, 'rgba(200,120,255,0)');
  tx.fillStyle = g;
  tx.beginPath(); tx.arc(W.vortexX, W.vortexY, 80, 0, TAU); tx.fill();
}

export function drawSolarCenter(tx) {
  if (!W.solar) return;
  const cx = W.cw / 2, cy = W.ch / 2;
  const pulse = 0.92 + 0.08 * Math.sin(performance.now() * 0.002);
  const g = tx.createRadialGradient(cx, cy, 30, cx, cy, 200);
  g.addColorStop(0,   'rgba(255,220,120,0.8)');
  g.addColorStop(0.4, 'rgba(255,140,40,0.25)');
  g.addColorStop(1,   'rgba(255,120,40,0)');
  tx.fillStyle = g;
  tx.beginPath();
  tx.arc(cx, cy, 200 * pulse, 0, TAU);
  tx.fill();
}

/**
 * Soft floor shadows — rendered with a canvas filter blur so they read as
 * penumbra, not a sharp ellipse. Three stacked ellipses: the umbra (darkest,
 * smallest), a mid band, and a wide penumbra. Distance softens + spreads.
 */
export function drawBallShadows(tx) {
  if (!PHYS.shadow || !PHYS.gravityOn) return;
  const floorY = W.ch - 40;
  // Same key light the ball shader uses (upper-left), so shadows agree with
  // the highlights instead of sitting straight below every ball.
  const lx = light.x * W.cw, ly = light.y * W.ch;
  tx.save();
  for (const b of balls) {
    const dist = floorY - (b.y + b.r);
    if (dist < 0 || dist > 300) continue;
    // Viewport cull — shadows sit at the floor, so check horizontally
    // against the camera view. Saves the 3-layer ellipse stack per ball.
    if (!isBallOnScreen(b)) continue;
    // distance-based: the higher the ball, the wider + fainter the shadow
    const t = dist / 300;
    // Contact hardening: the penumbra collapses as the ball nears the floor —
    // a sharp dark contact patch at d→0, soft + wide when it is high up.
    tx.filter = `blur(${(1 + t * 5).toFixed(1)}px)`;
    const spread = 1 + t * 1.6;
    const alpha = 0.42 * (1 - t);
    // Planar shadow projection along the light ray (similar triangles): a ball
    // lit from the upper-left casts to the lower-right, the offset + skew
    // growing with height. Lean is a gentle horizontal tilt so the ellipse
    // stays flat on the floor (not the full vertical-dominated azimuth).
    const bias = clamp((b.x - lx) / (floorY - ly), -1.2, 1.2);
    const sx = b.x + bias * dist * 0.5;
    const stretch = 1 + 0.4 * Math.abs(bias);
    const rot = bias * 0.5;
    // firm dark contact 'kiss' only when very close to the floor (capped so it
    // never reads as a hard black blob — keeps the soft stylized look)
    const contact = clamp((0.15 - t) * 3, 0, 1);
    const umbraA = Math.min(0.55, alpha * 0.7 * (1 + contact * 0.6));
    // Tinted shadows: translucent glass filters the skylight to its own hue, so
    // its shadow isn't pure black; an emissive/hot ball under-lights the floor
    // rather than darkening it, so its shadow is much fainter.
    const tint = b.mat.refract > 0.3 ? mix('#000000', b.mat.color, 0.45) : '#000000';
    const shScale = (b.mat.glow > 0.5 || b.heat > 0.4) ? 0.3 : 1;
    // 3-layer shadow: umbra → mid → penumbra
    tx.fillStyle = withAlpha(tint, umbraA * shScale);
    tx.beginPath();
    tx.ellipse(sx, floorY, b.r * spread * (0.8 - contact * 0.2) * stretch, b.r * 0.24 * spread, rot, 0, TAU);
    tx.fill();
    tx.fillStyle = withAlpha(tint, alpha * 0.4 * shScale);
    tx.beginPath();
    tx.ellipse(sx, floorY, b.r * spread * 1.15 * stretch, b.r * 0.32 * spread, rot, 0, TAU);
    tx.fill();
    tx.fillStyle = withAlpha(tint, alpha * 0.18 * shScale);
    tx.beginPath();
    tx.ellipse(sx, floorY, b.r * spread * 1.7 * stretch, b.r * 0.45 * spread, rot, 0, TAU);
    tx.fill();
  }
  tx.restore();
}
