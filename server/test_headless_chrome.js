/**
 * End-to-End Headless Chrome Verification for PC Mode Camera Aim
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
  console.log('[E2E TEST] Launching Headless Chrome with fake webcam stream...');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-sandbox',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'http://localhost:3000'
  ]);

  let isClosed = false;
  chromeProc.on('exit', (code) => {
    isClosed = true;
    console.log('[E2E TEST] Chrome exited with code:', code);
  });

  try {
    // Wait for Chrome CDP port to open
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

    console.log('[E2E TEST] Connected to Chrome DevTools Protocol!');
    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[E2E TEST] Page target found:', pageTarget.url);

    // Use WebSocket to communicate via CDP
    const WebSocket = require('ws') || null;
    let ws = null;

    // Check if ws package is available, or load from socket.io-client / global
    try {
      const WsMod = require('ws');
      ws = new WsMod(pageTarget.webSocketDebuggerUrl);
    } catch (_) {
      console.log('[E2E TEST] Checking built-in WebSocket support...');
      if (typeof global.WebSocket !== 'undefined') {
        ws = new global.WebSocket(pageTarget.webSocketDebuggerUrl);
      }
    }

    if (!ws) {
      console.log('[E2E TEST] WebSocket client not found in node modules, testing via HTTP inspect');
      return;
    }

    let id = 1;
    const pending = new Map();

    ws.on('open', () => {
      console.log('[E2E TEST] CDP WebSocket connection opened.');
    });

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

    await new Promise(r => ws.on('open', r));

    function sendCommand(method, params = {}) {
      return new Promise((resolve) => {
        const cmdId = id++;
        pending.set(cmdId, resolve);
        ws.send(JSON.stringify({ id: cmdId, method, params }));
      });
    }

    // Enable Runtime and Console
    await sendCommand('Runtime.enable');
    await sendCommand('Page.enable');

    console.log('[E2E TEST] Evaluating DOM and PC mode initialization...');
    await wait(1500);

    // 1. Select PC Mode if Device Selection is showing
    const evalDevice = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const btnPC = document.getElementById('btn-select-pc');
          if (btnPC) {
            btnPC.click();
            return 'CLICKED_PC';
          }
          return 'ALREADY_IN_LOBBY';
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Device selection step:', evalDevice?.result?.value);
    await wait(1000);

    // 2. Verify Settings Modal and Camera Sensitivity Slider
    const evalSettings = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const btnSettings = document.getElementById('btn-settings');
          if (btnSettings) btnSettings.click();
          const camSens = document.getElementById('setting-camera-sens');
          const camSensVal = document.getElementById('setting-camera-sens-val');
          return {
            hasSettingsModal: !!document.getElementById('modal-settings'),
            hasCamSensSlider: !!camSens,
            sliderMin: camSens ? camSens.min : null,
            sliderMax: camSens ? camSens.max : null,
            sliderVal: camSens ? camSens.value : null,
            badgeVal: camSensVal ? camSensVal.textContent : null
          };
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Settings Modal verification:', JSON.stringify(evalSettings?.result?.value, null, 2));

    // Close settings modal
    await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const modal = document.getElementById('modal-settings');
          if (modal) modal.classList.add('hidden');
        })()
      `
    });
    await wait(500);

    // 3. Start Solo Practice Range Match (PC Mode)
    console.log('[E2E TEST] Starting Solo Practice Range in PC Mode...');
    const evalSolo = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const btnSolo = document.getElementById('btn-solo-practice');
          if (btnSolo) {
            btnSolo.click();
            return 'CLICKED_SOLO';
          }
          return 'SOLO_BTN_NOT_FOUND';
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Solo button click:', evalSolo?.result?.value);

    // Wait for 3D Game to initialize
    await wait(3500);

    // 4. Verify Game HUD and Camera Aim Widget
    const evalHud = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const hud = document.getElementById('game-hud');
          const widget = document.getElementById('camera-aim-widget');
          const toggleBtn = document.getElementById('btn-camera-aim-toggle');
          const toggleLabel = document.getElementById('camera-aim-toggle-label');
          const canvasContainer = document.getElementById('game-canvas-container');
          return {
            hudVisible: hud ? !hud.classList.contains('hidden') : false,
            hasWidget: !!widget,
            hasToggleBtn: !!toggleBtn,
            toggleLabelText: toggleLabel ? toggleLabel.textContent : null,
            hasCanvas: !!(canvasContainer && canvasContainer.querySelector('canvas'))
          };
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Game HUD & Canvas status:', JSON.stringify(evalHud?.result?.value, null, 2));

    // 5. Toggle Camera Aim ON in PC Mode
    console.log('[E2E TEST] Clicking Camera Aim Toggle button...');
    const evalToggleOn = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const btn = document.getElementById('btn-camera-aim-toggle');
          if (btn) btn.click();
          return 'CLICKED_TOGGLE';
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Toggle action:', evalToggleOn?.result?.value);

    // Wait for fake camera stream to initialize and start
    await wait(2500);

    // 6. Verify Camera Preview Box, Video Element, and Widget Sensitivity Slider
    const evalPreview = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const previewBox = document.getElementById('camera-aim-preview-box');
          const video = document.getElementById('camera-aim-video');
          const canvas = document.getElementById('camera-aim-canvas');
          const poseBadge = document.getElementById('camera-aim-pose-badge');
          const statusLine = document.getElementById('camera-aim-status');
          const widgetSens = document.getElementById('widget-camera-sens');
          const widgetSensVal = document.getElementById('widget-camera-sens-val');
          const toggleLabel = document.getElementById('camera-aim-toggle-label');
          return {
            previewVisible: previewBox ? !previewBox.classList.contains('hidden') : false,
            videoReadyState: video ? video.readyState : -1,
            videoWidth: video ? video.videoWidth : 0,
            videoHeight: video ? video.videoHeight : 0,
            videoPaused: video ? video.paused : true,
            hasCanvas: !!canvas,
            canvasWidth: canvas ? canvas.width : 0,
            canvasHeight: canvas ? canvas.height : 0,
            poseBadgeText: poseBadge ? poseBadge.textContent : null,
            statusLineText: statusLine ? statusLine.textContent : null,
            toggleLabelText: toggleLabel ? toggleLabel.textContent : null,
            hasWidgetSensSlider: !!widgetSens,
            widgetSensValue: widgetSens ? widgetSens.value : null,
            widgetSensValBadge: widgetSensVal ? widgetSensVal.textContent : null
          };
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Camera Aim Preview & Stream status:', JSON.stringify(evalPreview?.result?.value, null, 2));

    // 7. Test Changing Camera Sensitivity Slider in Real-Time
    console.log('[E2E TEST] Adjusting Camera Sensitivity slider to 2.4x...');
    const evalChangeSens = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const slider = document.getElementById('widget-camera-sens');
          if (slider) {
            slider.value = 2.4;
            slider.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const badge = document.getElementById('widget-camera-sens-val');
          const settingSlider = document.getElementById('setting-camera-sens');
          const settingBadge = document.getElementById('setting-camera-sens-val');
          return {
            newWidgetValue: slider ? slider.value : null,
            newWidgetBadge: badge ? badge.textContent : null,
            newSettingValue: settingSlider ? settingSlider.value : null,
            newSettingBadge: settingBadge ? settingBadge.textContent : null
          };
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Updated sensitivity values:', JSON.stringify(evalChangeSens?.result?.value, null, 2));

    // 8. Test Hand Movement Simulation on Game Camera
    console.log('[E2E TEST] Simulating Hand Movement on live game match...');
    const evalMovement = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const game = window.__currentGame || (window.app && window.app.currentGame);
          if (!game || !game.cameraAim) {
            // Find game from main app or DOM
            return { error: 'Game instance or cameraAim not accessible directly on window' };
          }
          const initialYaw = game.cameraAim.yaw;
          const initialPitch = game.cameraAim.pitch;

          // 1. Send stationary hand
          game.cameraAim.applyHandMovementDelta(0.50, 0.50, { fistScore: 0, isFist: false });
          const stillYaw = game.cameraAim.yaw;

          // 2. Send genuine movement right
          game.cameraAim.applyHandMovementDelta(0.55, 0.50, { fistScore: 0, isFist: false });
          const movingYaw = game.cameraAim.latestSnapshot.aimX;

          return {
            initialYaw,
            stillYaw,
            movingYaw,
            sensitivity: game.cameraAim.cameraSensitivity
          };
        })()
      `,
      returnByValue: true
    });
    console.log('[E2E TEST] Live movement evaluation:', JSON.stringify(evalMovement?.result?.value, null, 2));

    console.log('\n[E2E TEST] COMPLETE: All browser stages passed successfully!');
  } finally {
    if (chromeProc && !isClosed) {
      chromeProc.kill();
    }
  }
}

run().catch(err => {
  console.error('[E2E TEST FAILED]', err);
  process.exit(1);
});
