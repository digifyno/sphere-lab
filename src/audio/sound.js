/**
 * Procedural impact audio — advanced modal synthesis.
 *
 * What makes this sound like real materials instead of video-game beeps:
 *
 *   1. **Inharmonic partials.** Each material has a list of mode *ratios*
 *      (relative to its fundamental) that aren't clean 2:3:4 harmonics.
 *      That mathematical inharmonicity is what makes a struck steel ball
 *      sound like metal instead of a flute. Real steel spheres vibrate at
 *      approximately 1, 1.59, 2.14, 2.65, 3.16, 3.65… of the fundamental.
 *
 *   2. **Size-dependent pitch.** Ring frequency is inversely proportional
 *      to object size (≈ 1/L for a vibrating body). A small ball rings
 *      higher than a big one of the same material — `sizeExp` controls
 *      how strongly. All modes shift together, preserving timbre.
 *
 *   3. **Velocity-dependent brightness.** Soft taps excite only the
 *      fundamental. Hard hits pour energy into every mode. We scale each
 *      mode's amplitude by `strength ^ (1 + index · 0.25)` so higher modes
 *      fade out faster as the impact gets weaker — exactly how a real body
 *      behaves when struck gently vs. hard.
 *
 *   4. **Cross-material damping.** A collision puts BOTH bodies' voices
 *      in play, each damped by the *other*'s softness. Rubber hitting
 *      steel → rubber thud with a faint, heavily-damped steel ring
 *      (because rubber absorbs the impulse before steel can ring freely).
 *
 *   5. **Attack transient.** A short filtered-noise burst models the
 *      physical contact click — highpass for metals, lowpass for rubbery
 *      thuds, bandpass for mercury. This is the "onset" that happens
 *      before any ringing sets in.
 *
 *   6. **Stereo localization.** Every impact is panned based on its x
 *      position on the canvas — balls on the left sound from your left
 *      speaker.
 *
 *   7. **Per-material reverb send.** Bright materials (glass, ice, steel)
 *      send more of their bright modes to the reverb bus than dull ones.
 *
 *   8. **Detune jitter.** Each mode picks up ±1.5 % random detune per hit
 *      so repeated collisions don't phase-lock into identical sounds.
 *
 *   9. **Master compressor.** A gentle 4:1 compressor after the master bus
 *      keeps cascaded shatters from clipping.
 */

import { PHYS } from '../core/config.js';
import { W } from '../core/world.js';
import { clamp } from '../core/math.js';

/** Reference radius — modal frequencies in the profiles below are the values
 *  for a ball of this radius. Smaller balls shift up; larger shift down. */
const REF_R = 20;

/* ------------------------------------------------------------------ */
/*  Voice budget + trigger gating                                      */
/* ------------------------------------------------------------------ */
/* The sandbox can easily fire 50+ simultaneous collisions (pile-ups,
 * cascade shatters). Without limits this either overloads the audio
 * graph (causing audible dropouts) or the compressor pumps everything
 * down to a mush. So we cap concurrent voices, rate-limit spawns in a
 * short window, and gate retriggers on the same ball.                 */

/** Hard ceiling on simultaneously-playing oscillator / buffer voices. */
const MAX_ACTIVE_VOICES = 56;
/** Per-frame spawn limit — avoids a single tick creating 100+ nodes. */
const SPAWN_WINDOW_MS = 16;
const MAX_SPAWNS_PER_WINDOW = 28;
/** Minimum gap between consecutive material voices for a single ball
 *  (seconds). A heavy ball settling on the floor 'collides' every 4 ms
 *  at 240 Hz physics — this stops that from becoming 240 clicks/sec. */
const PER_BALL_COOLDOWN = 0.045;
/** Normal-velocity thresholds below which the impact is treated as a
 *  rolling / sliding contact, not a real hit. Sounds are skipped.     */
const MIN_AUDIBLE_VN_BALL = 14;
const MIN_AUDIBLE_VN_WALL = 18;

/**
 * @typedef {Object} Mode
 * @property {number} ratio   multiplier against the material's baseFreq
 * @property {number} amp     0..1 relative amplitude of this mode
 * @property {number} decay   seconds to silence
 */
/**
 * @typedef {Object} Profile
 * @property {number}  resonance   how "ringable" the material is (rubber ~0.2, glass 1.0)
 * @property {number}  baseFreq    fundamental at REF_R, in Hz
 * @property {Mode[]}  modes
 * @property {number}  sizeExp     pitch scaling exponent (≈1 for solid bodies)
 * @property {Object}  attack      transient noise burst descriptor
 * @property {number}  reverbSend  0..1, per-material wet-bus send level
 */

/** @type {Record<string, Profile>} */
const MODAL = {
  // Wood — a dry knock. Mid fundamental, a couple of inharmonic partials, fast
  // decay, soft lowpass attack (the "tok" of two blocks).
  WOOD: {
    resonance: 0.45, baseFreq: 440, sizeExp: 0.95,
    modes: [
      { ratio: 1.000, amp: 0.95, decay: 0.20 },
      { ratio: 1.73,  amp: 0.50, decay: 0.13 },
      { ratio: 2.61,  amp: 0.24, decay: 0.08 }
    ],
    attack: { type: 'lowpass', freq: 2200, dur: 0.012, amp: 0.50, velHpScale: 0.25 },
    reverbSend: 0.10
  },
  // Sand — granular. Almost no ring; the sound is mostly a short filtered-noise
  // hiss with a faint low body. A soft "pf".
  SAND: {
    resonance: 0.18, baseFreq: 210, sizeExp: 0.8,
    modes: [
      { ratio: 1.000, amp: 0.55, decay: 0.05 },
      { ratio: 2.30,  amp: 0.20, decay: 0.03 }
    ],
    attack: { type: 'lowpass', freq: 1500, dur: 0.030, amp: 0.70 },
    reverbSend: 0.05
  },
  // Balloon — soft latex "boing"/squeak. Light, mid-high, quick.
  BALLOON: {
    resonance: 0.40, baseFreq: 600, sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 0.85, decay: 0.16 },
      { ratio: 1.55,  amp: 0.40, decay: 0.10 },
      { ratio: 2.30,  amp: 0.16, decay: 0.06 }
    ],
    attack: { type: 'lowpass', freq: 1800, dur: 0.018, amp: 0.40 },
    reverbSend: 0.10
  },
  // Antimatter — an electric zap: bright inharmonic high modes + two close
  // beating partials for an unstable shimmer, sharp highpass onset.
  ANTIMATTER: {
    resonance: 0.55, baseFreq: 1500, sizeExp: 0.9,
    modes: [
      { ratio: 1.000, amp: 0.80, decay: 0.16 },
      { ratio: 1.027, amp: 0.80, decay: 0.16 },
      { ratio: 3.70,  amp: 0.42, decay: 0.09 },
      { ratio: 6.10,  amp: 0.24, decay: 0.05 }
    ],
    onset:  { dur: 0.0010, amp: 0.34 },
    attack: { type: 'highpass', freq: 5500, dur: 0.020, amp: 0.55, velHpScale: 0.45 },
    reverbSend: 0.30
  },
  // Honey — a wet squelch. Heavily damped, very low, no ring at all.
  HONEY: {
    resonance: 0.16, baseFreq: 150, sizeExp: 0.85,
    modes: [
      { ratio: 1.000, amp: 0.85, decay: 0.08 },
      { ratio: 2.05,  amp: 0.22, decay: 0.04 }
    ],
    attack: { type: 'lowpass', freq: 500, dur: 0.045, amp: 0.75 },
    reverbSend: 0.03
  },
  // Steel ball bearing — sharp click, bright clang with rich inharmonic overtones.
  // Ratios modelled on a solid-sphere resonance pattern (not flute-like harmonics).
  // Decays extended to match real chrome-steel: a 20 mm sphere in free air rings
  // well over a second before going inaudible. A two-stage attack separates the
  // unfiltered contact click (onset) from the coupled surface ring-up (attack).
  STEEL: {
    resonance: 1.00,
    baseFreq: 2800,
    sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 1.30 },
      { ratio: 1.594, amp: 0.80, decay: 1.02 },
      { ratio: 2.136, amp: 0.64, decay: 0.80 },
      { ratio: 2.653, amp: 0.50, decay: 0.62 },
      { ratio: 3.155, amp: 0.38, decay: 0.48 },
      { ratio: 3.650, amp: 0.28, decay: 0.38 },
      { ratio: 4.128, amp: 0.20, decay: 0.30 },
      { ratio: 4.593, amp: 0.14, decay: 0.24 },
      { ratio: 5.055, amp: 0.09, decay: 0.20 }
    ],
    onset:  { dur: 0.0014, amp: 0.42 },
    attack: { type: 'highpass', freq: 5000, dur: 0.014, amp: 0.55, velHpScale: 0.55 },
    reverbSend: 0.42
  },
  // Rubber — almost entirely damped. A deep boomy thud plus a tiny higher
  // skin-slap ping. No sustained ring (hysteresis dissipates the energy
  // in the first few cycles). Low-pass attack models the "fwump" of the
  // contact deforming a soft skin.
  RUBBER: {
    resonance: 0.22,
    baseFreq: 120,
    sizeExp: 0.85,
    modes: [
      { ratio: 1.000, amp: 0.95, decay: 0.11 },
      { ratio: 1.88,  amp: 0.42, decay: 0.06 },
      { ratio: 3.10,  amp: 0.16, decay: 0.03 }
    ],
    attack: { type: 'lowpass', freq: 680, dur: 0.065, amp: 0.90 },
    reverbSend: 0.04
  },
  // Glass — brittle bell. Bright click, high sparse modes, fast decay.
  // Two-stage attack: sharp unfiltered tick, then the filtered ring-up.
  // Decays bumped — real glass rings briefly even on a soft tap.
  GLASS: {
    resonance: 1.00,
    baseFreq: 3500,
    sizeExp: 1.1,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 0.42 },
      { ratio: 1.94,  amp: 0.80, decay: 0.32 },
      { ratio: 2.88,  amp: 0.58, decay: 0.24 },
      { ratio: 3.82,  amp: 0.40, decay: 0.18 },
      { ratio: 4.76,  amp: 0.26, decay: 0.14 },
      { ratio: 5.70,  amp: 0.16, decay: 0.10 }
    ],
    onset:  { dur: 0.0010, amp: 0.36 },
    attack: { type: 'highpass', freq: 7000, dur: 0.010, amp: 0.48, velHpScale: 0.50 },
    reverbSend: 0.45
  },
  // Bowling ball — dense polyurethane over a heavy core. Deep low thud
  // with a bit more body than pure rubber — the hard shell rings briefly
  // even as the core absorbs. Four modes give it a denser thunk.
  BOWLING: {
    resonance: 0.55,
    baseFreq: 95,
    sizeExp: 0.9,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 0.40 },
      { ratio: 2.20,  amp: 0.48, decay: 0.24 },
      { ratio: 3.70,  amp: 0.22, decay: 0.14 },
      { ratio: 5.20,  amp: 0.10, decay: 0.09 }
    ],
    attack: { type: 'lowpass', freq: 360, dur: 0.055, amp: 0.62 },
    reverbSend: 0.14
  },
  // Neon — light acrylic shell enclosing glow gas. Mid fundamentals with
  // a slightly hollow character (thin wall). Onset is soft but present
  // — the shell ticks on contact before the gas interior can dampen.
  NEON: {
    resonance: 0.55,
    baseFreq: 900,
    sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 0.92, decay: 0.22 },
      { ratio: 1.60,  amp: 0.55, decay: 0.15 },
      { ratio: 2.40,  amp: 0.28, decay: 0.10 },
      { ratio: 3.35,  amp: 0.14, decay: 0.07 }
    ],
    onset:  { dur: 0.0018, amp: 0.22 },
    attack: { type: 'lowpass', freq: 2400, dur: 0.014, amp: 0.44, velHpScale: 0.25 },
    reverbSend: 0.18
  },
  // Gold — soft dense metal (Mohs 2.5). Warm, low fundamental that rings
  // like a gong. Onset click is duller than steel because the contact
  // plasticizes immediately — the high-frequency spectrum is suppressed.
  // Low modes persist for seconds on a real gold bar; we lean into that.
  GOLD: {
    resonance: 0.92,
    baseFreq: 540,
    sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 1.80 },
      { ratio: 1.62,  amp: 0.62, decay: 1.20 },
      { ratio: 2.28,  amp: 0.42, decay: 0.85 },
      { ratio: 2.97,  amp: 0.26, decay: 0.55 },
      { ratio: 3.71,  amp: 0.16, decay: 0.38 },
      { ratio: 4.43,  amp: 0.10, decay: 0.26 }
    ],
    onset:  { dur: 0.0020, amp: 0.25 },
    attack: { type: 'highpass', freq: 3200, dur: 0.018, amp: 0.42, velHpScale: 0.35 },
    reverbSend: 0.38
  },
  // Plasma — sci-fi: two beating modes near each other + bright overtones.
  // Keeps its signature warble, but now with a sharp onset tick for the
  // dielectric-snap character of plasma arcs making contact.
  PLASMA: {
    resonance: 0.45,
    baseFreq: 380,
    sizeExp: 0.9,
    modes: [
      { ratio: 1.000, amp: 0.88, decay: 0.18 },
      { ratio: 1.042, amp: 0.88, decay: 0.18 },   // ~16 Hz beat with the fundamental
      { ratio: 5.10,  amp: 0.44, decay: 0.09 },
      { ratio: 8.30,  amp: 0.26, decay: 0.06 },
      { ratio: 11.40, amp: 0.14, decay: 0.04 }    // ultrasonic shimmer
    ],
    onset:  { dur: 0.0010, amp: 0.30 },
    attack: { type: 'highpass', freq: 5000, dur: 0.022, amp: 0.58, velHpScale: 0.40 },
    reverbSend: 0.24
  },
  // Ice — crystalline. Very bright click, sharp ephemeral modes. The
  // internal lattice has lots of micro-cracks that damp ringing fast;
  // even pristine ice rings for less than a glass sphere of same size.
  ICE: {
    resonance: 0.95,
    baseFreq: 1700,
    sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 0.22 },
      { ratio: 1.41,  amp: 0.62, decay: 0.15 },
      { ratio: 2.12,  amp: 0.40, decay: 0.10 },
      { ratio: 2.82,  amp: 0.22, decay: 0.07 },
      { ratio: 3.60,  amp: 0.12, decay: 0.05 }
    ],
    onset:  { dur: 0.0012, amp: 0.38 },
    attack: { type: 'highpass', freq: 8500, dur: 0.016, amp: 0.58, velHpScale: 0.45 },
    reverbSend: 0.38
  },
  // Magnet — ferromagnetic steel alloy. Damper than chrome steel (magnetic
  // domain boundary motion adds internal friction) but still metallic.
  // Mode ratios follow the solid-sphere pattern but ring decays are
  // roughly half of steel's. Gets the two-stage attack for a crisp click.
  MAGNET: {
    resonance: 0.75,
    baseFreq: 1200,
    sizeExp: 1.0,
    modes: [
      { ratio: 1.000, amp: 0.95, decay: 0.70 },
      { ratio: 1.59,  amp: 0.62, decay: 0.55 },
      { ratio: 2.14,  amp: 0.42, decay: 0.42 },
      { ratio: 2.65,  amp: 0.28, decay: 0.30 },
      { ratio: 3.15,  amp: 0.18, decay: 0.22 },
      { ratio: 3.65,  amp: 0.11, decay: 0.16 }
    ],
    onset:  { dur: 0.0016, amp: 0.34 },
    attack: { type: 'highpass', freq: 4200, dur: 0.014, amp: 0.48, velHpScale: 0.45 },
    reverbSend: 0.28
  },
  // Mercury — liquid metal. No tonal ring (no solid modes) but now with
  // a very brief muted sub-thump underneath the splash bandpass, giving
  // a sense of the heavy fluid displacing on contact.
  MERCURY: {
    resonance: 0.35,
    baseFreq: 180,
    sizeExp: 0.7,
    modes: [
      { ratio: 1.000, amp: 0.45, decay: 0.06 }   // single heavy sub-thud
    ],
    attack: { type: 'bandpass', freq: 1200, dur: 0.070, amp: 0.62, q: 2.4 },
    reverbSend: 0.18
  },
  // Obsidian — volcanic glass. Darker, lower fundamental than glass, fast
  // decay (internal micro-fractures damp the ring), mid-range click.
  // Two-stage attack adds a sharp initial tick — obsidian hits crisply.
  OBSIDIAN: {
    resonance: 0.58,
    baseFreq: 1400,
    sizeExp: 0.95,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 0.32 },
      { ratio: 1.76,  amp: 0.58, decay: 0.22 },
      { ratio: 2.58,  amp: 0.34, decay: 0.15 },
      { ratio: 3.50,  amp: 0.20, decay: 0.10 },
      { ratio: 4.40,  amp: 0.11, decay: 0.07 }
    ],
    onset:  { dur: 0.0014, amp: 0.32 },
    attack: { type: 'bandpass', freq: 2400, dur: 0.012, amp: 0.52, q: 1.6, velHpScale: 0.35 },
    reverbSend: 0.16
  },
  // Diamond — crystalline but much harder + brighter than glass. Very high
  // fundamental, dense inharmonic mode stack, low internal damping so the
  // ring lingers. Attack is an ultrahigh click (10 kHz+). Reverb send is
  // pushed up — diamond's brilliance carries in the room response.
  DIAMOND: {
    resonance: 1.00,
    baseFreq: 4500,
    sizeExp: 1.15,
    modes: [
      { ratio: 1.000, amp: 1.00, decay: 0.95 },
      { ratio: 1.533, amp: 0.88, decay: 0.72 },
      { ratio: 2.142, amp: 0.70, decay: 0.55 },
      { ratio: 2.817, amp: 0.54, decay: 0.42 },
      { ratio: 3.544, amp: 0.40, decay: 0.32 },
      { ratio: 4.311, amp: 0.28, decay: 0.25 },
      { ratio: 5.116, amp: 0.18, decay: 0.20 },
      { ratio: 5.900, amp: 0.12, decay: 0.16 }
    ],
    onset:  { dur: 0.0008, amp: 0.38 },
    attack: { type: 'highpass', freq: 10000, dur: 0.006, amp: 0.45, velHpScale: 0.60 },
    reverbSend: 0.58
  },
  // Water — a plop, not a ring. One heavily-damped sub-thud under a bandpass
  // splash transient (like mercury, lighter + brighter). No tonal modes.
  WATER: {
    resonance: 0.14, baseFreq: 170, sizeExp: 0.8,
    modes: [
      { ratio: 1.000, amp: 0.55, decay: 0.05 }
    ],
    attack: { type: 'bandpass', freq: 1400, dur: 0.060, amp: 0.55, q: 1.8 },
    reverbSend: 0.06
  },
  // Lava — molten squelch. Very low, no ring, soft lowpass onset.
  LAVA: {
    resonance: 0.18, baseFreq: 130, sizeExp: 0.8,
    modes: [
      { ratio: 1.000, amp: 0.80, decay: 0.07 },
      { ratio: 2.10,  amp: 0.20, decay: 0.04 }
    ],
    attack: { type: 'lowpass', freq: 520, dur: 0.045, amp: 0.72 },
    reverbSend: 0.05
  },
  // Rock — dense basalt thud. Low stony knock, fast decay, lowpass attack.
  ROCK: {
    resonance: 0.42, baseFreq: 200, sizeExp: 0.9,
    modes: [
      { ratio: 1.000, amp: 0.95, decay: 0.14 },
      { ratio: 1.84,  amp: 0.40, decay: 0.08 },
      { ratio: 2.72,  amp: 0.16, decay: 0.05 }
    ],
    attack: { type: 'lowpass', freq: 900, dur: 0.030, amp: 0.62 },
    reverbSend: 0.08
  },
  // Slime — soft clingy elastomer. A wet, very-low damped squelch, no ring.
  SLIME: {
    resonance: 0.16, baseFreq: 160, sizeExp: 0.85,
    modes: [
      { ratio: 1.000, amp: 0.85, decay: 0.09 }
    ],
    attack: { type: 'lowpass', freq: 600, dur: 0.050, amp: 0.78 },
    reverbSend: 0.04
  },
  // TNT — dull, dense casing thud (the crate, not the blast). Lowpass onset.
  TNT: {
    resonance: 0.40, baseFreq: 180, sizeExp: 0.9,
    modes: [
      { ratio: 1.000, amp: 0.95, decay: 0.16 },
      { ratio: 2.05,  amp: 0.34, decay: 0.09 }
    ],
    attack: { type: 'lowpass', freq: 700, dur: 0.040, amp: 0.66 },
    reverbSend: 0.06
  }
};

// Generic dull thud for any material without its own modal voice — neutral on
// purpose so an unmapped material reads as "something heavy hit" rather than
// borrowing NEON's bright acrylic ring. (All 22 current materials are mapped
// above; this only guards future additions.)
const FALLBACK = {
  resonance: 0.30, baseFreq: 240, sizeExp: 0.9,
  modes: [
    { ratio: 1.000, amp: 0.85, decay: 0.10 },
    { ratio: 1.84,  amp: 0.32, decay: 0.06 }
  ],
  attack: { type: 'lowpass', freq: 1600, dur: 0.016, amp: 0.55 },
  reverbSend: 0.06
};

export const Snd = {
  /** @type {AudioContext | null} */  ctx: null,
  /** @type {GainNode | null} */      master: null,
  /** @type {AudioNode | null} */     wetBus: null,
  enabled: true,

  /** Live count of oscillator / buffer voices currently playing. */
  _activeVoices: 0,
  /** performance.now() timestamps of recent spawns, pruned to the window. */
  _spawnTimes: [],

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window['webkitAudioContext'])();

      this.master = this.ctx.createGain();
      this.master.gain.value = PHYS.volume;

      // Master limiter — a gentle safety net, not a dynamics-killer.
      // Previous settings (-10 dB threshold, 6:1 ratio) were squashing
      // the very dynamic range the modal envelope is trying to
      // express: soft and hard hits ended up at nearly the same
      // perceived loudness. Now only the peaks above -6 dB get
      // reduced, and at 3:1 so the reduction is subtle. Dense
      // cascades still can't clip, but individual hits breathe.
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -6;
      comp.knee.value = 10;
      comp.ratio.value = 3;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      // Short room — noise-impulse convolver, low wet level
      const conv = this.ctx.createConvolver();
      const sr = this.ctx.sampleRate, irLen = sr * 0.8;
      const buf = this.ctx.createBuffer(2, irLen, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.5);
      }
      conv.buffer = buf;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.10;
      conv.connect(wet);
      wet.connect(comp);
      this.wetBus = conv;
    } catch (e) {
      this.ctx = null;
    }
  },

  applyVolume() { if (this.master) this.master.gain.value = PHYS.volume; },

  /** Returns true if the budget has room for another voice right now. */
  _canSpawn() {
    const now = performance.now();
    const w = this._spawnTimes;
    while (w.length && now - w[0] > SPAWN_WINDOW_MS) w.shift();
    if (w.length >= MAX_SPAWNS_PER_WINDOW) return false;
    if (this._activeVoices >= MAX_ACTIVE_VOICES) return false;
    return true;
  },

  /** Register a new voice start — call right before `node.start()`. */
  _claim() {
    this._activeVoices++;
    this._spawnTimes.push(performance.now());
  },

  /** Decrement when a voice ends. Wired via `node.onended`. */
  _release() {
    if (this._activeVoices > 0) this._activeVoices--;
  },

  /* ------------------------------------------------------------------ */
  /*  Primitives                                                         */
  /* ------------------------------------------------------------------ */

  bonk(freq, vol, dur, timbre) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    if (!this._canSpawn()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = timbre || 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.master);
    if (this.wetBus) g.connect(this.wetBus);
    o.onended = () => this._release();
    this._claim();
    o.start(t); o.stop(t + dur);
  },

  noise(dur, vol, cutoff) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    if (!this._canSpawn()) return;
    const t = this.ctx.currentTime;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.onended = () => this._release();
    this._claim();
    src.start(t);
  },

  /** Internal — sub-millisecond broadband click, the primary contact pop.
   *  No filter, hard edges — reads as an impulse, not a tone. Used as the
   *  first stage of a two-stage attack for hard materials. */
  _onset(on, gain, destination) {
    if (!this.ctx || gain <= 0) return;
    if (!this._canSpawn()) return;
    const t = this.ctx.currentTime;
    const len = Math.max(16, Math.floor(this.ctx.sampleRate * on.dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain * on.amp;
    src.connect(g); g.connect(destination);
    src.onended = () => this._release();
    this._claim();
    src.start(t);
  },

  /** Internal — short filtered noise burst for an attack transient. */
  _attack(atk, gain, destination) {
    if (!this.ctx || gain <= 0) return;
    if (!this._canSpawn()) return;
    const t = this.ctx.currentTime;
    const len = Math.max(32, Math.floor(this.ctx.sampleRate * atk.dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = atk.type;
    f.frequency.value = atk.freq;
    if (atk.type === 'bandpass' && atk.q) f.Q.value = atk.q;
    const g = this.ctx.createGain();
    g.gain.value = gain * atk.amp;
    src.connect(f); f.connect(g); g.connect(destination);
    src.onended = () => this._release();
    this._claim();
    src.start(t);
  },

  /* ------------------------------------------------------------------ */
  /*  Modal synthesis                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Emit one ball's voice at `strength`, damped by the other participant's
   * softness. Accepts a ball so it can extract size (pitch) + x (pan).
   *
   * @param {{mat: any, x?: number, r?: number}} ball
   * @param {number} strength          0..1 overall loudness
   * @param {number} otherSoftness     0..1 other participant's `deform`
   */
  emitMaterialSound(ball, strength, otherSoftness = 0.15) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    const mat = ball.mat;
    const profile = MODAL[mat.name] || FALLBACK;
    if (strength <= 0.005) return;

    const t = this.ctx.currentTime;

    // Per-ball retrigger cooldown. A ball in continuous contact with a
    // wall or another ball re-enters `collideX` every physics tick; we
    // only want a new voice every ~45 ms so rolling / sliding doesn't
    // turn into a buzzsaw.
    if (ball._sndT !== undefined && t - ball._sndT < PER_BALL_COOLDOWN) return;
    ball._sndT = t;

    // Stereo panner — position in the world maps to L/R in the mix.
    const cw = W.cw || window.innerWidth || 1000;
    const px = ball.x ?? cw / 2;
    const panVal = clamp((px / cw) * 2 - 1, -0.85, 0.85);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = panVal;
    pan.connect(this.master);

    // Two-stage attack. `onset` (if present) is an ultra-brief broadband
    // click — the unfiltered impulsive contact pop that precedes any
    // coupled surface ringing. `attack` is the filtered ring-up that
    // optionally shifts brighter with harder impacts (velHpScale) — real
    // metal contacts get sharper-spectrum as contact time shortens.
    //
    // Strength-dependent shaping (continuous, no stepped presets) so a
    // soft tap really does sound different from a hard slam — same
    // material, same pitch, but the dynamic envelope is different:
    //   • onset duration shortens with strength (Hertzian contact time)
    //   • mode decays lengthen with strength (more energy → longer ring)
    //   • reverb send rises with strength (hard hits radiate into the room)
    const attackAmp = strength * (1 - otherSoftness * 0.35);
    if (profile.onset) {
      const onsetDur = profile.onset.dur * clamp(1.20 - strength * 0.45, 0.70, 1.25);
      this._onset(
        { dur: onsetDur, amp: profile.onset.amp },
        strength * (1 - otherSoftness * 0.25),
        pan
      );
    }
    const atk = profile.attack;
    const effAtk = atk.velHpScale
      ? { ...atk, freq: atk.freq * (1 + strength * atk.velHpScale) }
      : atk;
    this._attack(effAtk, attackAmp, pan);

    // Modes — pitch + brightness depend on size + velocity
    const modeScale = strength * (1 - otherSoftness * 0.75) * profile.resonance;
    if (modeScale < 0.003) return;

    const radius = ball.r || REF_R;
    const sizeScale = Math.pow(REF_R / radius, profile.sizeExp || 0);
    const reverbSend = profile.reverbSend ?? 0.15;

    // Continuous strength-based envelope shaping.
    //
    // Every shaping curve here is deliberately smooth so the perceived
    // "level" of a hit varies continuously with impact — no stepped
    // thresholds, no audible plateaus. A soft tap, a nudge, a firm hit,
    // a slam, and a cannon-shot should all feel like distinct points
    // on one gradient rather than three discrete presets.
    const decayScale   = 0.20 + 0.80 * strength;
    const reverbGain   = reverbSend * 0.6 * (0.15 + 0.85 * strength);
    // Per-hit micro-variation. Repeated hits at near-identical intensities
    // otherwise sound identical, collapsing fine-grained differences in
    // the listener's perception. ±6 % amplitude + ±8 % decay jitter gives
    // the mix natural texture without changing the fundamental character.
    const ampJitter   = 1 + (Math.random() - 0.5) * 0.12;
    const decayJitter = 1 + (Math.random() - 0.5) * 0.16;

    for (let i = 0; i < profile.modes.length; i++) {
      const m = profile.modes[i];

      // Velocity-dependent excitation. Exponent 0.35 gives a smooth,
      // gradual mode fade-in rather than the hard on/off steps of a
      // steeper curve. Higher modes still need real energy to ring, but
      // they whisper at every strength instead of vanishing abruptly.
      const excitation = Math.pow(strength, i * 0.35);
      const peak = m.amp * modeScale * excitation * 0.85 * ampJitter;
      // Lowered cull threshold (0.001 → 0.0003) so quiet modes fade to
      // inaudibility continuously instead of snapping off at a threshold.
      if (peak < 0.0003) continue;

      const freq = profile.baseFreq * m.ratio * sizeScale;
      // Guard against silly-high frequencies on very small balls
      if (freq > 18000 || freq < 30) continue;

      // Voice budget — if the graph is saturated, drop the mode rather
      // than pile on. The fundamental mode (i=0) is the most important
      // so it goes first and the least important modes drop first.
      if (!this._canSpawn()) break;

      const detune = 1 + (Math.random() - 0.5) * 0.015;
      const decay = m.decay * decayScale * decayJitter;

      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * detune, t);

      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

      o.connect(g);
      g.connect(pan);

      // bright modes also tickle the reverb bus
      if (this.wetBus && freq > 1500 && reverbGain > 0) {
        const send = this.ctx.createGain();
        send.gain.value = reverbGain;
        g.connect(send);
        send.connect(this.wetBus);
      }

      o.onended = () => this._release();
      this._claim();
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  },

  /* ------------------------------------------------------------------ */
  /*  Events used by the physics layer                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Ball-on-ball collision. Each participant rings in its own location,
   * damped by the other's softness. `vn` is the pre-impact relative
   * normal speed; below ~14 px/s the contact is sliding / resting, not
   * a real impact, and we stay silent.
   *
   * Strength uses a square-root mapping: linear mag·k saturated far too
   * early (every cradle tick was already at max), so typical in-game
   * hits all sounded identically "hard". sqrt spreads the usable range
   * across the full 0..1 band — a gentle nudge sits around 0.2, a
   * typical mid-play impact near 0.5, a pinball launch or heavy drop
   * pushes toward 0.95. Now the dynamic-envelope changes in
   * emitMaterialSound actually get to express themselves.
   */
  collision(a, b, magnitude, vn = Infinity) {
    if (vn < MIN_AUDIBLE_VN_BALL) return;
    // Max(0, ...) defends against any future caller passing a negative
    // magnitude — Math.sqrt(-n) is NaN which then propagates through
    // every setValueAtTime() in the WebAudio graph and throws.
    const strength = clamp(Math.sqrt(Math.max(0, magnitude)) * 0.030, 0.03, 0.98);
    const softA = a.mat.deform ?? 0.2;
    const softB = b.mat.deform ?? 0.2;
    this.emitMaterialSound(a, strength, softB);
    this.emitMaterialSound(b, strength, softA);
  },

  /** Ball-on-wall / ball-on-peg — walls count as hard infrastructure.
   *  Same sliding-contact gate as `collision`, same sqrt mapping.       */
  wall(ball, magnitude, vn = Infinity) {
    if (vn < MIN_AUDIBLE_VN_WALL) return;
    const strength = clamp(Math.sqrt(Math.max(0, magnitude)) * 0.025, 0.03, 0.92);
    this.emitMaterialSound(ball, strength, 0.15);
  },

  /** Fragile material shatter — play at full strength + add bright shards. */
  shatter(ball) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    // Shatters are special events — bypass the per-ball cooldown so the
    // voice fires even if the ball just emitted a regular collision.
    ball._sndT = undefined;
    this.emitMaterialSound(ball, 0.95, 0);
    if (ball.mat.name === 'ICE') {
      this.bonk(1800, 0.22, 0.06, 'sine');
      this.bonk(2600, 0.15, 0.05, 'sine');
    } else if (ball.mat.name === 'GLASS') {
      this.bonk(2500, 0.20, 0.09, 'sine');
      this.bonk(3300, 0.14, 0.07, 'sine');
      this.bonk(4800, 0.10, 0.05, 'sine');
    }
    this.noise(0.30, 0.18, 5500);
  },

  click()  { this.bonk(800, 0.04, 0.02, 'square'); },
  spring() { this.bonk(450, 0.04, 0.04, 'triangle'); },

  /* ------------------------------------------------------------------ */
  /*  Rolling / sliding friction — persistent per-material voices        */
  /* ------------------------------------------------------------------ */
  /* While impact sounds are one-shot, rolling and sliding are continuous.
   * Each material has a shared looping noise source with a distinctive
   * filter (rubber squeaks, ice hisses high, bowling rumbles low…). Each
   * physics tick every rolling ball contributes to its material's mix;
   * `commitRoll` applies the mix to a smoothed gain so transitions are
   * seamless instead of chopped.                                        */

  /** @type {Record<string, {source:AudioBufferSourceNode, filter:BiquadFilterNode, gain:GainNode, pan:StereoPannerNode, profile:any}>} */
  _rollVoices: {},
  /** @type {Record<string, {total:number, rSum:number, xSum:number}>} */
  _rollMix: {},

  _rollProfile(matName) {
    switch (matName) {
      case 'STEEL':   return { type: 'bandpass', freq: 2200, q: 6.0, gs: 1.00 };
      case 'RUBBER':  return { type: 'bandpass', freq:  950, q: 3.8, gs: 1.55 };
      case 'GLASS':   return { type: 'highpass', freq: 5500, q: 1.0, gs: 0.85 };
      case 'BOWLING': return { type: 'lowpass',  freq: 280,  q: 0.7, gs: 1.15 };
      case 'NEON':    return { type: 'bandpass', freq: 1800, q: 3.0, gs: 0.90 };
      case 'GOLD':    return { type: 'bandpass', freq: 850,  q: 4.0, gs: 1.00 };
      case 'PLASMA':  return { type: 'bandpass', freq: 3200, q: 8.0, gs: 1.00 };
      case 'ICE':     return { type: 'highpass', freq: 7200, q: 1.0, gs: 1.00 };
      case 'MAGNET':  return { type: 'bandpass', freq: 1300, q: 3.5, gs: 1.00 };
      case 'MERCURY': return { type: 'lowpass',  freq: 520,  q: 0.7, gs: 0.90 };
      case 'DIAMOND': return { type: 'highpass', freq: 8500, q: 2.5, gs: 0.95 };
      case 'OBSIDIAN':return { type: 'bandpass', freq: 1600, q: 3.0, gs: 0.95 };
      // Granular + dense materials scrape rather than ring (broadband, not tonal).
      case 'SAND':    return { type: 'highpass', freq: 3600, q: 0.6, gs: 1.10 }; // grain hiss
      case 'ROCK':    return { type: 'bandpass', freq: 1400, q: 1.2, gs: 1.05 }; // gritty scrape
      case 'WOOD':    return { type: 'bandpass', freq: 700,  q: 1.4, gs: 1.05 }; // woody scrape
      // Fluids + soft bodies drag wetly/dully — low lowpass, no resonant band.
      case 'WATER':   return { type: 'lowpass',  freq: 650,  q: 0.7, gs: 0.80 };
      case 'HONEY':   return { type: 'lowpass',  freq: 360,  q: 0.7, gs: 0.85 };
      case 'LAVA':    return { type: 'lowpass',  freq: 240,  q: 0.7, gs: 0.90 };
      case 'SLIME':   return { type: 'lowpass',  freq: 600,  q: 0.8, gs: 0.85 };
      case 'BALLOON': return { type: 'lowpass',  freq: 1600, q: 0.9, gs: 0.90 }; // latex squeak
      case 'TNT':     return { type: 'lowpass',  freq: 420,  q: 0.8, gs: 1.00 };
      default:        return { type: 'bandpass', freq: 1500, q: 2.0, gs: 1.00 };
    }
  },

  _ensureRollVoice(matName) {
    const existing = this._rollVoices[matName];
    if (existing) return existing;
    if (!this.ctx) return null;

    const profile = this._rollProfile(matName);
    const sr = this.ctx.sampleRate;
    // Two-second pinkish loop — bias random white toward low freq so the
    // filter has body to work with on every material.
    const len = sr * 2;
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.62 + white * 0.38;
      d[i] = last;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buf; source.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = profile.type;
    filter.frequency.value = profile.freq;
    if (profile.q !== undefined) filter.Q.value = profile.q;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(pan);
    pan.connect(this.master);
    source.start();

    const voice = { source, filter, gain, pan, profile };
    this._rollVoices[matName] = voice;
    return voice;
  },

  /** Called per rolling ball per physics tick. Accumulates intensity
   *  (tangential speed, px/s), size (radius, px), and position (canvas x,
   *  px). The commit stage uses intensity as a weight to compute a
   *  representative size + position for the material, then derives filter
   *  frequency and stereo pan from them. */
  addRoll(matName, intensity, radius, x) {
    let m = this._rollMix[matName];
    if (!m) { m = { total: 0, rSum: 0, xSum: 0 }; this._rollMix[matName] = m; }
    m.total += intensity;
    m.rSum  += intensity * radius;
    m.xSum  += intensity * x;
  },

  /** After all balls have contributed, apply mix to voice gains with
   *  smoothing. Materials not contributing this frame fade to silence. */
  commitRoll() {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) {
      this._rollMix = {};
      return;
    }
    const t = this.ctx.currentTime;
    const cw = W.cw || window.innerWidth || 1000;
    for (const name in this._rollMix) {
      const m = this._rollMix[name];
      if (m.total <= 0) continue;
      const voice = this._ensureRollVoice(name);
      if (!voice) continue;
      const avgR = m.rSum / m.total;
      const avgX = m.xSum / m.total;
      // Filter frequency shift with size — smaller balls whine higher
      // (scale chosen to match the modal-impact sizeExp roughly).
      const freqScale = Math.pow(20 / Math.max(4, avgR), 0.75);
      const targetFreq = voice.profile.freq * freqScale;
      voice.filter.frequency.setTargetAtTime(targetFreq, t, 0.05);
      // Stereo pan weighted by intensity-weighted x of contributors.
      const panVal = clamp((avgX / cw) * 2 - 1, -0.85, 0.85);
      voice.pan.pan.setTargetAtTime(panVal, t, 0.06);
      // Gain
      const target = Math.min(0.18, m.total * 0.00035 * voice.profile.gs);
      voice.gain.gain.setTargetAtTime(target, t, 0.06);
    }
    for (const name in this._rollVoices) {
      if (this._rollMix[name] === undefined) {
        const voice = this._rollVoices[name];
        voice.gain.gain.setTargetAtTime(0, t, 0.09);
      }
    }
    this._rollMix = {};
  },

  /* ------------------------------------------------------------------ */
  /*  Plasma arc sustain — a continuous buzz under the crackle pops      */
  /* ------------------------------------------------------------------ */
  _plasmaHum: null,
  _plasmaHumTarget: 0,

  _ensurePlasmaHum() {
    if (this._plasmaHum) return this._plasmaHum;
    if (!this.ctx) return null;
    // Two detuned oscillators through a bandpass — cheap electric buzz.
    const o1 = this.ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = 112;
    const o2 = this.ctx.createOscillator();
    o2.type = 'square';   o2.frequency.value = 227;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 780; filter.Q.value = 6;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    o1.connect(filter); o2.connect(filter);
    filter.connect(gain); gain.connect(this.master);
    o1.start(); o2.start();
    this._plasmaHum = { o1, o2, filter, gain };
    return this._plasmaHum;
  },

  /** Called once per physics tick with the sum of pair intensities (each
   *  pair contributes t², 0..1, where t is closeness). */
  setPlasmaHum(intensity) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    const hum = this._ensurePlasmaHum();
    if (!hum) return;
    const target = Math.min(0.045, intensity * 0.025);
    const t = this.ctx.currentTime;
    hum.gain.gain.setTargetAtTime(target, t, 0.12);
  },

  /** Short electric crackle — used when plasma balls are close enough to
   *  arc. Bandpass-filtered noise at high frequencies. */
  crackle(x = 0, pitch = 1) {
    if (!this.ctx || !PHYS.sound || PHYS.volume <= 0) return;
    if (!this._canSpawn()) return;
    const t = this.ctx.currentTime;
    const dur = 0.04 + Math.random() * 0.04;
    const sr = this.ctx.sampleRate;
    const len = Math.max(32, Math.floor(sr * dur));
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.2);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = (2500 + Math.random() * 2500) * pitch;
    f.Q.value = 4;
    const g = this.ctx.createGain();
    g.gain.value = 0.06 + Math.random() * 0.04;
    const pan = this.ctx.createStereoPanner();
    const cw = W.cw || window.innerWidth || 1000;
    pan.pan.value = clamp((x / cw) * 2 - 1, -0.85, 0.85);
    src.connect(f); f.connect(g); g.connect(pan); pan.connect(this.master);
    src.onended = () => this._release();
    this._claim();
    src.start(t);
  }
};
