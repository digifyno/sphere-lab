/**
 * Fixed-timestep physics integration. Called by `loop.js` at 240 Hz via an
 * accumulator.
 *
 * Drag: `F_drag = (k_lin + k_quad · |v|) · A · v` where A = π·r². A larger
 * ball has more cross-section and feels more air resistance — small balls
 * dart, bowling balls plough.
 *
 * Magnus: `F⊥ ∝ ω · v · A`. Same scaling — larger balls curve more.
 *
 * Sleep: after `SLEEP_DELAY` seconds of resting motion under gravity, a
 * ball goes to sleep (skips integration + collision iteration). Any contact
 * or tool interaction wakes it via `wake(b)`.
 */

import { W } from '../core/world.js';
import { PHYS } from '../core/config.js';
import { clamp, lerp, len, rand, pick } from '../core/math.js';
import { balls, Ball, wake, SLEEP_DELAY, SLEEP_V, SLEEP_W } from '../entities/ball.js';
import { MATERIALS, MAT_KEYS } from '../entities/materials.js';
import { particles, spawnHeatShimmer, spawnSmoke, spawnSparkle, spawnChip } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';
import { collideWall, collidePeg, ballContactEvent, tryFluidMerge } from './collisions.js';
import { solveBallContacts } from './contactSolver.js';
import { updateFlippers, collideFlipper } from './flippers.js';
import { applyVortex, applySolar, applyBuoyancy, applyMagnetism, applyNbody, stepRipples } from './forces.js';
import { processTNT } from './tnt.js';
import { breakSlimeBonds } from './adhesion.js';
import { mouse } from '../input/mouse.js';
import { getTool } from '../input/tools.js';

/** Reference cross-section: a 20 px radius ball (= the default spawn radius). */
const REF_AREA = Math.PI * 20 * 20;

export function physicsStep(dt) {
  if (W.rainSpawn && Math.random() < 0.1 && balls.length < 200) {
    const mat = MATERIALS[pick(MAT_KEYS)];
    const b = new Ball(rand(W.cw * 0.1, W.cw * 0.9), 60, rand(7, 16), mat);
    b.vx = rand(-30, 30) + PHYS.wind * 0.1;
    balls.push(b);
  }

  updateFlippers(dt);
  applyMagnetism(dt);
  applyNbody(dt);
  stepRipples(dt);

  const TOOL = getTool();

  // wake balls the user is actively interacting with
  if (mouse.down && (TOOL === 'push' || TOOL === 'attract' || TOOL === 'heat')) {
    const r2 = TOOL === 'attract' ? 300*300 : TOOL === 'push' ? 200*200 : 100*100;
    for (const b of balls) {
      const dx = b.x - mouse.wx, dy = b.y - mouse.wy;
      if (dx*dx + dy*dy < r2) wake(b);
    }
  }

  for (const b of balls) {
    b.life += dt;
    const mat = b.mat;
    // Viscoelastic squash recovery. Materials with low `bounceBack` are
    // overdamped (simple exponential — steel snaps back). Materials with
    // high `bounceBack` use a spring-damper ODE so they jiggle visibly
    // back to rest over ~150 ms — rubber wobble, plasma wiggle.
    const bb = mat.bounceBack ?? 0;
    if (bb < 0.05) {
      const squashRate = 20 - (mat.deform || 0.4) * 15;
      b.squash = lerp(b.squash, 1, clamp(dt * squashRate, 0, 1));
      b.squashVel = 0;
    } else {
      // stiffness ~ 900, damping reduced for elastic materials
      const stiffness = 900 * (1 - bb * 0.4);
      const damping = 28 * (1 - bb * 0.82);
      const err = 1 - b.squash;
      b.squashVel += (err * stiffness - b.squashVel * damping) * dt;
      b.squash += b.squashVel * dt;
      // Clamp to safe range so overshoot stays visible but not absurd.
      if (b.squash > 1.18) { b.squash = 1.18; b.squashVel = Math.min(b.squashVel, 0); }
      if (b.squash < 0.35) { b.squash = 0.35; b.squashVel = Math.max(b.squashVel, 0); }
    }

    // Per-material heat cooling — metals hold heat, rubber sheds it quickly.
    b.heat *= (mat.heatKeep ?? 0.996);
    if (b.heat > 0.3) { spawnHeatShimmer(b.x, b.y - b.r, b.heat); wake(b); }

    // Material-specific heat visuals -----------------------------------
    if (PHYS.heatFx && b.heat > 0.05 && !b.isFragment) {
      const matName = mat.name;

      // Ice melts: radius shrinks, mass follows, occasional water droplet.
      // When it gets too small it's gone — water evaporated away.
      // Previous guards trapped ice at r≈3.15 (outer `r > 3.2` blocked
      // further melt once the ball had already shrunk a bit, and the
      // Math.max(3, ...) floor sat above the 3.05 kill threshold).
      if (matName === 'ICE' && b.heat > 0.2 && b.r > 3.0) {
        const meltRate = (b.heat - 0.2) * 1.6;
        const dr = meltRate * dt;
        b.r = b.r - dr;
        b.mass = b.r * b.r * mat.density * 0.001;
        b.inertia = 0.5 * b.mass * b.r * b.r;
        b.area = Math.PI * b.r * b.r;
        if (Math.random() < dt * meltRate * 25) {
          spawnChip(b.x + rand(-b.r * 0.4, b.r * 0.4), b.y + b.r * 0.6, 0, 1, 30, '#7fc4ff');
        }
        if (b.r <= 3.05) { b._dead = true; continue; }
      }
      // Hot rubber smokes.
      else if (matName === 'RUBBER' && b.heat > 0.45 && Math.random() < dt * 8) {
        spawnSmoke(b.x + rand(-b.r * 0.5, b.r * 0.5), b.y - b.r * 0.3, 0, -15,
                   'rgba(50,40,48,0.45)', 0.85);
      }
      // Hot metals throw small embers. Flame-colored so gated by Fire.
      else if (PHYS.fire && (matName === 'STEEL' || matName === 'GOLD' || matName === 'MAGNET') && b.heat > 0.55 && Math.random() < dt * 10) {
        const emberColor = matName === 'GOLD' ? '#ffd890' : matName === 'MAGNET' ? '#ff9060' : '#ffb060';
        spawnSparkle(b.x + rand(-b.r * 0.4, b.r * 0.4), b.y + rand(-b.r * 0.4, b.r * 0.4),
                     0, -1, 35, emberColor);
      }
    }

    // Gold anneals when hot — real gold softens and dents shallow out.
    // Heat above 0.45 slowly reduces each dent's depth; once a dent falls
    // below a tiny threshold it's removed entirely. This rewards using the
    // heat tool on damaged gold balls.
    if (mat.name === 'GOLD' && b.heat > 0.45 && b.dents && b.dents.length) {
      const rate = (b.heat - 0.45) * 0.12 * dt;
      for (let di = b.dents.length - 1; di >= 0; di--) {
        b.dents[di].depth -= rate;
        if (b.dents[di].depth <= 0.08) b.dents.splice(di, 1);
      }
    }

    // lifespan (fragments) — count down + mark for removal
    if (b.lifespan !== undefined) {
      b.lifespan -= dt;
      if (b.lifespan <= 0) { b._dead = true; continue; }
    }

    // Lava → rock phase change. Molten materials radiate heat (visualized
    // as shimmer / glow via existing heat FX) until heat decays below a
    // threshold, at which point the ball swaps to its `solidifiesTo`
    // material. We swap material + recompute mass-dependent fields so the
    // physics pipeline sees a proper rock from the next step onward.
    if (mat.molten && mat.solidifiesTo && b.heat < 0.08 && !b.isFragment) {
      const next = MATERIALS[mat.solidifiesTo];
      if (next) {
        b.mat = next;
        b.mass = b.r * b.r * next.density * 0.001;
        b.inertia = 0.5 * b.mass * b.r * b.r;
        b.heat = 0;
        // One-shot dust puff as the crust forms.
        spawnSmoke(b.x + rand(-b.r * 0.4, b.r * 0.4), b.y - b.r * 0.4, 0, -10,
                   'rgba(70,55,45,0.45)', 0.6);
      }
    }

    // TNT lit by heat — sitting in lava or a big fire heats TNT to its
    // auto-ignition point. Lights a standard fuse (not the shorter chain
    // fuse) so the player sees a moment of warning.
    if (mat.explosive && b.heat > 0.65 && b.fuseT <= 0 && !b.isFragment) {
      b.fuseT = 0.35;
    }

    // TNT fuse — tiny sparks fly off while the fuse burns, plus warning
    // sparkle cadence that gets frantic near detonation. Fire toggle off
    // silences these (the fuse still burns + the tip still glints in the
    // ball renderer, so the player sees the countdown visually).
    if (b.fuseT > 0 && !b.isFragment && PHYS.fire) {
      const urgency = 1 - (b.fuseT / 0.35);
      if (Math.random() < dt * (18 + urgency * 40)) {
        particles.push({
          x: b.x + rand(-b.r * 0.35, b.r * 0.35),
          y: b.y - b.r * 0.95,
          vx: rand(-30, 30), vy: -rand(40, 120),
          life: 0.35, maxLife: 0.35,
          color: '#ffd870', size: rand(1, 2.2), type: 'spark'
        });
      }
    }

    if (b.pinned) { b.vx = b.vy = b.omega = 0; continue; }

    if (b.grabbed) {
      wake(b);
      b.vx = (mouse.wx - b.x) * 25 - b.vx * 8 * dt;
      b.vy = (mouse.wy - b.y) * 25 - b.vy * 8 * dt;
    }

    // sleeping balls still get squash tweened + heat decay but skip dynamics.
    if (b.sleeping) continue;

    if (PHYS.gravityOn) b.vy += PHYS.gravity * dt;
    if (PHYS.wind)      b.vx += PHYS.wind * dt;

    // Rolling resistance — only active while in sustained wall contact.
    // Damps the tangential component of velocity (leaves normal alone so
    // gravity / bounces behave correctly). Pure rolling has no kinetic
    // friction, so this is the ONLY thing slowing a rolling ball down —
    // the multiplier has to be strong to feel, since rolling can otherwise
    // continue forever. Rubber grinds to a stop in ~1.5 s, steel coasts
    // for 10+ s, ice glides practically forever.
    if (b.groundT > 0) {
      b.groundT -= dt;
      const rollK = mat.roll ?? 0.05;
      const nx = b.contactNx, ny = b.contactNy;
      const vn = b.vx * nx + b.vy * ny;
      const vtx = b.vx - vn * nx;
      const vty = b.vy - vn * ny;
      const dampFac = Math.max(0, 1 - rollK * 14 * dt);
      b.vx = vn * nx + vtx * dampFac;
      b.vy = vn * ny + vty * dampFac;
      b.omega *= Math.max(0, 1 - rollK * 20 * dt);

      // Static friction — below a small tangential speed + low spin, snap
      // the ball to rest on the surface. Prevents endless creep on slight
      // slopes and fixes the "ball almost stopped but doesn't quite" case.
      // Threshold scales with friction coefficient (grippy materials stick
      // at higher speeds).
      const staticThresh = 2.5 + (mat.friction || 0.3) * 14;
      const vtMag = Math.sqrt(vtx * vtx + vty * vty);
      if (vtMag < staticThresh && Math.abs(b.omega) < 1.3) {
        b.vx = vn * nx;
        b.vy = vn * ny;
        b.omega *= 0.5;
      }
    }

    // Diamond dispersion trail — a moving diamond continuously sheds tiny
    // rainbow glints in its wake, the visual signature of its characteristic
    // "fire" (spectral dispersion). Glass refracts; diamond *prisms*.
    if (mat.name === 'DIAMOND' && !b.isFragment) {
      const dspd = len(b.vx, b.vy);
      if (dspd > 50) {
        const intensity = Math.min(1, dspd / 450);
        if (Math.random() < dt * (32 + intensity * 60)) {
          const hues = [
            'rgba(255,180,230,0.75)', 'rgba(180,220,255,0.75)',
            'rgba(200,255,200,0.65)', 'rgba(255,235,160,0.70)',
            'rgba(220,190,255,0.75)', 'rgba(255,255,255,0.85)'
          ];
          particles.push({
            x: b.x + rand(-b.r * 0.4, b.r * 0.4),
            y: b.y + rand(-b.r * 0.4, b.r * 0.4),
            vx: b.vx * 0.08 + rand(-22, 22),
            vy: b.vy * 0.08 + rand(-22, 22),
            life: 0.45 + Math.random() * 0.25,
            maxLife: 0.70,
            color: hues[Math.floor(Math.random() * hues.length)],
            size: 1.0 + Math.random() * 1.4,
            type: 'sparkle'
          });
        }
      }
    }

    // Hot-ball cooling trail — a short fading heat smear behind any moving
    // hot ball. Reuses the smoke particle type with hot colors so there's
    // no new particle branch. Only spawns above a speed threshold so
    // stationary hot balls keep their vertical shimmer-only look. Gated by
    // Fire since it's one of the most visible flame-like effects.
    if (PHYS.heatFx && PHYS.fire && b.heat > 0.3 && !b.isFragment) {
      const spd = len(b.vx, b.vy);
      if (spd > 70 && Math.random() < dt * 32) {
        const hotCol = b.heat > 0.65
          ? 'rgba(255,80,30,0.55)'
          : 'rgba(255,140,50,0.45)';
        particles.push({
          x: b.x + rand(-b.r * 0.25, b.r * 0.25),
          y: b.y + rand(-b.r * 0.25, b.r * 0.25),
          vx: b.vx * 0.12 + rand(-14, 14),
          vy: b.vy * 0.12 + rand(-14, 14) - 18,
          life: 0.35, maxLife: 0.35,
          color: hotCol,
          size: b.r * (0.35 + 0.3 * b.heat),
          type: 'smoke'
        });
      }
    }

    applyVortex(b, dt);
    applySolar(b, dt);
    applyBuoyancy(b, dt);

    if (mouse.down && TOOL === 'push') {
      const dx = b.x - mouse.wx, dy = b.y - mouse.wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < 200 * 200) {
        const d = Math.sqrt(d2) || 0.001;
        const f = (200 - d) * 800 / b.mass;
        b.vx += dx / d * f * dt;
        b.vy += dy / d * f * dt;
      }
    }
    if (mouse.down && TOOL === 'attract') {
      const dx = mouse.wx - b.x, dy = mouse.wy - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 300 * 300 && d2 > 400) {
        const d = Math.sqrt(d2);
        const falloff = 1 - d / 300;
        const f = 1400 * falloff / b.mass;
        b.vx += dx / d * f * dt;
        b.vy += dy / d * f * dt;
      }
    }
    if (mouse.down && TOOL === 'heat') {
      const dx = b.x - mouse.wx, dy = b.y - mouse.wy;
      if (dx * dx + dy * dy < 100 * 100) b.heat = Math.min(1, b.heat + dt * 3);
    }

    // drag scales with cross-sectional area — big balls feel heavy air.
    // Suppressed in N-body space (vacuum) so orbits don't slowly spiral in.
    const vmag = len(b.vx, b.vy);
    const areaScale = b.area / REF_AREA;
    if (!W.nbody) {
      const dragK = PHYS.drag * areaScale * (1 + vmag * 0.0018);
      const dragFactor = Math.max(0, 1 - dragK * dt);
      b.vx *= dragFactor; b.vy *= dragFactor;
      b.omega *= Math.max(0, 1 - PHYS.drag * areaScale * dt * 0.8);
    }

    // Magnus: F⊥ = k · ω · v · A. Velocity snapshot to avoid self-contamination.
    if (vmag > 10 && Math.abs(b.omega) > 0.1) {
      const magK = PHYS.magnus * 0.002 * areaScale;
      const mvx = -b.vy * b.omega * magK * dt;
      const mvy =  b.vx * b.omega * magK * dt;
      b.vx += mvx;
      b.vy += mvy;
    }

    const spd = len(b.vx, b.vy);
    const maxV = 4000;
    if (spd > maxV) { b.vx *= maxV / spd; b.vy *= maxV / spd; }

    // CCD substep
    const steps = Math.max(1, Math.ceil(spd * dt / (b.r * 0.6)));
    const sdt = dt / steps;
    b.px = b.x; b.py = b.y;
    for (let s = 0; s < steps; s++) {
      b.x += b.vx * sdt;
      b.y += b.vy * sdt;
      for (const w of W.walls) collideWall(b, w);
      for (const peg of W.pegs) collidePeg(b, peg);
      for (const f of W.flippers) collideFlipper(b, f);
    }
    b.angle += b.omega * dt;

    if (PHYS.trails) {
      b.trailT -= dt;
      if (b.trailT <= 0) {
        b.trailT = 0.02;
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > 30) b.trail.shift();
      }
    } else if (b.trail.length) {
      b.trail.length = 0;
    }
  }

  // springs + pendulum tethers — springs wake their endpoints
  const springIters = W.springs.length > 200 ? 3 : 6;
  for (let i = 0; i < springIters; i++) {
    for (const s of W.springs) {
      wake(s.a); wake(s.b);
      s.solve(dt / springIters * 4);
    }
    for (const c of W.constraints) {
      if (!c.a || c.a.pinned) continue;
      const a = c.a;
      const dx = a.x - c.ax, dy = a.y - c.ay;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = dx / d, ny = dy / d;
      const corr = d - c.len;
      if (Math.abs(corr) < 0.001) continue;
      wake(a);
      a.x -= nx * corr;
      a.y -= ny * corr;
      const vn = a.vx * nx + a.vy * ny;
      if ((corr > 0 && vn > 0) || (corr < 0 && vn < 0)) {
        a.vx -= vn * nx; a.vy -= vn * ny;
      }
    }
  }

  if (balls.length > 0) {
    solveBallContacts(dt, { merge: tryFluidMerge, contact: ballContactEvent });
  }

  // sleep bookkeeping — must come AFTER integration + solver
  for (const b of balls) {
    if (b.pinned || b.grabbed) { b.sleeping = false; b.restTime = 0; continue; }
    if (b.isResting()) {
      b.restTime += dt;
      if (b.restTime > SLEEP_DELAY) {
        b.sleeping = true;
        b.vx = 0; b.vy = 0; b.omega = 0;
      } else {
        // Mild settling damping while accumulating rest time — prevents
        // tiny numeric jitter in piles from repeatedly resetting restTime.
        b.vx *= 0.88;
        b.vy *= 0.88;
        b.omega *= 0.88;
      }
    } else {
      b.restTime = 0;
      b.sleeping = false;
    }
  }

  // Rolling / sliding sound contribution. Each ball in contact with a
  // surface AND moving tangentially contributes tangential speed + its
  // size + position to its material's mix bus. The audio layer uses those
  // to set per-material filter freq (small balls high, big low) and
  // stereo pan (weighted by which side of the canvas the rolling happens).
  for (const b of balls) {
    if (b.sleeping || b.groundT <= 0) continue;
    const nx = b.contactNx, ny = b.contactNy;
    const vn = b.vx * nx + b.vy * ny;
    const vtx = b.vx - vn * nx;
    const vty = b.vy - vn * ny;
    const vt = Math.sqrt(vtx * vtx + vty * vty);
    if (vt > 12) Snd.addRoll(b.mat.name, vt, b.r, b.x);
  }
  Snd.commitRoll();

  // Plasma: cumulative arc intensity (for sustain buzz) + occasional
  // crackle per close pair.
  let plasmaArcTotal = 0;
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.mat.name !== 'PLASMA') continue;
    for (let j = i + 1; j < balls.length; j++) {
      const c = balls[j];
      if (c.mat.name !== 'PLASMA') continue;
      const dx = c.x - a.x, dy = c.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 140 * 140) continue;
      const t = 1 - Math.sqrt(d2) / 140;
      plasmaArcTotal += t * t;
      // Occasional transient crackle on top of the sustain.
      if (Math.random() < dt * 14 * t * t) {
        Snd.crackle((a.x + c.x) * 0.5, 0.85 + Math.random() * 0.4);
      }
    }
  }
  Snd.setPlasmaHum(plasmaArcTotal);

  // particles
  for (const p of particles) {
    p.life -= dt;
    if (p.type !== 'ring') {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    switch (p.type) {
      case 'smoke':
      case 'dust':
        p.size *= 1 + dt * 0.4;
        p.vx *= 1 - dt * 1.2;
        p.vy *= 1 - dt * 1.2;
        break;
      case 'spark':
      case 'sparkle':
        p.vx *= 1 - dt * 0.6;
        p.vy *= 1 - dt * 0.6;
        if (PHYS.gravityOn) p.vy += 400 * dt;
        break;
      case 'chip':
      case 'shard':
        p.vx *= 1 - dt * 0.35;
        p.vy *= 1 - dt * 0.35;
        if (PHYS.gravityOn) p.vy += 600 * dt;   // chips fall
        if (p.rotV !== undefined) p.rot = (p.rot || 0) + p.rotV * dt;
        break;
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);

  // Post-solver systems:
  //  - TNT fuses tick + detonate (can flag other balls `_dead`).
  //  - Slime bonds break if over-stretched or endpoints are gone.
  // Both must run before the dead-ball cleanup below so freed bonds +
  // exploded TNT corpses disappear in the same frame.
  processTNT(dt);
  breakSlimeBonds();

  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b._dead || b.x < -800 || b.x > W.cw + 800 || b.y > W.ch + 600 || b.y < -500) {
      balls.splice(i, 1);
    }
  }
}
