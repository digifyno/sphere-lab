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
import { balls, Ball, wake, kickBall } from '../src/entities/ball.js';
import { Spring } from '../src/entities/spring.js';
import { MATERIALS } from '../src/entities/materials.js';
import { physicsStep } from '../src/physics/step.js';
import { clearContactCache } from '../src/physics/contactSolver.js';
import { NBODY_G } from '../src/physics/forces.js';
import { buildSoftBall, destroySoftBody, softBodies, polyArea } from '../src/entities/softBody.js';
import { matVelRestScale } from '../src/physics/materialMods.js';
import { spawnFlipper } from '../src/physics/flippers.js';
import { ballAt } from '../src/input/tools.js';
import { loadScene } from '../src/scenes/index.js';
import { saveState, loadState } from '../src/ui/save.js';

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
  PHYS.restitutionMul = 1; PHYS.frictionMul = 1;
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

// ───────────────────────────── E: N-body orbit ────────────────────────────
function testOrbit() {
  console.log('E. N-body orbit stays bound');
  reset({ gravity: false, drag: 0 });
  W.nbody = true;
  const cx = 600, cy = 400, R = 250;
  const star = new Ball(cx, cy, 46, MATERIALS.gold); star.pinned = true; balls.push(star);
  const p = new Ball(cx + R, cy, 12, MATERIALS.rock);
  p.vx = 0; p.vy = Math.sqrt(NBODY_G * star.mass / R);   // circular orbit speed
  balls.push(p);
  let minD = 1e9, maxD = 0;
  for (let i = 0; i < 240 * 13; i++) {                    // ~1.1 orbital periods
    physicsStep(DT);
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (!Number.isFinite(d)) { maxD = Infinity; break; }
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
  ok(noNaN(), 'E: no NaN');
  ok(minD > 46 + 12, `E: planet never fell into the star (minD=${minD.toFixed(0)})`);
  ok(maxD < R * 1.6, `E: orbit stayed bound (maxD=${maxD.toFixed(0)} < ${(R * 1.6).toFixed(0)})`);
  console.log(`   orbit radius band: ${minD.toFixed(0)}..${maxD.toFixed(0)} px (circular R=${R})`);
}

// ───────────────────────────── F: buoyancy by density ─────────────────────
function testFloatVsSink() {
  console.log('F. wood floats, steel sinks (Archimedes by density)');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  W.waterY = W.ch * 0.5;
  const wood = new Ball(W.cw / 2 + 120, W.waterY + 130, 18, MATERIALS.wood);
  const steel = new Ball(W.cw / 2 - 120, W.waterY + 130, 18, MATERIALS.steel);
  // Rock (ρ=2.7 > water) MUST sink. This guards the buoyancy unit-scale: a
  // πr² displaced "volume" against a π-less (r²·ρ) mass scaled buoyancy by π,
  // so everything up to ρ≈3.8 wrongly floated. Rock floating ⇒ that bug is back.
  const rock = new Ball(W.cw / 2, W.waterY + 130, 18, MATERIALS.rock);
  balls.push(wood, steel, rock);
  const woodY0 = wood.y;
  run(240 * 5);
  ok(noNaN(), 'F: no NaN');
  ok(wood.y < woodY0 - 50, `F: wood rose toward the surface (${woodY0.toFixed(0)} → ${wood.y.toFixed(0)})`);
  ok(wood.y < W.waterY + 60, `F: wood floats at the surface (y=${wood.y.toFixed(0)}, surface=${W.waterY})`);
  ok(steel.y > W.waterY + 100, `F: steel sank (y=${steel.y.toFixed(0)})`);
  ok(rock.y > W.waterY + 150, `F: rock (ρ>water) sank instead of floating (y=${rock.y.toFixed(0)})`);
}

// ───────────────────────────── G: balloon lift ────────────────────────────
function testBalloonRises() {
  console.log('G. balloon rises against gravity');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const bal = new Ball(W.cw / 2, W.ch * 0.6, 16, MATERIALS.balloon);
  balls.push(bal);
  const y0 = bal.y;
  run(240 * 2);
  ok(noNaN(), 'G: no NaN');
  ok(bal.y < y0 - 40, `G: balloon floated up (${y0.toFixed(0)} → ${bal.y.toFixed(0)})`);
}

// ───────────────────────────── H: annihilation ────────────────────────────
function testAnnihilation() {
  console.log('H. matter + antimatter annihilate, blasting bystanders');
  reset({ gravity: false, drag: 0 });
  const am = new Ball(600, 400, 16, MATERIALS.antimatter);
  const st = new Ball(630, 400, 16, MATERIALS.steel);     // overlapping the antimatter
  const by = new Ball(600, 470, 14, MATERIALS.rubber);    // bystander inside the blast
  balls.push(am, st, by);
  run(3);
  ok(noNaN(), 'H: no NaN');
  ok(!balls.includes(am) && !balls.includes(st), 'H: antimatter + steel both annihilated');
  ok(balls.includes(by), 'H: bystander survived');
  ok(Math.hypot(by.vx, by.vy) > 5, `H: bystander got blasted (|v|=${Math.hypot(by.vx, by.vy).toFixed(0)})`);
}

// ───────────────────────────── I: dam break (fluid flow) ──────────────────
function damBreak(matKey) {
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad, r = 10, x0 = pad + r + 2;
  for (let row = 0; row < 16; row++)
    for (let col = 0; col < 5; col++)
      balls.push(new Ball(x0 + col * (2 * r - 0.5), floorY - r - row * (2 * r - 0.5), r, MATERIALS[matKey]));
  run(240 * 5);
  let maxX = -1e9, top = 1e9, sumY = 0;
  for (const b of balls) { maxX = Math.max(maxX, b.x); top = Math.min(top, b.y); sumY += b.y; }
  return { maxX, top, avgY: sumY / balls.length };
}
function testFluidSpreads() {
  console.log('I. water levels into a flat pool; sand heaps (fluid vs granular)');
  const water = damBreak('water');
  const sand = damBreak('sand');
  ok(noNaN(), 'I: no NaN');
  ok(Number.isFinite(water.avgY), 'I: finite');
  // water's mass settles lower (a shallow flat pool) than the steep sand heap
  ok(water.avgY > sand.avgY + 5, `I: water pools lower than sand heaps (avgY ${water.avgY.toFixed(0)} > ${sand.avgY.toFixed(0)})`);
  // and its surface is lower than the sand peak
  ok(water.top > sand.top + 20, `I: water surface below the sand peak (top ${water.top.toFixed(0)} > ${sand.top.toFixed(0)})`);
  console.log(`   water: top ${water.top.toFixed(0)}, avgY ${water.avgY.toFixed(0)}  |  sand: top ${sand.top.toFixed(0)}, avgY ${sand.avgY.toFixed(0)}`);
}

// ───────────────────────── J: high mass-ratio stack ───────────────────────
function testHeavyOnLight() {
  console.log('J. heavy-on-light stack stays stable (≈50:1 mass ratio)');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;
  const light = new Ball(W.cw / 2, floorY - 12, 12, MATERIALS.rubber);   // ~0.17
  const heavy = new Ball(W.cw / 2, floorY - 12 - 12 - 22, 22, MATERIALS.gold); // ~8.5
  balls.push(light, heavy);
  run(240 * 5);
  ok(noNaN(), 'J: no NaN');
  ok(light.y + 12 <= floorY + 2, `J: light ball not crushed through floor (gap=${((light.y + 12) - floorY).toFixed(2)})`);
  ok(heavy.y < light.y, 'J: heavy stayed on top (no penetration swap)');
  ok(maxSpeed() < 8, `J: settled despite mass ratio (maxSpeed=${maxSpeed().toFixed(2)})`);
  const overlap = (12 + 22) - Math.hypot(heavy.x - light.x, heavy.y - light.y);
  ok(overlap < 3, `J: no deep penetration (overlap=${overlap.toFixed(2)})`);
}

// ───────────────────────── K: pinned ball is support ──────────────────────
function testPinnedSupport() {
  console.log('K. a ball rests on a pinned ball (no gravity leak)');
  reset();
  const anchor = new Ball(600, 400, 26, MATERIALS.steel); anchor.pinned = true;
  const rider = new Ball(600, 400 - 26 - 18, 18, MATERIALS.steel);
  balls.push(anchor, rider);
  const ax0 = anchor.x, ay0 = anchor.y;
  run(240 * 4);
  ok(noNaN(), 'K: no NaN');
  ok(anchor.x === ax0 && anchor.y === ay0, 'K: pinned anchor never moved');
  ok(rider.y < anchor.y, 'K: rider stayed on top of the anchor');
  const overlap = (26 + 18) - Math.hypot(rider.x - anchor.x, rider.y - anchor.y);
  ok(overlap < 3 && overlap > -3, `K: rider sits on the anchor surface (overlap=${overlap.toFixed(2)})`);
}

// ───────────────────── L: spin friction dissipates ────────────────────────
function testSpinFriction() {
  console.log('L. friction dissipates (never adds) energy in a spinning contact');
  reset({ gravity: false, drag: 0 });
  // a fast-spinning ball collides into a resting one; friction acts on the big
  // tangential slip. Wrong-signed friction would *amplify* spin + inject KE.
  const a = new Ball(600, 400, 20, MATERIALS.rubber); a.vx = 80; a.omega = 40;
  const b = new Ball(639, 400, 20, MATERIALS.rubber);
  balls.push(a, b);
  const ke0 = totalKE(), spin0 = Math.abs(a.omega);
  run(120);
  ok(noNaN(), 'L: no NaN');
  ok(totalKE() <= ke0 + 1e-6, `L: KE not increased by friction (${totalKE().toFixed(0)} ≤ ${ke0.toFixed(0)})`);
  ok(Math.abs(a.omega) <= spin0 + 1e-6, `L: spin not amplified (${Math.abs(a.omega).toFixed(1)} ≤ ${spin0})`);
}

// ───────────────────── M: wake on support removal ─────────────────────────
function testWakeOnRemoval() {
  console.log('M. removing a support wakes the ball resting on it');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;
  const base = new Ball(600, floorY - 20, 20, MATERIALS.steel);
  const top = new Ball(600, floorY - 20 - 20 - 18, 18, MATERIALS.steel);
  balls.push(base, top);
  run(240 * 2);                       // let them settle + sleep
  const topY = top.y;
  base._dead = true;                  // structural removal (e.g. merge/annihilate)
  run(240 * 2);
  ok(noNaN(), 'M: no NaN');
  ok(!balls.includes(base), 'M: base removed');
  ok(top.y > topY + 20, `M: unsupported ball woke + fell (${topY.toFixed(0)} → ${top.y.toFixed(0)})`);
}

// ───────────────────── O: a dropped ball bounces repeatedly ────────────────
function testRepeatedBounce() {
  console.log('O. a dropped ball bounces more than once (support contacts must not steal the bounce)');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;
  // Steel is lively (e=0.86); it should bounce many times. The "bounces once
  // then sticks" bug was the no-restitution wall support contact zeroing the
  // approach velocity of a ball caught in the speculative margin band.
  const b = new Ball(W.cw / 2, floorY - 300, 20, MATERIALS.steel);
  balls.push(b);
  let rebounds = 0;
  for (let i = 0; i < 240 * 6; i++) {
    const vyPrev = b.vy;
    physicsStep(DT);
    if (vyPrev > 50 && b.vy < -20) rebounds++;   // was falling, now moving up = a real bounce
    if (b.sleeping) break;
  }
  ok(noNaN(), 'O: no NaN');
  ok(rebounds >= 3, `O: ball rebounded repeatedly, not just once (rebounds=${rebounds})`);
}

// ───────────────────── N: hot plasma can't inject energy ───────────────────
function testHotPlasmaNoGain() {
  console.log('N. hot plasma bounce never gains energy (restitution capped at 1)');
  reset({ gravity: false, drag: 0 });
  PHYS.heatFx = true;
  // heatRestMod boosts plasma restitution by up to 1.2× per ball; two hot
  // plasma balls would give a combined e>1 (separating faster than approaching)
  // and pump KE every bounce. The solver clamps e≤1, so KE must not rise.
  const a = new Ball(600, 400, 20, MATERIALS.plasma); a.vx = 15; a.heat = 1;
  const b = new Ball(640, 400, 20, MATERIALS.plasma); b.vx = -15; b.heat = 1;
  balls.push(a, b);
  const ke0 = totalKE();
  run(120);
  ok(noNaN(), 'N: no NaN');
  ok(totalKE() <= ke0 + 1e-6, `N: hot plasma didn't inject KE (${totalKE().toFixed(2)} ≤ ${ke0.toFixed(2)})`);
}

// ───────────────────── R/S: PBF water injects no energy ────────────────────
function waterColumn() {
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad, r = 10, x0 = pad + r + 2;
  for (let row = 0; row < 14; row++)
    for (let col = 0; col < 6; col++)
      balls.push(new Ball(x0 + col * (2 * r - 0.5), floorY - r - row * (2 * r - 0.5), r, MATERIALS.water));
}
function testWaterEnergyBounded() {
  console.log('R. a water column never gains total energy (PBF density projection is energy-safe)');
  waterColumn();
  const e0 = totalEnergy();
  run(240 * 5);
  ok(noNaN(), 'R: no NaN');
  ok(totalEnergy() <= e0 * 1.02, `R: water energy bounded (${totalEnergy().toFixed(0)} ≤ ${(e0 * 1.02).toFixed(0)})`);
}
function testWaterSteadyState() {
  console.log('S. a SETTLED water pool does not creep upward in energy (no steady-state injection)');
  waterColumn();
  run(240 * 6);                  // settle into a pool
  const e0 = totalEnergy();
  run(240 * 5);                  // 5 more seconds at rest
  ok(noNaN(), 'S: no NaN');
  ok(totalEnergy() <= e0 * 1.02 + 1, `S: settled pool didn't gain energy (${totalEnergy().toFixed(0)} ≤ ${(e0 * 1.02).toFixed(0)})`);
}

// ───────────────────── Q: terminal velocity depends on density ─────────────
function testTerminalByDensity() {
  console.log('Q. dense balls coast, light balls are held back by air drag (density-correct drag)');
  reset({ gravity: false });
  PHYS.drag = 0.05;
  // Same radius, same launch speed — drag deceleration ∝ 1/ρ, so after a moment
  // the dense ball has kept far more speed than the light one.
  const gold = new Ball(400, 400, 20, MATERIALS.gold); gold.vy = 1000;
  const wood = new Ball(800, 400, 20, MATERIALS.wood); wood.vy = 1000;
  balls.push(gold, wood);
  run(120);   // 0.5 s of pure drag deceleration
  ok(noNaN(), 'Q: no NaN');
  ok(balls.includes(gold) && balls.includes(wood), 'Q: both balls still in play');
  ok(gold.vy > wood.vy + 80, `Q: dense gold coasts, light wood is held back (gold vy=${gold.vy.toFixed(0)} > wood vy=${wood.vy.toFixed(0)})`);
}

// ───────────────────── P: fast balls don't tunnel (ball-ball CCD) ──────────
function testNoTunnelFast() {
  console.log('P. fast small balls collide instead of passing through (ball-ball CCD)');
  reset({ gravity: false, drag: 0 });
  const r = 5;
  // Two tiny balls fired head-on near the max speed cap. Without swept CCD they
  // skip past each other between discrete steps (confirmed: a ends right of b).
  const a = new Ball(560, 400, r, MATERIALS.steel); a.vx = 3500;
  const b = new Ball(640, 400, r, MATERIALS.steel); b.vx = -3500;
  balls.push(a, b);
  const p0 = a.mass * a.vx + b.mass * b.vx;
  const ke0 = totalKE();
  run(60);
  ok(noNaN(), 'P: no NaN');
  ok(a.x < b.x, `P: balls did not tunnel through each other (a.x=${a.x.toFixed(0)} stayed left of b.x=${b.x.toFixed(0)})`);
  ok(a.vx < 3500, `P: the fast ball actually collided (vx ${a.vx.toFixed(0)} < 3500)`);
  ok(Math.abs((a.mass * a.vx + b.mass * b.vx) - p0) < 1e-2, 'P: momentum conserved through the CCD bounce');
  ok(totalKE() <= ke0 + 1e-6, `P: CCD bounce injected no KE (${totalKE().toFixed(0)} ≤ ${ke0.toFixed(0)})`);
}

// ───────────────────── T–X: soft bodies (deformable blobs) ─────────────────
function dropJelly(R = 40) {
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  return buildSoftBall(W.cw / 2, W.ch * 0.4, R, MATERIALS.jelly);
}
function blobBBox(sb) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const b of sb.nodes) { minx = Math.min(minx, b.x); maxx = Math.max(maxx, b.x); miny = Math.min(miny, b.y); maxy = Math.max(maxy, b.y); }
  return { w: maxx - minx, h: maxy - miny };
}
function blobMaxSpeed(sb) { let m = 0; for (const b of sb.nodes) m = Math.max(m, Math.hypot(b.vx, b.vy)); return m; }

function testSoftFlattenRecover() {
  console.log('T. a soft blob flattens on impact then recovers its shape (real shape storage)');
  const sb = dropJelly();
  let peak = 0;
  for (let i = 0; i < 240 * 3; i++) { physicsStep(DT); const bb = blobBBox(sb); peak = Math.max(peak, bb.w / Math.max(1, bb.h)); }
  const e = blobBBox(sb); const endAspect = e.w / Math.max(1, e.h);
  ok(noNaN(), 'T: no NaN');
  ok(peak > 1.2, `T: blob flattened on impact (peak aspect ${peak.toFixed(2)} > 1.2 — a rigid disk can't)`);
  // it springs back from the peak compression (a soft body still rests slightly
  // domed under gravity, so it doesn't return to a perfect circle).
  ok(endAspect < peak - 0.1, `T: blob recovered from peak compression (end ${endAspect.toFixed(2)} < peak ${peak.toFixed(2)})`);
  ok(endAspect < 1.6, `T: blob isn't permanently pancaked (end aspect ${endAspect.toFixed(2)} < 1.6)`);
}
function testSoftSettles() {
  console.log('U. a soft blob settles — dissipative, no runaway/jitter');
  const sb = dropJelly();
  run(240 * 6);
  ok(noNaN(), 'U: no NaN');
  ok(blobMaxSpeed(sb) < 30, `U: blob came to rest (node maxSpeed ${blobMaxSpeed(sb).toFixed(1)} < 30)`);
}
function testSoftAreaPreserved() {
  console.log('V. a soft blob preserves its area (pressure constraint holds — no collapse/balloon)');
  const sb = dropJelly();
  let minA = 1e18, maxA = 0;
  for (let i = 0; i < 240 * 4; i++) { physicsStep(DT); const a = Math.abs(polyArea(sb.nodes)); minA = Math.min(minA, a); maxA = Math.max(maxA, a); }
  ok(noNaN(), 'V: no NaN');
  ok(minA > sb.restArea * 0.4, `V: never collapsed (minArea ${minA.toFixed(0)} > ${(sb.restArea * 0.4).toFixed(0)})`);
  ok(maxA < sb.restArea * 1.8, `V: never ballooned (maxArea ${maxA.toFixed(0)} < ${(sb.restArea * 1.8).toFixed(0)})`);
}
function blobCentroid(sb) {
  let cx = 0, cy = 0;
  for (const b of sb.nodes) { cx += b.x; cy += b.y; }
  return { x: cx / sb.nodes.length, y: cy / sb.nodes.length };
}

function testSoftBudget() {
  console.log('Y. a soft blob is cheap — at most 12 balls per blob');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const before = balls.length;
  const sb = buildSoftBall(W.cw / 2, W.ch / 2, 46, MATERIALS.jelly);
  ok(sb !== null, 'Y: blob built');
  const used = balls.length - before;
  ok(used <= 12, `Y: blob uses ${used} balls (≤ 12 of the 260 cap)`);
}

function testSoftHardSquash() {
  console.log('W. a slammed blob deforms heavily and still recovers (large deformation)');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const sb = buildSoftBall(W.cw / 2, W.ch - pad - 160, 40, MATERIALS.jelly);
  for (const n of sb.nodes) n.vy = 900;          // cannon it into the floor
  let peak = 0;
  for (let i = 0; i < 240 * 3; i++) {
    physicsStep(DT);
    const bb = blobBBox(sb);
    peak = Math.max(peak, bb.w / Math.max(1, bb.h));
  }
  const e = blobBBox(sb); const endAspect = e.w / Math.max(1, e.h);
  const a = Math.abs(polyArea(sb.nodes));
  ok(noNaN(), 'W: no NaN');
  ok(peak > 1.5, `W: heavy squash happened (peak aspect ${peak.toFixed(2)} > 1.5)`);
  ok(endAspect < 1.45, `W: recovered from the slam (end aspect ${endAspect.toFixed(2)} < 1.45)`);
  ok(a > sb.restArea * 0.6 && a < sb.restArea * 1.4,
     `W: area survived the slam (${(a / sb.restArea).toFixed(2)}× rest in [0.6, 1.4])`);
}

function testSoftStack() {
  console.log('Z. two stacked blobs settle without jitter and stay distinct');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const lo = buildSoftBall(W.cw / 2, W.ch - pad - 60, 44, MATERIALS.jelly);
  const hi = buildSoftBall(W.cw / 2, W.ch - pad - 200, 44, MATERIALS.jelly);
  run(240 * 6);
  ok(noNaN(), 'Z: no NaN');
  ok(blobMaxSpeed(lo) < 30, `Z: bottom blob at rest (maxSpeed ${blobMaxSpeed(lo).toFixed(1)} < 30)`);
  ok(blobMaxSpeed(hi) < 30, `Z: top blob at rest (maxSpeed ${blobMaxSpeed(hi).toFixed(1)} < 30)`);
  for (const [name, sb] of [['bottom', lo], ['top', hi]]) {
    const a = Math.abs(polyArea(sb.nodes));
    ok(a > sb.restArea * 0.5 && a < sb.restArea * 1.5,
       `Z: ${name} blob kept its area (${(a / sb.restArea).toFixed(2)}× rest)`);
  }
  ok(blobCentroid(hi).y < blobCentroid(lo).y - 20,
     `Z: top blob rests ON the bottom one, not inside it (Δy=${(blobCentroid(lo).y - blobCentroid(hi).y).toFixed(0)})`);
}

function testSoftDecay() {
  console.log('X. a perturbed blob (no gravity) loses its motion — damping is genuinely dissipative');
  reset({ gravity: false });
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const sb = buildSoftBall(W.cw / 2, W.ch / 2, 40, MATERIALS.jelly);
  const c0 = blobCentroid(sb);
  for (const b of sb.nodes) {                       // radial kick (breathing perturbation)
    const rx = b.x - c0.x, ry = b.y - c0.y, rl = Math.hypot(rx, ry) || 1;
    b.vx += rx / rl * 300; b.vy += ry / rl * 300;
  }
  run(240 * 5);
  ok(noNaN(), 'X: no NaN');
  ok(blobMaxSpeed(sb) < 25, `X: perturbation decayed to rest (node maxSpeed ${blobMaxSpeed(sb).toFixed(1)} < 25)`);
}

// ───────────────── AA: material constants are physically ordered ───────────
function testMaterialOrderings() {
  console.log('AA. material constants are physically ordered (real-data audit)');
  const M = MATERIALS;
  const gt = (a, b, prop) =>
    ok(M[a][prop] > M[b][prop],
       `AA: ${prop} ${a} (${M[a][prop]}) > ${b} (${M[b][prop]})`);

  // sanity: every material's constants live in physical ranges
  for (const [id, m] of Object.entries(M)) {
    ok(m.restitution >= 0 && m.restitution <= 1, `AA: ${id} restitution in [0,1]`);
    ok(m.density > 0, `AA: ${id} density > 0`);
    ok(m.friction >= 0 && m.friction <= 1.5, `AA: ${id} friction sane`);
  }

  // restitution — elastomers + elastic crystals out-bounce plastic/dead matter
  gt('rubber', 'steel', 'restitution');     // the classic demo: rubber wins
  gt('glass', 'steel', 'restitution');      // glass marbles bounce remarkably
  gt('diamond', 'glass', 'restitution');    // stiffest crystal, least loss
  gt('steel', 'gold', 'restitution');       // elastic vs soft plastic metal
  gt('obsidian', 'bowling', 'restitution'); // obsidian IS glass — elastic till it cleaves
  gt('rubber', 'wood', 'restitution');
  gt('wood', 'sand', 'restitution');
  ok(M.water.restitution < 0.1 && M.honey.restitution < 0.1,
     'AA: liquids have no bounce of their own');

  // density — real g/cm³
  ok(Math.abs(M.gold.density - 19.3) < 0.5, `AA: gold is real gold (${M.gold.density} ≈ 19.3)`);
  gt('gold', 'mercury', 'density');
  gt('mercury', 'steel', 'density');
  gt('steel', 'diamond', 'density');
  gt('diamond', 'glass', 'density');
  gt('glass', 'rubber', 'density');
  ok(M.sand.density > 2, `AA: a sand grain is quartz (${M.sand.density} ≈ 2.65), not bulk sand`);
  ok(M.wood.density < 1 && M.ice.density < 1, 'AA: wood + ice are lighter than water');
  gt('honey', 'water', 'density');
  ok(Math.abs(M.tnt.density - 1.65) < 0.15, `AA: TNT at its real 1.65 (${M.tnt.density})`);

  // friction — tyre rubber grips hardest (sand's identity is interlock —
  // `roll` + the impact-gated granular catch — not surface grip)
  gt('rubber', 'sand', 'friction');
  gt('sand', 'steel', 'friction');
  gt('rubber', 'wood', 'friction');
  gt('wood', 'steel', 'friction');
  gt('steel', 'glass', 'friction');
  ok(M.ice.friction < 0.05, `AA: ice is near-frictionless (${M.ice.friction})`);
  ok(M.water.friction <= M.ice.friction, 'AA: water is the most slippery thing in the lab');
  ok(M.mercury.friction < 0.1, 'AA: mercury slides like the liquid it is');
}

// ───────────────── AB–AD: fluid rheology (mercury / honey / lava) ──────────
function testMercurySplash() {
  console.log('AB. a slammed mercury blob splits into beads, conserving area');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const m = new Ball(W.cw / 2, W.ch - pad - 300, 20, MATERIALS.mercury);
  m.vy = 800;                                   // slam it into the floor
  balls.push(m);
  const area0 = m.r * m.r;
  run(240 * 1.5);
  const beads = balls.filter(b => b.mat.name === 'MERCURY');
  const area1 = beads.reduce((s, b) => s + b.r * b.r, 0);
  ok(noNaN(), 'AB: no NaN');
  ok(beads.length > 1, `AB: blob splashed into beads (${beads.length} > 1)`);
  ok(Math.abs(area1 - area0) < area0 * 0.02,
     `AB: area conserved through the splash (${(area1 / area0).toFixed(3)}× original)`);

  // and a GENTLE landing must NOT split — beads only fly on hard impacts
  reset();
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const g = new Ball(W.cw / 2, W.ch - pad - 60, 20, MATERIALS.mercury);
  balls.push(g);
  run(240 * 1.5);
  ok(balls.filter(b => b.mat.name === 'MERCURY').length === 1,
     'AB: gentle landing stays one blob');
}

function testHoneyVsWater() {
  console.log('AC. honey is a DISTINCT liquid — discrete drops, flows far slower than water');
  const pad = 40;
  const pour = (mat) => {
    reset();
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const r = 9, floorY = W.ch - pad;
    // a 6-wide × 8-tall column of drops standing on the floor
    for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) {
      balls.push(new Ball(W.cw / 2 + (i - 2.5) * 2 * r, floorY - r - j * 2 * r, r, mat));
    }
    const count0 = balls.length;
    run(240 * 2);
    let minx = 1e9, maxx = -1e9;
    for (const b of balls) { minx = Math.min(minx, b.x); maxx = Math.max(maxx, b.x); }
    return { spread: maxx - minx, count: balls.length, count0 };
  };
  const w = pour(MATERIALS.water);
  const h = pour(MATERIALS.honey);
  ok(noNaN(), 'AC: no NaN');
  ok(h.count >= h.count0 * 0.8,
     `AC: honey stays discrete drops (${h.count}/${h.count0} — a liquid, not one merged ball)`);
  ok(h.spread > 6 * 2 * 9 * 1.05,
     `AC: honey does flow outward (spread ${h.spread.toFixed(0)} > column width)`);
  ok(w.spread > h.spread * 1.4,
     `AC: water runs much further than honey (water ${w.spread.toFixed(0)} vs honey ${h.spread.toFixed(0)})`);
}

function testLavaCoolsStiff() {
  console.log('AD. lava merges while molten; a cooling crust (low heat) no longer merges');
  reset({ gravity: false, drag: 0 });
  const mk = (x, heat) => {
    const b = new Ball(x, 400, 14, MATERIALS.lava);
    b.heat = heat; b.vx = x < W.cw / 2 ? 25 : -25;
    balls.push(b); return b;
  };
  mk(560, 1.0); mk(640, 1.0);                  // molten pair, drifting together
  run(240 * 2);
  ok(balls.length === 1, `AD: molten lava merged (${balls.length} ball)`);

  reset({ gravity: false, drag: 0 });
  mk(560, 0.15); mk(640, 0.15);                // crusted-over pair (not yet rock)
  run(240 * 2);
  const lavas = balls.filter(b => b.mat.name === 'LAVA' || b.mat.name === 'ROCK');
  ok(lavas.length === 2, `AD: crusted lava stays separate (${lavas.length} balls)`);
}

// ───────────────── AE: brittle fracture realism ────────────────────────────
function testFractureRealism() {
  console.log('AE. fracture: mass conserved, energy-honest, skewed shards, mass-aware');
  const pad = 40;

  // 1+2+3: aggregate 6 glass shatters — fragment area ≈ conserved, KE never
  // injected across the fracture step, sizes right-skewed (big + many small)
  const ratios = [], spreads = [];
  let keInjected = false, shattered = 0;
  for (let k = 0; k < 6; k++) {
    reset();
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const g = new Ball(W.cw / 2, W.ch - pad - 220, 20, MATERIALS.glass);
    g.vy = 700; balls.push(g);
    for (let i = 0; i < 240 * 2; i++) {
      const keBefore = totalKE();
      physicsStep(DT);
      if (balls.length > 1) {
        shattered++;
        if (totalKE() > keBefore * 1.02) keInjected = true;
        ratios.push(balls.reduce((s, b) => s + b.r * b.r, 0) / 400);
        const rs = balls.map(b => b.r);
        spreads.push(Math.max(...rs) / Math.min(...rs));
        break;
      }
    }
  }
  ok(shattered === 6, `AE: all six glass drops shattered (${shattered}/6)`);
  const meanRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  ok(meanRatio > 0.85 && meanRatio < 0.98,
     `AE: fragment area ≈ conserved, small dust loss (${meanRatio.toFixed(2)}× in [0.85, 0.98])`);
  ok(!keInjected, 'AE: fracture never injects kinetic energy');
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  ok(meanSpread > 2.5,
     `AE: shard sizes are skewed — a few big, many small (max/min ${meanSpread.toFixed(1)} > 2.5)`);

  // 4: the criterion is impact ENERGY, not bare speed — a tiny pebble tapping
  // a glass boulder at 600 px/s breaks NOTHING (reduced mass is tiny)…
  reset({ gravity: false, drag: 0 });
  const peb = new Ball(480, 400, 6, MATERIALS.glass); peb.vx = 600;
  const big = new Ball(560, 400, 30, MATERIALS.glass);
  balls.push(peb, big);
  run(120);
  ok(balls.length === 2, `AE: pebble tap leaves boulder AND pebble whole (${balls.length} balls)`);

  // …while the same boulder slamming a wall at 600 px/s shatters (its own
  // mass supplies the energy; bigger pieces break EASIER, like real glass)
  reset({ gravity: false, drag: 0 });
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const slam = new Ball(300, 400, 30, MATERIALS.glass); slam.vx = -600;
  balls.push(slam);
  run(300);
  ok(balls.length > 1, `AE: boulder-on-wall slam at the same speed shatters (${balls.length} pieces)`);

  // 5: threshold ordering — obsidian cleaves easiest, then ice, then glass
  const wallHit = (mat, v) => {
    reset({ gravity: false, drag: 0 });
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const b = new Ball(300, 400, 20, mat); b.vx = -v;
    balls.push(b);
    run(300);
    return balls.length;
  };
  ok(wallHit(MATERIALS.glass, 450) === 1, 'AE: glass shrugs off 450 px/s');
  ok(wallHit(MATERIALS.ice, 450) > 1, 'AE: ice breaks at 450 px/s');
  ok(wallHit(MATERIALS.ice, 350) === 1, 'AE: ice shrugs off 350 px/s');
  ok(wallHit(MATERIALS.obsidian, 350) > 1, 'AE: obsidian cleaves at 350 px/s');

  // 6: diamond is effectively unbreakable
  ok(wallHit(MATERIALS.diamond, 1800) === 1, 'AE: diamond survives a 1800 px/s slam');
}

// ───────────────── AF: granular slope stability (angle of repose) ───────────
// Deterministic bounds instead of a chaotic pour: a 30° pile must HOLD (the
// repose lower bound), a near-vertical wall must SLUMP, and interlocking
// grains must hold far steeper rubble than rounded boulders.
function heapStats(r) {
  const floorY = W.ch - 40, mid = W.cw / 2;
  let minY = 1e9;
  for (const b of balls) minY = Math.min(minY, b.y - b.r);
  const dx = balls.map(b => Math.abs(b.x - mid)).sort((a, b) => a - b);
  const halfW = dx[Math.floor(dx.length * 0.95)] + r;
  const h = floorY - minY;
  return { h, angle: Math.atan2(h, halfW) * 180 / Math.PI };
}
function buildPyramid(mat, r, baseN, insetPerLayer) {
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad, mid = W.cw / 2;
  for (let j = 0; ; j++) {
    const n = baseN - Math.round(j * 2 * insetPerLayer);
    if (n < 1) break;
    for (let i = 0; i < n; i++) {
      balls.push(new Ball(mid + (i - (n - 1) / 2) * 2 * r, floorY - r - j * 2 * r * 0.866, r, mat));
    }
  }
}
function buildTower(mat, r) {
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad, mid = W.cw / 2;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 3; i++) {
    balls.push(new Ball(mid + (i - 1) * 2 * r + (j % 2) * 3, floorY - r - j * 2 * r * 0.93, r, mat));
  }
}

function testAngleOfRepose() {
  console.log('AF. sand holds a 30° pile, towers slump; boulders scatter where grains interlock');
  // 30° pyramid (the real repose band's lower edge) must stand
  buildPyramid(MATERIALS.sand, 7, 21, 1.5);
  const p0 = heapStats(7);
  run(240 * 4);
  const p1 = heapStats(7);
  ok(noNaN(), 'AF: no NaN');
  ok(p1.h > p0.h * 0.88,
     `AF: a 30° sand pile holds (height ${p0.h.toFixed(0)} → ${p1.h.toFixed(0)})`);

  // a near-vertical sand wall cannot stand — it must slump toward repose
  buildTower(MATERIALS.sand, 7);
  const t0 = heapStats(7);
  run(240 * 4);
  const sandTower = heapStats(7);
  ok(sandTower.angle < t0.angle - 12,
     `AF: a sand tower slumps (${t0.angle.toFixed(0)}° → ${sandTower.angle.toFixed(0)}°)`);

  // rounded boulders don't interlock: the same tower scatters nearly flat,
  // far below what angular sand rubble holds
  buildTower(MATERIALS.rock, 7);
  run(240 * 4);
  const rockTower = heapStats(7);
  ok(rockTower.angle < 20,
     `AF: a boulder tower scatters flat (${rockTower.angle.toFixed(0)}° < 20°)`);
  ok(sandTower.angle > rockTower.angle + 20,
     `AF: interlocking grains hold steeper rubble than round boulders (sand ${sandTower.angle.toFixed(0)}° vs rock ${rockTower.angle.toFixed(0)}°)`);
}

// ───────────────── AG: metal plasticity (gold dents cost energy) ────────────
function testGoldPlasticity() {
  console.log('AG. denting is plastic work: gold rebounds below its elastic model on denting hits');
  const pad = 40;
  const wallBounce = (v) => {
    reset({ gravity: false, drag: 0 });
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const b = new Ball(150, 400, 20, MATERIALS.gold); b.vx = -v;
    balls.push(b);
    for (let i = 0; i < 240 * 2; i++) {
      physicsStep(DT);
      if (b.vx > 0) break;
    }
    return { e: b.vx / v, dents: (b.dents || []).length };
  };
  // the elastic prediction (no plasticity): e_model = rest · velRestScale(v)
  const model = (v) => MATERIALS.gold.restitution * matVelRestScale(v, MATERIALS.gold);

  const gentle = wallBounce(120);
  ok(gentle.dents === 0,
     `AG: a 120 px/s tap leaves no dents (got ${gentle.dents}) — yield needs real impact`);
  ok(Math.abs(gentle.e - model(120)) < model(120) * 0.12,
     `AG: gentle bounce matches the elastic model (${gentle.e.toFixed(3)} ≈ ${model(120).toFixed(3)})`);

  const hard = wallBounce(600);
  ok(hard.dents > 0, `AG: a 600 px/s slam dents (${hard.dents} dent)`);
  ok(hard.e < model(600) * 0.93,
     `AG: denting bite — rebound ${hard.e.toFixed(3)} < elastic model ${model(600).toFixed(3)} · 0.93 (plastic work eats energy)`);
  ok(hard.e > 0.05, `AG: still bounces a little (${hard.e.toFixed(3)} > 0.05)`);
}

// ───────────────── AH–AJ: balloon pop, sticky slime, wood grain ─────────────
function testBalloonPop() {
  console.log('AH. balloons bounce gently, POP on hard slams and against hot things');
  const pad = 40;
  const slam = (v) => {
    reset({ gravity: false, drag: 0 });
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const b = new Ball(150, 400, 18, MATERIALS.balloon); b.vx = -v;
    balls.push(b);
    run(240);
    return balls.length;
  };
  ok(slam(200) === 1, 'AH: a gentle 200 px/s bounce leaves the balloon whole');
  ok(slam(700) === 0, 'AH: a 700 px/s slam pops it (bang, shreds, gone)');

  // heat pops a balloon at ANY speed — rest one against a hot ball
  reset({ gravity: false, drag: 0 });
  const hot = new Ball(600, 400, 20, MATERIALS.steel); hot.heat = 0.9; hot.pinned = true;
  const bal = new Ball(637, 400, 18, MATERIALS.balloon); bal.vx = -8;
  balls.push(hot, bal);
  run(240);
  ok(balls.length === 1 && balls[0].mat.name === 'STEEL',
     `AH: touching a hot ball pops the balloon (${balls.length} ball left)`);
}

function testSlimeBlob() {
  console.log('AI. slime spawns as a sticky soft blob that adheres to what it lands on');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const anchor = new Ball(W.cw / 2, W.ch - pad - 24, 24, MATERIALS.steel);
  balls.push(anchor);
  const before = balls.length;
  const sb = buildSoftBall(W.cw / 2 + 10, W.ch - pad - 160, 34, MATERIALS.slime);
  ok(sb !== null, 'AI: slime blob built');
  ok(balls.length - before <= 9, `AI: slime blob is cheap (${balls.length - before} ≤ 9 balls)`);
  run(240 * 4);
  ok(noNaN(), 'AI: no NaN');
  let bonded = false;
  for (const s of W.springs) {
    if (s.tag === 'slime' && (s.a === anchor || s.b === anchor)) bonded = true;
  }
  ok(bonded, 'AI: a slime bond formed onto the steel ball (it sticks, not just rests)');
  const c = blobCentroid(sb);
  const d = Math.hypot(c.x - anchor.x, c.y - anchor.y);
  ok(d < 110, `AI: the blob stayed stuck around its anchor (centroid ${d.toFixed(0)} px away)`);
}

function testWoodGrain() {
  console.log('AJ. wood slides farther along its grain than across it (anisotropic friction)');
  const pad = 40;
  const slideDistance = (grainAngle) => {
    reset();
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const b = new Ball(200, W.ch - pad - 20, 20, MATERIALS.wood);
    b.angle = grainAngle;
    b.vx = 600;
    b.inertia = 1e12;          // rotation-locked rig: isolate sliding friction
    balls.push(b);
    const x0 = b.x;
    for (let i = 0; i < 240 * 3; i++) {
      physicsStep(DT);
      if (Math.abs(b.vx) < 40) break;
    }
    return b.x - x0;
  };
  const along = slideDistance(0);                 // grain parallel to travel
  const across = slideDistance(Math.PI / 2);      // grain perpendicular
  ok(noNaN(), 'AJ: no NaN');
  ok(along > across * 1.15,
     `AJ: along-grain slide ${along.toFixed(0)} px > across-grain ${across.toFixed(0)} px × 1.15`);
}

// ───────────────── AK–AO: review-pass regressions (contacts + materials) ───
function testBalloonPairAndPartner() {
  console.log('AK. a pop never short-circuits the partner: both balloons burst, TNT still fuses, diamond is sharp');
  // two balloons slamming head-on above popV must BOTH burst
  reset({ gravity: false, drag: 0 });
  const a = new Ball(520, 400, 18, MATERIALS.balloon); a.vx = 400;
  const b = new Ball(640, 400, 18, MATERIALS.balloon); b.vx = -400;
  balls.push(a, b);
  run(240);
  ok(noNaN(), 'AK: no NaN');
  ok(balls.length === 0, `AK: head-on balloon slam pops BOTH (${balls.length} left, want 0)`);

  // TNT that pops a balloon experienced the same super-detonateV impact —
  // its fuse must light even though the balloon died in the same contact
  reset({ gravity: false, drag: 0 });
  const t = new Ball(520, 400, 18, MATERIALS.tnt); t.vx = 700;
  const bal = new Ball(640, 400, 18, MATERIALS.balloon);
  balls.push(t, bal);
  let fuseLit = false;
  for (let i = 0; i < 240; i++) { physicsStep(DT); if (t.fuseT > 0) fuseLit = true; }
  ok(fuseLit, 'AK: TNT that pops a balloon still lights its own fuse');
  ok(balls.filter(x => x.mat.name === 'BALLOON').length === 0, 'AK: the balloon popped');

  // diamond is the canonical sharp hitter — a moderate (sub-popV) touch pops
  const poke = (mat, v) => {
    reset({ gravity: false, drag: 0 });
    const d = new Ball(520, 400, 16, mat); d.vx = v;
    const m = new Ball(640, 400, 18, MATERIALS.balloon);
    balls.push(d, m);
    run(240);
    return balls.filter(x => x.mat.name === 'BALLOON').length === 0;
  };
  ok(poke(MATERIALS.diamond, 300), 'AK: diamond pops a balloon at 300 px/s (sharp, well below popV)');
  ok(!poke(MATERIALS.diamond, 100), 'AK: a 100 px/s diamond nudge leaves the balloon whole');
  ok(!poke(MATERIALS.wood, 300), 'AK: blunt wood at the same 300 px/s does NOT pop it');
}

function testDentSaturation() {
  console.log('AL. a fully-formed dent stops eating energy — plastic work needs deformation');
  const pad = 40;
  reset({ gravity: false, drag: 0 });
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const b = new Ball(150, 400, 20, MATERIALS.gold);
  balls.push(b);
  const bounce = () => {
    b.x = 150; b.y = 400; b.vx = -600; b.vy = 0; b.omega = 0; wake(b);
    for (let i = 0; i < 240; i++) { physicsStep(DT); if (b.vx > 0 && b.x > 120) break; }
    return b.vx / 600;
  };
  const model = MATERIALS.gold.restitution * matVelRestScale(600, MATERIALS.gold);
  const e1 = bounce();              // dents: plastic bite expected
  bounce();                         // deepens to saturation
  bounce(); bounce();               // saturated — no further deformation
  const eSat = bounce();
  ok(e1 < model * 0.93, `AL: first denting hit pays the plastic bite (${e1.toFixed(3)} < ${model.toFixed(3)}·0.93)`);
  ok(b.dents && b.dents.length > 0 && b.dents[0].depth >= 1, 'AL: the dent saturated at full depth');
  ok(eSat > model * 0.93,
     `AL: once saturated the rebound returns to the elastic model (${eSat.toFixed(3)} ≈ ${model.toFixed(3)})`);
}

function testBalloonCeiling() {
  console.log('AM. a free balloon survives its own buoyant rise — even in a tall world');
  reset();
  W.ch = 1600;
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const b = new Ball(W.cw / 2, W.ch - pad - 20, 18, MATERIALS.balloon);
  balls.push(b);
  run(240 * 6);
  ok(noNaN(), 'AM: no NaN');
  ok(balls.length === 1, `AM: the balloon did not self-pop on the ceiling (${balls.length} left)`);
  ok(balls.length === 1 && balls[0].y < 300,
     `AM: it rose and bobs at the ceiling (y=${balls.length ? balls[0].y.toFixed(0) : '—'})`);
}

function testHoneyNotGranular() {
  console.log('AN. honey is a liquid, not sand — a collapsing tower slumps where grain rubble holds');
  // A 12-high tower is far outside any static friction cone, so it MUST fall;
  // what it relaxes to is what separates interlocking grains from a viscous
  // liquid. With the (removed) roll>=0.2 gate honey kept a sand-like 47°.
  buildTower(MATERIALS.honey, 7);
  run(240 * 4);
  const honeyTower = heapStats(7);
  buildTower(MATERIALS.sand, 7);
  run(240 * 4);
  const sandTower = heapStats(7);
  ok(noNaN(), 'AN: no NaN');
  ok(honeyTower.angle < 43,
     `AN: a honey tower slumps like a liquid (${honeyTower.angle.toFixed(0)}° < 43°)`);
  ok(sandTower.angle > honeyTower.angle + 15,
     `AN: grain rubble holds far steeper than honey (sand ${sandTower.angle.toFixed(0)}° vs honey ${honeyTower.angle.toFixed(0)}°)`);
}

function testFlipperDestructive() {
  console.log('AO. flippers carry the same destructive contacts as walls: pops + splashes');
  // balloon slammed into a static flipper above popV must burst
  reset({ gravity: false, drag: 0 });
  spawnFlipper(400, 500, 180, -1);
  const b = new Ball(480, 420, 18, MATERIALS.balloon); b.vy = 800;
  balls.push(b);
  run(120);
  ok(balls.length === 0, `AO: flipper slam pops the balloon (${balls.length} left)`);

  // a big mercury blob slammed into a flipper splashes into beads
  reset({ gravity: false, drag: 0 });
  spawnFlipper(400, 500, 180, -1);
  const m = new Ball(480, 420, 20, MATERIALS.mercury); m.vy = 800;
  balls.push(m);
  run(120);
  ok(balls.filter(x => x.mat.name === 'MERCURY').length > 1,
     `AO: flipper slam splashes mercury into beads (${balls.filter(x => x.mat.name === 'MERCURY').length})`);
}

// ───────────────── AP–AS: review-pass regressions (soft-body physics) ──────
function testSoftSleeps() {
  console.log('AP. a settled blob joins the sleeping islands — and a real impact wakes it');
  const sb = dropJelly();
  run(240 * 8);
  ok(noNaN(), 'AP: no NaN');
  const asleep = sb.nodes.filter(nd => nd.sleeping).length;
  ok(asleep === sb.nodes.length,
     `AP: every node of a settled blob sleeps (${asleep}/${sb.nodes.length})`);
  // a real impact must wake it back into a deformable body
  const c0 = blobCentroid(sb);
  const slug = new Ball(c0.x, 200, 14, MATERIALS.steel); slug.vy = 700;
  balls.push(slug);
  run(120);
  ok(sb.nodes.some(nd => !nd.sleeping), 'AP: an impact wakes the sleeping blob');
}

function testSoftBuoyancy() {
  console.log('AQ. a soft blob displaces its DISK volume — jelly bobs nearly submerged, not like cork');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  W.waterY = 400;
  const disk = new Ball(W.cw / 2 - 250, 300, 40, MATERIALS.jelly);  // rigid reference
  balls.push(disk);
  const sb = buildSoftBall(W.cw / 2 + 250, 300, 40, MATERIALS.jelly);
  run(240 * 6);
  ok(noNaN(), 'AQ: no NaN');
  const blobDepth = blobCentroid(sb).y - W.waterY;
  const diskDepth = disk.y - W.waterY;
  ok(blobDepth > 5,
     `AQ: blob centroid floats BELOW the waterline like its ρ=1.05 says (depth ${blobDepth.toFixed(0)} px)`);
  ok(Math.abs(blobDepth - diskDepth) < 30,
     `AQ: blob rides like the equivalent rigid disk (blob ${blobDepth.toFixed(0)} vs disk ${diskDepth.toFixed(0)} px deep)`);
}

function testSoftSlingshot() {
  console.log('AS. a slingshot-launched blob actually flies — the kick reaches the whole body');
  reset({ gravity: false, drag: 0 });
  const sb = buildSoftBall(300, 400, 20, MATERIALS.jelly);
  kickBall(sb.nodes[0], 600, 0);          // exactly what the slingshot release does
  run(240);
  let mvx = 0;
  for (const nd of sb.nodes) mvx += nd.vx;
  mvx /= sb.nodes.length;
  ok(noNaN(), 'AS: no NaN');
  ok(mvx > 540, `AS: the blob flies at the slingshot speed (mean vx ${mvx.toFixed(0)} ≈ 600)`);
  // and a rigid ball through the same helper behaves exactly as before
  reset({ gravity: false, drag: 0 });
  const r = new Ball(300, 400, 20, MATERIALS.rubber);
  balls.push(r);
  kickBall(r, 600, 0);
  ok(r.vx === 600 && r.vy === 0, 'AS: kickBall on a rigid ball is a plain velocity set');
}

function testBlobHitTest() {
  console.log('AR. clicking anywhere on a blob hits it — including the visually-solid centre');
  const sb = dropJelly(50);
  run(240 * 2);
  sb.refreshCentroid();
  const hit = ballAt(sb.cx, sb.cy);
  ok(hit !== null && hit.soft === sb, 'AR: the blob centre is clickable (nearest node returned)');
  ok(ballAt(sb.cx + 400, sb.cy - 300) === null, 'AR: empty space still misses');
}

// ───────────────── AT–AV: review-pass regressions (soft-body lifecycle) ────
function testBlobSaveLoad() {
  console.log('AT. Save → Load round-trips soft blobs intact (material, springs, softness, no ghosts)');
  reset();
  loadScene('jelly');
  run(240);                                       // let the blobs settle into a real pose
  const nBlobs = softBodies.length;
  const jellyN0 = balls.filter(b => b.mat.name === 'JELLY').length;
  ok(nBlobs > 0 && jellyN0 > 0, `AT: jelly scene has blobs to save (${nBlobs} blobs, ${jellyN0} nodes)`);
  saveState();
  run(120);
  loadState();
  // No stepping before these asserts — this is exactly the paused-Load case.
  ok(softBodies.length === nBlobs, `AT: every blob round-tripped (${softBodies.length}/${nBlobs})`);
  ok(balls.filter(b => b.mat.name === 'JELLY').length === jellyN0,
     'AT: nodes kept their jelly material (no rubber degradation)');
  ok(softBodies.every(sb => sb.nodes.every(nd => balls.includes(nd) && nd.soft === sb && nd.isSoftNode)),
     'AT: no ghost blobs — every registered blob is wired to live pool balls');
  ok(softBodies.every(sb => sb.springs.length === sb.nodes.length &&
                            sb.springs.every(s => s.tag === 'soft')),
     'AT: membrane springs rebuilt and tagged (hidden from the spring renderer)');
  run(240 * 2);
  ok(noNaN(), 'AT: no NaN after resuming');
  ok(softBodies.every(sb => Math.abs(polyArea(sb.nodes)) > sb.restArea * 0.4),
     'AT: blobs are still pressurized soft bodies after the round-trip');
}

function testBlobTeardown() {
  console.log('AV. erase/undo tears a blob down instantly — no orphan nodes, springs, or registration');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const bystander = new Ball(200, 200, 16, MATERIALS.steel);
  balls.push(bystander);
  const springs0 = W.springs.length;
  const sb = buildSoftBall(600, 400, 40, MATERIALS.jelly);
  // What the erase tool / spawn-undo call — NO physics step in between,
  // which is exactly the paused case that used to leave ghost blobs.
  destroySoftBody(sb);
  ok(softBodies.length === 0, 'AV: blob unregistered immediately');
  ok(balls.length === 1 && balls[0] === bystander, `AV: all nodes left the pool (${balls.length} ball left)`);
  ok(W.springs.length === springs0, 'AV: membrane springs removed');
  destroySoftBody(sb);                       // double-destroy must be a no-op
  ok(balls.length === 1 && W.springs.length === springs0, 'AV: teardown is idempotent');
  run(60);
  ok(noNaN(), 'AV: no NaN after stepping past a teardown');
}

function testSoftNodeRenderHygiene() {
  console.log('AW. soft nodes are render-invisible: no refraction-pass trigger, no per-node trails');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const sb = buildSoftBall(W.cw / 2, W.ch / 2, 30, MATERIALS.slime);
  // loop.js triggers the full-canvas refraction snapshot on refract > 0.3 —
  // slime is 0.42, but its hidden nodes must never trip it (they're skipped
  // by drawBall, so the snapshot would buy zero pixels every frame).
  ok(sb.nodes.every(nd => (nd.mat.refract || 0) <= 0.3),
     'AW: slime nodes do not trip the refraction pass');
  PHYS.trails = true;
  run(240);
  const ribbons = sb.nodes.filter(nd => nd.trail.length > 0).length;
  PHYS.trails = false;
  ok(noNaN(), 'AW: no NaN');
  ok(ribbons === 0, `AW: hidden lattice nodes record no trail ribbons (${ribbons} did)`);
}

// ───────────────── AX–AZ: review-pass regressions (death side-effects) ─────
function testShatterWakesSleepers() {
  console.log('AX. shattering a support wakes the sleepers resting on it — no mid-air freezes');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const floorY = W.ch - pad;
  const support = new Ball(W.cw / 2, floorY - 40, 40, MATERIALS.glass);
  const sleeper = new Ball(W.cw / 2, floorY - 80 - 12, 12, MATERIALS.steel);
  balls.push(support, sleeper);
  run(240 * 3);                                  // settle until both sleep
  ok(sleeper.sleeping, 'AX: the stacked ball fell asleep on its glass support');
  const slug = new Ball(200, support.y, 24, MATERIALS.steel);
  slug.vx = 750;                                 // above the energy criterion for r=40 glass
  balls.push(slug);
  let shattered = false;
  for (let i = 0; i < 240 * 2; i++) {
    physicsStep(DT);
    if (!balls.includes(support)) { shattered = true; break; }
  }
  ok(shattered, 'AX: the support shattered');
  run(240);
  ok(noNaN(), 'AX: no NaN');
  ok(sleeper.y > floorY - 80,
     `AX: the sleeper fell when its support vanished (y=${sleeper.y.toFixed(0)}) instead of freezing mid-air`);
}

function testDeadBallDropsSprings() {
  console.log('AY. springs to a destroyed ball are removed — no tugging on corpses');
  reset();
  const pad = 40; addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  const anchor = new Ball(W.cw / 2 - 60, 200, 16, MATERIALS.steel);
  const merc = new Ball(W.cw / 2 + 60, W.ch - pad - 300, 20, MATERIALS.mercury);
  merc.vy = 800;                                  // will splash-split on the floor
  balls.push(anchor, merc);
  W.springs.push(new Spring(anchor, merc, 120, 0.6, 0.1));   // user Link-tool spring
  run(240 * 1.5);
  ok(noNaN(), 'AY: no NaN');
  ok(!balls.includes(merc), 'AY: the mercury blob split (died)');
  ok(W.springs.every(s => balls.includes(s.a) && balls.includes(s.b)),
     'AY: no spring references a ball that left the pool');
}

function testMoltenGripSingleLaw() {
  console.log('AZ. lava grips as it cools — one law, sane magnitudes on the wall path');
  const pad = 40;
  const slideDistance = (heat) => {
    reset();
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const b = new Ball(150, W.ch - pad - 20, 20, MATERIALS.lava);
    b.heat = heat; b.vx = 500;
    b.inertia = 1e12;            // rotation-locked: isolate sliding friction
    balls.push(b);
    const x0 = b.x;
    for (let i = 0; i < 240 * 3; i++) {
      physicsStep(DT);
      b.heat = heat;             // hold heat fixed — we probe μ(heat), not cooling
      if (Math.abs(b.vx) < 30) break;
    }
    return b.x - x0;
  };
  const hot = slideDistance(1.0);
  const crusted = slideDistance(0.12);
  ok(noNaN(), 'AZ: no NaN');
  ok(hot > crusted * 1.3,
     `AZ: molten lava slides farther than crusted (hot ${hot.toFixed(0)} px vs crusted ${crusted.toFixed(0)} px)`);
  ok(crusted > 40,
     `AZ: crusted lava still slides somewhat (${crusted.toFixed(0)} px > 40) — grip isn't double-counted into weld`);
}

// ───────────── BA: heat conducts over seconds, not instantly ───────────────
function testHeatConductionRate() {
  console.log('BA. contact heat conduction is gradual, conservative, and conductivity-ordered');
  // hot ball on the floor, cold ball stacked on top — gravity keeps the
  // contact alive, and the heat-shimmer wake keeps the hot ball awake so the
  // contact event (where conduction lives) fires every step.
  const stack = (matK) => {
    reset();
    PHYS.heatFx = true;
    const pad = 40;
    addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
    const floorY = W.ch - pad;
    const hot = new Ball(600, floorY - 20, 20, MATERIALS[matK]);
    const cold = new Ball(600, floorY - 60, 20, MATERIALS[matK]);
    hot.heat = 1.0;
    balls.push(hot, cold);
    return { hot, cold };
  };

  const s = stack('steel');
  const total0 = s.hot.heat + s.cold.heat;
  run(24);                                     // 0.1 s of contact
  ok(noNaN(), 'BA: no NaN');
  ok(s.hot.heat - s.cold.heat > 0.5,
     `BA: after 0.1 s a steel pair is still far from equilibrium (Δ=${(s.hot.heat - s.cold.heat).toFixed(2)} > 0.5)`);
  ok(s.cold.heat > 0.02,
     `BA: but heat IS flowing (cold side at ${s.cold.heat.toFixed(3)} > 0.02)`);
  // conduction is symmetric — it can move heat, never mint it (heatKeep only decays)
  ok(s.hot.heat + s.cold.heat <= total0 + 1e-6,
     `BA: conduction never creates heat (${(s.hot.heat + s.cold.heat).toFixed(3)} ≤ ${total0.toFixed(3)})`);
  run(240 * 3);                                // 3 more seconds in contact
  ok(Math.abs(s.hot.heat - s.cold.heat) < 0.15,
     `BA: a steel pair has nearly equalised after ~3 s (Δ=${Math.abs(s.hot.heat - s.cold.heat).toFixed(3)} < 0.15)`);

  // insulator pair (rubber·rubber, cond 0.05²) — conduction is negligible
  const r = stack('rubber');
  run(24);
  ok(r.cold.heat < 0.01,
     `BA: rubber insulates — cold side barely warms in 0.1 s (${r.cold.heat.toFixed(4)} < 0.01)`);
}

// ───────────── BB: the float line sits at ρ = 1.0 exactly ──────────────────
function testFloatLineAtWaterDensity() {
  console.log('BB. neutral buoyancy at ρ=1.0 — rubber (1.15) sinks, ice (0.92) floats nearly submerged');
  reset();
  const pad = 40;
  addBox(pad, pad, W.cw - pad * 2, W.ch - pad * 2);
  W.waterY = W.ch * 0.4;
  PHYS.heatFx = false;                          // keep ice from melting — buoyancy only
  const rubber = new Ball(W.cw / 2 - 150, W.waterY + 60, 18, MATERIALS.rubber);
  const ice    = new Ball(W.cw / 2 + 150, W.waterY + 60, 18, MATERIALS.ice);
  balls.push(rubber, ice);
  run(240 * 6);
  ok(noNaN(), 'BB: no NaN');
  // Rubber is denser than water: it must sink, not bob at the surface.
  ok(rubber.y > W.waterY + 150,
     `BB: rubber (ρ=1.15) sank (depth ${(rubber.y - W.waterY).toFixed(0)} px > 150)`);
  // Ice floats — but at ρ=0.92 it rides ~90 % submerged: centroid below the
  // waterline, yet it must NOT sink away (still within a radius of the surface).
  ok(ice.y < W.waterY + ice.r * 1.5,
     `BB: ice stayed at the surface (centroid ${(ice.y - W.waterY).toFixed(1)} px below waterline < r·1.5)`);
  ok(ice.y > W.waterY - ice.r,
     `BB: ice floats LOW in the water, not riding on top like cork (centroid ${(ice.y - W.waterY).toFixed(1)} px vs waterline)`);
}

// ───────────────────────────── run all ────────────────────────────────────
console.log('\n=== Sphere Lab physics invariants ===\n');
testHeadOn();
testStackSettles();
testPackedBox();
testCradle();
testOrbit();
testFloatVsSink();
testBalloonRises();
testAnnihilation();
testFluidSpreads();
testHeavyOnLight();
testPinnedSupport();
testSpinFriction();
testWakeOnRemoval();
testRepeatedBounce();
testHotPlasmaNoGain();
testNoTunnelFast();
testTerminalByDensity();
testWaterEnergyBounded();
testWaterSteadyState();
testSoftFlattenRecover();
testSoftSettles();
testSoftAreaPreserved();
testSoftDecay();
testSoftBudget();
testSoftHardSquash();
testSoftStack();
testMaterialOrderings();
testMercurySplash();
testHoneyVsWater();
testLavaCoolsStiff();
testFractureRealism();
testAngleOfRepose();
testGoldPlasticity();
testBalloonPop();
testSlimeBlob();
testWoodGrain();
testBalloonPairAndPartner();
testDentSaturation();
testBalloonCeiling();
testHoneyNotGranular();
testFlipperDestructive();
testSoftSleeps();
testSoftBuoyancy();
testSoftSlingshot();
testBlobHitTest();
testBlobSaveLoad();
testBlobTeardown();
testSoftNodeRenderHygiene();
testShatterWakesSleepers();
testDeadBallDropsSprings();
testMoltenGripSingleLaw();
testHeatConductionRate();
testFloatLineAtWaterDensity();
console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${passed} passed, ${failed} failed`);
if (failed) { for (const f of fails) console.error('   - ' + f); process.exit(1); }
