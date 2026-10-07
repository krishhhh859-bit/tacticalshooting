/**
 * Comprehensive Automated Verification Suite
 * Tests BOTH Solo Mode PC and Multiplayer PC face-tracking pipelines
 */

const { spawn } = require('child_process');
const http = require('http');
const io = require('socket.io-client');
const assert = require('assert');

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
  console.log('RUNNING FULL SOLO PC + MULTIPLAYER PC VERIFICATION');
  console.log('====================================================\n');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9228',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'http://localhost:3000'
  ]);

  try {
    let targets = null;
    for (let i = 0; i < 25; i++) {
      await wait(400);
      try {
        targets = await fetchJson('http://localhost:9228/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP port 9228');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[TEST] Chrome Connected to:', pageTarget.url);

    const WsMod = require('ws');
    const ws = new WsMod(pageTarget.webSocketDebuggerUrl);

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
        if (text.includes('MULTIPLAYER FACE DEBUG') || text.includes('CAMERA AIM') || text.includes('SCORE')) {
          console.log(`[P1 LOG] ${text}`);
        }
      }
    });

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

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

    // =============================================================
    // PART 1: TEST SOLO MODE PC (Confirm it STILL works)
    // =============================================================
    console.log('\n>>> TEST 1: SOLO MODE PC INITIALIZATION & CAMERA AIM <<<');
    await evalInBrowser(`
      (() => {
        localStorage.setItem('para_sf_device', 'pc');
        if (window.app) {
          window.app.selectedDevice = 'pc';
          window.app.proceedToLobby();
        }
      })()
    `);
    await wait(1500);

    await evalInBrowser(`
      (() => {
        const btnSolo = document.getElementById('btn-solo-practice');
        if (btnSolo) btnSolo.click();
      })()
    `);
    await wait(3000);

    // Toggle Camera Aim ON in Solo Mode
    await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (btn) btn.click();
      })()
    `);
    await wait(2500);

    const soloCamCheck = await evalInBrowser(`
      (() => {
        const ca = window.game ? window.game.cameraAim : null;
        return {
          caActive: ca ? ca.isActive : false,
          hasStream: ca ? !!ca.stream : false,
          isFaceDetectorInitialized: ca ? ca.isFaceDetectorInitialized : false,
          label: document.getElementById('camera-aim-toggle-label')?.textContent
        };
      })()
    `);
    console.log('Solo Cam Check:', soloCamCheck);
    assert.strictEqual(soloCamCheck.caActive, true, 'Solo Camera Aim must be active');
    assert.strictEqual(soloCamCheck.hasStream, true, 'Solo webcam stream must exist');
    assert.strictEqual(soloCamCheck.label, 'CAMERA AIM: ON', 'Toggle label must show ON');
    console.log('✓ Solo Mode webcam and Camera Aim verified working.');

    // Feed face movement into Solo Mode
    console.log('\n>>> TEST 2: SOLO MODE FACE ROTATION & ZERO DRIFT <<<');
    const soloRotResult = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;
        ca.handleFaceLoss(); // Reset state
        ca.latestSnapshot.hasFace = false;

        // Initial face anchor
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.50, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        const startYaw = ca.yaw;
        const startPitch = ca.pitch;

        // Move head left (rawFaceX increases in mirrored view: 0.50 -> 0.54)
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.54, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        ca.update(0.05);
        const yawAfterMove = ca.yaw;

        // Stationary face (keep head still)
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.5401, rawFaceY: 0.5001, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());
        ca.update(0.05);
        const yawAfterStill = ca.yaw;

        return {
          startYaw,
          yawAfterMove,
          yawDiff: yawAfterMove - startYaw,
          drift: Math.abs(yawAfterStill - yawAfterMove)
        };
      })()
    `);
    console.log('Solo Rotation Result:', soloRotResult);
    assert.ok(Math.abs(soloRotResult.yawDiff) > 0.05, 'Solo face movement must rotate camera');
    assert.ok(soloRotResult.drift < 0.001, 'Stationary face must have zero drift');
    console.log('✓ Solo Mode face movement rotates camera with zero drift.');

    // Return to Lobby from Solo
    console.log('\n>>> RETURNING TO LOBBY <<<');
    await evalInBrowser(`
      (() => {
        const btnHome = document.getElementById('btn-hud-home');
        if (btnHome) btnHome.click();
        const btnLeave = document.getElementById('btn-home-leave');
        if (btnLeave) btnLeave.click();
      })()
    `);
    await wait(2000);

    // =============================================================
    // PART 2: TEST MULTIPLAYER PC MODE
    // =============================================================
    console.log('\n>>> TEST 3: MULTIPLAYER PC - HOST ROOM & JOIN <<<');
    await evalInBrowser(`
      (() => {
        const btnCreate = document.getElementById('btn-create-match');
        if (btnCreate) btnCreate.click();
      })()
    `);
    await wait(1500);

    const roomCode = await evalInBrowser(`
      (() => window.app ? window.app.currentRoomCode : null)()
    `);
    console.log('Hosted Multiplayer Room Code:', roomCode);
    assert.ok(roomCode && roomCode.length === 6, 'Must have valid 6-char room code');

    // Player 2 joins via socket.io client
    console.log('Connecting Player 2 to room:', roomCode);
    const p2Socket = io('http://localhost:3000');
    let p2LastOpponentLook = null;

    await new Promise((resolve, reject) => {
      p2Socket.on('connect', () => {
        p2Socket.emit('join_room', { roomCode, name: 'Opponent P2', device: 'pc' });
      });
      p2Socket.on('room_joined', resolve);
      p2Socket.on('join_error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for P2 room_joined')), 5000);
    });

    p2Socket.on('opponent_move', (data) => {
      if (data && data.rotation) {
        p2LastOpponentLook = data.rotation;
      }
    });

    // Wait for match countdown and start
    console.log('Waiting for Multiplayer match to start...');
    let matchStarted = false;
    for (let w = 0; w < 30; w++) {
      const s = await evalInBrowser(`
        (() => {
          return {
            gameActive: !!(window.game && window.game.isActive),
            hasCA: !!(window.game && window.game.cameraAim)
          };
        })()
      `);
      if (s && s.gameActive && s.hasCA) {
        matchStarted = true;
        break;
      }
      await wait(500);
    }
    assert.strictEqual(matchStarted, true, 'Multiplayer match must start');
    await wait(2500);

    // =============================================================
    // PART 3: VERIFY MULTIPLAYER WEBCAM & FACE DETECTION
    // =============================================================
    console.log('\n>>> TEST 4: VERIFY MULTIPLAYER WEBCAM & DETECTOR STATE <<<');
    const mpDiag = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;
        return {
          caActive: ca ? ca.isActive : false,
          hasStream: ca ? !!ca.stream : false,
          streamTracks: ca && ca.stream ? ca.stream.getVideoTracks().length : 0,
          videoReadyState: ca && ca.video ? ca.video.readyState : -1,
          isFaceDetectorInitialized: ca ? ca.isFaceDetectorInitialized : false,
          trackingActive: ca ? ca.trackingActive : false,
          controlsActive: !!(ca && ca.getControls && ca.getControls() && ca.getControls().isCameraAimActive),
          debugState: ca ? ca.getMultiplayerFaceDebug() : null
        };
      })()
    `);
    console.log('Multiplayer Diagnostics State:', mpDiag);
    assert.strictEqual(mpDiag.caActive, true, 'Multiplayer Camera Aim must be active');
    assert.strictEqual(mpDiag.hasStream, true, 'Multiplayer webcam stream must be active');
    assert.strictEqual(mpDiag.trackingActive, true, 'Detection loop must be running');
    assert.strictEqual(mpDiag.controlsActive, true, 'PCControls.isCameraAimActive must be true');
    assert.strictEqual(mpDiag.debugState.cameraStream, 'YES', 'Debug cameraStream must be YES');
    assert.strictEqual(mpDiag.debugState.detectionLoop, 'RUNNING', 'Debug detectionLoop must be RUNNING');
    assert.strictEqual(mpDiag.debugState.cameraController, 'ACTIVE', 'Debug cameraController must be ACTIVE');
    console.log('✓ Multiplayer PC Mode webcam and face tracking loop verified ACTIVE.');

    // =============================================================
    // PART 4: TEST MULTIPLAYER HEAD MOVEMENT ROTATES CAMERA
    // =============================================================
    console.log('\n>>> TEST 5: MULTIPLAYER HEAD MOVEMENT ROTATES LOCAL CAMERA <<<');
    const mpHeadMove = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;
        const game = window.game;

        ca.handleFaceLoss();
        ca.update(0.016);

        // 1. Anchor head at center
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.50, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        const yawInitial = ca.yaw;
        const camRotYInitial = game.camera.rotation.y;

        // 2. Move head left (rawFaceX increases: 0.50 -> 0.55)
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.55, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        ca.update(0.05);

        const yawAfterLeft = ca.yaw;
        const camRotYAfterLeft = game.camera.rotation.y;

        // 3. Move head right (rawFaceX decreases: 0.55 -> 0.45)
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.45, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        ca.update(0.05);

        const yawAfterRight = ca.yaw;
        const camRotYAfterRight = game.camera.rotation.y;

        return {
          yawInitial,
          camRotYInitial,
          yawAfterLeft,
          camRotYAfterLeft,
          leftDelta: camRotYAfterLeft - camRotYInitial,
          yawAfterRight,
          camRotYAfterRight,
          rightDelta: camRotYAfterRight - camRotYAfterLeft
        };
      })()
    `);
    console.log('Multiplayer Head Movement Result:', mpHeadMove);
    assert.ok(mpHeadMove.leftDelta > 0.05, 'Left head movement must rotate multiplayer camera left (positive yaw)');
    assert.ok(mpHeadMove.rightDelta < -0.05, 'Right head movement must rotate multiplayer camera right (negative yaw)');
    console.log('✓ Multiplayer PC Mode local camera responds correctly to face movement left & right.');

    // =============================================================
    // PART 5: TEST ZERO DRIFT ON STATIONARY FACE IN MULTIPLAYER
    // =============================================================
    console.log('\n>>> TEST 6: MULTIPLAYER STATIONARY FACE ZERO DRIFT <<<');
    const mpStationary = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;
        const game = window.game;

        const yawBefore = game.camera.rotation.y;

        // Feed micro-jitter within deadzone (dist < DEADZONE_X)
        for (let i = 0; i < 5; i++) {
          ca.handleFaceResult({
            hasFace: true, faceCount: 1, confidence: 0.95,
            rawFaceX: 0.45 + (Math.sin(i) * 0.0005),
            rawFaceY: 0.50 + (Math.cos(i) * 0.0005),
            faceWidth: 0.25, faceHeight: 0.30
          }, performance.now());
          ca.update(0.016);
        }

        const yawAfter = game.camera.rotation.y;
        return {
          yawBefore,
          yawAfter,
          drift: Math.abs(yawAfter - yawBefore)
        };
      })()
    `);
    console.log('Multiplayer Stationary Result:', mpStationary);
    assert.ok(mpStationary.drift < 0.001, 'Stationary face must produce zero camera drift');
    console.log('✓ Multiplayer stationary face zero-drift confirmed.');

    // =============================================================
    // PART 6: TEST SENSITIVITY ADJUSTMENT IN MULTIPLAYER
    // =============================================================
    console.log('\n>>> TEST 7: SENSITIVITY SCALING IN MULTIPLAYER <<<');
    const mpSensResult = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;

        // 1. Test at 1.0x sensitivity
        ca.setCameraSensitivity(1.0);
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.50, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.54, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());
        const delta1x = Math.abs(ca.latestSnapshot.aimX);

        // 2. Test at 2.5x sensitivity
        ca.setCameraSensitivity(2.5);
        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.50, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());

        ca.handleFaceResult({
          hasFace: true, faceCount: 1, confidence: 0.95,
          rawFaceX: 0.54, rawFaceY: 0.50, faceWidth: 0.25, faceHeight: 0.30
        }, performance.now());
        const delta25x = Math.abs(ca.latestSnapshot.aimX);

        // Restore to 1.0x
        ca.setCameraSensitivity(1.0);

        return {
          delta1x,
          delta25x,
          ratio: delta25x / delta1x
        };
      })()
    `);
    console.log('Multiplayer Sensitivity Result:', mpSensResult);
    assert.ok(mpSensResult.ratio >= 2.4 && mpSensResult.ratio <= 2.6, 'Sensitivity 2.5x must scale rotation delta by ~2.5x');
    console.log('✓ Sensitivity adjustment scales multiplayer camera rotation proportionally.');

    // =============================================================
    // PART 7: TEST HAND MOVEMENT DOES NOT ROTATE CAMERA
    // =============================================================
    console.log('\n>>> TEST 8: HAND MOVEMENT ISOLATION (NO CAMERA ROTATION) <<<');
    const mpHandIsolation = await evalInBrowser(`
      (() => {
        const ca = window.game.cameraAim;
        const game = window.game;

        ca.handleFaceLoss();
        ca.update(0.016);

        const yawBefore = game.camera.rotation.y;
        const pitchBefore = game.camera.rotation.x;

        // Feed hand results with moving positions and fist clench
        ca.handleHandResult(true, {
          rawAimX: 0.85, rawAimY: 0.20,
          fistScore: 0.88, isFist: true
        }, performance.now());

        ca.update(0.05);

        const yawAfter = game.camera.rotation.y;
        const pitchAfter = game.camera.rotation.x;

        return {
          yawBefore,
          yawAfter,
          pitchBefore,
          pitchAfter,
          yawDelta: Math.abs(yawAfter - yawBefore),
          pitchDelta: Math.abs(pitchAfter - pitchBefore),
          shootHeld: ca.shootHeld,
          confirmedFist: ca.confirmedFist
        };
      })()
    `);
    console.log('Multiplayer Hand Isolation Result:', mpHandIsolation);
    assert.strictEqual(mpHandIsolation.yawDelta, 0, 'Hand movement must NEVER rotate camera yaw');
    assert.strictEqual(mpHandIsolation.pitchDelta, 0, 'Hand movement must NEVER rotate camera pitch');
    assert.strictEqual(mpHandIsolation.shootHeld, true, 'Fist clench must trigger shooting');
    console.log('✓ Hand movement strictly isolated: ZERO camera rotation, fist trigger only.');

    // =============================================================
    // PART 8: MULTIPLAYER NETWORKING STILL SYNCHRONIZING
    // =============================================================
    console.log('\n>>> TEST 9: CONFIRM MULTIPLAYER NETWORKING WORKS <<<');
    // Give time for position update to reach Player 2
    await evalInBrowser(`
      (() => {
        window.game.camera.rotation.y = 0.42;
        window.game.camera.rotation.x = -0.15;
      })()
    `);
    await wait(400);

    console.log('P2 Received Opponent Look Rotation:', p2LastOpponentLook);
    assert.ok(p2LastOpponentLook !== null, 'Player 2 should receive opponent look synchronization');
    console.log('✓ Multiplayer networking verified active and synchronizing look orientation.');

    p2Socket.disconnect();
    console.log('\n====================================================');
    console.log('ALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('[TEST FAILED]', err);
  process.exit(1);
});
