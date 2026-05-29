/**
 * World + camera state. Reset by `clearWorld()` whenever a scene loads.
 */

import { balls, wakeAll } from '../entities/ball.js';
import { particles } from '../entities/particles.js';
import { PHYS } from './config.js';

/**
 * @typedef {Object} Wall
 * @property {number} x1 @property {number} y1 @property {number} x2 @property {number} y2
 * @property {boolean} [bouncy]      — 1.4× restitution + pink render
 * @property {boolean} [flipper]     — visual-only, orange render
 * @property {number}  [conveyorV]   — tangential drag speed; positive = toward (x2,y2)
 */

/** @typedef {Object} Peg
 * @property {number} x  @property {number} y  @property {number} r
 * @property {boolean} [bumper] */

/** @typedef {Object} Constraint
 * @property {import('../entities/ball.js').Ball} a
 * @property {number} ax @property {number} ay @property {number} len */

/** @typedef {Object} Flipper
 * @property {number} px @property {number} py
 * @property {number} length
 * @property {number} angle @property {number} angVel
 * @property {number} restAngle @property {number} upAngle
 * @property {number} side
 * @property {boolean} active */

/** @typedef {Object} Ripple
 * @property {number} x  @property {number} amp
 * @property {number} phase @property {number} life */

export const W = {
  cw: 0, ch: 0,
  /** @type {Wall[]} */        walls: [],
  /** @type {Peg[]} */         pegs: [],
  /** @type {Constraint[]} */  constraints: [],
  /** @type {import('../entities/spring.js').Spring[]} */ springs: [],
  /** @type {Flipper[]} */     flippers: [],
  bumpers: [],
  scene: 'sandbox',
  bgColor1: '#0b1324', bgColor2: '#02040b',
  rainSpawn: false,
  vortexX: 0, vortexY: 0,
  solar: false,
  magnetic: false,
  /** Newtonian mutual gravitation between every ball (Orbits scene). When on,
   *  air drag is suppressed (space has no air) so orbits don't decay. */
  nbody: false,
  /** @type {number | undefined} */ waterY: undefined,
  /** @type {Ripple[]} */ ripples: []
};

export const cam = { x: 0, y: 0, zoom: 1, tx: 0, ty: 0, tz: 1 };

export function screenToWorld(sx, sy) {
  return {
    x: (sx - W.cw / 2) / cam.zoom + cam.x,
    y: (sy - W.ch / 2) / cam.zoom + cam.y
  };
}

export function addBox(x, y, w, h) {
  W.walls.push(
    { x1: x,     y1: y,     x2: x + w, y2: y     },
    { x1: x + w, y1: y,     x2: x + w, y2: y + h },
    { x1: x + w, y1: y + h, x2: x,     y2: y + h },
    { x1: x,     y1: y + h, x2: x,     y2: y     }
  );
}

export function clearWorld() {
  balls.length = 0;
  W.walls.length = 0;
  W.pegs.length = 0;
  W.constraints.length = 0;
  W.springs.length = 0;
  W.flippers.length = 0;
  W.bumpers.length = 0;
  W.ripples.length = 0;
  particles.length = 0;
  W.solar = false;
  W.magnetic = false;
  W.nbody = false;
  W.waterY = undefined;
}

export function setGravityUI(on, g) {
  PHYS.gravityOn = on;
  if (typeof g === 'number') {
    PHYS.gravity = g;
    const s = /** @type {HTMLInputElement} */ (document.getElementById('s-g'));
    if (s) { s.value = String(g); document.getElementById('v-g').textContent = String(g); }
  }
  // wake every ball — sleeping balls resting on gravity shouldn't stay frozen
  // in place when gravity vanishes or flips magnitude
  wakeAll();
  const b = document.getElementById('btn-gravity');
  if (!b) return;
  const span = b.querySelector('span:not(.kbd)');
  if (span) span.textContent = on ? 'Gravity on' : 'Gravity off';
  b.classList.toggle('active', on);
}
