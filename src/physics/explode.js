/**
 * Radial explosion — pushes balls outward with 1/radius falloff, spawns
 * sparks + smoke, and plays a boom. Bound to right-click in the mouse input.
 */

import { rand, pick } from '../core/math.js';
import { TAU } from '../core/math.js';
import { balls, wake } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { Snd } from '../audio/sound.js';

/**
 * @param {number} x world-space center
 * @param {number} y
 * @param {number} force base impulse (scaled by 1/mass)
 * @param {number} radius affected radius; balls outside are untouched
 */
export function explode(x, y, force, radius) {
  for (const b of balls) {
    if (b.pinned) continue;
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > radius * radius) continue;
    const d = Math.sqrt(d2) || 0.001;
    const falloff = 1 - d / radius;
    const f = force * falloff / b.mass;
    b.vx += dx / d * f * 0.02;
    b.vy += dy / d * f * 0.02;
    b.omega += rand(-5, 5) * falloff;
    wake(b);     // a sleeping ball must wake or it ignores the impulse entirely
  }

  for (let i = 0; i < 60; i++) {
    const a = rand(0, TAU);
    const sp = rand(120, 440);
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.3, 0.8), maxLife: 0.8,
      color: pick(['#ffcc66', '#ff8844', '#ffffff']),
      size: rand(1, 3.2), type: 'spark'
    });
  }
  for (let i = 0; i < 20; i++) {
    particles.push({
      x, y, vx: rand(-40, 40), vy: rand(-100, 20),
      life: 1.2, maxLife: 1.2,
      color: '#80808088', size: rand(6, 14), type: 'smoke'
    });
  }
  Snd.bonk(120, 0.3, 0.4, 'sawtooth');
  Snd.noise(0.3, 0.2, 2000);
}
