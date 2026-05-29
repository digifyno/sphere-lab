/**
 * Orbits — Newtonian N-body gravitation. A heavy pinned star with planets on
 * (mostly) circular orbits, set by v = √(G·M / R). Planets also attract each
 * other, so the system drifts, precesses, and occasionally slingshots — real
 * gravitational dynamics, not a scripted animation. Air drag is off in space
 * (see `W.nbody` handling in step.js) so orbits persist.
 *
 * Drop more balls in (any material) and they'll be captured, flung, or fall
 * into the star. Try Attract/Push tools as a rogue gravity source.
 */

import { W, cam, setGravityUI } from '../core/world.js';
import { Ball, balls } from '../entities/ball.js';
import { MATERIALS } from '../entities/materials.js';
import { NBODY_G } from '../physics/forces.js';
import { rand, pick, TAU } from '../core/math.js';

export default function orbits() {
  W.nbody = true;
  W.bgColor1 = '#06060f';
  W.bgColor2 = '#010109';
  setGravityUI(false);

  // wider framing so the outer orbits sit comfortably on screen
  cam.tz = 0.82; cam.zoom = 0.82;

  const cx = W.cw / 2, cy = W.ch / 2;

  // central star — heavy + pinned. Born hot (a young star) so it glows before
  // cooling; its mass anchors every orbit below.
  const star = new Ball(cx, cy, 46, MATERIALS.gold);
  star.pinned = true;
  star.heat = 1;
  balls.push(star);
  const M = star.mass;

  const planetMats = ['rock', 'steel', 'ice', 'magnet', 'diamond', 'obsidian', 'bowling', 'neon'];
  const radii = [140, 200, 258, 318, 372];
  for (let k = 0; k < radii.length; k++) {
    const R = radii[k];
    const ang = rand(0, TAU);
    const p = new Ball(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, rand(9, 16), MATERIALS[pick(planetMats)]);
    // tangential (counter-clockwise) speed for a near-circular orbit; a touch
    // under circular for the inner ones gives gentle eccentricity.
    const v = Math.sqrt(NBODY_G * M / R) * rand(0.88, 1.02);
    p.vx = -Math.sin(ang) * v;
    p.vy = Math.cos(ang) * v;
    p.omega = rand(-3, 3);
    balls.push(p);

    // give the 2nd planet a tiny moon — a body orbiting a body orbiting a star
    if (k === 1) {
      const mr = 24;
      const moon = new Ball(p.x + mr, p.y, 5, MATERIALS.ice);
      const mv = Math.sqrt(NBODY_G * p.mass / mr);
      moon.vx = p.vx;
      moon.vy = p.vy + mv;      // orbital velocity added on top of the planet's
      balls.push(moon);
    }
  }
}
