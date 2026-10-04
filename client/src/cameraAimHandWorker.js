/**
 * PARA SF: FOREST ACCURACY - Decoupled Background Hand Worker
 * 
 * Offloads HandLandmarker inference and fist-curl analysis off the main browser thread.
 * Guarantees ZERO main-thread blocking for Three.js rendering and weapon shooting.
 */

/* global importScripts, self */
let VisionObj = null;

function ensureVisionBundle() {
  if (VisionObj) return VisionObj;
  if (typeof Vision !== 'undefined') {
    VisionObj = Vision;
    return VisionObj;
  }
  if (self.Vision) {
    VisionObj = self.Vision;
    return VisionObj;
  }
  if (typeof importScripts === 'function') {
    try {
      importScripts('/lib/mediapipe/vision_bundle.js');
      VisionObj = (typeof Vision !== 'undefined') ? Vision : self.Vision;
      return VisionObj;
    } catch (err) {
      console.error('[HAND WORKER] Failed to importScripts vision_bundle.js:', err);
    }
  }
  return null;
}

let handLandmarker = null;
let isInitializing = false;
let isReady = false;

// Instant Fist Hysteresis Thresholds
const FIST_ON_THRESHOLD = 0.65;
const FIST_OFF_THRESHOLD = 0.45;
let confirmedFist = false;

function calculateFistScore(hand) {
  if (!hand || hand.length < 21) return 0;

  const wrist = hand[0], middleMcp = hand[9], pinkyMcp = hand[17], indexMcp = hand[5];
  const palmLen = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const palmWid = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);
  const handScale = Math.max(0.04, (palmLen + palmWid) * 0.5);

  const getFingerCurl = (tipIdx, mcpIdx) => {
    const dWrist = Math.hypot(hand[tipIdx].x - wrist.x, hand[tipIdx].y - wrist.y) / handScale;
    const dMcp = Math.hypot(hand[tipIdx].x - hand[mcpIdx].x, hand[tipIdx].y - hand[mcpIdx].y) / handScale;
    return Math.max(0, Math.min(1, (1.55 - dWrist) / 0.75)) * 0.55 + Math.max(0, Math.min(1, (1.15 - dMcp) / 0.60)) * 0.45;
  };

  const cIndex = getFingerCurl(8, 5);
  const cMiddle = getFingerCurl(12, 9);
  const cRing = getFingerCurl(16, 13);
  const cPinky = getFingerCurl(20, 17);
  const dThumb = Math.hypot(hand[4].x - indexMcp.x, hand[4].y - indexMcp.y) / handScale;
  const cThumb = Math.max(0, Math.min(1, (1.20 - dThumb) / 0.65));

  const fourFingers = (cIndex + cMiddle + cRing + cPinky) * 0.25;
  const minCurl = Math.min(cIndex, cMiddle, cRing, cPinky);

  return Math.max(0, Math.min(1, fourFingers * 0.70 + minCurl * 0.20 + cThumb * 0.10));
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'INIT': {
      if (isReady || isInitializing) {
        self.postMessage({ type: 'INIT_OK', isReady: true });
        return;
      }
      isInitializing = true;

      try {
        const vision = ensureVisionBundle();
        if (!vision) {
          throw new Error('Failed to load Vision bundle in hand worker');
        }
        const { FilesetResolver, HandLandmarker } = vision;
        const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath || '/lib/mediapipe/wasm');

        const handOpts = {
          baseOptions: {
            modelAssetPath: msg.handModelPath || '/assets/models/hand_landmarker.task',
            delegate: 'CPU'
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        };

        handLandmarker = await HandLandmarker.createFromOptions(fileset, handOpts);
        isInitializing = false;
        isReady = true;
        console.log('[HAND WORKER] HandLandmarker initialized successfully in background thread.');
        self.postMessage({ type: 'INIT_OK', isReady: true });
      } catch (err) {
        isInitializing = false;
        console.error('[HAND WORKER] Init failed:', err);
        self.postMessage({ type: 'INIT_ERROR', error: String(err?.message || err) });
      }
      break;
    }

    case 'INFER_HAND': {
      const bitmap = msg.bitmap;
      const timestamp = msg.timestamp || performance.now();
      const capturedAt = msg.capturedAt || timestamp;

      if (!bitmap || !handLandmarker) {
        if (bitmap) {
          try { bitmap.close(); } catch (_) {}
        }
        self.postMessage({
          type: 'HAND_RESULT',
          hasHand: false,
          fistScore: 0,
          isFist: false,
          timestamp,
          capturedAt,
          inferenceMs: 0
        });
        return;
      }

      try {
        const t0 = performance.now();
        const handRes = handLandmarker.detectForVideo(bitmap, timestamp);
        const inferenceMs = Math.round(performance.now() - t0);
        bitmap.close();

        const landmarks = handRes?.landmarks;
        if (!landmarks || landmarks.length === 0 || landmarks[0].length < 21) {
          confirmedFist = false;
          self.postMessage({
            type: 'HAND_RESULT',
            hasHand: false,
            fistScore: 0,
            isFist: false,
            timestamp,
            capturedAt,
            inferenceMs
          });
          return;
        }

        const hand = landmarks[0];
        const fistScore = calculateFistScore(hand);

        if (fistScore >= FIST_ON_THRESHOLD) {
          confirmedFist = true;
        } else if (fistScore <= FIST_OFF_THRESHOLD) {
          confirmedFist = false;
        }

        self.postMessage({
          type: 'HAND_RESULT',
          hasHand: true,
          fistScore,
          isFist: confirmedFist,
          timestamp,
          capturedAt,
          inferenceMs
        });
      } catch (err) {
        if (bitmap) {
          try { bitmap.close(); } catch (_) {}
        }
        self.postMessage({
          type: 'HAND_RESULT',
          hasHand: false,
          fistScore: 0,
          isFist: false,
          timestamp,
          capturedAt,
          inferenceMs: 0,
          error: String(err?.message || err)
        });
      }
      break;
    }

    case 'CLOSE': {
      if (handLandmarker && typeof handLandmarker.close === 'function') {
        try { handLandmarker.close(); } catch (_) {}
      }
      handLandmarker = null;
      isReady = false;
      self.close();
      break;
    }
  }
};
