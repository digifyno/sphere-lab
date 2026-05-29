/** Balloons — helium lift in action. Six balloons are tethered to floor anchors
 *  and float straight up until their strings go taut (bobbing like inverted
 *  pendulums); a crowd of free balloons rises and collects against the ceiling;
 *  heavy steel balls sit on the floor for contrast. Pop one with Erase, or cut
 *  a string and watch it escape. */

import { W, addBox, setGravityUI } from '../core/world.js';
import { rand } from '../core/math.js';
import { Ball, balls } from '../entities/ball.js';
import { MATERIALS } from '../entities/materials.js';

export default function balloons() {
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;

  // tethered balloons — anchored to the floor by a distance constraint (string)
  for (let i = 0; i < 6; i++) {
    const ax = W.cw * (0.16 + i * 0.135);
    const len = rand(W.ch * 0.40, W.ch * 0.62);
    const b = new Ball(ax + rand(-8, 8), floorY - len, rand(16, 22), MATERIALS.balloon);
    balls.push(b);
    W.constraints.push({ a: b, ax, ay: floorY, len });
  }

  // free balloons — rise and pool at the ceiling
  for (let i = 0; i < 12; i++) {
    balls.push(new Ball(rand(pad + 40, W.cw - pad - 40), floorY - rand(20, 160), rand(12, 20), MATERIALS.balloon));
  }

  // heavy steel for contrast — stays planted on the floor
  for (let i = 0; i < 5; i++) {
    balls.push(new Ball(rand(pad + 70, W.cw - pad - 70), floorY - 20, 18, MATERIALS.steel));
  }

  W.bgColor1 = '#101a2e';
  W.bgColor2 = '#05080f';
  setGravityUI(true, 900);
}
