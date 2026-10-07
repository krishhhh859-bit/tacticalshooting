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
  console.log('[LIVE TEST] Launching Headless Chrome with fake webcam stream (NO FACE)...');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9225',
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
        targets = await fetchJson('http://localhost:9225/json/list');
        if (targets && targets.length > 0) break;
      } catch (_) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP port 9225');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    console.log('[LIVE TEST] Connected to Page:', pageTarget.url);

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
        console.log(`[BROWSER CONSOLE] ${text}`);
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

    // Click PC mode
    await evalInBrowser(`
      (() => {
        const btnPC = document.getElementById('btn-select-pc');
        if (btnPC) btnPC.click();
      })()
    `);
    await wait(1000);

    // Click Solo
    await evalInBrowser(`
      (() => {
        const btnSolo = document.getElementById('btn-solo-practice');
        if (btnSolo) btnSolo.click();
      })()
    `);
    // Wait for match to start
    console.log('[LIVE TEST] Waiting for match countdown to finish...');
    for (let w = 0; w < 30; w++) {
      const hasGame = await evalInBrowser(`!!(window.game && window.game.cameraAim)`);
      if (hasGame) {
        console.log('[LIVE TEST] window.game.cameraAim found at wait step', w);
        break;
      }
      await wait(500);
    }

    // Click camera aim toggle
    await evalInBrowser(`
      (() => {
        const btn = document.getElementById('btn-camera-aim-toggle');
        if (btn) btn.click();
      })()
    `);

    // Monitor for 10 seconds without any mocking!
    console.log('[LIVE TEST] Monitoring live cameraAim state for 8 seconds...');
    for (let i = 0; i < 8; i++) {
      await wait(1000);
      const state = await evalInBrowser(`
        (() => {
          const ca = (window.game && window.game.cameraAim) || (window.app && window.app.currentGame && window.app.currentGame.cameraAim);
          if (!ca) return { error: 'No cameraAim' };
          return {
            isActive: ca.isActive,
            isFaceDetectorInitialized: ca.isFaceDetectorInitialized,
            latestFrameProcessed: ca.latestFrameProcessed,
            faceWorkerReady: ca.faceWorkerReady,
            faceWorkerBusy: ca.faceWorkerBusy,
            useFaceDetector: ca.useFaceDetector,
            hasFace: ca.latestSnapshot.hasFace,
            faceCount: ca.latestSnapshot.faceCount,
            confidence: ca.latestSnapshot.confidence,
            aimX: ca.latestSnapshot.aimX,
            aimY: ca.latestSnapshot.aimY,
            poseBadgeText: ca.dom.poseBadge?.textContent,
            statusLine: ca.dom.statusLine?.textContent,
            diagLine: ca.dom.diag?.textContent
          };
        })()
      `);
      console.log(`[LIVE TEST T+${i+1}s]`, JSON.stringify(state));
    }

  } finally {
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('[LIVE TEST ERROR]', err);
  process.exit(1);
});
