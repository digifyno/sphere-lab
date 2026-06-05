/** Empty walled arena. The default scene. */

import { W, addBox, setGravityUI } from '../core/world.js';

export default function sandbox() {
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  W.bgColor1 = '#0b1324';
  W.bgColor2 = '#02040b';
  // Route through setGravityUI like every other scene: resets PHYS.gravity to
  // the default (overwriting a leftover 0 from a prior zero-g scene), syncs the
  // s-g slider + gravity button, and wakes carried-over balls.
  setGravityUI(true, 900);
}
