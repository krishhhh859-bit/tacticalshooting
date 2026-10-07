const { spawn } = require('child_process');
const http = require('http');
const io = require('socket.io-client');

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
  console.log('[MP TRACE] Launching Headless Chrome for Player 1 (Host PC)...');
  console.log('====================================================');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9226',
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
        targets = await fetchJson('http://localhost:9226/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP port 9226');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[MP TRACE] Connected to Page:', pageTarget.url);

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
        console.log(`[P1 CONSOLE] ${text}`);
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

    // 1. Ensure Player 1 is in Lobby on PC Mode
    console.log('[MP TRACE] Setting PC Mode and opening lobby for Player 1...');
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

    // 2. Click CREATE MATCH to host multiplayer room
    console.log('[MP TRACE] Clicking CREATE MATCH button...');
    await evalInBrowser(`
      (() => {
        const btnCreate = document.getElementById('btn-create-match');
        if (btnCreate) btnCreate.click();
      })()
    `);
    await wait(1500);

    // Read room code
    const roomCode = await evalInBrowser(`
      (() => {
        return window.app ? window.app.currentRoomCode : null;
      })()
    `);
    console.log('[MP TRACE] Hosted Room Code:', roomCode);

    if (!roomCode) {
      throw new Error('Failed to create room: roomCode is null');
    }

    // 3. Connect Player 2 via socket.io client to join room
    console.log('[MP TRACE] Connecting Player 2 via Socket.IO to room:', roomCode);
    const p2Socket = io('http://localhost:3000');
    await new Promise((resolve, reject) => {
      p2Socket.on('connect', () => {
        console.log('[MP TRACE] Player 2 socket connected:', p2Socket.id);
        p2Socket.emit('join_room', { roomCode, name: 'Player 2 Opponent', device: 'pc' });
      });
      p2Socket.on('room_joined', () => {
        console.log('[MP TRACE] Player 2 joined room successfully');
        resolve();
      });
      p2Socket.on('join_error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for P2 room_joined')), 5000);
    });

    // 4. Wait for countdown and match to start in Player 1's browser
    console.log('[MP TRACE] Waiting for match countdown to finish and game to start...');
    let matchStarted = false;
    for (let w = 0; w < 30; w++) {
      const status = await evalInBrowser(`
        (() => {
          return {
            hasApp: !!window.app,
            hasGame: !!(window.game || (window.app && window.app.currentGame)),
            gameActive: !!(window.game && window.game.isActive),
            roundActive: !!(window.game && window.game.isRoundActive),
            isSolo: !!(window.game && window.game.isSoloPractice),
            netIsSolo: !!(window.net && window.net.isSolo),
            hasCameraAim: !!(window.game && window.game.cameraAim)
          };
        })()
      `);
      console.log(`[MP TRACE wait ${w}]`, JSON.stringify(status));
      if (status && status.gameActive && status.hasCameraAim) {
        matchStarted = true;
        break;
      }
      await wait(500);
    }

    if (!matchStarted) {
      throw new Error('Match did not start within timeout');
    }

    // 5. Inspect Camera Aim Widget & State before toggle
    console.log('\n--- SECTION 2 TRACE: BEFORE CAMERA AIM TOGGLE ---');
    const beforeToggle = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        const widget = document.getElementById('camera-aim-widget');
        const btnToggle = document.getElementById('btn-camera-aim-toggle');
        const label = document.getElementById('camera-aim-toggle-label');
        return {
          caExists: !!ca,
          caActive: ca ? ca.isActive : false,
          widgetFound: !!widget,
          widgetDisplay: widget ? window.getComputedStyle(widget).display : null,
          widgetVisibility: widget ? window.getComputedStyle(widget).visibility : null,
          btnToggleFound: !!btnToggle,
          btnToggleLabel: label ? label.textContent : null
        };
      })()
    `);
    console.log('Before Toggle State:', beforeToggle);

    // 6. Click Camera Aim Toggle Button
    console.log('\n--- SECTION 2 TRACE: CLICKING CAMERA AIM TOGGLE ---');
    const toggleClickResult = await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (!btn) return { error: 'Toggle button not found' };
        btn.click();
        return { clicked: true };
      })()
    `);
    console.log('Toggle Click Result:', toggleClickResult);

    // Wait 3 seconds for camera stream and workers to start
    await wait(3000);

    // 7. Check Questions A - F from user prompt
    console.log('\n--- SECTION 2 TRACE: QUESTIONS A - F ---');
    const detailedDiagnostics = await evalInBrowser(`
      (() => {
        const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
        if (!ca) return { error: 'No cameraAim' };

        const video = ca.video || document.getElementById('camera-aim-video');

        return {
          // A. Does webcam start in multiplayer?
          hasStream: !!ca.stream,
          streamActive: ca.stream ? ca.stream.active : false,
          videoTracksCount: ca.stream ? ca.stream.getVideoTracks().length : 0,
          videoTrackEnabled: ca.stream && ca.stream.getVideoTracks()[0] ? ca.stream.getVideoTracks()[0].enabled : false,

          // B. Does the video element receive frames?
          hasVideoElement: !!video,
          videoReadyState: video ? video.readyState : -1,
          videoPaused: video ? video.paused : true,
          videoCurrentTime: video ? video.currentTime : -1,
          videoWidth: video ? video.videoWidth : -1,
          videoHeight: video ? video.videoHeight : -1,
          videoFramesDelivered: ca.videoFramesDelivered,

          // C. Is the face detector initialized?
          isFaceDetectorInitialized: ca.isFaceDetectorInitialized,
          faceWorkerExists: !!ca.faceWorker,
          faceWorkerReady: ca.faceWorkerReady,
          faceWorkerBusy: ca.faceWorkerBusy,
          useFaceDetector: ca.useFaceDetector,

          // D. Is the detector processing frames?
          latestFrameProcessed: ca.latestFrameProcessed,
          faceFrameCount: ca.diagnostics.faceFrameCount,
          lastFaceRunTime: ca.lastFaceRunTime,
          trackingActive: ca.trackingActive,

          // E. Are face results being returned?
          hasFace: ca.latestSnapshot.hasFace,
          faceCount: ca.latestSnapshot.faceCount,
          confidence: ca.latestSnapshot.confidence,
          faceTimestamp: ca.latestSnapshot.faceTimestamp,
          poseBadgeText: ca.dom.poseBadge ? ca.dom.poseBadge.textContent : null,
          statusLine: ca.dom.statusLine ? ca.dom.statusLine.textContent : null,

          // F. Is the multiplayer camera controller receiving those results?
          controlsExists: !!(ca.getControls && ca.getControls()),
          controlsLocked: !!(ca.getControls && ca.getControls() && ca.getControls().isLocked),
          controlsCamAimActive: !!(ca.getControls && ca.getControls() && ca.getControls().isCameraAimActive),
          yaw: ca.yaw,
          pitch: ca.pitch,
          turnRateYaw: ca.turnRateYaw,
          turnRatePitch: ca.turnRatePitch,
          cameraAimActive: ca.isActive
        };
      })()
    `);
    console.log('Detailed Multiplayer Diagnostics:', detailedDiagnostics);

    p2Socket.disconnect();
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('[MP TRACE ERROR]', err);
  process.exit(1);
});
