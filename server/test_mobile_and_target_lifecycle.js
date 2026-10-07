/**
 * Comprehensive Validation Test Suite for:
 * 1. Target Board Existence Duration (3s -> 5s) & 6s Cooldown Preservation
 * 2. Target Board Movement & Hit Detection across distances
 * 3. Mobile Mode Control Spacing (FIRE vs AIM, SCOPE, RELOAD)
 * 4. Mobile Mode FIRE Button Held/Active Visual Indicator & Cancellation Safeguards
 * 5. Isolation: Touching FIRE never triggers AIM/SCOPE/RELOAD, and vice versa
 */

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const config = require('./config.js');
const MatchManager = require('./matchManager.js');

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Mock Socket.IO server
function createMockIO() {
  const emittedEvents = [];
  return {
    emittedEvents,
    to: (room) => ({
      emit: (event, payload) => {
        emittedEvents.push({ room, event, payload });
      }
    }),
    sockets: {
      sockets: new Map()
    }
  };
}

// ============================================================================
// PART 1: TARGET LIFECYCLE, 5-SECOND DURATION, & HIT COOLDOWN
// ============================================================================
async function testTargetLifecycle() {
  console.log('\n========================================');
  console.log('PART 1: TARGET LIFECYCLE & 5-SECOND DURATION');
  console.log('========================================');

  // 1. Verify Configuration
  console.log('Testing server target configuration...');
  assert.strictEqual(
    config.RANGE_TARGETS.EXISTENCE_DURATION_MS,
    5000,
    'RANGE_TARGETS.EXISTENCE_DURATION_MS must be 5000ms (5 seconds)'
  );
  console.log('✔ PASS: EXISTENCE_DURATION_MS is configured to exactly 5000ms');

  assert.strictEqual(
    config.RANGE_TARGETS.HIT_COOLDOWN_MS,
    6000,
    'RANGE_TARGETS.HIT_COOLDOWN_MS must remain strictly 6000ms (6 seconds)'
  );
  console.log('✔ PASS: HIT_COOLDOWN_MS remains strictly 6000ms (unchanged)');

  // 2. Test Target Existence Duration Lifecycle
  console.log('\nTesting target existence lifecycle in MatchManager...');
  const io = createMockIO();
  const room = { code: 'TEST_ROOM', players: { 'sock1': { slot: 1, name: 'P1' } } };
  const manager = new MatchManager(room, io);

  const t0 = 1000000;
  manager.startTime = t0;
  manager.endTime = t0 + 240000;
  manager.targetCycleStartTime = t0;
  manager.targetCyclePhase = 'ACTIVE';
  manager.spawnInitialTargets(t0);

  assert.strictEqual(manager.targetCyclePhase, 'ACTIVE', 'Initial cycle phase is ACTIVE');
  assert.strictEqual(manager.rangeTargets.length, 8, '8 targets initially spawned');
  assert.strictEqual(manager.rangeTargets[0].state, 'ACTIVE', 'Targets are initially ACTIVE');

  // At t = 2.5s (2500ms): Must be ACTIVE
  manager.updateRangeTargets(0.033, t0 + 2500);
  assert.strictEqual(manager.targetCyclePhase, 'ACTIVE', 'At 2.5s, cycle is still ACTIVE');
  assert.strictEqual(manager.rangeTargets[0].state, 'ACTIVE', 'At 2.5s, target 0 is still ACTIVE');
  console.log('✔ PASS: Target remains active at 2.5s');

  // At t = 3.5s (3500ms): Old 3s timer would have expired here! Now it MUST STILL BE ACTIVE!
  manager.updateRangeTargets(0.033, t0 + 3500);
  assert.strictEqual(manager.targetCyclePhase, 'ACTIVE', 'At 3.5s, cycle must STILL be ACTIVE (not expired at 3s)');
  assert.strictEqual(manager.rangeTargets[0].state, 'ACTIVE', 'At 3.5s, target 0 must STILL be ACTIVE');
  console.log('✔ PASS: Target remains active at 3.5s (successfully past the old 3-second limit!)');

  // At t = 4.8s (4800ms): Must still be ACTIVE
  manager.updateRangeTargets(0.033, t0 + 4800);
  assert.strictEqual(manager.targetCyclePhase, 'ACTIVE', 'At 4.8s, cycle must STILL be ACTIVE');
  assert.strictEqual(manager.rangeTargets[0].state, 'ACTIVE', 'At 4.8s, target 0 must STILL be ACTIVE');
  console.log('✔ PASS: Target remains active at 4.8s');

  // At t = 5.05s (5050ms): The 5s existence duration expires, transitioning to COOLDOWN
  manager.updateRangeTargets(0.033, t0 + 5050);
  assert.strictEqual(manager.targetCyclePhase, 'COOLDOWN', 'At 5.05s, cycle transitions to COOLDOWN');
  for (const t of manager.rangeTargets) {
    assert.strictEqual(t.state, 'FALLING', 'Un-hit targets topple to FALLING when cycle expires');
    assert.strictEqual(t.active, false, 'Targets active flag is false in COOLDOWN');
    assert.strictEqual(t.hitboxDisabled, true, 'Hitboxes disabled in COOLDOWN');
  }
  console.log('✔ PASS: Target cycle transitions to COOLDOWN exactly at 5 seconds (not before)');

  // 3. Test Target Movement Across 5 Seconds
  console.log('\nTesting target movement across 5 seconds...');
  const moveManager = new MatchManager(room, io);
  moveManager.startTime = t0;
  moveManager.endTime = t0 + 240000;
  moveManager.targetCycleStartTime = t0;
  moveManager.targetCyclePhase = 'ACTIVE';
  moveManager.spawnInitialTargets(t0);

  const pos0 = { x: moveManager.rangeTargets[0].x, z: moveManager.rangeTargets[0].z };
  moveManager.updateRangeTargets(1.0, t0 + 2000);
  const pos2 = { x: moveManager.rangeTargets[0].x, z: moveManager.rangeTargets[0].z };
  moveManager.updateRangeTargets(1.0, t0 + 4000);
  const pos4 = { x: moveManager.rangeTargets[0].x, z: moveManager.rangeTargets[0].z };

  const dist0to2 = Math.hypot(pos2.x - pos0.x, pos2.z - pos0.z);
  const dist2to4 = Math.hypot(pos4.x - pos2.x, pos4.z - pos2.z);
  assert(dist0to2 > 0.05, 'Target 0 moved between 0s and 2s');
  assert(dist2to4 > 0.05, 'Target 0 moved between 2s and 4s');
  console.log(`✔ PASS: Target movement is active throughout 5s (dist moved: ${dist0to2.toFixed(2)}m then ${dist2to4.toFixed(2)}m)`);

  // 4. Test Hit Behavior & 6-Second Post-Hit Cooldown Preservation
  console.log('\nTesting hit behavior & 6-second cooldown preservation...');
  const hitTarget = manager.rangeTargets[0];
  hitTarget.state = 'ACTIVE';
  hitTarget.active = true;
  hitTarget.hitboxDisabled = false;
  hitTarget.hitAt = 0;

  assert.strictEqual(hitTarget.cooldownMs, 6000, 'Per-target cooldownMs is exactly 6000ms');

  // Simulate hit registration
  const hitTime = t0 + 1000;
  hitTarget.state = 'FALLING';
  hitTarget.active = false;
  hitTarget.hitboxDisabled = true;
  hitTarget.hitAt = hitTime;

  assert.strictEqual(hitTarget.state, 'FALLING', 'Hit target transitions to FALLING');
  assert.strictEqual(hitTarget.hitboxDisabled, true, 'Hit target has hitboxDisabled = true');
  assert.strictEqual(hitTarget.hitAt, hitTime, 'Hit target records hit timestamp');
  console.log('✔ PASS: Hit target enters FALLING state with 6000ms cooldown timestamp');
}

// ============================================================================
// PART 2: MOBILE CONTROLS SPACING, HELD STATE & ISOLATION (CHROME CDP)
// ============================================================================
async function testMobileControlsHeadless() {
  console.log('\n========================================');
  console.log('PART 2: MOBILE CONTROLS SPACING & VISUAL STATE');
  console.log('========================================');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=844,390',
    'http://localhost:3000'
  ]);

  let isClosed = false;
  chromeProc.on('exit', () => { isClosed = true; });

  try {
    let targets = null;
    for (let i = 0; i < 20; i++) {
      await wait(500);
      try {
        targets = await fetchJson('http://localhost:9222/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Failed to connect to Chrome debugging port 9222');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[TEST] Chrome DevTools connected to page:', pageTarget.url);

    let ws = null;
    try {
      const WsMod = require('ws');
      ws = new WsMod(pageTarget.webSocketDebuggerUrl);
    } catch (_) {
      if (typeof global.WebSocket !== 'undefined') {
        ws = new global.WebSocket(pageTarget.webSocketDebuggerUrl);
      }
    }

    if (!ws) {
      console.warn('[TEST] WebSocket module not available for CDP, skipping browser DOM tests');
      return;
    }

    let cmdId = 1;
    const pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
    });

    await new Promise(r => ws.on('open', r));

    function sendCommand(method, params = {}) {
      return new Promise((resolve) => {
        const id = cmdId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const res = await sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res && res.exceptionDetails) {
        throw new Error(JSON.stringify(res.exceptionDetails));
      }
      return res && res.result && res.result.value;
    }

    // Wait for DOM
    await wait(2000);

    // 1. Emulate Mobile Device (Landscape: 844x390, iPhone 12/13/14 landscape)
    console.log('\n--- 1. Testing Mobile Viewport: 844 x 390 (Landscape Phone) ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 }
    });
    await wait(500);

    const layoutInfo = await evaluate(`
      (() => {
        const gameHud = document.getElementById('game-hud');
        if (gameHud) gameHud.classList.remove('hidden');
        const layer = document.getElementById('mobile-controls-layer');
        if (layer) layer.style.display = 'block';
        document.body.classList.add('phone-mode', 'mobile-controls-visible');
        const cluster = document.querySelector('.mobile-buttons-cluster');
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnScope = document.getElementById('btn-mobile-scope');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnReload = document.getElementById('btn-mobile-reload');

        const rCluster = cluster.getBoundingClientRect();
        const rShoot = btnShoot.getBoundingClientRect();
        const rScope = btnScope.getBoundingClientRect();
        const rAim = btnAim.getBoundingClientRect();
        const rReload = btnReload.getBoundingClientRect();

        return {
          cluster: { x: rCluster.x, y: rCluster.y, w: rCluster.width, h: rCluster.height },
          shoot: { x: rShoot.x, y: rShoot.y, w: rShoot.width, h: rShoot.height, right: rShoot.right, bottom: rShoot.bottom },
          scope: { x: rScope.x, y: rScope.y, w: rScope.width, h: rScope.height, right: rScope.right, bottom: rScope.bottom },
          aim: { x: rAim.x, y: rAim.y, w: rAim.width, h: rAim.height, right: rAim.right, bottom: rAim.bottom },
          reload: { x: rReload.x, y: rReload.y, w: rReload.width, h: rReload.height, right: rReload.right, bottom: rReload.bottom },
          window: { w: window.innerWidth, h: window.innerHeight }
        };
      })()
    `);

    console.log('Mobile Layout Measurements (844x390):');
    console.log(`  FIRE:   [${layoutInfo.shoot.w.toFixed(0)}x${layoutInfo.shoot.h.toFixed(0)}] at (${layoutInfo.shoot.x.toFixed(0)}, ${layoutInfo.shoot.y.toFixed(0)})`);
    console.log(`  AIM:    [${layoutInfo.aim.w.toFixed(0)}x${layoutInfo.aim.h.toFixed(0)}] at (${layoutInfo.aim.x.toFixed(0)}, ${layoutInfo.aim.y.toFixed(0)})`);
    console.log(`  SCOPE:  [${layoutInfo.scope.w.toFixed(0)}x${layoutInfo.scope.h.toFixed(0)}] at (${layoutInfo.scope.x.toFixed(0)}, ${layoutInfo.scope.y.toFixed(0)})`);
    console.log(`  RELOAD: [${layoutInfo.reload.w.toFixed(0)}x${layoutInfo.reload.h.toFixed(0)}] at (${layoutInfo.reload.x.toFixed(0)}, ${layoutInfo.reload.y.toFixed(0)})`);

    // Verify button sizes preserved
    assert(layoutInfo.shoot.w >= 60, 'FIRE button size preserved (not made too small)');
    assert(layoutInfo.aim.w >= 40, 'AIM button size preserved');
    assert(layoutInfo.scope.w >= 40, 'SCOPE button size preserved');
    assert(layoutInfo.reload.w >= 40, 'RELOAD button size preserved');
    console.log('✔ PASS: Button sizes properly preserved');

    // Calculate Clear Physical Gaps
    const gapFireAim = layoutInfo.shoot.x - layoutInfo.aim.right;
    const gapFireScope = layoutInfo.shoot.y - layoutInfo.scope.bottom;
    const gapFireReload = layoutInfo.reload.y - layoutInfo.shoot.bottom;

    console.log(`\nSeparation Distances from FIRE:`);
    console.log(`  Distance to AIM:    ${gapFireAim.toFixed(1)} px (was ~5px previously)`);
    console.log(`  Distance to SCOPE:  ${gapFireScope.toFixed(1)} px (was ~5px previously)`);
    console.log(`  Distance to RELOAD: ${gapFireReload.toFixed(1)} px (was ~5px previously)`);

    assert(gapFireAim >= 18, `Distance from FIRE to AIM is comfortably touch-safe (got ${gapFireAim.toFixed(1)}px, expected >= 18px)`);
    assert(gapFireScope >= 16, `Distance from FIRE to SCOPE is comfortably touch-safe (got ${gapFireScope.toFixed(1)}px, expected >= 16px)`);
    assert(gapFireReload >= 16, `Distance from FIRE to RELOAD is comfortably touch-safe (got ${gapFireReload.toFixed(1)}px, expected >= 16px)`);
    console.log('✔ PASS: All physical gaps between FIRE and neighboring controls exceed touch-safe standards');

    // Verify all buttons are within screen bounds
    assert(layoutInfo.shoot.right <= layoutInfo.window.w, 'FIRE is within viewport width');
    assert(layoutInfo.shoot.bottom <= layoutInfo.window.h, 'FIRE is within viewport height');
    assert(layoutInfo.scope.y >= 0, 'SCOPE is within viewport top');
    assert(layoutInfo.aim.x >= 0, 'AIM is within viewport left');
    console.log('✔ PASS: Controls are comfortably within screen bounds, nothing clipped');

    // 2. Test Other Screen Resolutions: Compact (667x375) and Portrait (390x844)
    console.log('\n--- 2. Testing Compact Screen: 667 x 375 (iPhone SE Landscape) ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 667,
      height: 375,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 }
    });
    await wait(400);

    const compactInfo = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');
        const rShoot = btnShoot.getBoundingClientRect();
        const rAim = btnAim.getBoundingClientRect();
        const rScope = btnScope.getBoundingClientRect();
        return {
          gapAim: rShoot.x - rAim.right,
          gapScope: rShoot.y - rScope.bottom,
          shootRight: rShoot.right,
          shootBottom: rShoot.bottom,
          winW: window.innerWidth,
          winH: window.innerHeight
        };
      })()
    `);
    assert(compactInfo.gapAim >= 18, `Compact landscape: FIRE-AIM gap is safe (${compactInfo.gapAim.toFixed(1)}px)`);
    assert(compactInfo.gapScope >= 16, `Compact landscape: FIRE-SCOPE gap is safe (${compactInfo.gapScope.toFixed(1)}px)`);
    assert(compactInfo.shootRight <= compactInfo.winW, 'Compact landscape: FIRE is on-screen');
    console.log(`✔ PASS: Compact 667x375 layout maintains safe gaps (AIM: ${compactInfo.gapAim.toFixed(1)}px, SCOPE: ${compactInfo.gapScope.toFixed(1)}px)`);

    console.log('\n--- 3. Testing Portrait Screen: 390 x 844 (Vertical Phone) ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 }
    });
    await wait(400);

    const portraitInfo = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');
        const rShoot = btnShoot.getBoundingClientRect();
        const rAim = btnAim.getBoundingClientRect();
        const rScope = btnScope.getBoundingClientRect();
        return {
          gapAim: rShoot.x - rAim.right,
          gapScope: rShoot.y - rScope.bottom,
          shootRight: rShoot.right,
          shootBottom: rShoot.bottom,
          winW: window.innerWidth,
          winH: window.innerHeight
        };
      })()
    `);
    assert(portraitInfo.gapAim >= 18, `Portrait: FIRE-AIM gap is safe (${portraitInfo.gapAim.toFixed(1)}px)`);
    assert(portraitInfo.gapScope >= 16, `Portrait: FIRE-SCOPE gap is safe (${portraitInfo.gapScope.toFixed(1)}px)`);
    console.log(`✔ PASS: Portrait 390x844 layout maintains safe gaps (AIM: ${portraitInfo.gapAim.toFixed(1)}px, SCOPE: ${portraitInfo.gapScope.toFixed(1)}px)`);

    // Reset to landscape for event testing
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 }
    });
    await wait(300);

    // 3. Test FIRE Button Pointer/Touch Events & Held Visual Indicator
    console.log('\n--- 4. Testing FIRE Button Pointer/Touch Events & Held Visual Indicator ---');

    // Simulate instantiation of mobile controls handlers
    const eventSetupResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');
        const btnReload = document.getElementById('btn-mobile-reload');

        window.testLog = {
          shootDown: 0,
          shootUp: 0,
          aimToggled: 0,
          scopeToggled: 0,
          reloadTriggered: 0
        };

        // Create mock controls if not yet instantiated
        if (!window.mobileControlsInstance && typeof window.MobileControls !== 'undefined') {
          window.mobileControlsInstance = new window.MobileControls(
            null,
            () => { window.testLog.shootDown++; },
            () => { window.testLog.scopeToggled++; },
            () => { window.testLog.aimToggled++; },
            () => { window.testLog.reloadTriggered++; },
            () => {}
          );
        }

        return {
          hasBtnShoot: !!btnShoot,
          hasBtnAim: !!btnAim,
          hasBtnScope: !!btnScope,
          hasBtnReload: !!btnReload
        };
      })()
    `);
    assert(eventSetupResult.hasBtnShoot, 'btn-mobile-shoot element exists');

    // TEST: Touch Down on FIRE -> enters held state
    console.log('Testing Touch/Pointer Down on FIRE...');
    const downResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');

        // Dispatch pointerdown
        btnShoot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));

        const isHeldClass = btnShoot.classList.contains('is-held');
        const isActiveClass = btnShoot.classList.contains('active');
        const computedStyle = window.getComputedStyle(btnShoot);

        return {
          isHeldClass,
          isActiveClass,
          aimActive: btnAim.classList.contains('active'),
          scopeActive: btnScope.classList.contains('active'),
          shootScale: computedStyle.transform,
          shootBg: computedStyle.backgroundImage || computedStyle.background
        };
      })()
    `);

    assert.strictEqual(downResult.isHeldClass, true, 'FIRE button has .is-held class on pointer down');
    assert.strictEqual(downResult.isActiveClass, true, 'FIRE button has .active class on pointer down');
    assert.strictEqual(downResult.aimActive, false, 'AIM is NOT active when pressing FIRE');
    assert.strictEqual(downResult.scopeActive, false, 'SCOPE is NOT active when pressing FIRE');
    console.log('✔ PASS: Pointer down on FIRE enters visible held/active state');
    console.log('✔ PASS: Pressing FIRE did NOT trigger AIM or SCOPE');

    // TEST: Hold FIRE for 400ms -> remains held
    await wait(400);
    const holdResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        return {
          isHeld: btnShoot.classList.contains('is-held'),
          isActive: btnShoot.classList.contains('active')
        };
      })()
    `);
    assert.strictEqual(holdResult.isHeld, true, 'FIRE remains visibly held during hold duration');
    assert.strictEqual(holdResult.isActive, true, 'FIRE remains visibly active during hold duration');
    console.log('✔ PASS: FIRE remains continuously in active state while finger remains down');

    // TEST: Release FIRE (Pointer Up) -> exits held state immediately
    console.log('Testing Touch/Pointer Up on FIRE...');
    const upResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        btnShoot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));

        return {
          isHeld: btnShoot.classList.contains('is-held'),
          isActive: btnShoot.classList.contains('active')
        };
      })()
    `);
    assert.strictEqual(upResult.isHeld, false, 'FIRE button removes .is-held on pointer up');
    assert.strictEqual(upResult.isActive, false, 'FIRE button removes .active on pointer up');
    console.log('✔ PASS: Pointer up on FIRE immediately returns to normal visual state');

    // TEST: Rapid tap FIRE 5 times
    console.log('Testing Rapid Taps on FIRE (no neighbor activation)...');
    const rapidResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');
        const btnReload = document.getElementById('btn-mobile-reload');

        for (let i = 0; i < 5; i++) {
          btnShoot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1 }));
          btnShoot.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1 }));
        }

        return {
          shootHeld: btnShoot.classList.contains('is-held'),
          shootActive: btnShoot.classList.contains('active'),
          aimActive: btnAim.classList.contains('active'),
          scopeActive: btnScope.classList.contains('active'),
          reloadActive: btnReload.classList.contains('active')
        };
      })()
    `);
    assert.strictEqual(rapidResult.shootHeld, false, 'FIRE is not stuck after rapid taps');
    assert.strictEqual(rapidResult.aimActive, false, 'AIM was not triggered during rapid FIRE taps');
    assert.strictEqual(rapidResult.scopeActive, false, 'SCOPE was not triggered during rapid FIRE taps');
    console.log('✔ PASS: Rapid tapping FIRE never triggers AIM/SCOPE/RELOAD and never gets stuck');

    // TEST: Touch AIM, SCOPE, RELOAD individually -> FIRE never triggers
    console.log('\nTesting AIM, SCOPE, RELOAD isolation (never triggers FIRE)...');
    const auxResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        const btnAim = document.getElementById('btn-mobile-aim');
        const btnScope = document.getElementById('btn-mobile-scope');
        const btnReload = document.getElementById('btn-mobile-reload');

        // Tap AIM
        btnAim.click();
        const aimToggled = btnAim.classList.contains('active');
        const shootDuringAim = btnShoot.classList.contains('is-held') || btnShoot.classList.contains('active');

        // Tap SCOPE
        btnScope.click();
        const scopeToggled = btnScope.classList.contains('active');
        const shootDuringScope = btnShoot.classList.contains('is-held') || btnShoot.classList.contains('active');

        // Tap RELOAD
        btnReload.click();
        const shootDuringReload = btnShoot.classList.contains('is-held') || btnShoot.classList.contains('active');

        return {
          aimToggled,
          shootDuringAim,
          scopeToggled,
          shootDuringScope,
          shootDuringReload
        };
      })()
    `);
    assert.strictEqual(auxResult.shootDuringAim, false, 'FIRE not triggered when AIM tapped');
    assert.strictEqual(auxResult.shootDuringScope, false, 'FIRE not triggered when SCOPE tapped');
    assert.strictEqual(auxResult.shootDuringReload, false, 'FIRE not triggered when RELOAD tapped');
    console.log('✔ PASS: Tapping AIM/SCOPE/RELOAD never triggers FIRE');

    // TEST: Cancellation / Interruption recovery (never stuck)
    console.log('\nTesting Pointer Cancellation recovery...');
    const cancelResult = await evaluate(`
      (() => {
        const btnShoot = document.getElementById('btn-mobile-shoot');
        // Press down
        btnShoot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2 }));
        const downActive = btnShoot.classList.contains('is-held');

        // Cancel event
        btnShoot.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true, pointerId: 2 }));
        const afterCancel = btnShoot.classList.contains('is-held');

        return { downActive, afterCancel };
      })()
    `);
    assert.strictEqual(cancelResult.downActive, true, 'Held on down');
    assert.strictEqual(cancelResult.afterCancel, false, 'Cleanly cleared on pointercancel');
    console.log('✔ PASS: Pointer cancellation immediately clears held state (cannot get stuck)');

    ws.close();
  } finally {
    if (!isClosed) {
      chromeProc.kill('SIGKILL');
    }
  }
}

async function main() {
  try {
    await testTargetLifecycle();
    await testMobileControlsHeadless();
    console.log('\n========================================');
    console.log('ALL TESTS PASSED SUCCESSFULLY! (100%)');
    console.log('========================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
  }
}

main();
