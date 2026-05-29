/**
 * Scene smoke test — loads every real scene under the browser shim and steps
 * the real `physicsStep` for a few seconds, asserting nothing throws and no
 * value ever goes NaN/Infinity. Exercises flippers, pegs, springs, pendulum
 * constraints, vortex/solar fields, buoyancy, magnetism and conveyors against
 * the new contact solver.
 *
 * Run: node tests/scenes.test.mjs
 */
import './shim.mjs';
import { W } from '../src/core/world.js';
import { PHYS } from '../src/core/config.js';
import { balls } from '../src/entities/ball.js';
import { particles } from '../src/entities/particles.js';
import { physicsStep } from '../src/physics/step.js';
import { loadScene, SCENE_NAMES } from '../src/scenes/index.js';

const DT = 1 / 240;
let failed = 0;

W.cw = 1280; W.ch = 800;
PHYS.paused = false; PHYS.slowmo = 1;

function badNum(v) { return !Number.isFinite(v); }

console.log('\n=== Sphere Lab scene smoke test ===\n');

for (const name of SCENE_NAMES) {
  let err = null, nanAt = -1, peak = 0;
  try {
    W.cw = 1280; W.ch = 800;
    loadScene(name);
    for (let i = 0; i < 240 * 3; i++) {
      physicsStep(DT);
      peak = Math.max(peak, balls.length);
      if (i % 40 === 0) {
        for (const b of balls) {
          if (badNum(b.x) || badNum(b.y) || badNum(b.vx) || badNum(b.vy) || badNum(b.omega) || badNum(b.r)) { nanAt = i; break; }
        }
        if (nanAt >= 0) break;
      }
    }
  } catch (e) { err = e; }

  if (err) { failed++; console.error(`  ✗ ${name.padEnd(11)} threw: ${err.message}`); }
  else if (nanAt >= 0) { failed++; console.error(`  ✗ ${name.padEnd(11)} produced NaN at step ${nanAt}`); }
  else console.log(`  ✓ ${name.padEnd(11)} ok  (balls peak ${peak}, end ${balls.length}, particles ${particles.length})`);
}

console.log(`\n${failed === 0 ? '✓ ALL SCENES OK' : '✗ ' + failed + ' SCENE(S) FAILED'}`);
if (failed) process.exit(1);
