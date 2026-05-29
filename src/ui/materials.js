/**
 * Builds the material palette in the left sidebar. Called once at init.
 *
 * Each .mat element uses the material's own color for the swatch, with a
 * soft glow so dark materials (bowling) stay visible on the dark panel.
 */

import { MATERIALS, MAT_KEYS } from '../entities/materials.js';
import { selectedMat } from '../entities/ball.js';
import { updateMatButtons } from './hud.js';

export function buildMatButtons() {
  const wrap = document.getElementById('ball-types');
  MAT_KEYS.forEach((k, i) => {
    const m = MATERIALS[k];
    const b = document.createElement('button');
    b.className = 'mat';
    b.dataset.mat = k;
    // Only the first 9 materials have a 1-9 keyboard shortcut; past that the
    // badge would be misleading, so it's omitted.
    const hotkey = i < 9 ? `<span class="mat-hotkey">${i + 1}</span>` : '';
    b.innerHTML =
      `<span class="mat-swatch" style="background:${m.color}; box-shadow: 0 0 8px ${m.color}"></span>` +
      `<span class="mat-name">${capitalize(m.name)}</span>` +
      hotkey;
    b.onclick = () => { selectedMat.id = k; updateMatButtons(); };
    wrap.appendChild(b);
  });
  updateMatButtons();
}

function capitalize(s) {
  if (!s) return s;
  return s[0] + s.slice(1).toLowerCase();
}
