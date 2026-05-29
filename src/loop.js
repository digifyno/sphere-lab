/**
 * Main animation loop.
 *
 * Per frame:
 *   1. FPS sampling (0.3s).
 *   2. Camera smoothing.
 *   3. Fixed-step physics.
 *   4. Telemetry sampling (150ms) → sparklines.
 *   5. Render: background → world → balls → water → particles → flares →
 *      tool previews → bloom → postfx.
 *   6. HUD text + ball inspector.
 */

import { PHYS } from './core/config.js';
import { W, cam } from './core/world.js';
import { TAU, clamp, lerp, len } from './core/math.js';
import { balls, selectedMat } from './entities/ball.js';
import { MATERIALS } from './entities/materials.js';
import { physicsStep } from './physics/step.js';
import { stats, collisionWindow } from './physics/stats.js';
import { canvas, ctx, dpr, sceneCanvas, sceneCtx } from './render/canvas.js';
import { drawBackground } from './render/background.js';
import {
  drawWalls, drawPegs, drawConstraints, drawSprings,
  drawVortex, drawWater, drawSolarCenter, drawBallShadows, drawFlippers
} from './render/world.js';
import { drawBall, drawTrail } from './render/ball.js';
import { drawAO, drawParticles, drawLensFlares, drawPlasmaArcs } from './render/effects.js';
import { doBloomPass, doPostFX } from './render/postfx.js';
import { renderSparkline } from './render/statsGraph.js';
import { mouse, meshRadius, tickMouse } from './input/mouse.js';
import { getTool } from './input/tools.js';
import { updateInspector } from './ui/inspector.js';

const fpsHistory = /** @type {number[]} */ ([]);
const cpsHistory = /** @type {number[]} */ ([]);
const energyHistory = /** @type {number[]} */ ([]);

const FPS_CANVAS    = /** @type {HTMLCanvasElement} */ (document.getElementById('fps-canvas'));
const CPS_CANVAS    = /** @type {HTMLCanvasElement} */ (document.getElementById('cps-canvas'));
const ENERGY_CANVAS = /** @type {HTMLCanvasElement} */ (document.getElementById('energy-canvas'));

let lastT = performance.now();
let fpsTime = 0, fpsCount = 0, fps = 0;
let sampleTime = 0;
let accumulator = 0;
const FIXED_STEP = 1 / 240;

/** Read theme accent color each frame so graphs + previews follow theme swaps. */
function themeColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  fpsTime += dt;
  fpsCount++;
  if (fpsTime >= 0.3) {
    fps = Math.round(fpsCount / fpsTime);
    fpsTime = 0; fpsCount = 0;
    fpsHistory.push(fps);
    if (fpsHistory.length > 80) fpsHistory.shift();
    renderSparkline(FPS_CANVAS, fpsHistory, { color: themeColor('--accent', '#ffaa33'), max: 75, reference: 60 });
  }

  cam.x    = lerp(cam.x,    cam.tx, clamp(dt * 10, 0, 1));
  cam.y    = lerp(cam.y,    cam.ty, clamp(dt * 10, 0, 1));
  cam.zoom = lerp(cam.zoom, cam.tz, clamp(dt * 12, 0, 1));

  // Mouse tick — currently runs the auto-repeat link logic. Ticks even
  // while physics is paused so the feature works in a frozen scene too.
  tickMouse(dt);

  if (!PHYS.paused) {
    accumulator += dt * PHYS.slowmo;
    let its = 0;
    while (accumulator >= FIXED_STEP && its < 8) {
      physicsStep(FIXED_STEP);
      accumulator -= FIXED_STEP;
      its++;
    }
    if (its === 8) accumulator = 0;
  }

  collisionWindow.push({ t: now, c: stats.collisions });
  stats.collisions = 0;
  while (collisionWindow.length && now - collisionWindow[0].t > 1000) collisionWindow.shift();
  const cps = collisionWindow.reduce((s, x) => s + x.c, 0);

  sampleTime += dt;
  if (sampleTime >= 0.15) {
    sampleTime = 0;
    cpsHistory.push(cps);
    if (cpsHistory.length > 80) cpsHistory.shift();
    let ke = 0; for (const b of balls) ke += b.kineticEnergy();
    energyHistory.push(ke);
    if (energyHistory.length > 80) energyHistory.shift();
    renderSparkline(CPS_CANVAS, cpsHistory, { color: themeColor('--info', '#6fb9ff') });
    renderSparkline(ENERGY_CANVAS, energyHistory, { color: '#4bde9a' });
  }

  // ===== Render =====
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (PHYS.motionBlur) {
    ctx.fillStyle = 'rgba(5, 8, 18, 0.35)';
    ctx.fillRect(0, 0, W.cw, W.ch);
  } else {
    drawBackground(ctx);
  }

  ctx.save();
  ctx.translate(W.cw / 2 - cam.x * cam.zoom, W.ch / 2 - cam.y * cam.zoom);
  ctx.scale(cam.zoom, cam.zoom);

  drawSolarCenter(ctx);
  drawWalls(ctx);
  drawPegs(ctx);
  drawFlippers(ctx);
  drawConstraints(ctx);
  drawSprings(ctx);
  drawVortex(ctx);
  drawBallShadows(ctx);

  if (PHYS.refract && balls.some(b => (b.mat.refract || 0) > 0.3)) {
    ctx.restore();
    sceneCtx.setTransform(1, 0, 0, 1, 0, 0);
    sceneCtx.drawImage(canvas, 0, 0, W.cw * dpr, W.ch * dpr, 0, 0, W.cw, W.ch);
    ctx.save();
    ctx.translate(W.cw / 2 - cam.x * cam.zoom, W.ch / 2 - cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);
  }

  if (PHYS.trails) for (const b of balls) drawTrail(ctx, b);
  drawAO(ctx);
  for (const b of balls) drawBall(ctx, b);
  drawPlasmaArcs(ctx);
  drawWater(ctx);
  drawParticles(ctx);
  drawLensFlares(ctx);

  drawToolPreviews(ctx);

  ctx.restore();

  doBloomPass();
  doPostFX();

  updateHudText(cps);
  updateInspector();

  requestAnimationFrame(frame);
}

function drawToolPreviews(tx) {
  const TOOL = getTool();
  const accent = themeColor('--accent', '#ffaa33');

  // Slingshot preview — skipped while Shift is held, since Shift puts
  // the Spawn tool in burst/paint mode (no launch on release) and the
  // arrow would be misleading.
  if (mouse.down && TOOL === 'spawn' && !mouse.grab && !mouse.shift) {
    const dx = mouse.wsx - mouse.wx, dy = mouse.wsy - mouse.wy;
    const d = len(dx, dy);
    if (d > 5) {
      tx.strokeStyle = accent; tx.lineWidth = 2;
      tx.setLineDash([6, 4]);
      tx.beginPath(); tx.moveTo(mouse.wsx, mouse.wsy); tx.lineTo(mouse.wx, mouse.wy); tx.stroke();
      tx.setLineDash([]);
      const mat = MATERIALS[selectedMat.id];
      tx.fillStyle = mat.color + '44';
      tx.strokeStyle = mat.color; tx.lineWidth = 1;
      tx.beginPath(); tx.arc(mouse.wsx, mouse.wsy, PHYS.spawnRadius, 0, TAU);
      tx.fill(); tx.stroke();
      tx.strokeStyle = accent; tx.lineWidth = 2;
      const ax = mouse.wsx + dx, ay = mouse.wsy + dy;
      const ang = Math.atan2(dy, dx);
      tx.beginPath();
      tx.moveTo(mouse.wsx, mouse.wsy); tx.lineTo(ax, ay);
      tx.moveTo(ax, ay); tx.lineTo(ax - Math.cos(ang - 0.35) * 14, ay - Math.sin(ang - 0.35) * 14);
      tx.moveTo(ax, ay); tx.lineTo(ax - Math.cos(ang + 0.35) * 14, ay - Math.sin(ang + 0.35) * 14);
      tx.stroke();
    }
  }

  if (TOOL === 'draw' && mouse.draw.active) {
    tx.strokeStyle = accent; tx.lineWidth = 3;
    tx.globalAlpha = 0.7;
    tx.lineCap = 'round';
    tx.beginPath();
    tx.moveTo(mouse.draw.x1, mouse.draw.y1);
    tx.lineTo(mouse.wx, mouse.wy);
    tx.stroke();
    tx.globalAlpha = 1;
  }

  if (TOOL === 'link' && mouse.linkFirst) {
    tx.strokeStyle = '#b285ff';
    tx.setLineDash([4, 4]);
    tx.lineWidth = 2;
    tx.beginPath(); tx.moveTo(mouse.linkFirst.x, mouse.linkFirst.y); tx.lineTo(mouse.wx, mouse.wy);
    tx.stroke();
    tx.setLineDash([]);
    tx.strokeStyle = '#b285ff'; tx.lineWidth = 2;
    tx.beginPath(); tx.arc(mouse.linkFirst.x, mouse.linkFirst.y, mouse.linkFirst.r + 3, 0, TAU); tx.stroke();
  }

  // Ctrl-click auto-mesh preview — dashed radius circle + ghost lines
  // to every ball that'll get connected on release.
  if (TOOL === 'link' && mouse.mesh.active && mouse.mesh.source) {
    const cx = mouse.mesh.cx, cy = mouse.mesh.cy;
    const r = meshRadius();
    const src = mouse.mesh.source;
    tx.strokeStyle = '#b285ff';
    tx.setLineDash([6, 4]);
    tx.lineWidth = 2;
    tx.globalAlpha = 0.7;
    tx.beginPath(); tx.arc(cx, cy, r, 0, TAU); tx.stroke();
    tx.setLineDash([]);
    tx.globalAlpha = 1;

    // Source ball ring + ghost lines to eligible targets
    tx.strokeStyle = '#b285ff';
    tx.lineWidth = 2;
    tx.beginPath(); tx.arc(src.x, src.y, src.r + 3, 0, TAU); tx.stroke();

    const r2 = r * r;
    tx.strokeStyle = 'rgba(178,133,255,0.55)';
    tx.lineWidth = 1;
    for (const b of balls) {
      if (b === src) continue;
      const dx = b.x - cx, dy = b.y - cy;
      if (dx * dx + dy * dy > r2) continue;
      tx.beginPath(); tx.moveTo(src.x, src.y); tx.lineTo(b.x, b.y); tx.stroke();
    }
  }

  if (TOOL === 'push' || TOOL === 'attract' || TOOL === 'heat') {
    const r = TOOL === 'push' ? 200 : TOOL === 'attract' ? 300 : 100;
    const col = TOOL === 'push'    ? '#4bde9a' :
                TOOL === 'attract' ? '#b285ff' :
                                      '#ff5f7a';
    tx.strokeStyle = col;
    tx.globalAlpha = 0.3 + (mouse.down ? 0.3 : 0);
    tx.lineWidth = 2;
    tx.setLineDash([4, 4]);
    tx.beginPath(); tx.arc(mouse.wx, mouse.wy, r, 0, TAU); tx.stroke();
    tx.setLineDash([]);
    tx.globalAlpha = 1;

    // attract: extra inward arrows
    if (TOOL === 'attract' && mouse.down) {
      tx.strokeStyle = col;
      tx.globalAlpha = 0.55;
      tx.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const x1 = mouse.wx + Math.cos(a) * r * 0.95;
        const y1 = mouse.wy + Math.sin(a) * r * 0.95;
        const x2 = mouse.wx + Math.cos(a) * r * 0.55;
        const y2 = mouse.wy + Math.sin(a) * r * 0.55;
        tx.beginPath(); tx.moveTo(x1, y1); tx.lineTo(x2, y2); tx.stroke();
      }
      tx.globalAlpha = 1;
    }
  }

  if (mouse.grab) {
    tx.strokeStyle = '#4bde9a'; tx.lineWidth = 1;
    tx.setLineDash([4, 3]);
    tx.beginPath(); tx.moveTo(mouse.grab.x, mouse.grab.y); tx.lineTo(mouse.wx, mouse.wy);
    tx.stroke();
    tx.setLineDash([]);
  }
}

function updateHudText(cps) {
  document.getElementById('stat-n').textContent     = String(balls.length);
  document.getElementById('stat-fps').textContent   = String(fps);
  document.getElementById('stat-col').textContent   = String(cps);
  document.getElementById('stat-links').textContent = String(W.springs.length + W.constraints.length);
  document.getElementById('stat-zoom').textContent  = cam.zoom.toFixed(2);
  document.getElementById('stat-pairs').textContent = String(stats.pairs);
  let ke = 0, heat = 0;
  for (const b of balls) { ke += b.kineticEnergy(); heat += b.heat; }
  document.getElementById('stat-e').textContent = String(Math.round(ke));
  document.getElementById('stat-temp').textContent =
    balls.length ? Math.round(heat / balls.length * 100) + '%' : '0%';
}

export function startLoop() {
  lastT = performance.now();
  requestAnimationFrame(frame);
}
