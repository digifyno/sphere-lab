/**
 * Headless physics invariant tests — runs the REAL `physicsStep` under a
 * browser shim and asserts the properties a good solver must keep:
 *   - no NaNs ever
 *   - momentum conserved in free-space collisions (drag off)
 *   - restitution never *adds* kinetic energy
 *   - stacks settle without sinking/jitter/explosion
 *   - packed boxes stay bounded (energy doesn't blow up)
 *   - momentum propagates through a Newton's-cradle line
 *
 * Run: node tests/sim.test.mjs
 */
import './shim.mjs';
import { W, addBox, clearWorld } from '../src/core/world.js';
import { PHYS } from '../src/core/config.js';
import { balls, Ball } from '../src/entities/ball.js';
import { MATERIALS } from '../src/entities/materials.js';
import { physicsStep } from '../src/physics/step.js';
import { clearContactCache } from '../src/physics/contactSolver.js';

const DT = 1 / 240;
let passed = 0, failed = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; fails.push(msg); console.error('  ✗ ' + msg); }
}

function reset(opts = {}) {
  clearWorld();
  clearContactCache();
  W.cw = 1200; W.ch = 800; W.scene = 'sandbox'; W.rainSpawn = false;
  PHYS.gravityOn = opts.gravity ?? true;
  PHYS.gravity = 900;
  PHYS.drag = opts.drag ?? 0.05;
  PHYS.magnus = 0.6; PHYS.wind = 0;
  PHYS.restitutionMul = 1; PHYS.frictionMul = 0.5;
  PHYS.slowmo = 1; PHYS.paused = false;
  PHYS.solverVel = 8; PHYS.solverPos = 3; PHYS.warmStart = true;
}

function run(steps) { for (let i = 0; i < steps; i++) physicsStep(DT); }

function noNaN(label) {
  for (const b of balls) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y) ||
        !Number.isFinite(b.vx) || !Number.isFinite(b.vy) || !Number.isFinite(b.omega)) {
      return false;
    }
  }
  return true;
}
function totalKE() { let k = 0; for (const b of balls) k += b.kineticEnergy(); return k; }
function maxSpeed() { let m = 0; for (const b of balls) m = Math.max(m, Math.hypot(b.vx, b.vy)); return m; }
/** Total mechanical energy: kinetic + gravitational potential (ref = W.ch).
 *  A dissipative system with no energy source can only ever lose this. */
function totalEnergy() {
  let e = 0;
  for (const b of balls) e += b.kineticEnergy() + b.mass * PHYS.gravity * (W.ch - b.y);
  return e;
}

// ───────────────────────────── A: head-on elastic ─────────────────────────
function testHeadOn() {
  console.log('A. head-on collision (momentum + energy)');
  reset({ gravity: false, drag: 0 });
  const a = new Ball(560, 400, 20, MATERIALS.steel); a.vx = 240;
  const b = new Ball(640, 400, 20, MATERIALS.steel); b.vx = -240;
  balls.push(a, b);
  const p0 = a.mass * a.vx + b.mass * b.vx;
  const ke0 = totalKE();
  run(80);
  ok(noNaN(), 'A: no NaN');
  const p1 = a.mass * a.vx + b.mass * b.vx;
  ok(Math.abs(p1 - p0) < 1e-3, `A: momentum conserved (Δ=${(p1 - p0).toExponential(2)})`);
  ok(totalKE() <= ke0 + 1e-6, `A: KE not gained (${totalKE().toFixed(1)} ≤ ${ke0.toFixed(1)})`);
  ok(b.x - a.x >= 39.9, `A: balls separated (gap=${(b.x - a.x).toFixed(1)})`);
  ok(a.vx < 0 && b.vx > 0, `A: velocities reversed (a=${a.vx.toFixed(0)}, b=${b.vx.toFixed(0)})`);
}

// ───────────────────────────── B: resting contacts settle ─────────────────
function testStackSettles() {
  console.log('B. resting contacts settle + sleep (no energy injection)');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;
  const r = 20;

  // B1: a single dropped ball must come to rest AND sleep. Bowling (low
  // restitution) settles quickly — this tests the settle→sleep path, not a
  // material's bounciness.
  balls.push(new Ball(W.cw / 2, floorY - 200, r, MATERIALS.bowling));
  run(240 * 4);
  ok(noNaN(), 'B1: no NaN');
  ok(balls.length === 1 && balls[0].sleeping, 'B1: dropped ball fell asleep');
  ok(Math.abs((balls[0].y + r) - floorY) < 2.0, `B1: rests on floor (gap=${((balls[0].y + r) - floorY).toFixed(2)})`);

  // B2: a row of balls already resting + touching on the floor must NOT drift
  // apart or gain speed (warm-start / position-correction must be energy-free).
  reset();
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const N = 6, x0 = W.cw / 2 - (N - 1) * r;
  for (let i = 0; i < N; i++) balls.push(new Ball(x0 + i * (2 * r - 0.2), floorY - r, r, MATERIALS.steel));
  const x0Init = balls[0].x, xNInit = balls[N - 1].x;
  run(240 * 3);
  ok(noNaN(), 'B2: no NaN');
  ok(maxSpeed() < 5, `B2: resting row stays at rest (maxSpeed=${maxSpeed().toFixed(2)})`);
  const spread = (balls[N - 1].x - balls[0].x) - (xNInit - x0Init);
  ok(Math.abs(spread) < 4, `B2: row didn't blow apart or implode (Δspread=${spread.toFixed(2)})`);
  let allSleeping = true;
  for (const b of balls) if (!b.sleeping) allSleeping = false;
  ok(allSleeping, 'B2: whole row fell asleep');
}

// ───────────────────────────── C: packed box bounded ──────────────────────
function testPackedBox() {
  console.log('C. packed box stays bounded (no explosion)');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  // non-fragile, non-fluid, non-explosive materials only, so the retained-count
  // assertion cleanly detects tunnelling (no fractures/merges to confound it).
  const mats = [MATERIALS.steel, MATERIALS.rubber, MATERIALS.bowling, MATERIALS.gold];
  let n = 0;
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 10; gx++) {
    const r = 16 + (gx % 3) * 4;
    balls.push(new Ball(120 + gx * 90, 120 + gy * 70, r, mats[(gx + gy) % mats.length]));
    n++;
  }
  const eStart = totalEnergy();   // KE is ~0 here; this is the PE budget
  run(240 * 5);
  const eEnd = totalEnergy();
  ok(noNaN(), 'C: no NaN');
  ok(Number.isFinite(eEnd), 'C: energy finite');
  // Total mechanical energy can only fall (friction, drag, restitution losses).
  // A rise means the solver is *creating* energy — the classic position-
  // teleport bug we removed. Allow 1% slack for discrete-step PE/KE accounting.
  ok(eEnd <= eStart * 1.01, `C: energy never injected (start=${eStart.toFixed(0)} → end=${eEnd.toFixed(0)})`);
  // every surviving ball must remain inside the arena (allow shards a margin)
  let inside = true;
  for (const b of balls) {
    if (b.x < -50 || b.x > W.cw + 50 || b.y < -50 || b.y > W.ch + 50) inside = false;
  }
  ok(inside, 'C: no ball escaped the sealed box');
  ok(balls.length === n, `C: no tunnelling — all balls retained (${balls.length}/${n})`);
}

// ───────────────────────────── D: Newton's cradle ─────────────────────────
function testCradle() {
  console.log("D. Newton's-cradle momentum transfer");
  reset({ gravity: false, drag: 0 });
  const r = 20, y = 400, N = 5;
  const startX = 400;
  const line = [];
  for (let i = 0; i < N; i++) {
    const b = new Ball(startX + i * (2 * r - 0.3), y, r, MATERIALS.steel);
    line.push(b); balls.push(b);
  }
  line[0].vx = 320;
  const p0 = balls.reduce((s, b) => s + b.mass * b.vx, 0);
  const ke0 = totalKE();
  run(40);
  ok(noNaN(), 'D: no NaN');
  const p1 = balls.reduce((s, b) => s + b.mass * b.vx, 0);
  ok(Math.abs(p1 - p0) < 1e-2, `D: momentum conserved (Δ=${(p1 - p0).toExponential(2)})`);
  ok(totalKE() <= ke0 + 1e-6, `D: KE not gained (${totalKE().toFixed(1)} ≤ ${ke0.toFixed(1)})`);
  const last = line[N - 1], first = line[0];
  ok(last.vx > first.vx, `D: momentum moved down the line (last=${last.vx.toFixed(0)} > first=${first.vx.toFixed(0)})`);
  const ratio = last.vx / 320;
  console.log(`   cradle transfer ratio: ${(ratio * 100).toFixed(0)}% of input speed reached the far ball`);
  ok(ratio > 0.30, `D: meaningful transfer to far ball (ratio=${ratio.toFixed(2)})`);
}

// ───────────────────────────── run all ────────────────────────────────────
console.log('\n=== Sphere Lab physics invariants ===\n');
testHeadOn();
testStackSettles();
testPackedBox();
testCradle();
console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('   - ' + f); process.exit(1); }
