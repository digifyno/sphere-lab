/** Deformable jelly blobs (soft-body lattice + gas pressure) that flatten on
 *  impact, wobble, and pile — dropped onto an angled platform. */

import { W, addBox, setGravityUI } from '../core/world.js';
import { MATERIALS } from '../entities/materials.js';
import { buildSoftBall } from '../entities/softBody.js';

export default function jelly() {
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);

  // a few jelly blobs of varying size — they squash on landing and jiggle back
  buildSoftBall(W.cw * 0.30, 170, 46, MATERIALS.jelly);
  buildSoftBall(W.cw * 0.50, 130, 60, MATERIALS.jelly);
  buildSoftBall(W.cw * 0.70, 170, 40, MATERIALS.jelly);
  buildSoftBall(W.cw * 0.50, 320, 52, MATERIALS.jelly);

  // an angled launcher platform near the bottom
  W.walls.push({ x1: W.cw * 0.2, y1: W.ch * 0.7, x2: W.cw * 0.8, y2: W.ch * 0.78 });

  W.bgColor1 = '#101a20';
  W.bgColor2 = '#04080c';
  setGravityUI(true, 900);
}
