/**
 * Minimal browser shim so the real simulation modules import + run under
 * Node (no DOM, no Web Audio). Audio is a safe no-op because `Snd.ctx`
 * stays null until a user gesture, and every emit guards on it.
 *
 * Import this FIRST, before any `src/` module.
 */
const noop = () => {};

function fakeCtx() {
  const grad = { addColorStop: noop };
  const dims = (a) => {
    const n = a.filter(v => typeof v === 'number');
    return [Math.max(1, (n[n.length - 2] | 0) || 1), Math.max(1, (n[n.length - 1] | 0) || 1)];
  };
  const imageData = (...a) => {
    const [w, h] = dims(a);
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  };
  return new Proxy({ canvas: { width: 1280, height: 720 } }, {
    get: (t, p) => {
      if (p in t) return t[p];
      if (p === 'createImageData' || p === 'getImageData') return imageData;
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createConicGradient') return () => grad;
      if (p === 'createPattern') return () => ({ setTransform: noop });
      if (p === 'measureText') return () => ({ width: 0 });
      if (p === 'getContext') return fakeCtx;
      return noop;
    },
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

function fakeEl() {
  return {
    style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    textContent: '', value: '', width: 1280, height: 720,
    getContext: fakeCtx,
    appendChild: noop, removeChild: noop, remove: noop,
    setAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }),
    focus: noop, click: noop,
  };
}

const documentStub = {
  getElementById: fakeEl,
  createElement: fakeEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: fakeEl(),
  body: fakeEl(),
  addEventListener: noop, removeEventListener: noop,
};

const windowStub = {
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
};

globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.requestAnimationFrame = noop;
globalThis.cancelAnimationFrame = noop;
globalThis.getComputedStyle = windowStub.getComputedStyle;
globalThis.devicePixelRatio = 1;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
