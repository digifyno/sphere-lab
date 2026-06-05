/**
 * Hex color utilities.
 *
 * Supports `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` inputs. Always emits
 * `#rrggbb` from `mix` (so downstream code can continue to use 6-char hex
 * if it wants). `withAlpha(hex, a)` is the safe way to draw transparent
 * fills — don't concatenate alpha strings onto hex values directly.
 */

import { clamp, lerp } from './math.js';

/** Parse a hex color into [r,g,b] ∈ [0,255], ignoring any alpha component. */
export function hexToRgb(h) {
  let s = h.startsWith('#') ? h.slice(1) : h;
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length === 8) s = s.slice(0, 6);
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const c = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

export function mix(h1, h2, t) {
  const [r1, g1, b1] = hexToRgb(h1);
  const [r2, g2, b2] = hexToRgb(h2);
  return rgbToHex(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t));
}

export const lighten = (h, t) => mix(h, '#ffffff', t);
export const darken  = (h, t) => mix(h, '#000000', t);

/**
 * Gamma-correct mix: decode sRGB → linear, interpolate in linear light, then
 * re-encode. Light transport is linear; lerping raw sRGB channels darkens and
 * desaturates mid-tones, so a lit→dark roll-off passes through a muddy band.
 * Blending in linear light keeps the transition bright + saturated. Use for
 * diffuse body shading; keep plain `mix` for emissive/FX stops (those stay
 * gamma-encoded). γ≈2.2 is close enough and cheap.
 */
const _GAMMA = 2.2, _GAMMA_INV = 1 / 2.2;
const _toLin  = v => Math.pow(v / 255, _GAMMA);
const _toSrgb = v => Math.pow(v < 0 ? 0 : v, _GAMMA_INV) * 255;
export function mixLinear(h1, h2, t) {
  const [r1, g1, b1] = hexToRgb(h1);
  const [r2, g2, b2] = hexToRgb(h2);
  return rgbToHex(
    _toSrgb(lerp(_toLin(r1), _toLin(r2), t)),
    _toSrgb(lerp(_toLin(g1), _toLin(g2), t)),
    _toSrgb(lerp(_toLin(b1), _toLin(b2), t)),
  );
}
export const lightenL = (h, t) => mixLinear(h, '#ffffff', t);
export const darkenL  = (h, t) => mixLinear(h, '#000000', t);

/**
 * Produce `rgba(r, g, b, a)` from any hex input + a 0..1 alpha.
 * Replaces the fragile `color + 'XX'` concatenation pattern — that only
 * worked on 6-char hex inputs.
 */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}
