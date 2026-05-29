/**
 * Scene registry + `loadScene(name)` entry point.
 *
 * To add a new scene:
 *   1. Drop a file in this directory whose default export is a (no-arg) builder.
 *   2. Import it below and add to SCENES + LABELS.
 *   3. Add `<button class="tab" data-scene="NAME">Label</button>` to index.html.
 *   4. (Optional) add a tagline to `src/ui/sceneTitle.js`.
 */

import { W, cam, clearWorld } from '../core/world.js';
import { clearContactCache } from '../physics/contactSolver.js';
import { showSceneTitle } from '../ui/sceneTitle.js';

import sandbox   from './sandbox.js';
import billiards from './billiards.js';
import plinko    from './plinko.js';
import cradle    from './cradle.js';
import vortex    from './vortex.js';
import tower     from './tower.js';
import galton    from './galton.js';
import pinball   from './pinball.js';
import cloth     from './cloth.js';
import domino    from './domino.js';
import solar     from './solar.js';
import rain      from './rain.js';
import jelly     from './jelly.js';
import water     from './water.js';
import magnets   from './magnets.js';
import avalanche from './avalanche.js';
import conveyor  from './conveyor.js';
import chaos     from './chaos.js';
import orbits    from './orbits.js';
import fluid     from './fluid.js';
import sandpile  from './sandpile.js';
import balloons  from './balloons.js';

/** @type {Record<string, () => void>} */
const SCENES = {
  sandbox, billiards, plinko, cradle, vortex, tower, galton, pinball,
  cloth, domino, solar, rain, jelly, water, magnets, avalanche, conveyor, chaos,
  orbits, fluid, sandpile, balloons
};

export const SCENE_NAMES = Object.keys(SCENES);

const LABELS = {
  sandbox: 'Sandbox', billiards: 'Billiards', plinko: 'Plinko', cradle: 'Cradle',
  vortex: 'Vortex', tower: 'Tower', galton: 'Galton', pinball: 'Pinball',
  cloth: 'Cloth', domino: 'Domino', solar: 'Solar', rain: 'Rain',
  jelly: 'Jelly', water: 'Water', magnets: 'Magnets',
  avalanche: 'Avalanche', conveyor: 'Conveyor', chaos: 'Chaos',
  orbits: 'Orbits', fluid: 'Fluid', sandpile: 'Sandpile', balloons: 'Balloons'
};

export function loadScene(name) {
  clearWorld();
  clearContactCache();
  W.scene = name;
  W.rainSpawn = false;

  cam.tx = W.cw / 2; cam.ty = W.ch / 2; cam.tz = 1;
  cam.x  = W.cw / 2; cam.y  = W.ch / 2; cam.zoom = 1;

  (SCENES[name] || sandbox)();

  const label = LABELS[name] || name;
  document.getElementById('stat-scene').textContent = label;
  document.querySelectorAll('#top .tab')
    .forEach(b => b.classList.toggle('active', b.dataset.scene === name));
  showSceneTitle(name, label);
}
