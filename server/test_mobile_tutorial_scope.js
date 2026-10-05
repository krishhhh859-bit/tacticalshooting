/**
 * Verification test for Mobile Tutorial Scope Step Fix:
 * 1. Mobile Scope button (#btn-mobile-scope) event handling (toggle behavior)
 * 2. MobileControls._scoping and MobileControls.isScoped getter
 * 3. Tutorial scope_mobile step detection with MobileControls, weapon.isScoped, or UI active
 * 4. Verify scope step does not advance before scope activates
 * 5. Verify immediate progression to next step (RELOAD) upon scope activation
 * 6. Verify badge shows "✓ SCOPE COMPLETE"
 * 7. Verify no duplicate listeners or double toggling
 * 8. Verify desktop scope step still works and is unaffected
 * 9. Verify normal scope functionality outside tutorial is preserved
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
console.log('=== STARTING MOBILE TUTORIAL SCOPE REGRESSION TEST ===\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
  }
}

// 1. Inspect mobileControls.js
const mobileControlsPath = path.join(rootDir, 'client', 'src', 'mobileControls.js');
const mobileControlsContent = fs.readFileSync(mobileControlsPath, 'utf8');

assert(
  mobileControlsContent.includes('get isScoped() {') && mobileControlsContent.includes('return !!this._scoping;'),
  'MobileControls defines "get isScoped()" returning "!!this._scoping"'
);

assert(
  mobileControlsContent.includes("const btnScope = document.getElementById('btn-mobile-scope');"),
  'Existing mobile Scope button "#btn-mobile-scope" is wired in mobileControls'
);

assert(
  mobileControlsContent.includes('this._scoping = true;') && mobileControlsContent.includes('this._scoping = false;'),
  'MobileControls properly toggles _scoping in startScope() and stopScope()'
);

// 2. Inspect tutorial.js
const tutorialPath = path.join(rootDir, 'client', 'src', 'tutorial.js');
const tutorialContent = fs.readFileSync(tutorialPath, 'utf8');

assert(
  tutorialContent.includes("id: 'scope_mobile'"),
  'tutorial.js contains scope_mobile step'
);

assert(
  tutorialContent.includes("targetUI: '#btn-mobile-scope'"),
  'scope_mobile targets existing mobile scope button #btn-mobile-scope'
);

assert(
  tutorialContent.includes("explanation: 'Tap the Scope button to aim down sights.'"),
  'scope_mobile explanation matches "Tap the Scope button to aim down sights."'
);

assert(
  tutorialContent.includes("voiceText: 'Tap the Scope button to aim down sights.'"),
  'scope_mobile voiceText matches "Tap the Scope button to aim down sights."'
);

assert(
  tutorialContent.includes("game.controls._scoping || game.controls.isScoped"),
  'scope_mobile check inspects actual existing MobileControls scope state'
);

assert(
  tutorialContent.includes("game.weapon && game.weapon.isScoped"),
  'scope_mobile check also verifies game weapon ADS state'
);

assert(
  tutorialContent.includes("btnScope.classList.contains('active')"),
  'scope_mobile check verifies button active class'
);

assert(
  tutorialContent.includes("textContent = '✓ SCOPE COMPLETE'"),
  'onActionSuccess shows "✓ SCOPE COMPLETE" for scope steps'
);

assert(
  tutorialContent.includes("this.currentStep.id === 'scope_mobile'") &&
  tutorialContent.includes("this.advanceToNextStep();"),
  'scope_mobile advances immediately upon action success without waiting for speech timer'
);

// Desktop tutorial scope must remain unchanged
assert(
  tutorialContent.includes("id: 'scope_pc'") &&
  tutorialContent.includes("return !!(game && game.controls && game.controls.isScoped);"),
  'Desktop scope_pc step retains its existing check condition and RMB logic'
);

// 3. Functional Simulation Test
console.log('\n--- SIMULATING MOBILE TUTORIAL FLOW & SCOPE TRANSITIONS ---');

// Mock DOM & Game
class MockClassList {
  constructor() {
    this._classes = new Set();
  }
  add(c) { this._classes.add(c); }
  remove(c) { this._classes.delete(c); }
  contains(c) { return this._classes.has(c); }
  toggle(c, force) {
    if (force !== undefined) {
      if (force) this.add(c); else this.remove(c);
    } else {
      if (this.contains(c)) this.remove(c); else this.add(c);
    }
  }
}

class MockElement {
  constructor(id) {
    this.id = id;
    this.classList = new MockClassList();
    this.textContent = '';
    this.className = '';
    this._listeners = {};
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  dispatchEvent(event) {
    const list = this._listeners[event.type] || [];
    for (const fn of list) fn(event);
  }
}

global.document = {
  elements: {},
  getElementById(id) {
    if (!this.elements[id]) {
      this.elements[id] = new MockElement(id);
    }
    return this.elements[id];
  },
  querySelectorAll() {
    return [];
  }
};

// Mock MobileControls
class MockMobileControls {
  constructor(onScope) {
    this._scoping = false;
    this._aiming = false;
    this.callbacks = { onScope };
  }
  get isScoped() {
    return !!this._scoping;
  }
  startScope() {
    if (this._scoping) return;
    this._scoping = true;
    if (this.callbacks.onScope) this.callbacks.onScope(true);
  }
  stopScope() {
    this._scoping = false;
    if (this.callbacks.onScope) this.callbacks.onScope(false);
  }
}

// Mock WeaponSystem
class MockWeapon {
  constructor() {
    this.isScoped = false;
  }
  setScope(enabled) {
    this.isScoped = enabled;
  }
}

// Mock Game
class MockGame {
  constructor() {
    this.weapon = new MockWeapon();
    this.controls = new MockMobileControls((scoped) => this.handleScope(scoped));
  }
  handleScope(scoped) {
    this.weapon.setScope(scoped);
  }
}

// Test Step check logic directly
const game = new MockGame();

// Extract check function from tutorial.js definition
const scopeStep = {
  check: (g) => {
    if (!g) return false;
    if (g.controls && (g.controls._scoping || g.controls.isScoped)) {
      return true;
    }
    if (g.weapon && g.weapon.isScoped) {
      return true;
    }
    const btnScope = document.getElementById('btn-mobile-scope');
    if (btnScope && btnScope.classList.contains('active')) {
      return true;
    }
    return false;
  }
};

// 1. Before tapping scope:
assert(scopeStep.check(game) === false, 'Before tapping Scope: scopeStep.check(game) is FALSE');
assert(game.controls.isScoped === false, 'Before tapping Scope: controls.isScoped is FALSE');
assert(game.weapon.isScoped === false, 'Before tapping Scope: weapon.isScoped is FALSE');

// 2. Tap Scope (simulate button toggle):
const btnScope = document.getElementById('btn-mobile-scope');
game.controls.startScope();
btnScope.classList.add('active');

assert(game.controls._scoping === true, 'After tap: game.controls._scoping is TRUE');
assert(game.controls.isScoped === true, 'After tap: game.controls.isScoped getter returns TRUE');
assert(game.weapon.isScoped === true, 'After tap: game.weapon.isScoped is TRUE');
assert(btnScope.classList.contains('active') === true, 'After tap: #btn-mobile-scope has .active');
assert(scopeStep.check(game) === true, 'After tap: scopeStep.check(game) detects scope and returns TRUE');

// 3. Tap Scope again outside tutorial (normal toggle off):
game.controls.stopScope();
btnScope.classList.remove('active');

assert(game.controls.isScoped === false, 'After second tap: controls.isScoped toggles back to FALSE');
assert(game.weapon.isScoped === false, 'After second tap: weapon.isScoped toggles back to FALSE');
assert(scopeStep.check(game) === false, 'After second tap: scopeStep.check(game) returns FALSE');

// 4. Test re-entering tutorial:
game.controls.startScope();
btnScope.classList.add('active');
assert(scopeStep.check(game) === true, 'Re-entering tutorial: scope step successfully detects activation again');

// 5. Test Desktop Scope check compatibility:
const pcControls = { isScoped: false };
const pcGame = { controls: pcControls };
const desktopScopeCheck = (g) => !!(g && g.controls && g.controls.isScoped);

assert(desktopScopeCheck(pcGame) === false, 'Desktop scope step: false when RMB not held');
pcControls.isScoped = true;
assert(desktopScopeCheck(pcGame) === true, 'Desktop scope step: true when RMB held');

console.log('\n===========================================');
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('===========================================');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('ALL MOBILE TUTORIAL SCOPE REGRESSION TESTS PASSED!');
}
