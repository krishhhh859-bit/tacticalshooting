/**
 * PARA SF: FOREST ACCURACY - Decoupled Background Face Worker
 * 
 * Offloads computer vision inference from the main browser thread to guarantee:
 * - ZERO main-thread blocking (Three.js rendering stays at full 60+ FPS).
 * - ZERO input latency accumulation (latest frame only, drops stale frames).
 * - Ultra-lightweight BlazeFace detector (229KB, 2-5ms) with FaceLandmarker fallback.
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
      console.error('[FACE WORKER] Failed to importScripts vision_bundle.js:', err);
    }
  }
  return null;
}

let faceDetector = null;
let faceLandmarker = null;
let useFaceDetector = true;
let isInitializing = false;
let isReady = false;

// 5 Structural Regions for Whole-Face Centroid (FaceLandmarker fallback)
const FOREHEAD_IDXS = [10, 109, 338];
const LEFT_CHEEK_IDXS = [234, 93, 132];
const RIGHT_CHEEK_IDXS = [454, 323, 361];
const CHIN_IDXS = [152, 148, 377];
const MIDFACE_IDXS = [168, 6, 2, 1];

function computeWholeFaceCentroid(face) {
  if (!face || face.length < 468) return null;

  let foreheadX = 0, foreheadY = 0;
  for (let i = 0; i < FOREHEAD_IDXS.length; i++) {
    const pt = face[FOREHEAD_IDXS[i]];
    foreheadX += pt.x;
    foreheadY += pt.y;
  }
  foreheadX /= FOREHEAD_IDXS.length;
  foreheadY /= FOREHEAD_IDXS.length;

  let leftCheekX = 0, leftCheekY = 0;
  for (let i = 0; i < LEFT_CHEEK_IDXS.length; i++) {
    const pt = face[LEFT_CHEEK_IDXS[i]];
    leftCheekX += pt.x;
    leftCheekY += pt.y;
  }
  leftCheekX /= LEFT_CHEEK_IDXS.length;
  leftCheekY /= LEFT_CHEEK_IDXS.length;

  let rightCheekX = 0, rightCheekY = 0;
  for (let i = 0; i < RIGHT_CHEEK_IDXS.length; i++) {
    const pt = face[RIGHT_CHEEK_IDXS[i]];
    rightCheekX += pt.x;
    rightCheekY += pt.y;
  }
  rightCheekX /= RIGHT_CHEEK_IDXS.length;
  rightCheekY /= RIGHT_CHEEK_IDXS.length;

  let chinX = 0, chinY = 0;
  for (let i = 0; i < CHIN_IDXS.length; i++) {
    const pt = face[CHIN_IDXS[i]];
    chinX += pt.x;
    chinY += pt.y;
  }
  chinX /= CHIN_IDXS.length;
  chinY /= CHIN_IDXS.length;

  let midFaceX = 0, midFaceY = 0;
  for (let i = 0; i < MIDFACE_IDXS.length; i++) {
    const pt = face[MIDFACE_IDXS[i]];
    midFaceX += pt.x;
    midFaceY += pt.y;
  }
  midFaceX /= MIDFACE_IDXS.length;
  midFaceY /= MIDFACE_IDXS.length;

  const rawFaceX = (foreheadX + leftCheekX + rightCheekX + chinX + midFaceX) * 0.2;
  const rawFaceY = (foreheadY + leftCheekY + rightCheekY + chinY + midFaceY) * 0.2;

  const faceWidth = Math.max(0.08, Math.hypot(face[454].x - face[234].x, face[454].y - face[234].y));
  const faceHeight = Math.max(0.08, Math.hypot(face[10].x - face[152].x, face[10].y - face[152].y));

  return { rawFaceX, rawFaceY, faceWidth, faceHeight };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'INIT': {
      if (isReady || isInitializing) {
        self.postMessage({ type: 'INIT_OK', useFaceDetector, isReady: true });
        return;
      }
      isInitializing = true;

      try {
        const vision = ensureVisionBundle();
        if (!vision) {
          throw new Error('Failed to load Vision bundle in worker');
        }
        const { FilesetResolver, FaceDetector, FaceLandmarker } = vision;
        const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath || '/lib/mediapipe/wasm');

        // 1. Initialize FaceLandmarker (Full 468 facial landmark mesh verification)
        // Eliminates false positives from random objects, camera cover, or empty room
        const landmarkerOpts = {
          baseOptions: {
            modelAssetPath: msg.faceLandmarkerPath || '/assets/models/face_landmarker.task',
            delegate: 'CPU'
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.6,
          minFacePresenceConfidence: 0.6,
          minTrackingConfidence: 0.6
        };

        try {
          if (FaceLandmarker) {
            faceLandmarker = await FaceLandmarker.createFromOptions(fileset, landmarkerOpts);
            useFaceDetector = false;
            console.log('[FACE WORKER] FaceLandmarker initialized with 468 landmark verification.');
          } else {
            throw new Error('FaceLandmarker not in bundle');
          }
        } catch (landmarkerErr) {
          console.warn('[FACE WORKER] FaceLandmarker failed, trying FaceDetector:', landmarkerErr);
          if (FaceDetector) {
            const detectorOpts = {
              baseOptions: {
                modelAssetPath: msg.faceModelPath || '/assets/models/blaze_face_short_range.tflite',
                delegate: 'CPU'
              },
              runningMode: 'VIDEO',
              minDetectionConfidence: 0.75, // Higher threshold to avoid false positives on random objects
              minSuppressionThreshold: 0.3
            };
            faceDetector = await FaceDetector.createFromOptions(fileset, detectorOpts);
            useFaceDetector = true;
            console.log('[FACE WORKER] BlazeFace FaceDetector fallback initialized.');
          }
        }

        isInitializing = false;
        isReady = true;
        self.postMessage({ type: 'INIT_OK', useFaceDetector, isReady: true });
      } catch (err) {
        isInitializing = false;
        console.error('[FACE WORKER] Init failed:', err);
        self.postMessage({ type: 'INIT_ERROR', error: String(err?.message || err) });
      }
      break;
    }

    case 'INFER_FACE': {
      const bitmap = msg.bitmap;
      const timestamp = msg.timestamp || performance.now();
      const capturedAt = msg.capturedAt || timestamp;

      if (!bitmap || (!faceDetector && !faceLandmarker)) {
        if (bitmap) {
          try { bitmap.close(); } catch (_) {}
        }
        self.postMessage({
          type: 'FACE_RESULT',
          hasFace: false,
          timestamp,
          capturedAt,
          inferenceMs: 0
        });
        return;
      }

      try {
        const t0 = performance.now();

        if (useFaceDetector && faceDetector) {
          const detectRes = faceDetector.detectForVideo(bitmap, timestamp);
          const inferenceMs = Math.round(performance.now() - t0);
          const vw = bitmap.width || 640;
          const vh = bitmap.height || 480;
          bitmap.close();

          const detections = detectRes?.detections;
          if (!detections || !Array.isArray(detections) || detections.length === 0) {
            self.postMessage({
              type: 'FACE_RESULT',
              hasFace: false,
              faceCount: 0,
              confidence: 0,
              timestamp,
              capturedAt,
              inferenceMs
            });
            return;
          }

          const det = detections[0];
          const score = (det.categories && det.categories[0] && typeof det.categories[0].score === 'number')
            ? det.categories[0].score
            : 0;

          if (score < 0.75 || !det.keypoints || det.keypoints.length < 4) {
            self.postMessage({
              type: 'FACE_RESULT',
              hasFace: false,
              faceCount: 0,
              confidence: score,
              timestamp,
              capturedAt,
              inferenceMs
            });
            return;
          }

          const box = det.boundingBox || { originX: 0, originY: 0, width: 0, height: 0 };
          const boxNormWidth = Math.max(0.08, box.width / vw);
          const boxNormHeight = Math.max(0.08, box.height / vh);
          const boxCenterX = (box.originX + box.width * 0.5) / vw;
          const boxCenterY = (box.originY + box.height * 0.5) / vh;

          let rawFaceX = boxCenterX;
          let rawFaceY = boxCenterY;

          if (det.keypoints && det.keypoints.length >= 4) {
            let kpX = 0, kpY = 0;
            const kps = det.keypoints;
            for (let i = 0; i < kps.length; i++) {
              kpX += kps[i].x;
              kpY += kps[i].y;
            }
            rawFaceX = boxCenterX * 0.5 + (kpX / kps.length) * 0.5;
            rawFaceY = boxCenterY * 0.5 + (kpY / kps.length) * 0.5;
          }

          const boxNorm = {
            x: box.originX / vw,
            y: box.originY / vh,
            w: boxNormWidth,
            h: boxNormHeight
          };

          self.postMessage({
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: detections.length,
            confidence: score,
            rawFaceX,
            rawFaceY,
            faceWidth: boxNormWidth,
            faceHeight: boxNormHeight,
            box: boxNorm,
            timestamp,
            capturedAt,
            inferenceMs
          });
        } else if (faceLandmarker) {
          const faceResults = faceLandmarker.detectForVideo(bitmap, timestamp);
          const inferenceMs = Math.round(performance.now() - t0);
          bitmap.close();

          const faces = faceResults?.faceLandmarks;
          if (!faces || !Array.isArray(faces) || faces.length === 0 || faces[0].length < 468) {
            self.postMessage({
              type: 'FACE_RESULT',
              hasFace: false,
              faceCount: 0,
              confidence: 0,
              timestamp,
              capturedAt,
              inferenceMs
            });
            return;
          }

          const centroid = computeWholeFaceCentroid(faces[0]);
          if (!centroid) {
            self.postMessage({
              type: 'FACE_RESULT',
              hasFace: false,
              faceCount: 0,
              confidence: 0,
              timestamp,
              capturedAt,
              inferenceMs
            });
            return;
          }

          self.postMessage({
            type: 'FACE_RESULT',
            hasFace: true,
            faceCount: faces.length,
            confidence: 1.0,
            rawFaceX: centroid.rawFaceX,
            rawFaceY: centroid.rawFaceY,
            faceWidth: centroid.faceWidth,
            faceHeight: centroid.faceHeight,
            box: {
              x: Math.max(0, centroid.rawFaceX - centroid.faceWidth * 0.5),
              y: Math.max(0, centroid.rawFaceY - centroid.faceHeight * 0.5),
              w: centroid.faceWidth,
              h: centroid.faceHeight
            },
            timestamp,
            capturedAt,
            inferenceMs
          });
        }
      } catch (err) {
        if (bitmap) {
          try { bitmap.close(); } catch (_) {}
        }
        self.postMessage({
          type: 'FACE_RESULT',
          hasFace: false,
          faceCount: 0,
          confidence: 0,
          timestamp,
          capturedAt,
          inferenceMs: 0,
          error: String(err?.message || err)
        });
      }
      break;
    }

    case 'CLOSE': {
      if (faceDetector && typeof faceDetector.close === 'function') {
        try { faceDetector.close(); } catch (_) {}
      }
      if (faceLandmarker && typeof faceLandmarker.close === 'function') {
        try { faceLandmarker.close(); } catch (_) {}
      }
      faceDetector = null;
      faceLandmarker = null;
      isReady = false;
      self.close();
      break;
    }
  }
};
