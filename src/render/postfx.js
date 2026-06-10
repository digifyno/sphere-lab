/**
 * Post-processing pipeline.
 *
 *   doBloomPass() — half-res bright-pass (material glow > threshold), then a
 *                   horizontal blur, then a vertical blur, then composited
 *                   additively. Two passes give a softer, wider bloom than a
 *                   single blur; splitting H/V is cheaper than a 2D blur.
 *   doPostFX()    — chromatic aberration (radial red/blue tint) + film grain.
 *
 * Call order from the loop: bloom → postfx.
 */

import { W } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { TAU, clamp, len } from '../core/math.js';
import { mix, withAlpha } from '../core/color.js';
import { balls } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { canvas, ctx, dpr, bloomCanvas, bloomCtx } from './canvas.js';

/* ---------------------- film grain (precomputed noise tile) ---------------------- */
const grainCanvas = document.createElement('canvas');
const grainCtx = grainCanvas.getContext('2d');
let grainT = 0;
function buildGrain() {
  grainCanvas.width = 180;
  grainCanvas.height = 180;
  const img = grainCtx.createImageData(180, 180);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() * 255) | 0;
    img.data[i] = n; img.data[i + 1] = n; img.data[i + 2] = n;
    img.data[i + 3] = 28;
  }
  grainCtx.putImageData(img, 0, 0);
}
buildGrain();

/* Second offscreen used for the second blur pass. Same size as bloomCanvas. */
const bloomPass2 = document.createElement('canvas');
const bloomPass2Ctx = bloomPass2.getContext('2d');

export function doPostFX() {
  if (PHYS.aberration) {
    const avgSpeed = balls.length ? balls.reduce((s, b) => s + len(b.vx, b.vy), 0) / balls.length : 0;
    const strength = clamp(1 + avgSpeed * 0.003, 1, 3.5);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.05;
    const vigR = ctx.createRadialGradient(W.cw / 2, W.ch / 2, Math.min(W.cw, W.ch) * 0.5, W.cw / 2, W.ch / 2, Math.max(W.cw, W.ch) * 0.8);
    vigR.addColorStop(0, 'rgba(0,0,0,0)');
    vigR.addColorStop(1, `rgba(255,80,100,${0.08 * strength})`);
    ctx.fillStyle = vigR;
    ctx.fillRect(-strength, 0, W.cw, W.ch);
    const vigB = ctx.createRadialGradient(W.cw / 2, W.ch / 2, Math.min(W.cw, W.ch) * 0.5, W.cw / 2, W.ch / 2, Math.max(W.cw, W.ch) * 0.8);
    vigB.addColorStop(0, 'rgba(0,0,0,0)');
    vigB.addColorStop(1, `rgba(80,180,255,${0.08 * strength})`);
    ctx.fillStyle = vigB;
    ctx.fillRect(strength, 0, W.cw, W.ch);
    ctx.restore();
  }

  if (PHYS.grain) {
    grainT += 0.04;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    const ox = ((grainT * 37) % 1) * -180;
    const oy = ((grainT * 41) % 1) * -180;
    const pat = ctx.createPattern(grainCanvas, 'repeat');
    if (pat) {
      ctx.fillStyle = pat;
      ctx.translate(ox, oy);
      ctx.fillRect(-ox, -oy, W.cw, W.ch);
    }
    ctx.restore();
  }
}

/**
 * Bloom as three sequential passes:
 *   1. Bright pass: draw glowing sources into bloomCanvas (half-res, black bg).
 *   2. Horizontal blur: filter 10px H → bloomPass2.
 *   3. Vertical blur: filter 10px V from bloomPass2 → bloomCanvas.
 *   Finally, composite bloomCanvas additively onto the main canvas.
 */
export function doBloomPass() {
  if (!PHYS.bloom) return;

  // keep pass2 sized with bloom
  if (bloomPass2.width !== bloomCanvas.width || bloomPass2.height !== bloomCanvas.height) {
    bloomPass2.width  = bloomCanvas.width;
    bloomPass2.height = bloomCanvas.height;
  }

  // --- 1. bright pass ---
  bloomCtx.setTransform(0.5, 0, 0, 0.5, 0, 0);
  bloomCtx.fillStyle = '#000';
  bloomCtx.fillRect(0, 0, W.cw, W.ch);
  bloomCtx.globalCompositeOperation = 'source-over';

  const THRESHOLD = 0.15;
  for (const b of balls) {
    const glowAmt = Math.max(b.mat.glow || 0, b.heat * 0.9);
    if (glowAmt < THRESHOLD) continue;
    const r = b.r * (2 + glowAmt);
    const c = PHYS.heatFx && b.heat > 0.3 ? mix(b.mat.color, '#ff6020', b.heat) : b.mat.color;
    const g = bloomCtx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
    g.addColorStop(0,   withAlpha(c, 1.0));
    g.addColorStop(0.3, withAlpha(c, 0.53));
    g.addColorStop(1,   withAlpha(c, 0));
    bloomCtx.fillStyle = g;
    bloomCtx.beginPath(); bloomCtx.arc(b.x, b.y, r, 0, TAU); bloomCtx.fill();
  }

  for (const p of particles) {
    if (p.type !== 'spark') continue;
    bloomCtx.globalAlpha = p.life / p.maxLife;
    bloomCtx.fillStyle = p.color;
    bloomCtx.beginPath();
    bloomCtx.arc(p.x, p.y, p.size * 2, 0, TAU);
    bloomCtx.fill();
  }
  bloomCtx.globalAlpha = 1;

  for (const p of W.pegs) {
    if (!p.bumper) continue;
    const g = bloomCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2);
    g.addColorStop(0, 'rgba(255,200,80,0.7)');
    g.addColorStop(1, 'rgba(255,200,80,0)');
    bloomCtx.fillStyle = g;
    bloomCtx.beginPath(); bloomCtx.arc(p.x, p.y, p.r * 2, 0, TAU); bloomCtx.fill();
  }

  if (W.solar) {
    const cx = W.cw / 2, cy = W.ch / 2;
    const g = bloomCtx.createRadialGradient(cx, cy, 0, cx, cy, 200);
    g.addColorStop(0,   'rgba(255,220,120,0.8)');
    g.addColorStop(0.6, 'rgba(255,140,40,0.3)');
    g.addColorStop(1,   'rgba(255,140,40,0)');
    bloomCtx.fillStyle = g;
    bloomCtx.beginPath(); bloomCtx.arc(cx, cy, 200, 0, TAU); bloomCtx.fill();
  }

  // --- 2. horizontal blur: bloomCanvas → pass2 ---
  bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
  bloomPass2Ctx.setTransform(1, 0, 0, 1, 0, 0);
  bloomPass2Ctx.clearRect(0, 0, bloomPass2.width, bloomPass2.height);
  // canvas filter property — H blur only
  bloomPass2Ctx.filter = 'blur(10px)';
  bloomPass2Ctx.drawImage(bloomCanvas, 0, 0);
  bloomPass2Ctx.filter = 'none';

  // --- 3. vertical blur: pass2 → bloomCanvas (composited) ---
  bloomCtx.clearRect(0, 0, bloomCanvas.width, bloomCanvas.height);
  bloomCtx.filter = 'blur(10px)';
  bloomCtx.drawImage(bloomPass2, 0, 0);
  bloomCtx.filter = 'none';

  // --- 3b. dither the bloom to break 8-bit banding ---
  // The half-res bloom is wide, smooth, additive gradients on dark backgrounds —
  // the classic case where quantization posterizes into visible rings. A faint
  // noise overlay scatters the steps so glow halos / the solar corona read as
  // smooth. (Independent of the optional film-grain pass in doPostFX.)
  const pat = bloomCtx.createPattern(grainCanvas, 'repeat');
  if (pat) {
    bloomCtx.save();
    bloomCtx.globalCompositeOperation = 'overlay';
    bloomCtx.globalAlpha = 0.5;
    bloomCtx.fillStyle = pat;
    bloomCtx.fillRect(0, 0, bloomCanvas.width, bloomCanvas.height);
    bloomCtx.restore();
  }

  // --- 4. composite additively onto main canvas ---
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.95;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(bloomCanvas, 0, 0, W.cw, W.ch);
  ctx.restore();
}
