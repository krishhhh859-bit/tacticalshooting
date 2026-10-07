/**
 * PARA SF: FOREST ACCURACY - Decoupled Background Hand Worker
 * 
 * Offloads HandLandmarker inference, index-finger tracking, hand movement analysis,
 * and fist-curl analysis off the main browser thread.
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
let lastHandTimestamp = -1;

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

  let rawScore = fourFingers * 0.70 + minCurl * 0.20 + cThumb * 0.10;
  if (cIndex < 0.55) {
    rawScore *= (cIndex / 0.55);
  }

  return Math.max(0, Math.min(1, rawScore));
}

function calculateHandAimPoint(hand) {
  if (!hand || hand.length < 21) return null;

  const wrist = hand[0];
  const indexMcp = hand[5];
  const indexTip = hand[8];
  const middleMcp = hand[9];
  const pinkyMcp = hand[17];

  const palmLen = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const palmWid = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);
  const handScale = Math.max(0.04, (palmLen + palmWid) * 0.5);

  const dWrist = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y) / handScale;
  const dMcp = Math.hypot(indexTip.x - indexMcp.x, indexTip.y - indexMcp.y) / handScale;
  const cIndex = Math.max(0, Math.min(1,
    Math.max(0, Math.min(1, (1.55 - dWrist) / 0.75)) * 0.55 +
    Math.max(0, Math.min(1, (1.15 - dMcp) / 0.60)) * 0.45
  ));

  // Pointing: track index finger tip + knuckle
  const extendedX = indexTip.x * 0.75 + indexMcp.x * 0.25;
  const extendedY = indexTip.y * 0.75 + indexMcp.y * 0.25;

  // Fist / curled: anchor to knuckle + palm center
  const fistX = indexMcp.x * 0.5 + middleMcp.x * 0.3 + wrist.x * 0.2;
  const fistY = indexMcp.y * 0.5 + middleMcp.y * 0.3 + wrist.y * 0.2;

  // Continuous blend
  const aimX = extendedX * (1 - cIndex) + fistX * cIndex;
  const aimY = extendedY * (1 - cIndex) + fistY * cIndex;

  return {
    aimX,
    aimY,
    cIndex,
    indexTipX: indexTip.x,
    indexTipY: indexTip.y,
    indexMcpX: indexMcp.x,
    indexMcpY: indexMcp.y,
    wristX: wrist.x,
    wristY: wrist.y
  };
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
      let timestamp = msg.timestamp || performance.now();
      const capturedAt = msg.capturedAt || timestamp;

      if (!bitmap || !handLandmarker) {
        if (bitmap) {
          try { bitmap.close(); } catch (_) {}
        }
        self.postMessage({
          type: 'HAND_RESULT',
          hasHand: false,
          rawAimX: null,
          rawAimY: null,
          fistScore: 0,
          isFist: false,
          landmarks: null,
          timestamp,
          capturedAt,
          inferenceMs: 0
        });
        return;
      }

      try {
        // Enforce strictly monotonic timestamp for MediaPipe Video mode
        if (timestamp <= lastHandTimestamp) {
          timestamp = lastHandTimestamp + 1;
        }
        lastHandTimestamp = timestamp;

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
            rawAimX: null,
            rawAimY: null,
            fistScore: 0,
            isFist: false,
            landmarks: null,
            timestamp,
            capturedAt,
            inferenceMs
          });
          return;
        }

        const hand = landmarks[0];
        const fistScore = calculateFistScore(hand);
        const aimData = calculateHandAimPoint(hand);

        if (fistScore >= FIST_ON_THRESHOLD) {
          confirmedFist = true;
        } else if (fistScore <= FIST_OFF_THRESHOLD) {
          confirmedFist = false;
        }

        self.postMessage({
          type: 'HAND_RESULT',
          hasHand: true,
          rawAimX: aimData.aimX,
          rawAimY: aimData.aimY,
          indexTipX: aimData.indexTipX,
          indexTipY: aimData.indexTipY,
          indexMcpX: aimData.indexMcpX,
          indexMcpY: aimData.indexMcpY,
          wristX: aimData.wristX,
          wristY: aimData.wristY,
          cIndex: aimData.cIndex,
          fistScore,
          isFist: confirmedFist,
          landmarks: [
            { x: hand[0].x, y: hand[0].y },
            { x: hand[4].x, y: hand[4].y },
            { x: hand[5].x, y: hand[5].y },
            { x: hand[8].x, y: hand[8].y },
            { x: hand[9].x, y: hand[9].y },
            { x: hand[12].x, y: hand[12].y },
            { x: hand[13].x, y: hand[13].y },
            { x: hand[16].x, y: hand[16].y },
            { x: hand[17].x, y: hand[17].y },
            { x: hand[20].x, y: hand[20].y }
          ],
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
          rawAimX: null,
          rawAimY: null,
          fistScore: 0,
          isFist: false,
          landmarks: null,
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
