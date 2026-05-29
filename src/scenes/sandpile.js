/** Sandpile — a tall narrow column of sand grains dropped in the centre. With
 *  sand's very high friction + heavy rolling resistance it collapses into a
 *  cone and holds a steep angle of repose instead of flowing flat — the
 *  granular counterpart to the Fluid scene, and a stress test the warm-started
 *  solver passes where the old teleport-separation jittered piles apart. */

import { W, addBox, setGravityUI } from '../core/world.js';
import { rand } from '../core/math.js';
import { Ball, balls } from '../entities/ball.js';
import { MATERIALS } from '../entities/materials.js';

export default function sandpile() {
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);

  const floorY = W.ch - pad;
  const r = 8;
  const step = 2 * r - 1;
  const cx = W.cw / 2;
  const colCount = 5;

  let placed = 0;
  for (let row = 0; placed < 170; row++) {
    const y = floorY - r - row * step;
    if (y < pad + r) break;
    for (let c = 0; c < colCount && placed < 170; c++) {
      const x = cx + (c - (colCount - 1) / 2) * step + rand(-0.5, 0.5);
      balls.push(new Ball(x, y, r, MATERIALS.sand));
      placed++;
    }
  }

  W.bgColor1 = '#171206';
  W.bgColor2 = '#080602';
  setGravityUI(true, 900);
}
