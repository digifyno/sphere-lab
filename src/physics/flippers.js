/**
 * Pinball flipper physics.
 *
 * A flipper is a line segment pivoting at (px, py). When `active` is true it
 * rotates toward `upAngle` with a stiff restoring spring; when released it
 * relaxes toward `restAngle`. Ball/flipper contact resolves like a ball/wall
 * collision but with an extra tangential kick from the flipper's surface
 * velocity at the contact point.
 */

import { PHYS } from '../core/config.js';
import { W } from '../core/world.js';
import { clamp } from '../core/math.js';
import { spawnImpact } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';
import { stats } from './stats.js';
import { wake } from '../entities/ball.js';
import { matVelRestScale, heatRestMod } from './materialMods.js';
import { tryFracture } from './fracture.js';
import { tryFluidSplit, tryPop } from './collisions.js';
import { lightFuse } from './tnt.js';

export function spawnFlipper(px, py, length, side) {
  const restAngle = side < 0 ?  Math.PI * 0.18 : Math.PI - Math.PI * 0.18;
  const upAngle   = side < 0 ? -Math.PI * 0.30 : Math.PI + Math.PI * 0.30;
  W.flippers.push({
    px, py, length,
    angle: restAngle,
    angVel: 0,
    restAngle, upAngle,
    side,
    active: false
  });
}

export function updateFlippers(dt) {
  for (const f of W.flippers) {
    const target = f.active ? f.upAngle : f.restAngle;
    const stiffness = 900;
    const damping = 45;
    const err = target - f.angle;
    f.angVel += err * stiffness * dt;
    f.angVel *= Math.max(0, 1 - damping * dt);
    f.angVel = clamp(f.angVel, -28, 28);
    f.angle += f.angVel * dt;
  }
}

export function collideFlipper(b, f) {
  const x1 = f.px;
  const y1 = f.py;
  const x2 = f.px + Math.cos(f.angle) * f.length;
  const y2 = f.py + Math.sin(f.angle) * f.length;
  const wx = x2 - x1, wy = y2 - y1;
  // Guard against zero-length flippers (scene builder bug) — every other
  // line-segment routine uses a similar floor to avoid div-by-zero NaN.
  const wlen2 = (wx * wx + wy * wy) || 1e-6;

  let t = ((b.x - x1) * wx + (b.y - y1) * wy) / wlen2;
  t = clamp(t, 0, 1);
  const cx = x1 + wx * t;
  const cy = y1 + wy * t;
  const dx = b.x - cx;
  const dy = b.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= b.r * b.r) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = dx / d, ny = dy / d;

  b.x = cx + nx * b.r;
  b.y = cy + ny * b.r;

  const rArm = t * f.length;
  const flipperVx = -Math.sin(f.angle) * f.angVel * rArm;
  const flipperVy =  Math.cos(f.angle) * f.angVel * rArm;

  const relVx = b.vx - flipperVx;
  const relVy = b.vy - flipperVy;
  const vn = relVx * nx + relVy * ny;
  if (vn >= 0) return;

  const e = b.mat.restitution * PHYS.restitutionMul * 1.05
          * matVelRestScale(Math.abs(vn), b.mat) * heatRestMod(b);
  b.vx -= vn * nx * (1 + e);
  b.vy -= vn * ny * (1 + e);

  const tx = -ny, ty = nx;
  const kick = (flipperVx * tx + flipperVy * ty) * 0.55;
  b.vx += tx * kick;
  b.vy += ty * kick;
  b.omega += kick * 0.02;

  wake(b);

  // Flipper surface counts as a rolling contact for resistance.
  b.groundT = 0.08;
  b.contactNx = nx;
  b.contactNy = ny;

  // Same static-surface side-effects as walls/pegs: a hard hit shatters a
  // fragile ball, splashes a liquid, pops a membrane, or lights an
  // explosive's fuse. Each try* returns true when it consumed the ball, so
  // skip the now-stale impact FX (matches collideWall / collidePeg).
  if (tryFracture(b, Math.abs(vn))) return;
  if (tryFluidSplit(b, Math.abs(vn))) return;
  if (tryPop(b, Math.abs(vn))) return;
  if (b.mat.explosive && Math.abs(vn) > (b.mat.detonateV || 260)) lightFuse(b);

  spawnImpact(cx, cy, nx, ny, Math.abs(vn) * b.mass, '#ffb340');
  // ball-on-flipper: the ball's own material voice + a small flipper-whack.
  // Only whack on real hits — a ball resting on a raised flipper re-enters
  // collideFlipper every tick, which must not click continuously.
  const aVn = Math.abs(vn);
  Snd.wall(b, aVn * b.mass, aVn);
  if (aVn > 55) {
    Snd.bonk(520 + Math.abs(f.angVel) * 18, 0.12, 0.06, 'square');
  }
  stats.collisions++;
}
