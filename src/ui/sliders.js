/**
 * Wire up the right-sidebar numeric sliders → `PHYS` config.
 * Changes to slider values are persisted where appropriate.
 */

import { PHYS } from '../core/config.js';
import { Snd } from '../audio/sound.js';
import { savePref } from '../core/persistence.js';

export function bindSliders() {
  const bind = (id, vId, setVal, fmt, onChange) => {
    const s = /** @type {HTMLInputElement} */ (document.getElementById(id));
    const v = document.getElementById(vId);
    s.addEventListener('input', () => {
      const raw = parseFloat(s.value);
      setVal(raw);
      v.textContent = fmt(raw);
      if (onChange) onChange(raw);
    });
  };

  bind('s-g', 'v-g', v => PHYS.gravity        = v,       v => String(Math.round(v)));
  bind('s-d', 'v-d', v => PHYS.drag           = v / 100, v => (v / 100).toFixed(2));
  bind('s-e', 'v-e', v => PHYS.restitutionMul = v / 100, v => (v / 100).toFixed(2));
  bind('s-f', 'v-f', v => PHYS.frictionMul    = v / 100, v => (v / 100).toFixed(2));
  bind('s-m', 'v-m', v => PHYS.magnus         = v / 100, v => (v / 100).toFixed(2));
  bind('s-r', 'v-r', v => PHYS.spawnRadius    = v,       v => String(Math.round(v)));
  bind('s-w', 'v-w', v => PHYS.wind           = v,       v => String(Math.round(v)));
  bind('s-solver', 'v-solver',
    v => PHYS.solverVel = v,
    v => String(Math.round(v)),
    v => savePref('solver', v));

  bind('s-vol', 'v-vol',
    v => PHYS.volume = v / 100,
    v => String(Math.round(v)),
    v => { Snd.applyVolume(); savePref('volume', PHYS.volume); }
  );
}
