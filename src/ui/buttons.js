/**
 * Wire up scene tabs, tool grid, action buttons, visual toggles, theme
 * swatches, and the save/load/snapshot buttons.
 *
 * Called once at init from `src/main.js`.
 */

import { PHYS } from '../core/config.js';
import { W, cam, setGravityUI } from '../core/world.js';
import { balls } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { loadScene } from '../scenes/index.js';
import { setTool } from '../input/tools.js';
import { updatePauseBtn, updateSlowmoBtn, updateToggle } from './hud.js';
import { undo } from '../core/undo.js';
import { applyTheme } from '../core/theme.js';
import { savePref } from '../core/persistence.js';
import { saveState, loadState, screenshot } from './save.js';

export function bindButtons() {
  // scene tabs
  document.querySelectorAll('#top .tab').forEach(b => { b.onclick = () => loadScene(b.dataset.scene); });

  // tool grid
  document.querySelectorAll('#tool-row .tool').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });

  // action buttons
  document.getElementById('btn-clear').onclick = () => {
    // Also wipe constraints — otherwise a cradle / chaos / cloth scene
    // holds dead Ball refs in W.constraints after clearing balls, and
    // the solver pulls on phantoms.
    balls.length = 0; particles.length = 0;
    W.springs.length = 0; W.constraints.length = 0;
  };
  document.getElementById('btn-pause').onclick  = () => { PHYS.paused = !PHYS.paused; updatePauseBtn(); };
  document.getElementById('btn-slowmo').onclick = () => {
    PHYS.slowmo = PHYS.slowmo === 1 ? 0.15 : 1;
    updateSlowmoBtn();
  };
  document.getElementById('btn-gravity').onclick   = () => { PHYS.gravityOn = !PHYS.gravityOn; setGravityUI(PHYS.gravityOn); };
  document.getElementById('btn-reset-cam').onclick = () => { cam.tx = W.cw / 2; cam.ty = W.ch / 2; cam.tz = 1; };
  document.getElementById('btn-undo').onclick      = () => { undo(); };

  // settings — theme dots
  document.querySelectorAll('.theme-dot').forEach(el => {
    el.addEventListener('click', () => applyTheme(el.getAttribute('data-theme')));
  });

  // settings — save / load / snapshot
  document.getElementById('btn-snapshot').onclick = () => screenshot();
  document.getElementById('btn-save').onclick     = () => saveState();
  document.getElementById('btn-load').onclick     = () => loadState();

  // visual toggles → PHYS boolean flag + persistence
  const toggles = [
    ['t-bloom',      'bloom'],
    ['t-shadow',     'shadow'],
    ['t-blur',       'motionBlur'],
    ['t-trail',      'trails'],
    ['t-vec',        'showVec'],
    ['t-sound',      'sound'],
    ['t-refract',    'refract'],
    ['t-heat',       'heatFx'],
    ['t-ao',         'ao'],
    ['t-aberration', 'aberration'],
    ['t-grain',      'grain'],
    ['t-streaks',    'streaks'],
    ['t-flare',      'flare'],
    ['t-fire',       'fire'],
    ['t-warm',       'warmStart']
  ];
  for (const [id, k] of toggles) {
    const b = document.getElementById(id);
    b.onclick = () => {
      PHYS[k] = !PHYS[k];
      updateToggle(id, PHYS[k]);
      savePref(id, PHYS[k]);
    };
  }

  // help overlay
  document.getElementById('help-btn').onclick = () => document.getElementById('help').classList.add('show');
  document.getElementById('help').addEventListener('click', e => {
    if (e.target.id === 'help') e.currentTarget.classList.remove('show');
  });

  // Collapsible side panels. Each panel has a small × to hide it; an edge
  // handle appears to reopen. State persists between sessions so the user's
  // preferred layout sticks.
  for (const side of ['left', 'right']) {
    const panel  = document.getElementById(`panel-${side}`);
    const close  = document.getElementById(`panel-${side}-close`);
    const open   = document.getElementById(`panel-${side}-open`);
    close.onclick = () => setPanelOpen(side, false);
    open.onclick  = () => setPanelOpen(side, true);
  }
}

/** Collapse or reveal a side panel + persist the choice. */
export function setPanelOpen(side, isOpen) {
  const panel = document.getElementById(`panel-${side}`);
  const handle = document.getElementById(`panel-${side}-open`);
  if (!panel || !handle) return;
  if (isOpen) {
    panel.classList.remove('collapsed');
    handle.classList.remove('show');
  } else {
    panel.classList.add('collapsed');
    handle.classList.add('show');
  }
  savePref(`panel-${side}-open`, isOpen ? 1 : 0);
}
