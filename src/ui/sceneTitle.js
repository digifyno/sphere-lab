/**
 * Big centered scene title that fades in/out when a scene loads.
 *
 * The CSS animation (`@keyframes scene-pulse`) runs for ~2s; we re-trigger it
 * by removing and re-adding the `.show` class.
 */

const el    = document.getElementById('scene-title');
const title = document.getElementById('st-title');
const sub   = document.getElementById('st-sub');
const fade  = document.getElementById('scene-fade');

const SUBS = {
  sandbox:   'Open arena · no distractions',
  billiards: '5-row rack · steel cue · no gravity',
  plinko:    'Staggered pegs · bin physics',
  cradle:    'Conservation of momentum',
  vortex:    'Central attractor · tangential swirl',
  tower:     'Gravity stack · let it fall',
  galton:    'Rain into a bean machine',
  pinball:   '← → to flip · bumpers bounce',
  cloth:     'Grid of rubber + diagonal bracing',
  domino:    'Chain of spring-linked pieces',
  solar:     'Planets · moons · asteroid belt',
  rain:      'Slanted platforms · endless drop',
  jelly:     'Soft-body blobs · pressure + shape memory',
  water:     'Archimedes buoyancy · live ripples',
  magnets:   'Mutual 1/r² attraction',
  avalanche: 'Tilted slope · tower of balls',
  conveyor:  'Belts drag tangentially',
  chaos:     'Double pendulum · sensitive',
  orbits:    'Newtonian N-body · √(GM/R) orbits',
  fluid:     'Dam break · particle water',
  sandpile:  'Granular heap · angle of repose',
  balloons:  'Helium lift · tethered + free'
};

export function showSceneTitle(name, display) {
  title.textContent = display.toUpperCase();
  sub.textContent   = SUBS[name] || '';
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');

  // trigger the black fade overlay in parallel
  fade.classList.remove('fading');
  void fade.offsetWidth;
  fade.classList.add('fading');
}
