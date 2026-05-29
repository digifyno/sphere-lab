/**
 * Boot smoke test — imports the whole app under the browser shim. main.js runs
 * init() at module load (loadPrefs, resize, buildMatButtons, bindSliders,
 * bindButtons, applySavedPrefs, setTool, loadScene, startLoop), so a clean
 * import proves the entire UI/persistence/scene wiring graph resolves and runs
 * without throwing — the strongest end-to-end check available head-less.
 *
 * Run: node tests/boot.test.mjs
 */
import './shim.mjs';

try {
  await import('../src/main.js');
  console.log('✓ app boots — main.js init() ran clean (UI, prefs, scene, loop wired)');
  process.exit(0);
} catch (e) {
  console.error('✗ boot failed:', e && e.stack ? e.stack : e);
  process.exit(1);
}
