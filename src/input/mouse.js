/**
 * Mouse state + all canvas mouse/wheel handlers.
 *
 * Side-effects mutate the undo stack when the user creates new state
 * (spawned balls, drawn walls, linked springs) — Ctrl-Z in keyboard.js
 * pops and reverses.
 */

import { clamp, len, rand } from '../core/math.js';
import { W, cam, screenToWorld } from '../core/world.js';
import { canvas } from '../render/canvas.js';
import { balls, spawnBall, kickBall } from '../entities/ball.js';
import { destroySoftBody } from '../entities/softBody.js';
import { Spring } from '../entities/spring.js';
import { Snd } from '../audio/sound.js';
import { explode } from '../physics/explode.js';
import { getTool, ballAt, wallAt } from './tools.js';
import { pushUndo } from '../core/undo.js';

export const mouse = {
  x: 0, y: 0, wx: 0, wy: 0,
  down: false, right: false, middle: false, shift: false,
  sx: 0, sy: 0, wsx: 0, wsy: 0,
  /** @type {import('../entities/ball.js').Ball | null} */ grab: null,
  /** @type {import('../entities/ball.js').Ball | null} */ linkFirst: null,
  draw: { x1: 0, y1: 0, active: false },
  /** Springs created within a single drag-chain gesture — batched into a
   *  single undo entry on mouseup so Ctrl-Z removes the whole chain. */
  /** @type {any[]} */ chainSprings: [],
  /** Ctrl-click auto-mesh: `mesh.source` is the center ball, `mesh.cx/cy`
   *  is the initial click position in world coords, and the effective
   *  radius is computed live from cursor distance to (cx, cy). */
  mesh: {
    active: false,
    /** @type {import('../entities/ball.js').Ball | null} */ source: null,
    cx: 0, cy: 0,
    /** Springs created during a held mesh gesture (auto-repeat + release),
     *  all batched into one undo entry. */
    /** @type {any[]} */ batch: []
  },
  /** Balls spawned during a held Spawn-tool gesture (auto-spam). Batched
   *  into a single undo entry. */
  /** @type {any[]} */ autoSpawned: []
};

/** Default mesh radius when user Ctrl-clicks without dragging. */
export const MESH_MIN_R = 120;

export function meshRadius() {
  return Math.max(MESH_MIN_R, Math.hypot(mouse.wx - mouse.mesh.cx, mouse.wy - mouse.mesh.cy));
}

// Live shift tracking so the auto-repeat + hub-link features react the
// moment the user presses or releases Shift, instead of only at click
// time (mousedown sampled e.shiftKey but never updated after).
addEventListener('keydown', e => { if (e.key === 'Shift') mouse.shift = true; });
addEventListener('keyup',   e => { if (e.key === 'Shift') mouse.shift = false; });
// The window can lose focus while Shift is down (alt-tab, cmd-tab). Any
// re-focus clears the stale state so the user isn't stuck in auto-repeat.
addEventListener('blur', () => { mouse.shift = false; });

/* ------------------------------------------------------------------ */
/*  Auto-repeat gestures — hold mouse to keep firing                    */
/* ------------------------------------------------------------------ */
/* Three separate timers, all ticked from loop.js each frame. They let
 * the user hold the mouse button to repeat the gesture they just
 * committed, instead of clicking dozens of times:
 *   - Link tool:  shift+hold over a target → spam reinforcement strands
 *   - Link tool:  Ctrl+hold → keep re-committing the mesh at current radius
 *   - Spawn tool: hold without dragging → keep spawning balls at cursor
 */
let _autoLinkT  = 0;
let _autoMeshT  = 0;
let _spawnHoldT = 0;
let _spawnBurstT = 0;
/** 120 ms / 180 ms / 150 ms — chosen so each gesture gives good control
 *  (roughly 6-8 events/sec, fast enough to be productive, slow enough
 *  that the user can release at a specific count). */
const AUTO_LINK_INTERVAL   = 0.12;
const AUTO_MESH_INTERVAL   = 0.18;
const SPAWN_HOLD_DELAY     = 0.22;
const SPAWN_BURST_INTERVAL = 0.15;

export function tickMouse(dt) {
  const tool = getTool();

  // (1) Shift+hold over a target ball → auto-reinforce.
  if (mouse.down && mouse.shift && mouse.linkFirst && tool === 'link' && !mouse.mesh.active) {
    const hit = ballAt(mouse.wx, mouse.wy);
    if (hit && hit !== mouse.linkFirst) {
      _autoLinkT += dt;
      if (_autoLinkT >= AUTO_LINK_INTERVAL) {
        _autoLinkT = 0;
        mouse.chainSprings.push(createLink(mouse.linkFirst, hit));
      }
    } else {
      _autoLinkT = 0;
    }
  } else {
    _autoLinkT = 0;
  }

  // (2) Ctrl+hold auto-mesh → commit the mesh at current radius on each
  // interval tick, so repeated holding keeps piling up reinforcement.
  if (mouse.down && mouse.mesh.active && mouse.mesh.source && tool === 'link') {
    _autoMeshT += dt;
    if (_autoMeshT >= AUTO_MESH_INTERVAL) {
      _autoMeshT = 0;
      commitMesh(mouse.mesh.batch);
    }
  } else {
    _autoMeshT = 0;
  }

  // (3) Shift-held Spawn hold-to-paint. Explicit gate: paint only
  // activates when Shift is held. Plain click/drag keeps its classic
  // behavior (single on click, slingshot on drag) unaffected. Shift+
  // quick-click-release still fires the burst-of-10 via the mouseup
  // handler; Shift+hold-long-enough activates paint and suppresses
  // the release behavior.
  if (mouse.down && !mouse.grab && mouse.shift && tool === 'spawn') {
    _spawnHoldT += dt;
    if (_spawnHoldT >= SPAWN_HOLD_DELAY) {
      _spawnBurstT += dt;
      if (_spawnBurstT >= SPAWN_BURST_INTERVAL) {
        _spawnBurstT = 0;
        const b = spawnBall(mouse.wx, mouse.wy);
        if (b) {
          // Small random kick so piled balls don't stack perfectly
          b.vx += rand(-25, 25);
          b.vy += rand(-25, 25);
          mouse.autoSpawned.push(b);
        }
      }
    }
  } else {
    _spawnHoldT = 0;
    _spawnBurstT = 0;
  }
}

/** Commit a mesh at the current radius, pushing newly-created springs
 *  into the provided batch array (for end-of-gesture undo). Shared by
 *  the mouseup path and the Ctrl-hold auto-repeat.                    */
function commitMesh(batch) {
  const src = mouse.mesh.source;
  if (!src) return;
  const cx = mouse.mesh.cx, cy = mouse.mesh.cy;
  const r  = meshRadius();
  const r2 = r * r;
  for (const other of balls) {
    if (other === src) continue;
    const dx = other.x - cx, dy = other.y - cy;
    if (dx * dx + dy * dy > r2) continue;
    batch.push(createLink(src, other));
  }
}

/** Build a spring between two balls with reinforcement-aware attachment
 *  offsets. Pushes the spring to W.springs, plays the click, returns it. */
function createLink(a, b) {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  let existing = 0;
  for (const sp of W.springs) {
    if ((sp.a === a && sp.b === b) || (sp.a === b && sp.b === a)) existing++;
  }
  const baseA = Math.atan2(b.y - a.y, b.x - a.x) - a.angle;
  const baseB = Math.atan2(a.y - b.y, a.x - b.x) - b.angle;
  const k = (existing + 1) >> 1;
  const fan = (existing === 0) ? 0
            : (existing % 2 === 1 ? k : -k) * 0.22;
  const s = new Spring(a, b, d, 0.6, 0.1, baseA + fan, baseB - fan);
  W.springs.push(s);
  Snd.spring();
  return s;
}

/** Undo helper: remove a batch of spawn handles. A soft handle is just
 *  nodes[0] of its blob — undoing it must tear down the whole body, not
 *  splice one node and leave the rest to the next physics step's cull. */
function removeSpawned(batch) {
  for (const b of batch) {
    if (b.soft) { destroySoftBody(b.soft); continue; }
    const i = balls.indexOf(b);
    if (i >= 0) balls.splice(i, 1);
  }
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  Snd.init();
  mouse.shift = e.shiftKey;
  mouse.x = e.clientX; mouse.y = e.clientY;
  const wc = screenToWorld(mouse.x, mouse.y);
  mouse.wx = wc.x; mouse.wy = wc.y;
  mouse.sx = mouse.x; mouse.sy = mouse.y;
  mouse.wsx = mouse.wx; mouse.wsy = mouse.wy;

  if (e.button === 1) { mouse.middle = true; return; }
  if (e.button === 2) { mouse.right = true; explode(mouse.wx, mouse.wy, 900, 240); return; }
  mouse.down = true;

  const TOOL = getTool();

  if (TOOL === 'grab' || TOOL === 'pin') {
    const b = ballAt(mouse.wx, mouse.wy);
    if (b) {
      if (TOOL === 'pin') {
        const was = b.pinned;
        b.pinned = !b.pinned;
        b.vx = b.vy = b.omega = 0;
        Snd.click();
        pushUndo(() => { b.pinned = was; });
      } else {
        mouse.grab = b;
        b.grabbed = true;
      }
      return;
    }
  }

  if (TOOL === 'spawn') {
    const b = ballAt(mouse.wx, mouse.wy);
    if (b) { mouse.grab = b; b.grabbed = true; return; }
  }

  if (TOOL === 'link') {
    // Ctrl-click: auto-mesh mode. Commits on mouseup. If the user just
    // clicks without dragging, the minimum radius (MESH_MIN_R) is used;
    // if they drag outward, the radius grows to the drag distance.
    if (e.ctrlKey || e.metaKey) {
      const b = ballAt(mouse.wx, mouse.wy);
      if (b) {
        mouse.mesh.active = true;
        mouse.mesh.source = b;
        mouse.mesh.cx = mouse.wx;
        mouse.mesh.cy = mouse.wy;
      }
      return;
    }
    const b = ballAt(mouse.wx, mouse.wy);
    if (!b) {
      // Click on empty space cancels an in-progress source selection.
      if (mouse.linkFirst) mouse.linkFirst = null;
      return;
    }
    if (mouse.linkFirst === b) {
      // Clicking the source itself cancels the selection.
      mouse.linkFirst = null;
      return;
    }
    if (mouse.linkFirst) {
      // Explicit click-to-link: push its own undo entry immediately.
      const s = createLink(mouse.linkFirst, b);
      pushUndo(() => {
        const i = W.springs.indexOf(s);
        if (i >= 0) W.springs.splice(i, 1);
      });
      // Shift held → keep source for rapid reinforcement / spoke-linking.
      if (!mouse.shift) mouse.linkFirst = null;
      return;
    }
    mouse.linkFirst = b;
    return;
  }

  if (TOOL === 'erase') {
    const b = ballAt(mouse.wx, mouse.wy);
    if (b) {
      // A soft node is part of one body — erase the whole blob NOW (the
      // physics-step cull doesn't run while paused, so removing a single
      // node here left a fully-rendered ghost blob until unpause).
      if (b.soft) { destroySoftBody(b.soft); Snd.click(); return; }
      const i = balls.indexOf(b);
      if (i >= 0) balls.splice(i, 1);
      W.springs = W.springs.filter(s => s.a !== b && s.b !== b);
      W.constraints = W.constraints.filter(c => c.a !== b);
      Snd.click();
      return;
    }
    const wi = wallAt(mouse.wx, mouse.wy);
    if (wi >= 0) { W.walls.splice(wi, 1); Snd.click(); return; }
    return;
  }

  if (TOOL === 'draw') {
    mouse.draw.active = true;
    mouse.draw.x1 = mouse.wx;
    mouse.draw.y1 = mouse.wy;
  }
});

// mousemove + mouseup listen on `window`, not `canvas`. If a user drags a
// ball outside the canvas (onto a panel) and releases, the canvas-only
// handler would never fire mouseup — leaving `mouse.down`, `mouse.grab`,
// and tool-hold forces stuck on forever until a new click. Listening on
// window catches releases anywhere on the page.
addEventListener('mousemove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  const wc = screenToWorld(mouse.x, mouse.y);
  mouse.wx = wc.x; mouse.wy = wc.y;
  if (mouse.middle) {
    cam.tx += -e.movementX / cam.zoom;
    cam.ty += -e.movementY / cam.zoom;
  }

  // Drag-chain linking: while holding the mouse in Link tool with a
  // source ball selected, entering any new ball auto-links it and
  // advances the source. Lets the user chain-link dozens of balls in
  // one continuous stroke — press on A, drag through B-C-D-E, release.
  if (mouse.down && mouse.linkFirst && getTool() === 'link') {
    const hit = ballAt(mouse.wx, mouse.wy);
    if (hit && hit !== mouse.linkFirst) {
      const s = createLink(mouse.linkFirst, hit);
      mouse.chainSprings.push(s);
      mouse.linkFirst = hit;
    }
  }
});

addEventListener('mouseup', e => {
  if (e.button === 1) { mouse.middle = false; return; }
  if (e.button === 2) { mouse.right  = false; return; }
  // Only run release logic if a canvas mousedown started this gesture.
  // Since this listener is on `window` (so drag-off-canvas still releases
  // properly), it also fires on button / panel clicks — and we don't want
  // clicking the Link button to trigger a spawn-release that shoots a ball.
  if (!mouse.down) return;
  mouse.down = false;

  const TOOL = getTool();

  if (mouse.grab) {
    const dx = mouse.wx - mouse.grab.x;
    const dy = mouse.wy - mouse.grab.y;
    mouse.grab.vx += dx * 10;
    mouse.grab.vy += dy * 10;
    mouse.grab.grabbed = false;
    mouse.grab = null;
    return;
  }

  // If the user just completed a drag-chain of links, collapse every
  // strand they drew into a single undo entry so one Ctrl-Z removes
  // the whole chain (rather than requiring N presses for N links).
  if (TOOL === 'link' && mouse.chainSprings.length) {
    const chain = mouse.chainSprings.slice();
    mouse.chainSprings.length = 0;
    pushUndo(() => {
      for (const sp of chain) {
        const i = W.springs.indexOf(sp);
        if (i >= 0) W.springs.splice(i, 1);
      }
    });
    return;
  }

  // Ctrl-click auto-mesh: commit one final mesh at release, plus any
  // auto-repeat meshes that fired during the hold. Whole held gesture
  // batches into one undo entry.
  if (TOOL === 'link' && mouse.mesh.active && mouse.mesh.source) {
    commitMesh(mouse.mesh.batch);
    const created = mouse.mesh.batch.slice();
    mouse.mesh.batch.length = 0;
    mouse.mesh.active = false;
    mouse.mesh.source = null;
    if (created.length) {
      pushUndo(() => {
        for (const sp of created) {
          const i = W.springs.indexOf(sp);
          if (i >= 0) W.springs.splice(i, 1);
        }
      });
    }
    return;
  }

  if (TOOL === 'draw' && mouse.draw.active) {
    const dx = mouse.wx - mouse.draw.x1;
    const dy = mouse.wy - mouse.draw.y1;
    if (dx * dx + dy * dy > 100) {
      const wall = { x1: mouse.draw.x1, y1: mouse.draw.y1, x2: mouse.wx, y2: mouse.wy };
      W.walls.push(wall);
      Snd.click();
      pushUndo(() => {
        const i = W.walls.indexOf(wall);
        if (i >= 0) W.walls.splice(i, 1);
      });
    }
    mouse.draw.active = false;
    return;
  }

  if (TOOL === 'spawn') {
    // If the user was holding in place (auto-spam fired balls during
    // the hold), just batch-undo those and skip the normal release
    // logic — otherwise the mouseup would spawn one extra ball.
    if (mouse.autoSpawned.length) {
      const batch = mouse.autoSpawned.slice();
      mouse.autoSpawned.length = 0;
      pushUndo(() => removeSpawned(batch));
      return;
    }

    const dx = mouse.wsx - mouse.wx;
    const dy = mouse.wsy - mouse.wy;
    const d = len(dx, dy);
    /** Track every ball spawned in this release so Ctrl-Z undoes them as a batch. */
    const spawned = [];
    if (d < 5) {
      if (mouse.shift) {
        for (let i = 0; i < 10; i++) {
          const b = spawnBall(mouse.wx + rand(-20, 20), mouse.wy + rand(-20, 20));
          if (b) spawned.push(b);
        }
      } else {
        const b = spawnBall(mouse.wsx, mouse.wsy);
        if (b) spawned.push(b);
      }
    } else {
      const b = spawnBall(mouse.wsx, mouse.wsy);
      // kickBall, not a bare vx/vy set: for soft materials spawnBall returns
      // ONE node of the blob — the launch must reach the whole body.
      if (b) { kickBall(b, dx * 6, dy * 6); spawned.push(b); }
    }
    if (spawned.length) {
      pushUndo(() => removeSpawned(spawned));
    }
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const oldZoom = cam.tz;
  const newZoom = clamp(cam.tz * factor, 0.3, 5);
  const wb = screenToWorld(e.clientX, e.clientY);
  cam.tz = newZoom;
  cam.tx += (wb.x - cam.tx) * (1 - oldZoom / newZoom);
  cam.ty += (wb.y - cam.ty) * (1 - oldZoom / newZoom);
}, { passive: false });
