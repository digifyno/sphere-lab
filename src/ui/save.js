/**
 * Save / load / screenshot.
 *
 * Save: writes the current scene name + all ball state (positions, velocities,
 * material, pin, heat) to localStorage. Walls/pegs/flippers come from the scene
 * rebuild on load — we don't try to serialize every geometric primitive.
 *
 * Load: re-runs the saved scene, then clears and re-populates the ball pool.
 *
 * Screenshot: renders the canvas to a PNG blob and triggers a download.
 */

import { W } from '../core/world.js';
import { balls, Ball } from '../entities/ball.js';
import { Spring } from '../entities/spring.js';
import { MATERIALS } from '../entities/materials.js';
import { softBodies, enrollSoftBody } from '../entities/softBody.js';
import { loadScene } from '../scenes/index.js';
import { canvas } from '../render/canvas.js';

const KEY = 'sphere-lab:snapshot';

export function saveState() {
  // Skip in-flight fragments (their lifespan field would survive but they'd
  // never cull cleanly after load, leaving ghost fragments stuck in
  // mid-shatter state).
  const savedBalls = balls.filter(b => !b.isFragment);
  const ballIdx = new Map();
  savedBalls.forEach((b, i) => ballIdx.set(b, i));

  // Springs reference balls by index into the saved-balls array. Any
  // spring whose endpoint was filtered out (fragment, or a scene-built
  // ball that's no longer present for some reason) is dropped. Soft
  // membrane springs are excluded — the blob restore rebuilds them.
  const savedSprings = W.springs
    .filter(s => s.tag !== 'soft' && ballIdx.has(s.a) && ballIdx.has(s.b))
    .map(s => ({
      a: ballIdx.get(s.a),
      b: ballIdx.get(s.b),
      rest: s.rest, k: s.k, damp: s.damp,
      offA: s.offA, offB: s.offB,
      tag: s.tag
    }));

  // Soft blobs: node balls are saved in the main list (their pose +
  // velocities round-trip for free); this records the wiring — which
  // indices form a ring, plus the rest state shape matching pulls toward.
  const savedSoft = softBodies
    .filter(sb => sb.nodes.every(nd => ballIdx.has(nd)))
    .map(sb => ({
      mat: matKeyOf(sb.mat),
      nodes: sb.nodes.map(nd => ballIdx.get(nd)),
      R: sb.R,
      restArea: sb.restArea,
      restShape: sb.restShape,
      springRests: sb.springs.map(s => s.rest)
    }));

  // World-anchored constraints (cradle-style). Same index pattern.
  const savedConstraints = W.constraints
    .filter(c => ballIdx.has(c.a))
    .map(c => ({
      ball: ballIdx.get(c.a),
      ax: c.ax, ay: c.ay, len: c.len
    }));

  const payload = {
    scene: W.scene,
    balls: savedBalls.map(b => ({
      x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      r: b.r, mat: matKeyOf(b.mat),
      pinned: b.pinned, heat: b.heat,
      angle: b.angle, omega: b.omega,
      polarity: b.polarity
    })),
    springs: savedSprings,
    constraints: savedConstraints,
    softBodies: savedSoft
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
    flashButton('btn-save', 'Saved');
  } catch {
    flashButton('btn-save', 'Failed');
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { flashButton('btn-load', 'Empty'); return; }
    const payload = JSON.parse(raw);
    loadScene(payload.scene || 'sandbox');
    // Clear the scene's starting balls *and* the springs / constraints
    // that reference them. Otherwise cradle / cloth / jelly / chaos
    // springs hold dead Ball references and the solver pulls on phantoms.
    // softBodies too: the scene rebuild registered fresh blobs whose node
    // balls the wipes below orphan — without this they kept rendering as
    // ghost blobs until the next un-paused physics step culled them.
    balls.length = 0;
    W.springs.length = 0;
    W.constraints.length = 0;
    softBodies.length = 0;

    // Build balls first, keeping a local array so we can map saved
    // spring / constraint indices back to the new Ball instances.
    const restored = [];
    for (const s of payload.balls || []) {
      const mat = (Object.prototype.hasOwnProperty.call(MATERIALS, s.mat) && MATERIALS[s.mat]) || MATERIALS.rubber;
      const b = new Ball(s.x, s.y, s.r, mat);
      b.vx = s.vx; b.vy = s.vy;
      b.pinned = !!s.pinned;
      b.heat = s.heat || 0;
      b.angle = s.angle || 0;
      b.omega = s.omega || 0;
      if (typeof s.polarity === 'number') b.polarity = s.polarity;
      balls.push(b);
      restored.push(b);
    }

    // Rebuild springs from saved indices. Skip any with out-of-range refs.
    for (const sp of payload.springs || []) {
      const a = restored[sp.a];
      const b = restored[sp.b];
      if (!a || !b) continue;
      const spring = new Spring(a, b, sp.rest, sp.k, sp.damp, sp.offA, sp.offB);
      if (sp.tag) spring.tag = sp.tag;   // slime bonds stay managed bonds
      W.springs.push(spring);
    }

    // Re-wire soft blobs onto their restored node balls — material clone,
    // node mass/flags, membrane springs, and the saved rest shape (so a
    // blob saved mid-squash doesn't adopt the squash as its new rest).
    for (const sv of payload.softBodies || []) {
      const mat = Object.prototype.hasOwnProperty.call(MATERIALS, sv.mat) ? MATERIALS[sv.mat] : null;
      if (!mat || !mat.soft) continue;
      const nodes = (sv.nodes || []).map(i => restored[i]);
      if (nodes.length < 3 || nodes.some(n => !n)) continue;
      enrollSoftBody(nodes, mat, sv.R || 20, sv);
    }

    // Rebuild world-anchor constraints.
    for (const c of payload.constraints || []) {
      const a = restored[c.ball];
      if (!a) continue;
      W.constraints.push({ a, ax: c.ax, ay: c.ay, len: c.len });
    }

    flashButton('btn-load', 'Restored');
  } catch {
    flashButton('btn-load', 'Failed');
  }
}

/** Render the canvas to a PNG and trigger a download. */
export function screenshot() {
  canvas.toBlob(blob => {
    if (!blob) { flashButton('btn-snapshot', 'Failed'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sphere-lab-${timestamp()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashButton('btn-snapshot', 'Saved');
  }, 'image/png');
}

function matKeyOf(m) {
  for (const k of Object.keys(MATERIALS)) if (MATERIALS[k] === m) return k;
  // Soft-body nodes carry a per-blob CLONE of their material — identity
  // fails, but the clone keeps the parent's name.
  for (const k of Object.keys(MATERIALS)) if (MATERIALS[k].name === m.name) return k;
  return 'rubber';
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Brief "Saved / Loaded / Failed" feedback on the button's label span. */
function flashButton(id, text) {
  const b = document.getElementById(id);
  if (!b) return;
  const span = b.querySelector('span:not(.kbd)');
  if (!span) return;
  const prev = span.textContent;
  span.textContent = text;
  b.classList.add('active');
  setTimeout(() => {
    span.textContent = prev;
    b.classList.remove('active');
  }, 900);
}
