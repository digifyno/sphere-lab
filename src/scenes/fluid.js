/** Fluid — a dam break. A tall column of water held against the left wall is
 *  released on load: it collapses, surges across the tank, slaps the far wall
 *  and sloshes back. Water drops don't merge — they flow as a particle fluid
 *  (surface-tension cohesion + viscosity + rigid incompressibility). */

import { W, addBox, setGravityUI } from '../core/world.js';
import { rand } from '../core/math.js';
import { Ball, balls } from '../entities/ball.js';
import { MATERIALS } from '../entities/materials.js';

export default function fluid() {
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);

  const floorY = W.ch - pad;
  const r = 9;
  const step = 2 * r - 1;
  const x0 = pad + r + 3;
  const cols = Math.floor((W.cw - pad * 2) * 0.30 / step);

  let placed = 0;
  for (let row = 0; placed < 190; row++) {
    const y = floorY - r - row * step;
    if (y < pad + r) break;
    for (let c = 0; c < cols && placed < 190; c++) {
      balls.push(new Ball(x0 + c * step + rand(-0.5, 0.5), y, r, MATERIALS.water));
      placed++;
    }
  }

  W.bgColor1 = '#06121e';
  W.bgColor2 = '#02060c';
  setGravityUI(true, 900);
}
