/**
 * Per-ball shading. Highlights:
 *
 *   - Chromatic refraction for glass: samples sceneCanvas three times at
 *     slightly different scales for R/G/B, blending them into the ball's
 *     clipped interior. Cheap but recognisable rainbow edges.
 *
 *   - Material-aware body gradient:
 *       metallic > 0.7 — near-mirror, sharp core highlight + darker fringe
 *       metallic > 0.3 — satin finish, softer transitions
 *       else            — matte/diffuse, long lerp to darker rim
 *
 *   - Fresnel-style rim light: a concentric bright ring that doesn't depend
 *     on the light direction, brighter on metals and on grazing-view (edge)
 *     pixels. Stacked on top of any directional rim.
 *
 *   - Metallic env strip: horizontal bands approximating a sky / horizon /
 *     ground reflection for polished metals.
 */

import { W, cam } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { TAU, len } from '../core/math.js';
import { mix, lighten, darken, lightenL, darkenL, withAlpha } from '../core/color.js';
import { light, sceneCanvas } from './canvas.js';

/**
 * Viewport-cull helper. Returns true if a ball's bounding box (plus a
 * small margin for trails / shadows that extend slightly past it) has
 * any chance of being on screen under the current camera transform.
 *
 * We only call this against the main camera viewport. Post-FX passes
 * still run full-screen — this just saves per-ball work (gradients,
 * pattern transforms, path ops) when the ball is clearly off-screen.
 */
export function isBallOnScreen(b, margin = 60) {
  const halfW = W.cw / (2 * cam.zoom);
  const halfH = W.ch / (2 * cam.zoom);
  const m = b.r + margin;
  if (b.x + m < cam.x - halfW) return false;
  if (b.x - m > cam.x + halfW) return false;
  if (b.y + m < cam.y - halfH) return false;
  if (b.y - m > cam.y + halfH) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Material surface micro-textures                                    */
/* ------------------------------------------------------------------ */
/* A small offscreen canvas per material, tiled across the ball body
 * as a `createPattern` with `setTransform` so the pattern rotates with
 * the ball. Bakes once on first use, then reused for all balls of the
 * same material. The pattern is drawn through `overlay` blend at low
 * alpha — preserves the radial gradient shading and highlights under
 * it while adding per-material surface character.                     */
const _texCache = {};
/** CanvasPattern per material — created once per material, reused every
 *  frame. Building a pattern isn't free; before this cache, each ball
 *  (up to 260) was calling createPattern per frame → 15k+ allocations/sec.
 *  The pattern's transform is swapped per-ball via a shared DOMMatrix. */
const _patCache = {};
/** Shared DOMMatrix for pattern rotation. Filled in-place each call —
 *  no per-ball allocation. */
let _patternMatrix = null;
const TEX_SIZE = 96;

function getMatPattern(tx, matName) {
  if (_patCache[matName] !== undefined) return _patCache[matName];
  const tex = getMatTexture(matName);
  if (!tex) { _patCache[matName] = null; return null; }
  _patCache[matName] = tx.createPattern(tex, 'repeat');
  return _patCache[matName];
}
function getMatTexture(matName) {
  const cached = _texCache[matName];
  if (cached !== undefined) return cached;
  const c = document.createElement('canvas');
  c.width = TEX_SIZE; c.height = TEX_SIZE;
  const tc = c.getContext('2d');
  tc.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
  switch (matName) {
    case 'STEEL': {
      // brushed metal — dense near-horizontal scratches, light + dark mix
      for (let y = 0; y < TEX_SIZE; y += 0.8) {
        tc.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.09})`;
        tc.lineWidth = 0.4;
        tc.beginPath(); tc.moveTo(0, y); tc.lineTo(TEX_SIZE, y + (Math.random() - 0.5) * 0.3); tc.stroke();
      }
      for (let i = 0; i < 22; i++) {
        tc.strokeStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.08})`;
        tc.lineWidth = 0.5;
        const y = Math.random() * TEX_SIZE;
        tc.beginPath(); tc.moveTo(0, y); tc.lineTo(TEX_SIZE, y + (Math.random() - 0.5) * 0.4); tc.stroke();
      }
      break;
    }
    case 'RUBBER': {
      // Vulcanized rubber — dense micro-pores, low-frequency mottling for
      // hand-feel, plus scattered tiny dark pits that read as real surface.
      const imd = tc.createImageData(TEX_SIZE, TEX_SIZE);
      for (let y = 0; y < TEX_SIZE; y++) {
        for (let x = 0; x < TEX_SIZE; x++) {
          const i = (y * TEX_SIZE + x) * 4;
          // Low-freq rolling mottle + per-pixel grain
          const mottle = Math.sin(x * 0.22 + y * 0.17) * 7
                       + Math.sin(x * 0.08 - y * 0.11) * 5;
          const v = mottle + (Math.random() - 0.5) * 26;
          imd.data[i]     = clamp255(128 + v);
          imd.data[i + 1] = clamp255(128 + v);
          imd.data[i + 2] = clamp255(128 + v);
          imd.data[i + 3] = 95;
        }
      }
      tc.putImageData(imd, 0, 0);
      // Dense dark pits — the micro-porosity of vulcanized rubber
      for (let i = 0; i < 260; i++) {
        tc.fillStyle = `rgba(0,0,0,${0.22 + Math.random() * 0.30})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.28 + Math.random() * 0.75, 0, TAU);
        tc.fill();
      }
      // Sparse micro-highlights on pore rims catching the light
      for (let i = 0; i < 45; i++) {
        tc.fillStyle = `rgba(255,255,255,${0.10 + Math.random() * 0.15})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.28 + Math.random() * 0.55, 0, TAU);
        tc.fill();
      }
      // A few faint mold-seam scratches running one direction
      for (let i = 0; i < 4; i++) {
        tc.strokeStyle = `rgba(60,30,35,${0.18 + Math.random() * 0.15})`;
        tc.lineWidth = 0.4;
        tc.beginPath();
        const y0 = Math.random() * TEX_SIZE;
        tc.moveTo(0, y0);
        tc.lineTo(TEX_SIZE, y0 + (Math.random() - 0.5) * 3);
        tc.stroke();
      }
      break;
    }
    case 'GLASS': {
      // rare tiny bright specks
      for (let i = 0; i < 8; i++) {
        tc.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.4})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.5, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'BOWLING': {
      // colored polymer flecks
      const cols = ['#b06030', '#70401e', '#201810', '#504030', '#c09070'];
      for (let i = 0; i < 55; i++) {
        tc.fillStyle = cols[Math.floor(Math.random() * cols.length)];
        tc.globalAlpha = 0.4 + Math.random() * 0.35;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.6 + Math.random() * 1.3, 0, TAU);
        tc.fill();
      }
      tc.globalAlpha = 1;
      break;
    }
    case 'GOLD': {
      // scattered light specks (glitter)
      for (let i = 0; i < 28; i++) {
        tc.fillStyle = `rgba(255,230,150,${0.45 + Math.random() * 0.35})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4 + Math.random() * 0.6, 0, TAU);
        tc.fill();
      }
      for (let i = 0; i < 12; i++) {
        tc.fillStyle = `rgba(120,80,20,${0.18 + Math.random() * 0.14})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.5 + Math.random() * 0.8, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'PLASMA': {
      // wavy energy filaments
      for (let i = 0; i < 7; i++) {
        tc.strokeStyle = `rgba(240,180,255,${0.20 + Math.random() * 0.25})`;
        tc.lineWidth = 0.5 + Math.random() * 0.4;
        tc.beginPath();
        const y0 = Math.random() * TEX_SIZE;
        tc.moveTo(0, y0);
        for (let px = 0; px <= TEX_SIZE; px += 6) {
          tc.lineTo(px, y0 + Math.sin((px + i * 14) * 0.12) * (3 + i * 0.7));
        }
        tc.stroke();
      }
      break;
    }
    case 'ICE': {
      // crystalline sparkles
      for (let i = 0; i < 20; i++) {
        tc.fillStyle = `rgba(220,240,255,${0.30 + Math.random() * 0.4})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4 + Math.random() * 0.5, 0, TAU);
        tc.fill();
      }
      // a few tiny hairline fractures
      for (let i = 0; i < 3; i++) {
        tc.strokeStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.10})`;
        tc.lineWidth = 0.4;
        tc.beginPath();
        const x0 = Math.random() * TEX_SIZE, y0 = Math.random() * TEX_SIZE;
        tc.moveTo(x0, y0);
        tc.lineTo(x0 + (Math.random() - 0.5) * 20, y0 + (Math.random() - 0.5) * 20);
        tc.stroke();
      }
      break;
    }
    case 'NEON': {
      // fine bright fizz
      for (let i = 0; i < 70; i++) {
        tc.fillStyle = `rgba(255,255,255,${0.08 + Math.random() * 0.16})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'MAGNET': {
      // iron filing flecks
      for (let i = 0; i < 55; i++) {
        tc.fillStyle = `rgba(40,14,14,${0.35 + Math.random() * 0.35})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4 + Math.random() * 0.7, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'MERCURY': {
      // faint surface ripples
      for (let i = 0; i < 5; i++) {
        tc.strokeStyle = `rgba(200,215,225,${0.15 + Math.random() * 0.10})`;
        tc.lineWidth = 0.4;
        tc.beginPath();
        const y0 = Math.random() * TEX_SIZE;
        tc.moveTo(0, y0);
        for (let px = 0; px <= TEX_SIZE; px += 10) {
          tc.lineTo(px, y0 + Math.sin((px + i * 12) * 0.08) * 1.6);
        }
        tc.stroke();
      }
      break;
    }
    case 'OBSIDIAN': {
      // Polished volcanic glass — faint conchoidal striations + sparse glossy
      // bright glints. Dark base so only the brightest micro-highlights read.
      for (let i = 0; i < 5; i++) {
        tc.strokeStyle = `rgba(255,255,255,${0.07 + Math.random() * 0.08})`;
        tc.lineWidth = 0.4;
        tc.beginPath();
        const cx = Math.random() * TEX_SIZE;
        const cy = Math.random() * TEX_SIZE;
        const rad = 20 + Math.random() * 30;
        tc.arc(cx, cy, rad, Math.random() * TAU, Math.random() * TAU + 0.9);
        tc.stroke();
      }
      for (let i = 0; i < 8; i++) {
        tc.fillStyle = `rgba(220,200,255,${0.25 + Math.random() * 0.25})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4 + Math.random() * 0.7, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'TNT': {
      // Dynamite stripes — alternating dark bands with lighter paper
      // between them. Baked in pattern space so they rotate with the ball.
      for (let i = 0; i < TEX_SIZE; i += 12) {
        tc.fillStyle = 'rgba(40,10,10,0.55)';
        tc.fillRect(i, 0, 6, TEX_SIZE);
      }
      // Fine paper texture between stripes
      for (let i = 0; i < 80; i++) {
        tc.fillStyle = `rgba(255,210,180,${0.10 + Math.random() * 0.14})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.3 + Math.random() * 0.5, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'LAVA': {
      // Molten crust — dark craze lines where the surface has started to
      // cool, with bright orange in between. Overlay blend preserves the
      // hot glow behind it.
      for (let i = 0; i < 40; i++) {
        tc.strokeStyle = `rgba(30,10,0,${0.25 + Math.random() * 0.35})`;
        tc.lineWidth = 0.6 + Math.random() * 0.6;
        tc.beginPath();
        const x0 = Math.random() * TEX_SIZE, y0 = Math.random() * TEX_SIZE;
        const x1 = x0 + (Math.random() - 0.5) * 24;
        const y1 = y0 + (Math.random() - 0.5) * 24;
        tc.moveTo(x0, y0); tc.lineTo(x1, y1);
        tc.stroke();
      }
      // Bright molten specks
      for (let i = 0; i < 24; i++) {
        tc.fillStyle = `rgba(255,220,150,${0.35 + Math.random() * 0.4})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.5 + Math.random() * 0.9, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'ROCK': {
      // Basalt grain — dense fine dark pits + sparse lighter mineral specks.
      for (let i = 0; i < 120; i++) {
        tc.fillStyle = `rgba(10,6,4,${0.35 + Math.random() * 0.35})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.3 + Math.random() * 0.7, 0, TAU);
        tc.fill();
      }
      for (let i = 0; i < 14; i++) {
        tc.fillStyle = `rgba(180,150,110,${0.18 + Math.random() * 0.16})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.4 + Math.random() * 0.8, 0, TAU);
        tc.fill();
      }
      break;
    }
    case 'SLIME': {
      // Inner bubbles — pale circles suggesting suspended air pockets. With
      // refraction on, these read as "bubbles in a gel."
      for (let i = 0; i < 14; i++) {
        const rad = 1.4 + Math.random() * 3.2;
        tc.strokeStyle = `rgba(255,255,255,${0.16 + Math.random() * 0.18})`;
        tc.lineWidth = 0.5;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, rad, 0, TAU);
        tc.stroke();
      }
      // Darker green veins
      for (let i = 0; i < 5; i++) {
        tc.strokeStyle = `rgba(40,80,25,${0.20 + Math.random() * 0.15})`;
        tc.lineWidth = 0.5;
        tc.beginPath();
        const x0 = Math.random() * TEX_SIZE, y0 = Math.random() * TEX_SIZE;
        tc.moveTo(x0, y0);
        for (let px = 0; px <= 24; px += 4) {
          tc.lineTo(x0 + px, y0 + Math.sin(px * 0.3 + i) * 3);
        }
        tc.stroke();
      }
      break;
    }
    case 'DIAMOND': {
      // Sparse brilliant facet highlights — bright specks of light
      for (let i = 0; i < 14; i++) {
        tc.fillStyle = `rgba(255,255,255,${0.55 + Math.random() * 0.4})`;
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 0.5 + Math.random() * 0.8, 0, TAU);
        tc.fill();
      }
      // Dispersion hint — soft rainbow-tinged specks to suggest diamond's
      // characteristic "fire" when the texture catches the light.
      const rainbow = [
        'rgba(255,170,210,0.32)', 'rgba(170,215,255,0.32)',
        'rgba(200,255,215,0.28)', 'rgba(255,220,170,0.28)',
        'rgba(210,180,255,0.30)'
      ];
      for (let i = 0; i < 9; i++) {
        tc.fillStyle = rainbow[i % rainbow.length];
        tc.beginPath();
        tc.arc(Math.random() * TEX_SIZE, Math.random() * TEX_SIZE, 1.4 + Math.random() * 1.8, 0, TAU);
        tc.fill();
      }
      break;
    }
    default:
      _texCache[matName] = null;
      return null;
  }
  _texCache[matName] = c;
  return c;
}
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/* ------------------------------------------------------------------ */
/*  Metal env reflection — shared panorama infrastructure              */
/* ------------------------------------------------------------------ */
/* Polished metal has no colour of its own — what you see IS the
 * environment. We bake a sky/horizon/ground panorama per-material
 * (same structure, different palette) and tile it vertically across
 * the clipped ball with an offset driven by the ball's rotation.
 * Spinning metal shows a visibly scrolling reflection — the single
 * strongest cue for "this is metal, not a painted sphere."             */
const ENV_PALETTES = {
  // Chrome steel — cool blue sky, warm horizon, dark ground.
  STEEL: {
    skyTop: '#161f33', skyMid: '#3a5278', skyBot: '#8aa6c8',
    hzTop:  '#d6c090', hzMid:  '#fff3d0', hzBot:  '#b87840',
    grTop:  '#3e3424', grMid:  '#15110c', grBot:  '#050403',
    tint:   0.18
  },
  // Polished gold — warm sunset palette, amber sky, deep red ground.
  // Real gold's reflection is strongly chromatic; we lean into that.
  GOLD: {
    skyTop: '#3a1a08', skyMid: '#8c4a18', skyBot: '#ffa858',
    hzTop:  '#ffd888', hzMid:  '#fff2c8', hzBot:  '#b8600c',
    grTop:  '#5a2810', grMid:  '#1e0c04', grBot:  '#060201',
    tint:   0.36
  },
  // Magnetized iron alloy — darker, rusty red-tinted reflections, a
  // matte-ish character (domain-boundary scattering). Less saturated
  // than gold, less cool than steel.
  MAGNET: {
    skyTop: '#1a0a0a', skyMid: '#4a2020', skyBot: '#8a5858',
    hzTop:  '#c88878', hzMid:  '#f0c0b0', hzBot:  '#884038',
    grTop:  '#281810', grMid:  '#0e0706', grBot:  '#040202',
    tint:   0.28
  },
  // Mercury — liquid metal. Almost pure chrome reflection with a tiny
  // warm tint (quicksilver isn't quite as blue as chrome steel). Low
  // tint alpha so the reflection reads as genuine liquid-mirror.
  MERCURY: {
    skyTop: '#0f1620', skyMid: '#2a3648', skyBot: '#7a8898',
    hzTop:  '#c8c0b0', hzMid:  '#f0e8d8', hzBot:  '#a09888',
    grTop:  '#302820', grMid:  '#100c08', grBot:  '#040302',
    tint:   0.12
  }
};

const _envCache = {};
function getEnv(matName) {
  const cached = _envCache[matName];
  if (cached !== undefined) return cached;
  const p = ENV_PALETTES[matName];
  if (!p) { _envCache[matName] = null; return null; }

  const C = document.createElement('canvas');
  C.width = 64; C.height = 256;
  const tc = C.getContext('2d');

  // Sky (top 38%)
  const sky = tc.createLinearGradient(0, 0, 0, C.height * 0.38);
  sky.addColorStop(0,    p.skyTop);
  sky.addColorStop(0.55, p.skyMid);
  sky.addColorStop(1,    p.skyBot);
  tc.fillStyle = sky;
  tc.fillRect(0, 0, C.width, C.height * 0.38);

  // Horizon band (38-50%)
  const hz = tc.createLinearGradient(0, C.height * 0.38, 0, C.height * 0.50);
  hz.addColorStop(0,   p.hzTop);
  hz.addColorStop(0.4, p.hzMid);
  hz.addColorStop(1,   p.hzBot);
  tc.fillStyle = hz;
  tc.fillRect(0, C.height * 0.38, C.width, C.height * 0.12);

  // Ground (50-100%)
  const gr = tc.createLinearGradient(0, C.height * 0.50, 0, C.height);
  gr.addColorStop(0,   p.grTop);
  gr.addColorStop(0.45,p.grMid);
  gr.addColorStop(1,   p.grBot);
  tc.fillStyle = gr;
  tc.fillRect(0, C.height * 0.50, C.width, C.height * 0.50);

  // Soft cloud bands in the sky
  tc.fillStyle = 'rgba(255,255,255,0.14)';
  tc.beginPath();
  tc.ellipse(C.width * 0.45, C.height * 0.18, C.width * 0.50, C.height * 0.035, 0, 0, TAU);
  tc.fill();
  tc.fillStyle = 'rgba(255,255,255,0.09)';
  tc.beginPath();
  tc.ellipse(C.width * 0.20, C.height * 0.29, C.width * 0.30, C.height * 0.025, 0, 0, TAU);
  tc.fill();

  _envCache[matName] = C;
  return C;
}

/** Draw a metal ball body as a rotation-scrolled env panorama with depth
 *  gradient + material-color tint multiply. Shared by STEEL / GOLD / MAGNET.  */
function drawMetalBody(tx, b, offX, offY) {
  const { x, y, r, mat } = b;
  const env = getEnv(mat.name);
  if (!env) return;
  const palette = ENV_PALETTES[mat.name];

  tx.save();
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();

  const envH = r * 2.2;
  const worldBias = clamp((y / (W.ch || 1000) - 0.5) * 0.6, -0.5, 0.5);
  const phase = ((b.angle / TAU + worldBias) % 1 + 1) % 1;
  let envY = y - r - phase * envH;
  while (envY + envH > y - r) envY -= envH;
  for (let k = 0; k < 3; k++) {
    tx.drawImage(env, x - r, envY, r * 2, envH);
    envY += envH;
  }

  // Metallic depth — bright highlight toward light, dark fringe at lower rim.
  const depth = tx.createRadialGradient(x + offX, y + offY, 0, x, y, r);
  depth.addColorStop(0,   'rgba(255,255,255,0.22)');
  depth.addColorStop(0.5, 'rgba(255,255,255,0)');
  depth.addColorStop(0.9, 'rgba(0,0,0,0.30)');
  depth.addColorStop(1,   'rgba(0,0,0,0.55)');
  tx.fillStyle = depth;
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();

  // Material-color tint multiply — chrome cool-blue, gold amber, magnet
  // rusty red. Keeps the env reflection consistent with the base metal.
  tx.globalCompositeOperation = 'multiply';
  tx.fillStyle = withAlpha(mat.color, palette.tint);
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();
  tx.globalCompositeOperation = 'source-over';

  tx.restore();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Glass refraction with a small chromatic split: sample sceneCanvas three
 * times at slightly different scales (R wider, B tighter) and blend via
 * `screen` blending — gives a subtle color fringe on edges.
 */
function drawRefraction(tx, b) {
  if (!PHYS.refract || (b.mat.refract || 0) < 0.3) return false;
  tx.save();
  tx.beginPath(); tx.arc(b.x, b.y, b.r * 0.96, 0, TAU); tx.clip();

  // Lens magnitude stays pinned to the tuned `refract` amount (changing it
  // would explode/break the glass look); only dispersion + Fresnel are grounded
  // in the physical IOR `n`.
  const ior = b.mat.ior;
  const base = 1 - b.mat.refract * 0.25;
  // Chromatic dispersion ∝ (n−1): diamond (n=2.42) fringes ~2.8× wider than
  // glass (n=1.5) — its literal "fire". Falls back to the old constants when a
  // material has no IOR set.
  const spread = ior ? clamp((ior - 1) * 0.039, 0, 0.07)
                     : (b.mat.name === 'DIAMOND' ? 0.055 : 0.020);
  // Normal-incidence Fresnel reflectance R0 = ((n−1)/(n+1))²: glass ≈0.04,
  // diamond ≈0.17 (~4× brighter back-reflection — diamond's brilliance).
  const r0 = ior ? ((ior - 1) / (ior + 1)) ** 2 : 0.04;
  const scales = [ base + spread, base, base - spread ];

  for (let i = 0; i < 3; i++) {
    const s = scales[i];
    const ox = b.x - b.x * s;
    const oy = b.y - b.y * s;
    tx.globalAlpha = 0.55;
    tx.globalCompositeOperation = i === 0 ? 'source-over' : 'lighter';
    tx.drawImage(sceneCanvas, ox, oy, W.cw * s, W.ch * s);
  }
  tx.globalCompositeOperation = 'source-over';
  tx.globalAlpha = 1;

  // material tint — a faint colour cast keeps the refracted scene from
  // looking like a grayscale window (real glass carries a subtle hue)
  tx.fillStyle = withAlpha(b.mat.color, 0.16);
  tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.fill();
  tx.restore();

  // Total-internal-reflection rim + focal caustic. These two effects are
  // what your eye uses to recognize "this is a solid glass/ice/diamond
  // sphere" vs. "this is a transparent bubble". Drawn on the FULL ball
  // radius (not the 0.96 inner clip above) so the dark band sits at the
  // extreme silhouette edge where real TIR actually happens.
  tx.save();
  tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.clip();

  // TIR — a thin dark annulus just inside the edge. View rays near the
  // silhouette graze the back surface and undergo total internal
  // reflection, returning as near-black. Canvas can't simulate this so
  // we paint the cue directly.
  const tirR0 = b.r * 0.86, tirR1 = b.r * 1.0;
  const tirK = 0.32 * b.mat.refract * (ior ? (0.6 + r0 * 2.3) : 1);
  const tirG = tx.createRadialGradient(b.x, b.y, tirR0, b.x, b.y, tirR1);
  tirG.addColorStop(0,    'rgba(0,0,0,0)');
  tirG.addColorStop(0.55, `rgba(0,0,0,${tirK})`);
  tirG.addColorStop(0.92, `rgba(0,0,0,${tirK * 0.65})`);
  tirG.addColorStop(1,    'rgba(0,0,0,0)');
  tx.fillStyle = tirG;
  tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.fill();

  // Fresnel back-reflection — a thin bright annulus at the silhouette whose
  // strength tracks R0. Diamond (R0≈0.17) reflects ~4× harder than glass (0.04),
  // its visible brilliance; glass's faint rim stays nearly invisible (faithful).
  const fresA = clamp(r0 * 1.1, 0, 0.2);
  if (fresA > 0.01) {
    const frG = tx.createRadialGradient(b.x, b.y, b.r * 0.9, b.x, b.y, b.r);
    frG.addColorStop(0, 'rgba(255,255,255,0)');
    frG.addColorStop(1, `rgba(255,255,255,${fresA})`);
    tx.fillStyle = frG;
    tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.fill();
  }

  // Focal caustic — light bent through the ball converges just inside
  // the far side (opposite the illuminator). A small bright pinpoint
  // sells the "real glass lens" illusion. Only for strong refractives.
  if (b.mat.refract > 0.7) {
    const lx = light.x * W.cw, ly = light.y * W.ch;
    const ldx = b.x - lx, ldy = b.y - ly;
    const ldlen = len(ldx, ldy) || 1;
    const fx = b.x + (ldx / ldlen) * b.r * 0.55;
    const fy = b.y + (ldy / ldlen) * b.r * 0.55;
    const fr = b.r * 0.18;
    const fG = tx.createRadialGradient(fx, fy, 0, fx, fy, fr);
    const fK = 0.55 * b.mat.refract;
    fG.addColorStop(0,   `rgba(255,255,255,${fK})`);
    fG.addColorStop(0.4, `rgba(255,255,255,${fK * 0.4})`);
    fG.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = fG;
    tx.beginPath(); tx.arc(fx, fy, fr, 0, TAU); tx.fill();
  }

  tx.restore();
  return true;
}

function drawMotionStreak(tx, b) {
  if (!PHYS.streaks) return;
  const sp = len(b.vx, b.vy);
  if (sp < 260) return;
  // Motion blur = the path swept while the shutter is open: a continuous smear
  // whose length scales with |v|, brightest at the leading (current) position
  // and fading toward the trailing edge. Length is matched to the old 6-disc
  // tail extent (~0.072 s of travel) so the look is unchanged, then capped so a
  // hypervelocity ball doesn't paint a screen-spanning bar.
  const L = Math.min(sp * 0.072, b.r * 8);
  const ux = b.vx / sp, uy = b.vy / sp;
  const tailX = b.x - ux * L, tailY = b.y - uy * L;
  const c = b.effectiveColor();
  const grad = tx.createLinearGradient(tailX, tailY, b.x, b.y);
  grad.addColorStop(0, withAlpha(c, 0));                   // trailing edge: transparent
  grad.addColorStop(1, withAlpha(lighten(c, 0.3), 0.3));   // leading edge: brightest
  tx.save();
  tx.strokeStyle = grad;
  tx.lineWidth = b.r * 1.8;                                // capsule ≈ ball diameter wide
  tx.lineCap = 'round';
  tx.beginPath(); tx.moveTo(tailX, tailY); tx.lineTo(b.x, b.y); tx.stroke();
  tx.restore();
}

/**
 * Concentric Fresnel rim. Bright near the edge for all materials, extra
 * bright for metals. Implemented as a thin annular gradient — no angle
 * dependence on camera (we're 2D) but a genuine edge bias.
 */
function drawFresnelRim(tx, b) {
  const inner = b.r * 0.70;
  const outer = b.r * 1.0;
  const metal = b.mat.metallic > 0.5;
  const isRubber  = b.mat.name === 'RUBBER';
  const isBowling = b.mat.name === 'BOWLING';
  // Rubber has essentially no Fresnel reflectance (dielectric but very
  // rough) so skip the bright rim entirely — instead, darken the edge,
  // which is what the eye reads as "matte soft surface at grazing angle."
  if (isRubber) {
    const g = tx.createRadialGradient(b.x, b.y, inner, b.x, b.y, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.35)');
    tx.fillStyle = g;
    tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.fill();
    return;
  }
  const g = tx.createRadialGradient(b.x, b.y, inner, b.x, b.y, outer);
  const baseAlpha = metal ? 0.55 : isBowling ? 0.14 : 0.28;
  // Schlick's Fresnel: R(θ)=R0+(1-R0)(1-cosθ)^5, with cosθ=√(1-ρ²) for a 2D
  // sphere (ρ = screen radius). Reflectance rises sharply toward the silhouette;
  // dielectrics (R0≈0.04) reflect the white environment, metals (R0≈0.5) keep
  // their own tint at grazing — gold/steel get a warm rim, not a white one.
  const R0 = metal ? 0.5 : 0.04;
  const rimCol = metal ? lighten(b.mat.color, 0.4) : '#ffffff';
  const INNER_RHO = 0.70;                       // gradient covers ρ ∈ [0.70, 1.0]
  for (const s of [0, 0.25, 0.5, 0.75, 1]) {
    const rho = INNER_RHO + (1 - INNER_RHO) * s;
    const cosT = Math.sqrt(Math.max(0, 1 - rho * rho));
    const fres = R0 + (1 - R0) * Math.pow(1 - cosT, 5);
    g.addColorStop(s, withAlpha(rimCol, baseAlpha * fres));
  }
  tx.fillStyle = g;
  tx.beginPath(); tx.arc(b.x, b.y, b.r, 0, TAU); tx.fill();
}

export function drawBall(tx, b) {
  // Viewport cull — skip the entire ball render if clearly off-screen.
  // Saves gradient building, texture pattern transforms, path ops, and
  // per-material extras (cracks, dents, diamond sparks, etc.).
  if (!isBallOnScreen(b)) return;
  const { x, y, r, mat } = b;
  const squashAmt = b.squash;

  // Center-of-mass wobble for dented balls. Each dent removes metal at its
  // location, so the CoM drifts away from the dented side. The drawn body
  // shifts toward the heavy (un-dented) side — as the ball rotates, this
  // traces a tiny orbit, reading as a convincing wobble. Pure visual, no
  // physics impact. Only kicks in once several dents have accumulated.
  let wobbleX = 0, wobbleY = 0;
  if (mat.dentable && b.dents && b.dents.length > 2) {
    let sx = 0, sy = 0, sw = 0;
    for (const d of b.dents) {
      const aa = b.angle + d.localAngle;
      sx += Math.cos(aa) * d.depth;
      sy += Math.sin(aa) * d.depth;
      sw += d.depth;
    }
    if (sw > 0.6) {
      const mag = Math.min(1, (sw - 0.6) * 0.6);
      wobbleX = -(sx / sw) * r * 0.035 * mag;
      wobbleY = -(sy / sw) * r * 0.035 * mag;
    }
  }
  const wobbling = wobbleX !== 0 || wobbleY !== 0;
  if (wobbling) { tx.save(); tx.translate(wobbleX, wobbleY); }

  // fade fragments in their last 0.8 s of life
  let alphaScale = 1;
  if (b.lifespan !== undefined && b.lifespan < 0.8) {
    alphaScale = Math.max(0, b.lifespan / 0.8);
    tx.save();
    tx.globalAlpha = alphaScale;
  }

  drawMotionStreak(tx, b);

  tx.save();
  tx.translate(x, y);
  tx.rotate(b.squashAng);
  const rx = r * squashAmt, ry = r * (1 + (1 - squashAmt) * 0.28);
  tx.scale(rx / r, ry / r);
  tx.translate(-x, -y);

  const refracted = drawRefraction(tx, b);

  const lx = light.x * W.cw, ly = light.y * W.ch;
  const ldx = x - lx, ldy = y - ly;
  const ldlen = len(ldx, ldy) || 1;
  const offX = -ldx / ldlen * r * 0.45;
  const offY = -ldy / ldlen * r * 0.45;

  const hotGlow = PHYS.heatFx && b.heat > 0.15;
  const glowAmt = Math.max(mat.glow || 0, b.heat * 0.9);
  if (glowAmt > 0.05) {
    const gr = r * (2 + glowAmt);
    const g = tx.createRadialGradient(x, y, r * 0.8, x, y, gr);
    const gc = hotGlow ? mix(mat.color, '#ff6020', b.heat) : mat.color;
    g.addColorStop(0,    withAlpha(gc, hotGlow ? 0.8 : 0.73));
    g.addColorStop(0.45, withAlpha(gc, 0.27));
    g.addColorStop(1,    withAlpha(gc, 0));
    tx.fillStyle = g;
    tx.beginPath(); tx.arc(x, y, gr, 0, TAU); tx.fill();
  }

  const bodyColor = b.effectiveColor();
  if (!refracted && ENV_PALETTES[mat.name]) {
    // Steel / gold / magnet: env-panorama reflection body. See drawMetalBody.
    drawMetalBody(tx, b, offX, offY);
  } else {
    const g = tx.createRadialGradient(x + offX, y + offY, 0, x, y, r);
    if (refracted) {
      g.addColorStop(0,   'rgba(255,255,255,0.55)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.04)');
      g.addColorStop(1,   'rgba(0,0,0,0.32)');
    } else if (mat.metallic > 0.7) {
      // near-mirror: sharp hot core + deep dark fringe
      g.addColorStop(0,    '#ffffff');
      g.addColorStop(0.28, lightenL(bodyColor, 0.5));
      g.addColorStop(0.6,  bodyColor);
      g.addColorStop(0.88, darkenL(bodyColor, 0.55));
      g.addColorStop(1,    darkenL(bodyColor, 0.78));
    } else if (mat.metallic > 0.3) {
      g.addColorStop(0,   lightenL(bodyColor, 0.65));
      g.addColorStop(0.5, bodyColor);
      g.addColorStop(1,   darkenL(bodyColor, 0.55));
    } else if (mat.name === 'RUBBER' || mat.name === 'BOWLING') {
      // Matte elastomer / polymer. Real rubber/polyurethane is nearly pure
      // Lambertian — only a faint lightening near the illuminated point,
      // then a long gentle roll-off to a dark occluded rim. No brightness
      // anywhere near as high as a polished surface.
      g.addColorStop(0,    lightenL(bodyColor, 0.18));
      g.addColorStop(0.35, bodyColor);
      g.addColorStop(0.78, darkenL(bodyColor, 0.40));
      g.addColorStop(1,    darkenL(bodyColor, 0.78));
    } else {
      g.addColorStop(0,   lightenL(bodyColor, 0.55));
      g.addColorStop(0.6, bodyColor);
      g.addColorStop(1,   darkenL(bodyColor, 0.45));
    }
    tx.fillStyle = g;
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();
  }

  // Fresnel edge bias — uniform bright rim regardless of light direction.
  tx.save();
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();
  drawFresnelRim(tx, b);

  // Subsurface-scatter rim hint for rubber — a warm saturated tint near
  // the edge suggesting light diffusing a short distance into the body
  // before bouncing back out. This is the "dark ring with a glowing
  // border just inside it" look that silhouettes real rubber against
  // backlight. Also slightly biased toward the illuminator so lit
  // regions get more forward scatter.
  if (mat.name === 'RUBBER') {
    tx.save();
    tx.globalCompositeOperation = 'screen';
    const subG = tx.createRadialGradient(x, y, r * 0.60, x, y, r);
    subG.addColorStop(0,    withAlpha(lighten(mat.color, 0.25), 0));
    subG.addColorStop(0.70, withAlpha(lighten(mat.color, 0.15), 0.12));
    subG.addColorStop(0.92, withAlpha(lighten(mat.color, 0.30), 0.42));
    subG.addColorStop(1,    withAlpha(mat.color, 0));
    tx.fillStyle = subG;
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();
    tx.restore();
  }

  // metallic faux env — sky + horizon + ground bands.
  // Skipped for materials with their own full env panorama (steel/gold/magnet).
  if (mat.metallic > 0.5 && !ENV_PALETTES[mat.name]) {
    const sg = tx.createLinearGradient(x, y - r, x, y);
    sg.addColorStop(0,   'rgba(255,255,255,0.5)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.15)');
    sg.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = sg;
    tx.fillRect(x - r, y - r, r * 2, r);

    const hgEnv = tx.createLinearGradient(x, y + r * 0.08, x, y + r * 0.38);
    hgEnv.addColorStop(0,   'rgba(255,255,255,0)');
    hgEnv.addColorStop(0.5, 'rgba(255,240,200,0.22)');
    hgEnv.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = hgEnv;
    tx.fillRect(x - r, y + r * 0.08, r * 2, r * 0.32);

    const gg = tx.createLinearGradient(x, y + r * 0.5, x, y + r);
    gg.addColorStop(0, 'rgba(0,0,0,0)');
    gg.addColorStop(1, 'rgba(0,0,0,0.35)');
    tx.fillStyle = gg;
    tx.fillRect(x - r, y + r * 0.5, r * 2, r * 0.5);
  }

  // Anisotropic brushed streak — a thin bright horizontal band in the
  // ball-local frame, rotated with the ball. This is the "smeared
  // highlight along the brush direction" that separates brushed metal
  // from a plain mirror finish. Applies to any material with anisotropy.
  if (mat.anisotropy && mat.anisotropy > 0) {
    tx.save();
    tx.translate(x, y);
    tx.rotate(b.angle + (mat.brushAxis || 0));
    const streakY = offY * 0.4;
    const bandH = r * 0.20;
    const sg2 = tx.createLinearGradient(0, streakY - bandH, 0, streakY + bandH);
    sg2.addColorStop(0,   'rgba(255,255,255,0)');
    sg2.addColorStop(0.5, `rgba(255,255,255,${0.28 * mat.anisotropy})`);
    sg2.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = sg2;
    tx.fillRect(-r * 1.1, streakY - bandH, r * 2.2, bandH * 2);
    tx.restore();
  }
  tx.restore();

  // primary specular (directional). Polished metal has a very tight
  // hotspot plus a wider soft lobe — the dual-lobe structure reads as
  // "real" where a single spot looks like a cartoon reflection.
  // Rubber gets no spec at all (Lambertian only). Bowling gets a very
  // dim broad one.
  const isSharpMetal = mat.clearcoat > 0 && mat.metallic > 0.6;
  const isMatte = (mat.name === 'RUBBER' || mat.name === 'BOWLING');
  const noSpec = (mat.name === 'RUBBER');
  const hx = x + offX * 1.3, hy = y + offY * 1.3;
  const hr = r * (
    isSharpMetal ? 0.085 :
    isMatte ? 0.40 :
    mat.metallic > 0.5 ? 0.26 :
    0.18
  );
  if (!noSpec) {
    const hg = tx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    hg.addColorStop(0,   isMatte ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,1.0)');
    hg.addColorStop(0.5,
      isSharpMetal ? 'rgba(255,255,255,0.55)' :
      isMatte ? 'rgba(255,255,255,0.06)' :
      'rgba(255,255,255,0.38)'
    );
    hg.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = hg;
    tx.beginPath(); tx.arc(hx, hy, hr, 0, TAU); tx.fill();
  }

  // Wide soft specular lobe — the fuzzy halo surrounding the hotspot on
  // polished metal. Drawn for any sharp-polished metal (steel/gold/magnet).
  if (isSharpMetal) {
    const hrWide = r * 0.42;
    const hgW = tx.createRadialGradient(hx, hy, 0, hx, hy, hrWide);
    hgW.addColorStop(0,   'rgba(255,255,255,0.22)');
    hgW.addColorStop(0.5, 'rgba(255,255,255,0.07)');
    hgW.addColorStop(1,   'rgba(255,255,255,0)');
    tx.fillStyle = hgW;
    tx.beginPath(); tx.arc(hx, hy, hrWide, 0, TAU); tx.fill();
  }

  if (mat.metallic > 0.3 || mat.refract > 0.4) {
    const hx2 = x + offX * 0.6, hy2 = y + offY * 0.6;
    const hr2 = hr * 0.5;
    const hg2 = tx.createRadialGradient(hx2, hy2, 0, hx2, hy2, hr2);
    hg2.addColorStop(0, 'rgba(255,255,255,0.82)');
    hg2.addColorStop(1, 'rgba(255,255,255,0)');
    tx.fillStyle = hg2;
    tx.beginPath(); tx.arc(hx2, hy2, hr2, 0, TAU); tx.fill();
  }

  // Clearcoat — a sub-pixel bright glint from the thin gloss layer on
  // top of the base metal. Just a tiny pinpoint at the reflection point.
  if (mat.clearcoat) {
    const cc = mat.clearcoat;
    const ccr = r * 0.055;
    const ccx = x + offX * 1.45;
    const ccy = y + offY * 1.45;
    const cg = tx.createRadialGradient(ccx, ccy, 0, ccx, ccy, ccr);
    cg.addColorStop(0, `rgba(255,255,255,${Math.min(1, cc)})`);
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    tx.fillStyle = cg;
    tx.beginPath(); tx.arc(ccx, ccy, ccr, 0, TAU); tx.fill();
  }

  // rotation markers so spin is visible
  tx.save();
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();

  // Magnetic polarity — north/south hemispheres, rotating with the ball.
  // Drawn BEFORE the texture overlay so the iron-filing flecks read on top.
  if (mat.magnetic && b.polarity) {
    const northA = b.angle + (b.polarity < 0 ? Math.PI : 0);
    const nx_ = Math.cos(northA);
    const ny_ = Math.sin(northA);
    const grad = tx.createLinearGradient(x - nx_ * r, y - ny_ * r, x + nx_ * r, y + ny_ * r);
    grad.addColorStop(0,    'rgba(50,110,255,0.42)');    // south (blue)
    grad.addColorStop(0.42, 'rgba(255,255,255,0)');
    grad.addColorStop(0.58, 'rgba(255,255,255,0)');
    grad.addColorStop(1,    'rgba(255,70,70,0.42)');     // north (red)
    tx.fillStyle = grad;
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();
  }

  // Surface micro-texture — brushed-metal for steel, grain for rubber,
  // flecks for bowling, glitter for gold, and so on. Pattern is rotated
  // with the ball via setTransform so it reads as "baked into" the ball,
  // not drifting over it. Overlay blend preserves highlights under it.
  const pat = getMatPattern(tx, mat.name);
  if (pat) {
    if (pat.setTransform) {
      // Reuse a single DOMMatrix across all balls — mutating its fields
      // directly is ~free, whereas `new DOMMatrix()` per ball allocates
      // at 260 × 60 ≈ 15.6k/sec.
      if (!_patternMatrix && typeof DOMMatrix !== 'undefined') {
        _patternMatrix = new DOMMatrix();
      }
      if (_patternMatrix) {
        const c = Math.cos(b.angle), s = Math.sin(b.angle);
        _patternMatrix.a = c;
        _patternMatrix.b = s;
        _patternMatrix.c = -s;
        _patternMatrix.d = c;
        _patternMatrix.e = x;
        _patternMatrix.f = y;
        pat.setTransform(_patternMatrix);
      }
    }
    tx.save();
    tx.globalAlpha = 0.55;
    tx.globalCompositeOperation = 'overlay';
    tx.fillStyle = pat;
    tx.fillRect(x - r, y - r, r * 2, r * 2);
    tx.restore();
  }

  const mAng = b.angle;
  for (const a of [0, Math.PI]) {
    const mx = x + Math.cos(mAng + a) * r * 0.62;
    const my = y + Math.sin(mAng + a) * r * 0.62;
    tx.fillStyle = darkenL(bodyColor, 0.6);
    tx.beginPath(); tx.arc(mx, my, r * 0.13, 0, TAU); tx.fill();
  }

  // Hot-metal forge glow — a directed orange/red inner lick when a metallic
  // body is heated. Breathes slightly so it feels alive instead of static.
  if (PHYS.heatFx && b.heat > 0.4 && mat.metallic > 0.4) {
    const hh = Math.min(1, (b.heat - 0.4) / 0.6);
    const breathe = 1 + 0.15 * Math.sin(performance.now() * 0.0032 + b.id);
    const alpha = hh * breathe;
    const hgCol = mat.name === 'GOLD' ? '#ff9830' : '#ff5020';
    const hg = tx.createRadialGradient(x, y, r * 0.05, x, y, r);
    hg.addColorStop(0,    withAlpha(hgCol, 0.38 * alpha));
    hg.addColorStop(0.6,  withAlpha(hgCol, 0.20 * alpha));
    hg.addColorStop(1,    withAlpha(hgCol, 0));
    tx.fillStyle = hg;
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.fill();
  }

  // Ice crystalline interior — sparse white-line lattice inside ice balls,
  // fading out as heat rises (melting erases the crystal structure).
  if (mat.name === 'ICE' && !b.isFragment) {
    const crystalAlpha = Math.max(0, 1 - b.heat * 1.5);
    if (crystalAlpha > 0.05) {
      tx.lineWidth = 0.7;
      tx.strokeStyle = withAlpha('#ffffff', 0.32 * crystalAlpha);
      // Deterministic pattern seeded by ball id so a given ball always has
      // the same lattice — not a new random pattern each frame.
      const seed = b.id * 1337;
      for (let i = 0; i < 4; i++) {
        const s = (seed + i * 97) % 628;
        const e = (seed * 3 + i * 131) % 628;
        const a1 = (s / 100) + b.angle;
        const a2 = (e / 100) + b.angle;
        const r1 = r * (0.35 + (seed >> i) % 50 / 100);
        const r2 = r * (0.55 + ((seed >> (i + 2)) % 40) / 100);
        tx.beginPath();
        tx.moveTo(x + Math.cos(a1) * r1, y + Math.sin(a1) * r1);
        tx.lineTo(x + Math.cos(a2) * r2, y + Math.sin(a2) * r2);
        tx.stroke();
      }
      // a faint frosty sparkle dot
      tx.fillStyle = withAlpha('#ffffff', 0.45 * crystalAlpha);
      const sa = b.angle * 1.1;
      tx.beginPath();
      tx.arc(x + Math.cos(sa) * r * 0.35, y + Math.sin(sa) * r * 0.35, 0.9, 0, TAU);
      tx.fill();
    }
  }
  tx.restore();

  // outline
  tx.strokeStyle = darkenL(bodyColor, 0.75);
  tx.lineWidth = 0.8;
  tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.stroke();

  if (b.pinned) {
    tx.strokeStyle = '#ffffff'; tx.lineWidth = 1.3;
    tx.beginPath(); tx.arc(x, y, r + 3, 0, TAU); tx.stroke();
    tx.fillStyle = '#ffffff';
    tx.fillRect(x - 1, y - r - 8, 2, 6);
  }
  if (b.charge !== 0) {
    tx.strokeStyle = b.charge > 0 ? '#ff4060' : '#4080ff';
    tx.lineWidth = 1.5;
    tx.beginPath(); tx.arc(x, y, r + 4, 0, TAU); tx.stroke();
  }

  // sleeping balls get a subtle z (only visible with vectors toggle)
  if (b.sleeping && PHYS.showVec) {
    tx.fillStyle = withAlpha('#6fb9ff', 0.55);
    tx.font = '10px JetBrains Mono, monospace';
    tx.textAlign = 'center';
    tx.fillText('z', x, y - r - 6);
  }

  tx.restore();

  // TNT fuse — a short upright fuse stub above the ball with a white tip.
  // When the fuse is burning, the tip ignites (bright glowing spark + a
  // tiny moving ember at the burn line). Fuse rotates with the ball so
  // tumbling TNT reads as a physical stick of dynamite, not a decal.
  if (mat.name === 'TNT' && !b.isFragment) {
    tx.save();
    tx.translate(x, y);
    tx.rotate(b.angle);
    const fuseLen = r * 0.55;
    const fuseX = 0;
    const fuseY = -r - fuseLen * 0.5;
    tx.strokeStyle = '#d8b87a';
    tx.lineWidth = 1.6;
    tx.lineCap = 'round';
    tx.beginPath();
    tx.moveTo(fuseX, -r + 1);
    tx.lineTo(fuseX, fuseY - fuseLen * 0.5);
    tx.stroke();
    if (b.fuseT > 0) {
      // burning tip — flame gated by Fire toggle (bright flame halo),
      // but a small white core still renders so the player can see the
      // fuse is actively lit even with fire off.
      const urgency = Math.min(1, 1 - (b.fuseT / 0.35));
      const tipR = 1.4 + urgency * 1.2;
      const tipY = fuseY - fuseLen * 0.5;
      if (PHYS.fire) {
        const g = tx.createRadialGradient(fuseX, tipY, 0, fuseX, tipY, tipR * 3.5);
        g.addColorStop(0,   'rgba(255,240,120,1)');
        g.addColorStop(0.4, 'rgba(255,150,40,0.65)');
        g.addColorStop(1,   'rgba(255,150,40,0)');
        tx.fillStyle = g;
        tx.beginPath(); tx.arc(fuseX, tipY, tipR * 3.5, 0, TAU); tx.fill();
      }
      tx.fillStyle = '#ffffff';
      tx.beginPath(); tx.arc(fuseX, tipY, tipR, 0, TAU); tx.fill();
    }
    tx.restore();
  }

  // Diamond brilliance — flickering cross-stars at fixed ball-local angles,
  // additive-blended so they genuinely glint. Each star has its own drift
  // in radius + brightness so they don't pulse in lockstep. Drawn OUTSIDE
  // the squash transform (pinned to world) so they don't jump on impacts.
  if (mat.name === 'DIAMOND' && !b.isFragment) {
    tx.save();
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();
    tx.globalCompositeOperation = 'lighter';
    tx.lineCap = 'round';
    const now = performance.now();
    const count = 3;
    for (let i = 0; i < count; i++) {
      const localA = (i / count) * TAU + 0.55 + b.id * 0.17;
      const aa = b.angle + localA;
      const radial = 0.40 + 0.30 * Math.sin(now * 0.0022 + i * 2.3 + b.id);
      const px = x + Math.cos(aa) * r * radial;
      const py = y + Math.sin(aa) * r * radial;
      const twinkle = 0.5 + 0.5 * Math.sin(now * 0.0038 + i * 1.7 + b.id * 1.3);
      const ss = r * 0.22 * (0.6 + 0.4 * twinkle);
      const alpha = 0.50 * twinkle + 0.15;
      tx.strokeStyle = `rgba(255,255,255,${alpha})`;
      tx.lineWidth = 0.9;
      tx.beginPath();
      tx.moveTo(px - ss, py); tx.lineTo(px + ss, py);
      tx.moveTo(px, py - ss); tx.lineTo(px, py + ss);
      tx.stroke();
      // thinner diagonal rays for that gem-sparkle shape
      const diag = ss * 0.60;
      tx.lineWidth = 0.45;
      tx.beginPath();
      tx.moveTo(px - diag, py - diag); tx.lineTo(px + diag, py + diag);
      tx.moveTo(px - diag, py + diag); tx.lineTo(px + diag, py - diag);
      tx.stroke();
      // tiny solid core
      tx.fillStyle = `rgba(255,255,255,${alpha + 0.3})`;
      tx.beginPath(); tx.arc(px, py, 0.95, 0, TAU); tx.fill();
    }
    tx.restore();
  }

  // Fragile-ball cracks — same pin-to-world-surface pattern as dents.
  // Each crack is a short dark line extending inward from the impact
  // point, with an optional sub-branch for deeper cracks. Drawn slightly
  // inside the clip (r * 0.97) so the line ends are clipped cleanly.
  if (mat.fragile && b.cracks && b.cracks.length) {
    tx.save();
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();
    const crackCol =
      mat.name === 'ICE'      ? 'rgba(60,100,140,0.85)' :
      mat.name === 'DIAMOND'  ? 'rgba(180,210,240,0.80)' :
      mat.name === 'OBSIDIAN' ? 'rgba(150,120,170,0.75)' :
                                'rgba(30,50,80,0.85)';
    tx.lineCap = 'round';
    tx.strokeStyle = crackCol;
    for (const c of b.cracks) {
      const aa = b.angle + c.localAngle;
      const x0 = x + Math.cos(aa) * r * 0.96;
      const y0 = y + Math.sin(aa) * r * 0.96;
      const da = aa + Math.PI + c.angle; // inward + wander
      const L = r * c.length * 0.55;
      const x1 = x0 + Math.cos(da) * L;
      const y1 = y0 + Math.sin(da) * L;
      tx.lineWidth = 1.1;
      tx.beginPath();
      tx.moveTo(x0, y0); tx.lineTo(x1, y1);
      tx.stroke();
      // a small fork at the midpoint for deeper cracks
      if (c.length > 0.6) {
        const mx = x0 + Math.cos(da) * L * 0.55;
        const my = y0 + Math.sin(da) * L * 0.55;
        const fa = da + (c.localAngle > 0 ? 0.9 : -0.9);
        tx.lineWidth = 0.7;
        tx.beginPath();
        tx.moveTo(mx, my);
        tx.lineTo(mx + Math.cos(fa) * L * 0.35, my + Math.sin(fa) * L * 0.35);
        tx.stroke();
      }
    }
    tx.restore();
  }

  // Gold dents — drawn AFTER the squash transform restore so they stay
  // pinned to the ball's actual world-space surface. (Inside the squash
  // transform, every hit changes `squashAng` and visibly re-rotates every
  // stored dent, which is why they looked like they weren't at the impact
  // site.) Ball-local angle is converted to world via `b.angle + localAngle`.
  if (mat.dentable && b.dents && b.dents.length) {
    tx.save();
    tx.beginPath(); tx.arc(x, y, r, 0, TAU); tx.clip();
    for (const d of b.dents) {
      const aa = b.angle + d.localAngle;
      const cosA = Math.cos(aa), sinA = Math.sin(aa);
      const dx = x + cosA * r * 0.80;
      const dy = y + sinA * r * 0.80;
      const dr = r * (0.22 + 0.30 * d.depth);
      // 1. raised rim — hammered gold bulges outward around the pit
      const rg = tx.createRadialGradient(dx, dy, dr * 0.75, dx, dy, dr * 1.15);
      rg.addColorStop(0,   withAlpha('#6a4a10', 0));
      rg.addColorStop(0.4, withAlpha('#ffe6a0', 0.45 * d.depth));
      rg.addColorStop(1,   withAlpha('#6a4a10', 0));
      tx.fillStyle = rg;
      tx.beginPath(); tx.arc(dx, dy, dr * 1.15, 0, TAU); tx.fill();
      // 2. dark crater body
      const dg = tx.createRadialGradient(dx, dy, 0, dx, dy, dr);
      dg.addColorStop(0,    withAlpha('#120700', 0.85 * d.depth));
      dg.addColorStop(0.55, withAlpha('#3a2000', 0.55 * d.depth));
      dg.addColorStop(1,    withAlpha('#3a2000', 0));
      tx.fillStyle = dg;
      tx.beginPath(); tx.arc(dx, dy, dr, 0, TAU); tx.fill();
      // 3. inner-wall shadow crescent — the far side of the pit
      const sx = dx + cosA * dr * 0.30;
      const sy = dy + sinA * dr * 0.30;
      const sg = tx.createRadialGradient(sx, sy, 0, sx, sy, dr * 0.70);
      sg.addColorStop(0, withAlpha('#000000', 0.55 * d.depth));
      sg.addColorStop(1, withAlpha('#000000', 0));
      tx.fillStyle = sg;
      tx.beginPath(); tx.arc(sx, sy, dr * 0.70, 0, TAU); tx.fill();
    }
    tx.restore();
  }

  if (PHYS.showVec) {
    const sp = len(b.vx, b.vy);
    if (sp > 10) {
      const sc = 0.08;
      const ex = x + b.vx * sc, ey = y + b.vy * sc;
      tx.strokeStyle = '#4affb4';
      tx.lineWidth = 1.5;
      tx.beginPath(); tx.moveTo(x, y); tx.lineTo(ex, ey); tx.stroke();
      const ang = Math.atan2(b.vy, b.vx);
      tx.beginPath();
      tx.moveTo(ex, ey); tx.lineTo(ex - Math.cos(ang - 0.35) * 8, ey - Math.sin(ang - 0.35) * 8);
      tx.moveTo(ex, ey); tx.lineTo(ex - Math.cos(ang + 0.35) * 8, ey - Math.sin(ang + 0.35) * 8);
      tx.stroke();
    }
    if (Math.abs(b.omega) > 1) {
      tx.strokeStyle = '#ffb340';
      tx.lineWidth = 1;
      tx.beginPath();
      const da = Math.min(Math.PI * 1.5, Math.abs(b.omega) * 0.25);
      tx.arc(x, y, r + 6, 0, da * Math.sign(b.omega), b.omega < 0);
      tx.stroke();
    }
  }

  if (b.lifespan !== undefined && b.lifespan < 0.8) {
    tx.restore();
  }
  if (wobbling) tx.restore();
}

export function drawTrail(tx, b) {
  if (!b.trail || b.trail.length < 2) return;
  // Trails extend from the ball's recent positions — give generous margin
  // so a just-exited ball's trail tail still renders for a frame or two.
  if (!isBallOnScreen(b, 200)) return;
  tx.strokeStyle = withAlpha(b.mat.color, 0.33);
  tx.lineWidth = 2; tx.lineCap = 'round';
  tx.beginPath();
  for (let i = 0; i < b.trail.length; i++) {
    const pt = b.trail[i];
    if (i === 0) tx.moveTo(pt.x, pt.y); else tx.lineTo(pt.x, pt.y);
  }
  tx.stroke();
}
