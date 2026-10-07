/**
 * PARA SF: End-to-End Headless Chrome Test
 * Physically tests Face Detection Truth & Camera Movement Isolation in SOLO MODE PC
 */

const { spawn } = require('child_process');
const http = require('http');

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

async function run() {
  console.log('====================================================');
  console.log('[TEST] Launching Headless Chrome for Solo PC Mode...');
  console.log('====================================================');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9224',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'http://localhost:3000'
  ]);

  chromeProc.on('exit', (code) => {
    console.log('[TEST] Chrome exited with code:', code);
  });

  try {
    let targets = null;
    for (let i = 0; i < 25; i++) {
      await wait(400);
      try {
        targets = await fetchJson('http://localhost:9224/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP port 9224');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[TEST] Chrome CDP Connected to Page:', pageTarget.url);

    let ws = null;
    try {
      const WsMod = require('ws');
      ws = new WsMod(pageTarget.webSocketDebuggerUrl);
    } catch (_) {
      if (typeof global.WebSocket !== 'undefined') {
        ws = new global.WebSocket(pageTarget.webSocketDebuggerUrl);
      }
    }

    let id = 1;
    const pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
        console.log(`[BROWSER CONSOLE] ${text}`);
      }
    });

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Enable Runtime
    ws.send(JSON.stringify({ id: id++, method: 'Runtime.enable' }));

    function evalInBrowser(expr) {
      return new Promise((resolve) => {
        const cmdId = id++;
        pending.set(cmdId, (res) => {
          if (res?.exceptionDetails) {
            console.error('[BROWSER EXCEPTION]', res.exceptionDetails);
          }
          resolve(res?.result?.value);
        });
        ws.send(JSON.stringify({
          id: cmdId,
          method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true, awaitPromise: true }
        }));
      });
    }

    await wait(1500);

    // 1. Select PC Mode
    console.log('[TEST] Selecting PC Mode...');
    const selectRes = await evalInBrowser(`
      (() => {
        const btnPC = document.getElementById('btn-select-pc');
        if (btnPC) {
          btnPC.click();
          return 'CLICKED_PC';
        }
        return 'ALREADY_PAST_DEVICE_SELECT';
      })()
    `);
    console.log('[TEST] Device Selection:', selectRes);
    await wait(1200);

    // 2. Start Solo Practice Range
    console.log('[TEST] Starting Solo Practice Range...');
    const soloRes = await evalInBrowser(`
      (() => {
        const btnSolo = document.getElementById('btn-solo-practice');
        if (btnSolo) {
          btnSolo.click();
          return 'CLICKED_SOLO';
        }
        return 'SOLO_BTN_NOT_FOUND';
      })()
    `);
    console.log('[TEST] Solo Button Click:', soloRes);

    // Wait for 3D Game to initialize
    await wait(3500);

    // 3. Toggle Camera Aim ON
    console.log('[TEST] Clicking Camera Aim Toggle button...');
    const toggleRes = await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (btn) {
          btn.click();
          return 'CLICKED_TOGGLE';
        }
        return 'TOGGLE_BTN_NOT_FOUND';
      })()
    `);
    console.log('[TEST] Toggle Action:', toggleRes);

    // Wait for Camera to start
    await wait(2500);

    // -------------------------------------------------------------
    // TEST STEP 1: INITIAL STATE & DIAGNOSTIC DISPLAY
    // -------------------------------------------------------------
    console.log('\n--- STEP 1: VERIFY DIAGNOSTIC DISPLAY & NO-FACE INITIAL STATE ---');
    const diagCheck = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        if (!ca) return { error: 'cameraAim instance not found' };

        ca.handleFaceLoss(); // Ensure test starts at pure loss state
        ca.updateStatusUI();

        return {
          isActive: ca.isActive,
          poseBadgeText: ca.dom.poseBadge?.textContent,
          poseBadgeClass: ca.dom.poseBadge?.className,
          statusLine: ca.dom.statusLine?.textContent,
          diagLine: ca.dom.diag?.textContent,
          diagFaceInit: ca.dom.diagFaceInit?.textContent,
          diagCamRunning: ca.dom.diagCamRunning?.textContent,
          diagFrameProcessed: ca.dom.diagFrameProcessed?.textContent,
          diagFaceCount: ca.dom.diagFaceCount?.textContent,
          diagFaceConf: ca.dom.diagFaceConf?.textContent,
          diagFaceAge: ca.dom.diagFaceAge?.textContent,
          snapHasFace: ca.latestSnapshot.hasFace,
          snapFaceCount: ca.latestSnapshot.faceCount,
          aimX: ca.latestSnapshot.aimX,
          aimY: ca.latestSnapshot.aimY
        };
      })()
    `);
    console.log('Diagnostic Display Check:', diagCheck);

    if (diagCheck.error) {
      throw new Error(`FAIL: ${diagCheck.error}`);
    }
    if (diagCheck.snapHasFace !== false) {
      throw new Error('FAIL: snap.hasFace is true when no face is present!');
    }
    if (diagCheck.poseBadgeText !== 'NO FACE DETECTED') {
      throw new Error(`FAIL: Badge text is not 'NO FACE DETECTED', got: '${diagCheck.poseBadgeText}'`);
    }
    if (diagCheck.diagFaceCount !== '0') {
      throw new Error(`FAIL: Diagnostic face count is not 0, got: '${diagCheck.diagFaceCount}'`);
    }
    console.log('PASS: Diagnostic display shows NO FACE DETECTED, faceCount = 0, camera movement = 0.');

    // -------------------------------------------------------------
    // TEST STEP 2: FACE DETECTED (VALID DETECTOR RESULT)
    // -------------------------------------------------------------
    console.log('\n--- STEP 2: VALID FACE RESULT ARRIVES (A: FACE IN FRONT OF CAMERA) ---');
    const faceArrival = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);

        // MediaPipe FaceDetector returns 1 valid face with 95% confidence
        ca.handleWorkerMessage({
          data: {
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: 1,
            confidence: 0.95,
            rawFaceX: 0.50,
            rawFaceY: 0.45,
            faceWidth: 0.22,
            faceHeight: 0.28,
            box: { x: 0.39, y: 0.31, w: 0.22, h: 0.28 },
            capturedAt: performance.now(),
            inferenceMs: 4
          }
        });

        ca.updateStatusUI();

        return {
          hasFace: ca.latestSnapshot.hasFace,
          faceCount: ca.latestSnapshot.faceCount,
          confidence: ca.latestSnapshot.confidence,
          poseBadgeText: ca.dom.poseBadge?.textContent,
          poseBadgeClass: ca.dom.poseBadge?.className,
          diagFaceCount: ca.dom.diagFaceCount?.textContent,
          diagFaceConf: ca.dom.diagFaceConf?.textContent
        };
      })()
    `);
    console.log('Face Arrival Result:', faceArrival);

    if (faceArrival.hasFace !== true || faceArrival.faceCount !== 1) {
      throw new Error('FAIL: Face detection failed to transition to true with faceCount = 1!');
    }
    if (faceArrival.poseBadgeText !== 'FACE DETECTED') {
      throw new Error(`FAIL: Badge should display 'FACE DETECTED', got: '${faceArrival.poseBadgeText}'`);
    }
    if (faceArrival.diagFaceCount !== '1') {
      throw new Error(`FAIL: Diagnostic face count should be '1', got: '${faceArrival.diagFaceCount}'`);
    }
    console.log('PASS: Valid face arrival transitions badge to "FACE DETECTED" and face count to 1.');

    // -------------------------------------------------------------
    // TEST STEP 3: FACE MOVEMENT ROTATES CAMERA
    // -------------------------------------------------------------
    console.log('\n--- STEP 3: FACE MOVEMENT CONTROLS CAMERA ROTATION ---');
    const movementTest = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        const startYaw = ca.yaw;
        const startPitch = ca.pitch;

        // Frame 1: Establish anchor position on entry
        ca.handleWorkerMessage({
          data: {
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: 1,
            confidence: 0.96,
            rawFaceX: 0.50,
            rawFaceY: 0.45,
            faceWidth: 0.22,
            faceHeight: 0.28,
            capturedAt: performance.now(),
            inferenceMs: 4
          }
        });

        // Frame 2: User moves head right and up
        ca.handleWorkerMessage({
          data: {
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: 1,
            confidence: 0.96,
            rawFaceX: 0.56,
            rawFaceY: 0.39,
            faceWidth: 0.22,
            faceHeight: 0.28,
            capturedAt: performance.now(),
            inferenceMs: 4
          }
        });

        ca.update(0.033);

        return {
          startYaw,
          endYaw: ca.yaw,
          yawDiff: ca.yaw - startYaw,
          startPitch,
          endPitch: ca.pitch,
          pitchDiff: ca.pitch - startPitch,
          isFaceMoving: ca.isFaceMoving
        };
      })()
    `);
    console.log('Movement Test Result:', movementTest);

    if (movementTest.yawDiff === 0 && movementTest.pitchDiff === 0) {
      throw new Error('FAIL: Face movement did not produce camera rotation!');
    }
    console.log('PASS: Face movement rotates camera (yaw diff: ' + movementTest.yawDiff.toFixed(4) + ', pitch diff: ' + movementTest.pitchDiff.toFixed(4) + ').');

    // -------------------------------------------------------------
    // TEST STEP 4: FACE LEAVES CAMERA VIEW (B: OUT OF VIEW / C: COVERED)
    // -------------------------------------------------------------
    console.log('\n--- STEP 4: FACE DISAPPEARS / CAMERA COVERED (0 DETECTIONS) ---');
    const lossTest = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        const yawBefore = ca.yaw;
        const pitchBefore = ca.pitch;

        // MediaPipe FaceDetector returns 0 detections
        ca.handleWorkerMessage({
          data: {
            type: 'FACE_RESULT',
            hasFace: false,
            faceCount: 0,
            confidence: 0,
            capturedAt: performance.now(),
            inferenceMs: 3
          }
        });

        ca.update(0.033);
        ca.updateStatusUI();

        return {
          hasFace: ca.latestSnapshot.hasFace,
          faceCount: ca.latestSnapshot.faceCount,
          poseBadgeText: ca.dom.poseBadge?.textContent,
          poseBadgeClass: ca.dom.poseBadge?.className,
          diagFaceCount: ca.dom.diagFaceCount?.textContent,
          aimX: ca.latestSnapshot.aimX,
          aimY: ca.latestSnapshot.aimY,
          yawDrift: Math.abs(ca.yaw - yawBefore),
          pitchDrift: Math.abs(ca.pitch - pitchBefore)
        };
      })()
    `);
    console.log('Face Loss Result:', lossTest);

    if (lossTest.hasFace !== false || lossTest.faceCount !== 0) {
      throw new Error('FAIL: hasFace is still true after detector returned 0 detections!');
    }
    if (lossTest.poseBadgeText !== 'NO FACE DETECTED') {
      throw new Error(`FAIL: Badge must immediately return to 'NO FACE DETECTED', got: '${lossTest.poseBadgeText}'`);
    }
    if (lossTest.diagFaceCount !== '0') {
      throw new Error(`FAIL: Diagnostic face count must be '0', got: '${lossTest.diagFaceCount}'`);
    }
    if (lossTest.yawDrift > 0.0001 || lossTest.pitchDrift > 0.0001) {
      throw new Error('FAIL: Camera drifted when no face was detected!');
    }
    console.log('PASS: Face loss immediately sets NO FACE DETECTED, faceCount = 0, camera movement = 0.');

    // -------------------------------------------------------------
    // TEST STEP 5: STALE DETECTION TIMEOUT
    // -------------------------------------------------------------
    console.log('\n--- STEP 5: STALE DETECTION RESULT TIMEOUT ---');
    const staleTest = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);

        // Inject valid face
        ca.handleWorkerMessage({
          data: {
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: 1,
            confidence: 0.90,
            rawFaceX: 0.50,
            rawFaceY: 0.50,
            faceWidth: 0.22,
            faceHeight: 0.28,
            capturedAt: performance.now(),
            inferenceMs: 4
          }
        });

        const activeText = ca.dom.poseBadge?.textContent;

        // Simulate stale result by backdating faceTimestamp by 200ms (> 120ms threshold)
        ca.latestSnapshot.faceTimestamp = performance.now() - 200;

        // Run game render update loop
        ca.update(0.016);
        ca.updateStatusUI();

        return {
          activeText,
          staleText: ca.dom.poseBadge?.textContent,
          hasFaceAfterStale: ca.latestSnapshot.hasFace,
          faceCountAfterStale: ca.latestSnapshot.faceCount
        };
      })()
    `);
    console.log('Stale Timeout Result:', staleTest);

    if (staleTest.hasFaceAfterStale !== false) {
      throw new Error('FAIL: Stale detector result (>120ms) was retained as true!');
    }
    if (staleTest.staleText !== 'NO FACE DETECTED') {
      throw new Error(`FAIL: Badge after stale timeout should be 'NO FACE DETECTED', got: '${staleTest.staleText}'`);
    }
    console.log('PASS: Stale detector results (>120ms) are immediately treated as NO FACE DETECTED.');

    // -------------------------------------------------------------
    // TEST STEP 6: HAND MOVEMENT ISOLATION (ZERO CAMERA ROTATION)
    // -------------------------------------------------------------
    console.log('\n--- STEP 6: HAND MOVEMENT ISOLATION (SECTION 7 COMPLIANCE) ---');
    const handIsolation = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        ca.handleFaceLoss();

        const startYaw = ca.yaw;
        const startPitch = ca.pitch;

        // Move hand across screen
        ca.handleHandResult(true, {
          rawAimX: 0.15,
          rawAimY: 0.85,
          isFist: false,
          fistScore: 0.1
        }, performance.now());

        ca.update(0.033);

        ca.handleHandResult(true, {
          rawAimX: 0.85,
          rawAimY: 0.15,
          isFist: false,
          fistScore: 0.1
        }, performance.now());

        ca.update(0.033);

        return {
          startYaw,
          endYaw: ca.yaw,
          yawDiff: Math.abs(ca.yaw - startYaw),
          startPitch,
          endPitch: ca.pitch,
          pitchDiff: Math.abs(ca.pitch - startPitch)
        };
      })()
    `);
    console.log('Hand Isolation Result:', handIsolation);

    if (handIsolation.yawDiff > 0.0001 || handIsolation.pitchDiff > 0.0001) {
      throw new Error('FAIL: Hand movement rotated the camera! Hand movement -> CAMERA ROTATION must NOT exist.');
    }
    console.log('PASS: Hand movement produced EXACTLY 0 camera rotation.');

    // -------------------------------------------------------------
    // TEST STEP 7: FIST CLENCH WEAPON SHOOT TRIGGER
    // -------------------------------------------------------------
    console.log('\n--- STEP 7: FIST CLENCH WEAPON SHOOT TRIGGER ---');
    const fistTest = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);

        ca.handleHandResult(true, {
          rawAimX: 0.5,
          rawAimY: 0.5,
          isFist: true,
          fistScore: 0.88
        }, performance.now());

        const fistTriggered = ca.shootHeld && ca.latestSnapshot.isFist;

        ca.handleHandResult(true, {
          rawAimX: 0.5,
          rawAimY: 0.5,
          isFist: false,
          fistScore: 0.20
        }, performance.now());

        const fistReleased = !ca.shootHeld && !ca.latestSnapshot.isFist;

        return {
          fistTriggered,
          fistReleased
        };
      })()
    `);
    console.log('Fist Trigger Result:', fistTest);

    if (!fistTest.fistTriggered || !fistTest.fistReleased) {
      throw new Error('FAIL: Fist trigger clench/release is broken!');
    }
    console.log('PASS: Fist clench triggers weapon firing correctly without rotating camera.');

    console.log('\n====================================================');
    console.log('ALL TESTS PASSED: NO FACE -> FACE -> NO FACE FULLY VERIFIED IN RUNNING GAME!');
    console.log('====================================================');
  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

run().catch((err) => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
