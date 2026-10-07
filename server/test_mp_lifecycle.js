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
  console.log('[TEST] Testing Solo -> Lobby -> Multiplayer Transition');
  console.log('====================================================');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9227',
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
        targets = await fetchJson('http://localhost:9227/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP port 9227');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[TEST] Connected to Page:', pageTarget.url);

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
        console.log(`[P1 LOG] ${text}`);
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

    // 1. Enter PC mode and go to Solo Practice
    console.log('[TEST] Starting Solo Practice...');
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

    // Turn camera aim ON in Solo
    console.log('[TEST] Toggling Camera Aim ON in Solo Practice...');
    const soloToggle = await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (btn) btn.click();
        return { clicked: true };
      })()
    `);
    console.log('[TEST] Solo Toggle:', soloToggle);
    await wait(2500);

    const soloStatus = await evalInBrowser(`
      (() => {
        const ca = window.game ? window.game.cameraAim : null;
        return {
          caActive: ca ? ca.isActive : false,
          hasStream: ca ? !!ca.stream : false,
          isFaceDetectorInitialized: ca ? ca.isFaceDetectorInitialized : false
        };
      })()
    `);
    console.log('[TEST] Solo Status:', soloStatus);

    // 2. Click HOME button to return to Lobby
    console.log('[TEST] Returning to Lobby from Solo Practice...');
    await evalInBrowser(`
      (() => {
        const btnHome = document.getElementById('btn-hud-home');
        if (btnHome) btnHome.click();
        const btnLeave = document.getElementById('btn-home-leave');
        if (btnLeave) btnLeave.click();
      })()
    `);
    await wait(2000);

    // 3. Create Multiplayer Room
    console.log('[TEST] Creating Multiplayer Room...');
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
    console.log('[TEST] Room Code:', roomCode);

    // Connect Player 2
    console.log('[TEST] Player 2 connecting...');
    const p2Socket = io('http://localhost:3000');
    await new Promise((resolve, reject) => {
      p2Socket.on('connect', () => {
        p2Socket.emit('join_room', { roomCode, name: 'Player 2 Opponent', device: 'pc' });
      });
      p2Socket.on('room_joined', resolve);
      p2Socket.on('join_error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for P2 room_joined')), 5000);
    });

    // Wait for match to start
    console.log('[TEST] Waiting for multiplayer match to start...');
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
    console.log('[TEST] Multiplayer match started:', matchStarted);

    // Check camera aim status in Multiplayer immediately
    const mpInitialCA = await evalInBrowser(`
      (() => {
        const ca = window.game ? window.game.cameraAim : null;
        return {
          caActive: ca ? ca.isActive : false,
          hasStream: ca ? !!ca.stream : false,
          isFaceDetectorInitialized: ca ? ca.isFaceDetectorInitialized : false,
          btnText: document.getElementById('camera-aim-toggle-label')?.textContent
        };
      })()
    `);
    console.log('[TEST] MP Initial Camera Aim State:', mpInitialCA);

    // Now try clicking the Toggle button in Multiplayer!
    console.log('[TEST] Clicking Toggle Button in Multiplayer...');
    await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (btn) btn.click();
      })()
    `);
    await wait(3000);

    const mpAfterToggle = await evalInBrowser(`
      (() => {
        const ca = window.game ? window.game.cameraAim : null;
        return {
          caActive: ca ? ca.isActive : false,
          hasStream: ca ? !!ca.stream : false,
          isFaceDetectorInitialized: ca ? ca.isFaceDetectorInitialized : false,
          btnText: document.getElementById('camera-aim-toggle-label')?.textContent,
          videoReadyState: ca?.video?.readyState,
          cameraFps: ca?.diagnostics?.cameraFps,
          faceFrameCount: ca?.diagnostics?.faceFrameCount,
          yaw: ca?.yaw,
          pitch: ca?.pitch
        };
      })()
    `);
    console.log('[TEST] MP After Toggle State:', mpAfterToggle);

    p2Socket.disconnect();
  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
