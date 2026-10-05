const assert = require('assert');

// Mock browser environment for unit testing PCControls
class MockElement {
  constructor(tagName = 'div', id = '', classList = []) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classes = new Set(classList);
    this.listeners = new Map();
    this.parentElement = null;
    this.children = [];
    this.style = {};
    this.pointerLockRequested = false;
  }

  get classList() {
    return {
      contains: (c) => this.classes.has(c),
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c)
    };
  }

  addEventListener(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, []);
    this.listeners.get(evt).push(fn);
  }

  removeEventListener(evt, fn) {
    if (!this.listeners.has(evt)) return;
    const arr = this.listeners.get(evt);
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  dispatchEvent(evt) {
    if (!evt.target) evt.target = this;
    const arr = this.listeners.get(evt.type) || [];
    for (const fn of [...arr]) {
      fn(evt);
    }
  }

  contains(child) {
    let curr = child;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  closest(selector) {
    const selectors = selector.split(',').map(s => s.trim());
    let curr = this;
    while (curr) {
      for (const sel of selectors) {
        if (sel.startsWith('.') && curr.classes.has(sel.slice(1))) return curr;
        if (sel.startsWith('#') && curr.id === sel.slice(1)) return curr;
        if (curr.tagName === sel.toUpperCase()) return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  requestPointerLock() {
    this.pointerLockRequested = true;
    return Promise.resolve();
  }
}

// Global mocks
global.Element = MockElement;
global.window = new MockElement('window');
global.document = new MockElement('document');
global.document.body = new MockElement('body');
global.document.pointerLockElement = null;

// Mock DOM elements
const canvasContainer = new MockElement('div', 'game-canvas-container', ['canvas-container']);
const canvas = new MockElement('canvas');
canvas.parentElement = canvasContainer;
canvasContainer.children.push(canvas);

const btnAim = new MockElement('button', 'btn-camera-aim-toggle', ['camera-aim-btn']);
const hudScore = new MockElement('div', 'hud-p1-score', ['hud-score-card']);
const settingsModal = new MockElement('div', 'modal-settings', ['modal-overlay']);

global.document.getElementById = (id) => {
  if (id === 'game-canvas-container') return canvasContainer;
  if (id === 'btn-camera-aim-toggle') return btnAim;
  if (id === 'setting-mouse-sens') return null;
  return null;
};

// Mock THREE camera
const mockCamera = {
  rotation: { order: 'XYZ', x: 0, y: 0, z: 0 },
  position: { copy: () => { }, set: () => { } }
};

// Load PCControls using dynamic import or mock imports
async function runTest() {
  console.log('--- TESTING PC CONTROLS & POINTER LOCK FIX ---');

  // Load controls.js and adapt imports for Node.js
  const fs = require('fs');
  const path = require('path');
  const controlsSource = fs.readFileSync(path.join(__dirname, '../client/src/controls.js'), 'utf8')
    .replace("import * as THREE from '/lib/three/three.module.js';", "import * as THREE from 'three';")
    .replace("import { GAME_CONFIG } from './config.js';", "const GAME_CONFIG = { PLAYER: { MOUSE_SENSITIVITY: 0.0022 }, WEAPON: { FIRE_RATE_MS: 110 } };");

  const tempPath = path.join(__dirname, 'temp_controls_test.mjs');
  fs.writeFileSync(tempPath, controlsSource);

  let PCControls;
  try {
    const mod = await import('./temp_controls_test.mjs');
    PCControls = mod.PCControls;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (e) { }
  }

  let shotsFired = 0;
  let scopedState = null;
  let reloadsCount = 0;

  const controls = new PCControls(
    mockCamera,
    canvas,
    () => { shotsFired++; return true; },
    (scoped) => { scopedState = scoped; },
    () => { },
    () => { reloadsCount++; },
    () => { }
  );

  assert.equal(controls.isLocked, false, 'Controls should initially not be locked');
  assert.equal(controls.isFiring, false, 'Controls should not be firing initially');
  console.log('✔ Initial state verified: isLocked = false, isFiring = false');

  // TEST 1: UI Clicks MUST NOT trigger shooting or pointer lock
  console.log('Testing UI element clicks (button, score card, modal)...');
  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: btnAim });
  assert.equal(shotsFired, 0, 'Clicking button must NEVER fire weapon');
  assert.equal(canvas.pointerLockRequested, false, 'Clicking button must not request pointer lock');

  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: hudScore });
  assert.equal(shotsFired, 0, 'Clicking HUD score card must NEVER fire weapon');

  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: settingsModal });
  assert.equal(shotsFired, 0, 'Clicking settings modal must NEVER fire weapon');
  console.log('✔ Verified: UI element clicks NEVER trigger weapon shooting or pointer lock');

  // TEST 2: Clicking gameplay canvas requests pointer lock WITHOUT firing
  console.log('Testing canvas click to acquire pointer lock...');
  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: canvas });
  assert.equal(canvas.pointerLockRequested, true, 'Clicking canvas must request pointer lock');
  assert.equal(shotsFired, 0, 'Clicking canvas to acquire lock must NOT fire a shot!');
  assert.equal(controls.isFiring, false, 'isFiring must remain false on lock acquisition click');
  console.log('✔ Verified: Canvas click requested pointer lock without shooting');

  // TEST 3: Pointer lock engaged
  console.log('Engaging pointer lock...');
  global.document.pointerLockElement = canvas;
  controls.onPointerLockChange();
  assert.equal(controls.isLocked, true, 'controls.isLocked should be true after pointerlockchange');
  console.log('✔ Verified: Pointer lock active');

  // TEST 4: Mouse movement controls camera pitch and yaw
  console.log('Testing mouse look while locked...');
  const initialYaw = controls.yaw;
  const initialPitch = controls.pitch;

  controls.onMouseMove({ movementX: 20, movementY: -15 });
  assert.notEqual(controls.yaw, initialYaw, 'Yaw must change when moving mouse horizontally');
  assert.notEqual(controls.pitch, initialPitch, 'Pitch must change when moving mouse vertically');

  controls.update(0.016, { x: 0, y: 1.7, z: 0 });
  assert.equal(mockCamera.rotation.order, 'YXZ', 'Camera rotation order must be YXZ');
  assert.equal(mockCamera.rotation.y, controls.yaw, 'Camera rotation Y must match controls yaw');
  assert.equal(mockCamera.rotation.x, controls.pitch, 'Camera rotation X must match controls pitch');
  console.log(`✔ Verified: Mouse look works (yaw: ${controls.yaw.toFixed(4)}, pitch: ${controls.pitch.toFixed(4)})`);

  // TEST 5: Vertical pitch clamping
  console.log('Testing pitch clamping (-1.45 to +1.45)...');
  controls.onMouseMove({ movementX: 0, movementY: -10000 }); // Look way up
  assert(controls.pitch <= 1.45, 'Pitch up must be clamped at 1.45 rad');
  controls.onMouseMove({ movementX: 0, movementY: 20000 }); // Look way down
  assert(controls.pitch >= -1.45, 'Pitch down must be clamped at -1.45 rad');
  console.log('✔ Verified: Pitch clamping strictly enforced');

  // TEST 6: Shooting while pointer locked
  console.log('Testing LMB shooting while locked...');
  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: canvas });
  assert.equal(shotsFired, 1, 'LMB while locked MUST fire weapon');
  assert.equal(controls.isFiring, true, 'isFiring should be true while LMB held');

  // Mouseup stops firing
  canvas.dispatchEvent({ type: 'mouseup', button: 0, target: canvas });
  assert.equal(controls.isFiring, false, 'Mouseup MUST stop firing');
  console.log('✔ Verified: LMB shooting and continuous fire release work correctly');

  // TEST 7: Scoping with RMB while locked
  console.log('Testing RMB scoping while locked...');
  canvas.dispatchEvent({ type: 'mousedown', button: 2, target: canvas });
  assert.equal(controls.isScoped, true, 'RMB while locked MUST activate scope');
  assert.equal(scopedState, true, 'onScope(true) must be called');

  canvas.dispatchEvent({ type: 'mouseup', button: 2, target: canvas });
  assert.equal(controls.isScoped, false, 'Releasing RMB MUST deactivate scope');
  assert.equal(scopedState, false, 'onScope(false) must be called');
  console.log('✔ Verified: RMB scope activation and release work correctly');

  // TEST 8: ESC key releases pointer lock
  console.log('Testing ESC pointer lock release...');
  global.document.pointerLockElement = null;
  controls.onPointerLockChange();
  assert.equal(controls.isLocked, false, 'Releasing pointer lock must set isLocked = false');

  // Mouse move while unlocked should NOT rotate camera
  const yawBefore = controls.yaw;
  const pitchBefore = controls.pitch;
  controls.onMouseMove({ movementX: 50, movementY: 50 });
  assert.equal(controls.yaw, yawBefore, 'Mouse move while unlocked must NOT change yaw');
  assert.equal(controls.pitch, pitchBefore, 'Mouse move while unlocked must NOT change pitch');
  console.log('✔ Verified: Releasing pointer lock freezes camera look');

  // TEST 9: Clicking canvas re-acquires lock without firing
  console.log('Testing re-acquiring lock on canvas click...');
  canvas.pointerLockRequested = false;
  const shotsBeforeReacquire = shotsFired;
  canvas.dispatchEvent({ type: 'mousedown', button: 0, target: canvas });
  assert.equal(canvas.pointerLockRequested, true, 'Re-clicking canvas must request lock again');
  assert.equal(shotsFired, shotsBeforeReacquire, 'Re-acquiring lock must NOT fire weapon');
  console.log('✔ Verified: Pointer lock can be reacquired on canvas click without shooting');

  // TEST 10: Dispose cleanly removes listeners
  console.log('Testing controls.dispose()...');
  controls.dispose();
  assert.equal(controls.enabled, false, 'dispose must disable controls');
  console.log('✔ Verified: controls.dispose() successfully executed');

  console.log('\n--- ALL PC CONTROLS & POINTER LOCK TESTS PASSED! ---');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
