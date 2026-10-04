/**
 * PARA SF: FOREST ACCURACY - ZERO-LATENCY FACE + FIST INPUT CONTROLLER
 * 
 * Architecture & Core Principles:
 * 1. REAL-TIME HARDWARE WEBCAM CAPTURE & DIRECT DISPLAY:
 *    - getUserMedia() requests normal webcam stream: 640x480 @ 30 FPS.
 *    - Direct playback pipeline: MediaStream -> <video> (hardware-decoded by browser).
 *    - The <video> element playback NEVER depends on MediaPipe, inference completion,
 *      Three.js, canvas processing, or requestAnimationFrame.
 * 
 * 2. INDEPENDENT, DECOUPLED SCHEDULER (ZERO STARVATION):
 *    - Face and Hand tracking run independently:
 *        Face tracking target: 20-25 Hz (~45ms interval)
 *        Hand tracking target: 25-30 Hz (~35ms interval)
 *    - Hand NEVER blocks Face. Face NEVER blocks Hand.
 *    - ZERO backlog / queue: if an inference is busy, overlapping frames are dropped immediately.
 *      Inference always consumes the newest available video frame.
 * 
 * 3. STATE FLOW & CALIBRATION FIX (STEP 2 & STEP 4):
 *    - Flow: CAMERA READY -> WAITING FOR FACE -> FACE DETECTED -> CALIBRATING (1-10) -> TRACKING
 *    - If no face is in view: badge says 'WAITING FOR FACE' / 'FACE: NOT DETECTED', NEVER stuck on 'CALIBRATING'.
 *    - Calibration only collects samples from valid detected face landmarks.
 *    - Face detection continuously runs regardless of calibration state.
 * 
 * 4. INSTANT FIST TRIGGER (FRAME 1 LATENCY):
 *    - Clench (fistScore >= 0.65) -> shootHeld = true immediately on frame 1.
 *    - Open (fistScore <= 0.45) -> shootHeld = false immediately on frame 1.
 *    - Hand Lost -> shootHeld = false immediately on frame 1.
 *    - Fist shooting is completely independent from face tracking and calibration.
 * 
 * 5. ZERO-MOMENTUM WHOLE-FACE CAMERA AIM:
 *    - Symmetrical 5-region structural centroid (Forehead, Cheeks, Chin, Midface).
 *    - Bi-axial normalization by face width/height (distance invariant).
 *    - Instant stop: when head stops moving, movement delta drops to 0, camera halts immediately.
 * 
 * 6. COMPREHENSIVE REAL-TIME DIAGNOSTICS:
 *    - Real hardware metrics: VIDEO FPS, FACE FPS, HAND FPS, GAME FPS.
 *    - Step 3 & Step 9 diagnostic verification logs and HUD indicators.
 */

import { GAME_CONFIG } from './config.js';

export const FaceFistState = {
  DISABLED: 'DISABLED',
  CAMERA_STARTING: 'CAMERA_STARTING',
  WAITING_FOR_FACE: 'WAITING_FOR_FACE',
  CALIBRATING: 'CALIBRATING',
  TRACKING: 'TRACKING'
};

export class CameraAimController {
  constructor(camera, getControls, onShoot) {
    this.camera = camera;
    this.getControls = getControls; // Returns active PCControls or MobileControls
    this.onShoot = onShoot;         // Calls game.handleShoot(), returns boolean

    // State machine
    this.state = FaceFistState.DISABLED;
    this.isActive = false;
    this.isStarting = false;
    this.isSupported = !!(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
    );

    // Test Modes (RAW CAM, FACE ONLY, HAND ONLY, ALL ON)
    this.testMode = 'ALL'; // 'ALL', 'RAW', 'FACE_ONLY', 'HAND_ONLY'
    this.faceTrackingEnabled = true;
    this.handTrackingEnabled = true;

    // Hardware & Streams (Exactly ONE active stream)
    this.stream = null;
    this.video = null;
    this.canvasCtx = null;
    this.actualTrackWidth = 640;
    this.actualTrackHeight = 480;
    this.actualTrackFps = 30;

    // Trackers (Lightweight BlazeFace FaceDetector + HandLandmarker)
    this.faceDetector = null;
    this.faceLandmarker = null; // Fallback
    this.handLandmarker = null;
    this.useFaceDetector = true;
    this.isPipelineReady = false;
    this.faceGpuErrorCount = 0;
    this.handGpuErrorCount = 0;

    // Background Web Workers (Zero Main Thread Blocking for Face & Hand)
    this.faceWorker = null;
    this.faceWorkerReady = false;
    this.faceWorkerBusy = false;

    this.handWorker = null;
    this.handWorkerReady = false;
    this.handWorkerBusy = false;

    // Independent Tracking Busy Flags (Decoupled execution)
    this.handBusy = false;
    this.faceBusy = false;

    // Independent Scheduler Intervals (Zero starvation)
    this.handTrackingInterval = 35;  // ~28 Hz for fist detection
    this.faceTrackingInterval = 40;  // ~25 Hz for face aim
    this.lastHandRunTime = 0;
    this.lastFaceRunTime = 0;
    this.lastOverlayDrawTime = 0;
    this.lastFaceDiagLog = 0;

    // Frame Scheduler Management
    this.trackingActive = false;
    this.videoCallbackId = null;
    this.trackingTimerId = null;

    // Hardware Video Presentation Metrics (Step 9 & 10)
    this.videoFramesDelivered = 0;
    this.lastVideoFrameTime = 0;
    this.lastVideoFpsCalcTime = performance.now();
    this.lastObservedVideoTime = -1;

    // Whole-Face Movement State, Anti-Jitter Filter & Deadzones
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.faceWidth = 0.25;
    this.faceHeight = 0.30;
    this.isFaceMoving = false;
    this.sensitivityX = 2.4;
    this.sensitivityY = 2.0;
    this.DEADZONE_X = 0.0060; // Independent X deadzone threshold filtering sensor noise
    this.DEADZONE_Y = 0.0075; // Independent Y deadzone threshold filtering sensor noise
    this.DELTA_DEADZONE = 0.0060; // Backward compatibility alias
    this.MAX_REASONABLE_DELTA = 0.20; // Clamp impossible spikes & re-anchor
    this.invertY = false;

    // Fluid Sub-Frame Rotation (Smooth 60 FPS Camera Rotation without Stutter or Momentum)
    this.lastFaceDeltaTime = performance.now();
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;

    // Stale Input Safety Bounds
    this.MAX_FACE_INPUT_AGE = 120; // ms: if face result is older, stop camera look
    this.MAX_HAND_INPUT_AGE = 120; // ms: if hand result is older, stop shooting

    // Reused Snapshot Object (Zero GC Allocation Churn)
    this.latestSnapshot = {
      hasFace: false,
      hasHand: false,
      faceX: 0.5,
      faceY: 0.5,
      aimX: 0,
      aimY: 0,
      box: null,
      fistScore: 0,
      isFist: false,
      faceTimestamp: 0,
      handTimestamp: 0,
      faceCapturedAt: 0,
      handCapturedAt: 0
    };

    // Calibration State (STEP 2: Never calibrate without valid face detection)
    this.hasNeutralReference = false;
    this.isCalibrating = false;
    this.calibrationSamples = [];
    this.calibrationRequiredSamples = 10;
    this.neutralFaceX = 0.5;
    this.neutralFaceY = 0.5;

    // Camera Orientation
    this.yaw = 0;
    this.pitch = 0;

    // Weapon Hold-To-Fire & Instant Fist State
    this.shootHeld = false;
    this.confirmedFist = false;
    this.FIST_ON_THRESHOLD = 0.65;
    this.FIST_OFF_THRESHOLD = 0.45;
    this.fireInterval = (GAME_CONFIG?.WEAPON?.FIRE_RATE_MS || 110) / 1000; // 0.11s TAR-21
    this.fireCooldown = 0;

    // Performance Diagnostics & Latency Metrics (Step 9 Compliant)
    this.diagnostics = {
      cameraFps: 30,
      gameFps: 60,
      faceFps: 22,
      handFps: 28,
      faceMs: 8,
      handMs: 10,
      faceAgeMs: 0,
      handAgeMs: 0,
      faceLatencyMs: 0,
      handLatencyMs: 0,
      renderFrameCount: 0,
      faceFrameCount: 0,
      handFrameCount: 0,
      lastDiagTime: performance.now(),
      lastStatusUpdate: 0,
      lastConsoleLog: 0
    };

    // DOM Elements Cache
    this.dom = {
      widget: null,
      toggleBtn: null,
      toggleLabel: null,
      mobileToggleBtn: null,
      mobileToggleLabel: null,
      previewBox: null,
      video: null,
      canvas: null,
      poseBadge: null,
      statusLine: null,
      diag: null,
      calibrateBtn: null,
      stopBtn: null,
      alertToast: null,
      modeAllBtn: null,
      modeRawBtn: null,
      modeFaceBtn: null,
      modeHandBtn: null
    };

    this.initDOM();
  }

  // --- DOM INITIALIZATION (EXACT ID MATCHING WITH KEBAB & CAMEL FALLBACKS) ---

  initDOM() {
    if (typeof document === 'undefined') return;

    this.dom.widget = document.getElementById('camera-aim-widget') || document.getElementById('cameraAimWidget');
    this.dom.toggleBtn = document.getElementById('btn-camera-aim-toggle') || document.getElementById('cameraAimToggle');
    this.dom.toggleLabel = document.getElementById('camera-aim-toggle-label') || document.getElementById('cameraAimToggleLabel');
    this.dom.mobileToggleBtn = document.getElementById('btn-mobile-camera-aim-toggle') || document.getElementById('mobileCameraAimToggle');
    this.dom.mobileToggleLabel = document.getElementById('mobile-camera-aim-toggle-label') || document.getElementById('mobileCameraAimToggleLabel');
    this.dom.previewBox = document.getElementById('camera-aim-preview-box') || document.getElementById('cameraAimPreview');
    this.dom.video = document.getElementById('camera-aim-video') || document.getElementById('cameraAimVideo');
    this.dom.canvas = document.getElementById('camera-aim-canvas') || document.getElementById('cameraAimCanvas');
    this.dom.poseBadge = document.getElementById('camera-aim-pose-badge') || document.getElementById('cameraAimPoseBadge');
    this.dom.statusLine = document.getElementById('camera-aim-status') || document.getElementById('cameraAimStatusLine');
    this.dom.diag = document.getElementById('camera-aim-diag') || document.getElementById('cameraAimDiag');
    this.dom.calibrateBtn = document.getElementById('btn-camera-aim-calibrate') || document.getElementById('cameraAimCalibrate');
    this.dom.stopBtn = document.getElementById('btn-camera-aim-stop') || document.getElementById('cameraAimStop');
    this.dom.alertToast = document.getElementById('camera-aim-alert') || document.getElementById('cameraAimToast');

    // Test mode buttons
    this.dom.modeAllBtn = document.getElementById('btn-aim-mode-all');
    this.dom.modeRawBtn = document.getElementById('btn-aim-mode-raw');
    this.dom.modeFaceBtn = document.getElementById('btn-aim-mode-face');
    this.dom.modeHandBtn = document.getElementById('btn-aim-mode-hand');

    if (this.dom.modeAllBtn && !this.dom.modeAllBtn._hasHandler) {
      this.dom.modeAllBtn._hasHandler = true;
      this.dom.modeAllBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        this.setTestMode('ALL');
      });
    }
    if (this.dom.modeRawBtn && !this.dom.modeRawBtn._hasHandler) {
      this.dom.modeRawBtn._hasHandler = true;
      this.dom.modeRawBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        this.setTestMode('RAW');
      });
    }
    if (this.dom.modeFaceBtn && !this.dom.modeFaceBtn._hasHandler) {
      this.dom.modeFaceBtn._hasHandler = true;
      this.dom.modeFaceBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        this.setTestMode('FACE_ONLY');
      });
    }
    if (this.dom.modeHandBtn && !this.dom.modeHandBtn._hasHandler) {
      this.dom.modeHandBtn._hasHandler = true;
      this.dom.modeHandBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        this.setTestMode('HAND_ONLY');
      });
    }

    // High-contrast status line in markup
    if (!this.dom.statusLine && this.dom.previewBox) {
      this.dom.statusLine = document.createElement('div');
      this.dom.statusLine.id = 'camera-aim-status';
      this.dom.statusLine.className = 'camera-aim-status-line';
      this.dom.statusLine.textContent = 'GAME: 60 FPS · CAMERA: 30 FPS · FACE: 22 FPS · HAND: 28 FPS';
      if (this.dom.diag && this.dom.diag.parentElement) {
        this.dom.diag.parentElement.insertBefore(this.dom.statusLine, this.dom.diag);
      } else {
        this.dom.previewBox.appendChild(this.dom.statusLine);
      }
    }

    if (this.dom.canvas) {
      this.canvasCtx = this.dom.canvas.getContext('2d', { alpha: true });
    }

    // Bind UI actions safely without duplicate listeners
    const handleToggle = (e) => {
      e?.preventDefault();
      e?.stopPropagation();
      this.toggle();
    };

    if (this.dom.toggleBtn && !this.dom.toggleBtn._hasCameraAimHandler) {
      this.dom.toggleBtn._hasCameraAimHandler = true;
      this.dom.toggleBtn.addEventListener('click', handleToggle);
    }
    if (this.dom.mobileToggleBtn && !this.dom.mobileToggleBtn._hasCameraAimHandler) {
      this.dom.mobileToggleBtn._hasCameraAimHandler = true;
      this.dom.mobileToggleBtn.addEventListener('click', handleToggle);
    }

    if (this.dom.calibrateBtn && !this.dom.calibrateBtn._hasCameraAimHandler) {
      this.dom.calibrateBtn._hasCameraAimHandler = true;
      this.dom.calibrateBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        e?.stopPropagation();
        this.calibrate();
      });
    }

    if (this.dom.stopBtn && !this.dom.stopBtn._hasCameraAimHandler) {
      this.dom.stopBtn._hasCameraAimHandler = true;
      this.dom.stopBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        e?.stopPropagation();
        this.stop();
      });
    }

    this.updateToggleButton(false);
    this.updateTestModeUI();
  }

  setTestMode(mode) {
    this.testMode = mode;
    switch (mode) {
      case 'RAW':
        this.faceTrackingEnabled = false;
        this.handTrackingEnabled = false;
        this.shootHeld = false;
        this.confirmedFist = false;
        this.latestSnapshot.aimX = 0;
        this.latestSnapshot.aimY = 0;
        this.turnDurationRemaining = 0;
        this.turnRateYaw = 0;
        this.turnRatePitch = 0;
        this.showToast('TEST MODE: RAW WEBCAM ONLY (NO AI)');
        break;
      case 'FACE_ONLY':
        this.faceTrackingEnabled = true;
        this.handTrackingEnabled = false;
        this.shootHeld = false;
        this.confirmedFist = false;
        this.showToast('TEST MODE: FACE TRACKING ONLY');
        break;
      case 'HAND_ONLY':
        this.faceTrackingEnabled = false;
        this.handTrackingEnabled = true;
        this.latestSnapshot.aimX = 0;
        this.latestSnapshot.aimY = 0;
        this.turnDurationRemaining = 0;
        this.turnRateYaw = 0;
        this.turnRatePitch = 0;
        this.showToast('TEST MODE: HAND TRACKING ONLY');
        break;
      case 'ALL':
      default:
        this.faceTrackingEnabled = true;
        this.handTrackingEnabled = true;
        this.showToast('TEST MODE: FACE + FIST FULL ACTIVE');
        break;
    }
    this.updateTestModeUI();
    this.updateStatusUI();
  }

  updateTestModeUI() {
    const list = [
      { btn: this.dom.modeAllBtn, mode: 'ALL' },
      { btn: this.dom.modeRawBtn, mode: 'RAW' },
      { btn: this.dom.modeFaceBtn, mode: 'FACE_ONLY' },
      { btn: this.dom.modeHandBtn, mode: 'HAND_ONLY' }
    ];
    for (const item of list) {
      if (item.btn) {
        if (item.mode === this.testMode) {
          item.btn.classList.add('active');
        } else {
          item.btn.classList.remove('active');
        }
      }
    }
  }

  // --- TOGGLE / START / STOP ---

  async toggle() {
    if (this.isActive) {
      this.stop();
    } else {
      await this.start();
    }
  }

  async start() {
    if (this.isActive || this.isStarting) return;
    this.isStarting = true;

    // Refresh DOM element references to guarantee bindings
    this.initDOM();

    if (!this.isSupported) {
      this.showToast('WEBCAM NOT SUPPORTED (HTTPS REQUIRED ON LAN)');
      this.isStarting = false;
      return;
    }

    this.state = FaceFistState.CAMERA_STARTING;
    this.updatePoseBadge('STARTING WEBCAM...', 'badge-not-detected');
    this.updateToggleButton(true);

    if (this.dom.previewBox) {
      this.dom.previewBox.classList.remove('hidden');
    }

    try {
      // Release any prior stream tracks first to guarantee exactly one active stream
      if (this.stream) {
        this.stream.getTracks().forEach(t => {
          try { t.stop(); t.enabled = false; } catch (_) {}
        });
        this.stream = null;
      }

      // 1. Request normal webcam stream (640x480 @ 30 FPS)
      const constraints = {
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Verify active video track & log hardware settings
      const videoTracks = this.stream ? this.stream.getVideoTracks() : [];
      if (!videoTracks || videoTracks.length === 0 || !videoTracks[0].enabled) {
        throw new Error('No active video track available from webcam');
      }

      const track = videoTracks[0];
      const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      console.log('[WEBCAM TRACK SETTINGS]', settings);
      this.actualTrackWidth = settings.width || 640;
      this.actualTrackHeight = settings.height || 480;
      this.actualTrackFps = settings.frameRate || 30;

      // 2. Attach directly to webcam video element (MediaStream -> <video>)
      this.video = this.dom.video || document.getElementById('camera-aim-video');
      if (!this.video) {
        this.video = document.createElement('video');
        this.video.id = 'camera-aim-video';
        const wrapper = document.querySelector('.camera-preview-wrapper') || this.dom.previewBox || document.body;
        wrapper.insertBefore(this.video, wrapper.firstChild);
      }

      this.video.srcObject = this.stream;
      this.video.playsInline = true;
      this.video.muted = true;
      this.video.autoplay = true;

      // Wait for video data and readyState >= 2
      await new Promise((resolve) => {
        if (this.video.readyState >= 2) {
          resolve();
        } else {
          const onReady = () => {
            this.video.removeEventListener('loadeddata', onReady);
            this.video.removeEventListener('loadedmetadata', onReady);
            resolve();
          };
          this.video.addEventListener('loadeddata', onReady);
          this.video.addEventListener('loadedmetadata', onReady);
          setTimeout(resolve, 800);
        }
      });

      try {
        await this.video.play();
      } catch (playErr) {
        console.warn('[FACE+FIST] video.play() warning:', playErr);
      }

      if (this.dom.canvas) {
        this.dom.canvas.width = 320;
        this.dom.canvas.height = 240;
      }

      // 3. Sync orientation with current player look
      const ctrl = this.getControls ? this.getControls() : null;
      if (ctrl) {
        this.yaw = ctrl.yaw || 0;
        this.pitch = ctrl.pitch || 0;
        ctrl.isCameraAimActive = true;
      }

      this.isActive = true;
      this.trackingActive = true;
      this.handBusy = false;
      this.faceBusy = false;

      // STEP 2: State Flow Fix - Never calibrate until a face is detected
      this.hasNeutralReference = false;
      this.isCalibrating = false;
      this.calibrationSamples = [];
      this.state = FaceFistState.WAITING_FOR_FACE;
      this.updatePoseBadge('WAITING FOR FACE', 'badge-not-detected');

      this.stableFaceX = null;
      this.stableFaceY = null;
      this.prevFaceX = null;
      this.prevFaceY = null;
      this.isFaceMoving = false;
      this.latestSnapshot.hasFace = false;
      this.latestSnapshot.hasHand = false;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.shootHeld = false;
      this.confirmedFist = false;

      // Start hardware video presentation monitor
      this.startVideoPlaybackMonitoring();

      // 4. Initialize MediaPipe landmarkers
      await this.initLandmarkers();

      // 5. Start independent decoupled tracking scheduler
      this.startTrackingScheduler();

      this.showToast('FACE + FIST AIM ACTIVE');
      console.log(`[FACE+FIST] Hardware video pipeline active: ${this.actualTrackWidth}x${this.actualTrackHeight} @ ~${this.actualTrackFps}fps`);
    } catch (err) {
      console.error('[FACE+FIST] Failed to start webcam:', err);
      this.stop();
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        this.showToast('CAMERA PERMISSION DENIED - CLICK ALLOW TO RETRY');
      } else {
        this.showToast('WEBCAM ERROR: ' + (err?.message || 'FAILED'));
      }
    } finally {
      this.isStarting = false;
    }
  }

  stop() {
    this.isStarting = false;
    this.isActive = false;
    this.trackingActive = false;
    this.handBusy = false;
    this.faceBusy = false;
    this.state = FaceFistState.DISABLED;
    this.shootHeld = false;
    this.confirmedFist = false;
    this.isCalibrating = false;
    this.calibrationSamples = [];
    this.hasNeutralReference = false;
    this.isFaceMoving = false;
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;
    this.latestSnapshot.aimX = 0;
    this.latestSnapshot.aimY = 0;
    this.latestSnapshot.isFist = false;
    this.latestSnapshot.hasFace = false;
    this.latestSnapshot.hasHand = false;

    // 1. Cancel frame callbacks and timers
    this.cancelVideoPlaybackMonitoring();
    this.cancelTrackingScheduler();

    // 2. Release camera stream completely
    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        try {
          t.stop();
          t.enabled = false;
        } catch (_) {}
      });
      this.stream = null;
    }
    if (this.video) {
      try {
        this.video.pause();
      } catch (_) {}
      this.video.srcObject = null;
    }

    // 3. Close detectors and workers if present
    if (this.faceWorker) {
      try {
        this.faceWorker.postMessage({ type: 'CLOSE' });
        this.faceWorker.terminate();
      } catch (_) {}
      this.faceWorker = null;
    }
    this.faceWorkerReady = false;
    this.faceWorkerBusy = false;

    if (this.handWorker) {
      try {
        this.handWorker.postMessage({ type: 'CLOSE' });
        this.handWorker.terminate();
      } catch (_) {}
      this.handWorker = null;
    }
    this.handWorkerReady = false;
    this.handWorkerBusy = false;

    if (this.faceDetector && typeof this.faceDetector.close === 'function') {
      try { this.faceDetector.close(); } catch (_) {}
      this.faceDetector = null;
    }
    if (this.faceLandmarker && typeof this.faceLandmarker.close === 'function') {
      try { this.faceLandmarker.close(); } catch (_) {}
      this.faceLandmarker = null;
    }
    if (this.handLandmarker && typeof this.handLandmarker.close === 'function') {
      try { this.handLandmarker.close(); } catch (_) {}
      this.handLandmarker = null;
    }
    this.isPipelineReady = false;

    // 4. Restore controls orientation without snapping
    const ctrl = this.getControls ? this.getControls() : null;
    if (ctrl) {
      ctrl.yaw = this.yaw;
      ctrl.pitch = this.pitch;
      ctrl.isCameraAimActive = false;
    }

    // 5. Clear overlay canvas
    if (this.canvasCtx && this.dom.canvas) {
      this.canvasCtx.clearRect(0, 0, this.dom.canvas.width, this.dom.canvas.height);
    }

    // 6. Hide preview UI
    if (this.dom.previewBox) {
      this.dom.previewBox.classList.add('hidden');
    }

    this.updateToggleButton(false);
    this.updateStatusUI();
    console.log('[FACE+FIST] Face + Fist Aim cleanly stopped and all resources released.');
  }

  // --- HARDWARE VIDEO PRESENTATION MONITORING ---

  startVideoPlaybackMonitoring() {
    this.cancelVideoPlaybackMonitoring();
    this.videoFramesDelivered = 0;
    this.lastVideoFrameTime = performance.now();
    this.lastVideoFpsCalcTime = performance.now();

    if (typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype && this.video) {
      const onVideoFrame = (now, metadata) => {
        if (!this.isActive || !this.video) return;
        this.videoFramesDelivered++;
        this.lastVideoFrameTime = now;

        if (this.isActive && this.video && typeof this.video.requestVideoFrameCallback === 'function') {
          this.videoCallbackId = this.video.requestVideoFrameCallback(onVideoFrame);
        }
      };
      this.videoCallbackId = this.video.requestVideoFrameCallback(onVideoFrame);
    }
  }

  cancelVideoPlaybackMonitoring() {
    if (this.videoCallbackId && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
      try {
        this.video.cancelVideoFrameCallback(this.videoCallbackId);
      } catch (_) {}
      this.videoCallbackId = null;
    }
  }

  // --- MEDIAPIPE MODEL INITIALIZATION (BLAZEFACE DETECTOR + HAND LANDMARKER + WORKER) ---

  async initLandmarkers() {
    if (this.isPipelineReady && ((this.faceWorker && this.faceWorkerReady) || this.faceDetector || this.faceLandmarker) && this.handLandmarker) return;

    const tInitStart = performance.now();
    try {
      console.log('[FACE+FIST] Initializing MediaPipe Models & Background Worker...');

      // 1. Initialize Decoupled Background Face Worker (Zero Main Thread Blocking)
      if (typeof Worker !== 'undefined') {
        try {
          if (!this.faceWorker) {
            this.faceWorker = new Worker('/src/cameraAimWorker.js');
            this.faceWorker.onmessage = (e) => this.handleWorkerMessage(e);
            this.faceWorker.onerror = (wErr) => {
              console.warn('[FACE+FIST] Face Worker error, falling back to in-thread:', wErr);
              this.faceWorkerReady = false;
            };
            this.faceWorker.postMessage({
              type: 'INIT',
              wasmPath: '/lib/mediapipe/wasm',
              faceModelPath: '/assets/models/blaze_face_short_range.tflite'
            });
            console.log('[FACE+FIST] Spawning background Face Worker for zero-blocking face inference...');
          }
        } catch (wErr) {
          console.warn('[FACE+FIST] Could not spawn Face Worker:', wErr);
          this.faceWorker = null;
        }

        // 2. Initialize Decoupled Background Hand Worker (Zero Main Thread Blocking)
        try {
          if (!this.handWorker) {
            this.handWorker = new Worker('/src/cameraAimHandWorker.js');
            this.handWorker.onmessage = (e) => this.handleHandWorkerMessage(e);
            this.handWorker.onerror = (wErr) => {
              console.warn('[FACE+FIST] Hand Worker error, falling back to in-thread:', wErr);
              this.handWorkerReady = false;
            };
            this.handWorker.postMessage({
              type: 'INIT',
              wasmPath: '/lib/mediapipe/wasm',
              handModelPath: '/assets/models/hand_landmarker.task'
            });
            console.log('[FACE+FIST] Spawning background Hand Worker for zero-blocking hand inference...');
          }
        } catch (wErr) {
          console.warn('[FACE+FIST] Could not spawn Hand Worker:', wErr);
          this.handWorker = null;
        }
      }

      // 3. Fallback in-thread initialization only if workers are unavailable
      if (!this.faceWorker || !this.handWorker) {
        let vision = null;
        try {
          vision = window.Vision || self.Vision;
          if (!vision) {
            const mod = await import('/lib/mediapipe/vision_bundle.js');
            vision = mod.Vision || mod;
          }
        } catch (_) {
          vision = await import('@mediapipe/tasks-vision');
        }

        const { FilesetResolver, FaceDetector, HandLandmarker } = vision;
        const fileset = await FilesetResolver.forVisionTasks('/lib/mediapipe/wasm');

        if (!this.faceWorker) {
          const detectorOpts = {
            baseOptions: {
              modelAssetPath: '/assets/models/blaze_face_short_range.tflite',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            minDetectionConfidence: 0.5,
            minSuppressionThreshold: 0.3
          };
          this.faceDetector = await FaceDetector.createFromOptions(fileset, detectorOpts);
          this.useFaceDetector = true;
        }

        if (!this.handWorker) {
          const handOpts = {
            baseOptions: {
              modelAssetPath: '/assets/models/hand_landmarker.task',
              delegate: 'CPU'
            },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5
          };
          this.handLandmarker = await HandLandmarker.createFromOptions(fileset, handOpts);
        }
      }

      this.isPipelineReady = true;
      const initDuration = Math.round(performance.now() - tInitStart);
      console.log(`[FACE+FIST] Models initialized in ${initDuration} ms. Face worker: ${!!this.faceWorker}, Hand worker: ${!!this.handWorker}`);
    } catch (err) {
      console.error('[FACE+FIST] Failed to initialize MediaPipe models:', err);
      throw err;
    }
  }

  // --- DECOUPLED TRACKING SCHEDULER (ZERO MAIN-THREAD BLOCKING) ---

  startTrackingScheduler() {
    this.cancelTrackingScheduler();

    const schedulerTick = () => {
      if (!this.trackingActive) return;

      const now = performance.now();

      if (this.testMode !== 'RAW') {
        // 1. HAND / FIST TRACKING (PRIORITY 1: HAND > FACE)
        // Independent execution in background worker - NEVER blocks main thread
        if (this.handTrackingEnabled) {
          if (this.handWorker && this.handWorkerReady) {
            if (!this.handWorkerBusy && (now - this.lastHandRunTime >= this.handTrackingInterval)) {
              if (this.video && this.video.readyState >= 2 && !this.video.paused) {
                this.lastHandRunTime = now;
                this.handWorkerBusy = true;
                const frameTimestamp = this.lastVideoFrameTime > 0 ? this.lastVideoFrameTime : now;

                if (typeof createImageBitmap === 'function') {
                  createImageBitmap(this.video).then(bitmap => {
                    if (!this.trackingActive || !this.handWorker) {
                      try { bitmap.close(); } catch (_) {}
                      this.handWorkerBusy = false;
                      return;
                    }
                    this.handWorker.postMessage({
                      type: 'INFER_HAND',
                      bitmap,
                      timestamp: now,
                      capturedAt: frameTimestamp
                    }, [bitmap]);
                  }).catch(err => {
                    this.handWorkerBusy = false;
                    console.warn('[FACE+FIST] Hand createImageBitmap failed:', err);
                  });
                } else {
                  this.handWorkerBusy = false;
                }
              }
            }
          } else if (this.handLandmarker && !this.handBusy) {
            if (now - this.lastHandRunTime >= this.handTrackingInterval) {
              this.lastHandRunTime = now;
              this.runHandInference(now);
            }
          }
        }

        // 2. FACE TRACKING (PRIORITY 2: CAMERA AIM)
        // Independent execution in background worker - NEVER blocks main thread
        if (this.faceTrackingEnabled) {
          if (this.faceWorker && this.faceWorkerReady) {
            if (!this.faceWorkerBusy && (now - this.lastFaceRunTime >= this.faceTrackingInterval)) {
              if (this.video && this.video.readyState >= 2 && !this.video.paused) {
                this.lastFaceRunTime = now;
                this.faceWorkerBusy = true;
                const frameTimestamp = this.lastVideoFrameTime > 0 ? this.lastVideoFrameTime : now;

                if (typeof createImageBitmap === 'function') {
                  createImageBitmap(this.video).then(bitmap => {
                    if (!this.trackingActive || !this.faceWorker) {
                      try { bitmap.close(); } catch (_) {}
                      this.faceWorkerBusy = false;
                      return;
                    }
                    this.faceWorker.postMessage({
                      type: 'INFER_FACE',
                      bitmap,
                      timestamp: now,
                      capturedAt: frameTimestamp
                    }, [bitmap]);
                  }).catch(err => {
                    this.faceWorkerBusy = false;
                    console.warn('[FACE+FIST] Face createImageBitmap failed:', err);
                  });
                } else {
                  this.faceWorkerBusy = false;
                }
              }
            }
          } else {
            // Main-thread fallback if worker not ready/available
            const faceTracker = this.useFaceDetector ? this.faceDetector : this.faceLandmarker;
            if (faceTracker && !this.faceBusy) {
              if (now - this.lastFaceRunTime >= this.faceTrackingInterval) {
                this.lastFaceRunTime = now;
                this.runFaceInference(now);
              }
            }
          }
        }
      }

      if (this.trackingActive) {
        this.trackingTimerId = setTimeout(schedulerTick, 16);
      }
    };

    this.trackingTimerId = setTimeout(schedulerTick, 16);
  }

  cancelTrackingScheduler() {
    if (this.trackingTimerId) {
      clearTimeout(this.trackingTimerId);
      this.trackingTimerId = null;
    }
  }

  // --- BACKGROUND WORKER MESSAGE HANDLER ---

  handleWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'INIT_OK') {
      this.faceWorkerReady = true;
      this.faceWorkerBusy = false;
      console.log('[FACE+FIST] Face Worker ready. Detector mode:', msg.useFaceDetector ? 'BlazeFace' : 'FaceLandmarker');
    } else if (msg.type === 'INIT_ERROR') {
      console.warn('[FACE+FIST] Face Worker init error, falling back to in-thread:', msg.error);
      this.faceWorkerReady = false;
      this.faceWorkerBusy = false;
    } else if (msg.type === 'FACE_RESULT') {
      this.faceWorkerBusy = false;
      const now = performance.now();
      const frameTimestamp = msg.capturedAt || msg.timestamp || now;
      this.diagnostics.faceMs = msg.inferenceMs || 0;
      this.diagnostics.faceFrameCount++;
      this.diagnostics.faceAgeMs = Math.max(0, Math.round(now - frameTimestamp));

      if (now - this.lastFaceDiagLog >= 1500) {
        this.lastFaceDiagLog = now;
        console.log(
          `[FACE WORKER RESULT] detected: ${msg.hasFace} | calib: ${this.calibrationSamples.length}/10 | ` +
          `inference: ${this.diagnostics.faceMs}ms | age: ${this.diagnostics.faceAgeMs}ms | queue: 0 | main-thread: 0ms`
        );
      }

      if (!msg.hasFace) {
        this.handleFaceLoss();
        return;
      }

      this.applyFaceMovementDelta(msg.rawFaceX, msg.rawFaceY, msg.faceWidth, msg.faceHeight, msg.box || null);
    }
  }

  handleHandWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'INIT_OK') {
      this.handWorkerReady = true;
      this.handWorkerBusy = false;
      console.log('[FACE+FIST] Hand Worker ready in background thread.');
    } else if (msg.type === 'INIT_ERROR') {
      console.warn('[FACE+FIST] Hand Worker init error, falling back to in-thread:', msg.error);
      this.handWorkerReady = false;
      this.handWorkerBusy = false;
    } else if (msg.type === 'HAND_RESULT') {
      this.handWorkerBusy = false;
      const now = performance.now();
      const frameTimestamp = msg.capturedAt || msg.timestamp || now;
      this.diagnostics.handMs = msg.inferenceMs || 0;
      this.diagnostics.handFrameCount++;
      this.diagnostics.handAgeMs = Math.max(0, Math.round(now - frameTimestamp));

      const snap = this.latestSnapshot;
      snap.hasHand = !!msg.hasHand;
      snap.fistScore = msg.fistScore || 0;
      snap.isFist = !!msg.isFist;
      snap.handTimestamp = now;
      snap.handCapturedAt = frameTimestamp;

      // Phase 7: Instant shooting assignment (Zero delay, independent of face)
      this.confirmedFist = snap.isFist;
      this.shootHeld = snap.isFist;
    }
  }

  handleFaceLoss() {
    const snap = this.latestSnapshot;
    snap.hasFace = false;
    snap.aimX = 0;
    snap.aimY = 0;
    snap.box = null;
    this.isFaceMoving = false;
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;

    // Reset calibration if lost during calibration
    if (this.isCalibrating) {
      this.isCalibrating = false;
      this.calibrationSamples = [];
    }
    this.state = FaceFistState.WAITING_FOR_FACE;
    this.updatePoseBadge('WAITING FOR FACE', 'badge-not-detected');
  }

  // --- INDEPENDENT HAND INFERENCE (LATEST FRAME ONLY, ZERO BACKLOG) ---

  runHandInference(now) {
    if (!this.video || this.video.readyState < 2) return;
    this.handBusy = true;

    try {
      const frameTimestamp = this.lastVideoFrameTime > 0 ? this.lastVideoFrameTime : now;
      const tStart = performance.now();
      const handRes = this.handLandmarker.detectForVideo(this.video, now);
      const completionTime = performance.now();
      const duration = completionTime - tStart;
      this.diagnostics.handMs = Math.round(duration);
      this.diagnostics.handFrameCount++;
      this.diagnostics.handAgeMs = Math.max(0, Math.round(completionTime - frameTimestamp));

      const hands = handRes?.landmarks;
      const hasHand = !!(hands && hands.length > 0 && hands[0].length >= 21);

      this.handleHandResult(hasHand, hasHand ? hands[0] : null, now);
    } catch (handErr) {
      console.warn('[FACE+FIST] Hand inference error:', handErr);
      this.handGpuErrorCount++;
    } finally {
      this.handBusy = false;
    }
  }

  handleHandResult(hasHand, handLandmarks, timestamp) {
    const snap = this.latestSnapshot;
    snap.hasHand = hasHand;
    snap.handTimestamp = performance.now();
    snap.handCapturedAt = timestamp;

    if (hasHand && handLandmarks) {
      const fistScore = this.calculateFistScore(handLandmarks);
      snap.fistScore = fistScore;

      // Instant Hysteresis (Zero Frame Streak Delay)
      if (fistScore >= this.FIST_ON_THRESHOLD) {
        this.confirmedFist = true;
      } else if (fistScore <= this.FIST_OFF_THRESHOLD) {
        this.confirmedFist = false;
      }
      snap.isFist = this.confirmedFist;
    } else {
      // Hand Lost: immediately release shooting on that exact frame
      this.confirmedFist = false;
      snap.isFist = false;
      snap.fistScore = 0;
    }

    // Direct publishing of shootHeld (completely decoupled from face tracking)
    this.shootHeld = snap.isFist;
  }

  // --- IN-THREAD FACE INFERENCE FALLBACK (ONLY IF WORKER UNAVAILABLE) ---

  runFaceInference(now) {
    if (!this.video || this.video.readyState < 2) return;
    this.faceBusy = true;

    try {
      const frameTimestamp = this.lastVideoFrameTime > 0 ? this.lastVideoFrameTime : now;
      const tStart = performance.now();

      if (this.useFaceDetector && this.faceDetector) {
        const detectRes = this.faceDetector.detectForVideo(this.video, now);
        const completionTime = performance.now();
        const duration = completionTime - tStart;
        this.diagnostics.faceMs = Math.round(duration);
        this.diagnostics.faceFrameCount++;
        this.diagnostics.faceAgeMs = Math.max(0, Math.round(completionTime - frameTimestamp));

        const detections = detectRes?.detections;
        const hasFace = !!(detections && detections.length > 0);

        if (now - this.lastFaceDiagLog >= 1500) {
          this.lastFaceDiagLog = now;
          console.log(
            `[FACE IN-THREAD] detector: BlazeFace | count: ${detections ? detections.length : 0} | ` +
            `detected: ${hasFace} | calib: ${this.calibrationSamples.length}/10 | ` +
            `inference: ${this.diagnostics.faceMs}ms | age: ${this.diagnostics.faceAgeMs}ms | queue: 0`
          );
        }

        this.handleFaceDetectionResult(hasFace, hasFace ? detections[0] : null, now);
      } else if (this.faceLandmarker) {
        const faceRes = this.faceLandmarker.detectForVideo(this.video, now);
        const completionTime = performance.now();
        const duration = completionTime - tStart;
        this.diagnostics.faceMs = Math.round(duration);
        this.diagnostics.faceFrameCount++;
        this.diagnostics.faceAgeMs = Math.max(0, Math.round(completionTime - frameTimestamp));

        const faces = faceRes?.faceLandmarks;
        const hasFace = !!(faces && faces.length > 0 && faces[0].length >= 468);

        if (now - this.lastFaceDiagLog >= 1500) {
          this.lastFaceDiagLog = now;
          console.log(
            `[FACE IN-THREAD] detector: FaceLandmarker | count: ${faces ? faces.length : 0} | ` +
            `detected: ${hasFace} | calib: ${this.calibrationSamples.length}/10 | ` +
            `inference: ${this.diagnostics.faceMs}ms | age: ${this.diagnostics.faceAgeMs}ms | queue: 0`
          );
        }

        this.handleFaceResult(hasFace, hasFace ? faces[0] : null, now);
      }
    } catch (faceErr) {
      console.warn('[FACE+FIST] In-thread face inference error:', faceErr);
      this.faceGpuErrorCount++;
    } finally {
      this.faceBusy = false;
    }
  }

  handleFaceDetectionResult(hasFace, detection, timestamp) {
    const snap = this.latestSnapshot;
    snap.hasFace = hasFace;
    snap.faceTimestamp = performance.now();
    snap.faceCapturedAt = timestamp;

    if (!hasFace || !detection) {
      this.handleFaceLoss();
      return;
    }

    this.processFaceDetectionMetrics(detection);
  }

  processFaceDetectionMetrics(detection) {
    const vw = (this.video && this.video.videoWidth) ? this.video.videoWidth : (this.actualTrackWidth || 640);
    const vh = (this.video && this.video.videoHeight) ? this.video.videoHeight : (this.actualTrackHeight || 480);

    const box = detection.boundingBox || { originX: 0, originY: 0, width: 0, height: 0 };
    const boxNormWidth = Math.max(0.08, box.width / vw);
    const boxNormHeight = Math.max(0.08, box.height / vh);
    const boxCenterX = (box.originX + box.width * 0.5) / vw;
    const boxCenterY = (box.originY + box.height * 0.5) / vh;

    let rawFaceX = boxCenterX;
    let rawFaceY = boxCenterY;

    if (detection.keypoints && detection.keypoints.length >= 4) {
      let kpX = 0, kpY = 0;
      const kps = detection.keypoints;
      for (let i = 0; i < kps.length; i++) {
        kpX += kps[i].x;
        kpY += kps[i].y;
      }
      const kpAvgX = kpX / kps.length;
      const kpAvgY = kpY / kps.length;
      rawFaceX = boxCenterX * 0.5 + kpAvgX * 0.5;
      rawFaceY = boxCenterY * 0.5 + kpAvgY * 0.5;
    }

    const boxNorm = {
      x: box.originX / vw,
      y: box.originY / vh,
      w: boxNormWidth,
      h: boxNormHeight
    };

    this.applyFaceMovementDelta(rawFaceX, rawFaceY, boxNormWidth, boxNormHeight, boxNorm);
  }

  handleFaceResult(hasFace, faceLandmarks, timestamp) {
    const snap = this.latestSnapshot;
    snap.hasFace = hasFace;
    snap.faceTimestamp = performance.now();
    snap.faceCapturedAt = timestamp;

    if (!hasFace || !faceLandmarks) {
      this.handleFaceLoss();
      return;
    }

    // Compute whole-face structural centroid
    this.processWholeFaceCentroid(faceLandmarks);
  }

  // --- WHOLE-FACE STRUCTURAL CENTROID & ZERO-MOMENTUM DELTA CALCULATION ---

  processWholeFaceCentroid(face) {
    // 1. Forehead / Upper-face: 10, 109, 338
    const foreheadX = (face[10].x + face[109].x + face[338].x) / 3;
    const foreheadY = (face[10].y + face[109].y + face[338].y) / 3;

    // 2. Left Cheek: 234, 93, 132
    const leftCheekX = (face[234].x + face[93].x + face[132].x) / 3;
    const leftCheekY = (face[234].y + face[93].y + face[132].y) / 3;

    // 3. Right Cheek: 454, 323, 361
    const rightCheekX = (face[454].x + face[323].x + face[361].x) / 3;
    const rightCheekY = (face[454].y + face[323].y + face[361].y) / 3;

    // 4. Chin / Lower-face: 152, 148, 377
    const chinX = (face[152].x + face[148].x + face[377].x) / 3;
    const chinY = (face[152].y + face[148].y + face[377].y) / 3;

    // 5. Mid-face region: 168, 6, 2, 1
    const midFaceX = (face[168].x + face[6].x + face[2].x + face[1].x) * 0.25;
    const midFaceY = (face[168].y + face[6].y + face[2].y + face[1].y) * 0.25;

    // Balanced 5-region centroid
    const rawFaceX = (foreheadX + leftCheekX + rightCheekX + chinX + midFaceX) * 0.2;
    const rawFaceY = (foreheadY + leftCheekY + rightCheekY + chinY + midFaceY) * 0.2;

    const faceWidth = Math.max(0.08, Math.hypot(face[454].x - face[234].x, face[454].y - face[234].y));
    const faceHeight = Math.max(0.08, Math.hypot(face[10].x - face[152].x, face[10].y - face[152].y));

    this.applyFaceMovementDelta(rawFaceX, rawFaceY, faceWidth, faceHeight, null);
  }

  // --- UNIFIED WHOLE-FACE CALIBRATION & ANTI-JITTER DELTA CALCULATION ---

  applyFaceMovementDelta(rawFaceX, rawFaceY, faceWidth, faceHeight, boxNorm = null) {
    const snap = this.latestSnapshot;
    const now = performance.now();
    snap.hasFace = true;
    snap.box = boxNorm;
    snap.faceTimestamp = now;
    this.faceWidth = faceWidth;
    this.faceHeight = faceHeight;

    // STEP 2 & 4: CALIBRATION vs TRACKING STATE FLOW
    if (!this.hasNeutralReference) {
      // Need calibration: collect 10 valid samples
      this.isCalibrating = true;
      this.state = FaceFistState.CALIBRATING;
      this.calibrationSamples.push({ x: rawFaceX, y: rawFaceY });

      const sampleCount = this.calibrationSamples.length;
      this.updatePoseBadge(`CALIBRATING (${sampleCount}/10)`, 'badge-ready');

      if (sampleCount >= this.calibrationRequiredSamples) {
        let avgX = 0, avgY = 0;
        for (let i = 0; i < sampleCount; i++) {
          avgX += this.calibrationSamples[i].x;
          avgY += this.calibrationSamples[i].y;
        }
        this.neutralFaceX = avgX / sampleCount;
        this.neutralFaceY = avgY / sampleCount;
        this.hasNeutralReference = true;
        this.isCalibrating = false;
        this.calibrationSamples = [];
        this.stableFaceX = this.neutralFaceX;
        this.stableFaceY = this.neutralFaceY;
        this.prevFaceX = this.neutralFaceX;
        this.prevFaceY = this.neutralFaceY;
        this.lastFaceDeltaTime = now;
        snap.faceX = this.neutralFaceX;
        snap.faceY = this.neutralFaceY;
        snap.aimX = 0;
        snap.aimY = 0;
        this.turnDurationRemaining = 0;
        this.turnRateYaw = 0;
        this.turnRatePitch = 0;
        this.isFaceMoving = false;
        this.state = FaceFistState.TRACKING;
        this.showToast('FACE CALIBRATED');
        this.updatePoseBadge('FACE CALIBRATED', 'badge-ready');
      }
      return;
    }

    // TRACKING MODE: Anti-Jitter Stabilized Delta (ZERO Vibration, ZERO Momentum, ZERO Drift)
    this.state = FaceFistState.TRACKING;

    // 1. First-frame initialization or detection gap recovery
    if (this.stableFaceX === null || this.prevFaceX === null) {
      this.stableFaceX = rawFaceX;
      this.stableFaceY = rawFaceY;
      this.prevFaceX = rawFaceX;
      this.prevFaceY = rawFaceY;
      this.lastFaceDeltaTime = now;
      snap.faceX = rawFaceX;
      snap.faceY = rawFaceY;
      snap.aimX = 0;
      snap.aimY = 0;
      this.isFaceMoving = false;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
      return;
    }

    // 2. Anti-Jitter Temporal Filter on Face Position (Suppresses landmark sensor noise without adding latency)
    const diffNormX = Math.abs(rawFaceX - this.stableFaceX) / this.faceWidth;
    const diffNormY = Math.abs(rawFaceY - this.stableFaceY) / this.faceHeight;

    // Adaptive alpha: micro-noise (< 0.015) uses alpha 0.28 for strong noise suppression;
    // intentional movement scales alpha up to 0.85 for instantaneous responsiveness
    const alphaX = Math.min(0.85, Math.max(0.28, diffNormX * 25));
    const alphaY = Math.min(0.85, Math.max(0.28, diffNormY * 25));

    this.stableFaceX += alphaX * (rawFaceX - this.stableFaceX);
    this.stableFaceY += alphaY * (rawFaceY - this.stableFaceY);

    snap.faceX = this.stableFaceX;
    snap.faceY = this.stableFaceY;

    // 3. Movement Delta Calculation & Spike Clamping
    const normDeltaX = (this.stableFaceX - this.prevFaceX) / this.faceWidth;
    const normDeltaY = (this.stableFaceY - this.prevFaceY) / this.faceHeight;

    // Spike Prevention: clamp impossible jumps (detector glitch / sudden track change) and re-anchor
    if (Math.abs(normDeltaX) > this.MAX_REASONABLE_DELTA || Math.abs(normDeltaY) > this.MAX_REASONABLE_DELTA) {
      this.stableFaceX = rawFaceX;
      this.stableFaceY = rawFaceY;
      this.prevFaceX = rawFaceX;
      this.prevFaceY = rawFaceY;
      snap.aimX = 0;
      snap.aimY = 0;
      this.isFaceMoving = false;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
      return;
    }

    // 4. Independent Deadzones for Yaw (X) and Pitch (Y)
    let effDeltaX = 0;
    let effDeltaY = 0;

    if (Math.abs(normDeltaX) > this.DEADZONE_X) {
      effDeltaX = Math.sign(normDeltaX) * (Math.abs(normDeltaX) - this.DEADZONE_X);
    }

    if (Math.abs(normDeltaY) > this.DEADZONE_Y) {
      effDeltaY = Math.sign(normDeltaY) * (Math.abs(normDeltaY) - this.DEADZONE_Y);
    }

    // 5. Apply Movement or Immediate Stop
    const faceDt = Math.max(0.016, Math.min(0.100, (now - this.lastFaceDeltaTime) / 1000));
    this.lastFaceDeltaTime = now;

    if (effDeltaX === 0 && effDeltaY === 0) {
      // Head is stationary / within deadzone -> immediate zero rotation (Zero momentum, Zero rattle)
      this.isFaceMoving = false;
      snap.aimX = 0;
      snap.aimY = 0;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
    } else {
      // Intentional head movement -> calculate camera rotation rates
      this.isFaceMoving = true;
      const signY = this.invertY ? -1 : 1;

      const totalYawDelta = effDeltaX * this.sensitivityX;
      const totalPitchDelta = signY * (-effDeltaY) * this.sensitivityY;

      snap.aimX = totalYawDelta;
      snap.aimY = totalPitchDelta;

      // Distribute smoothly over the face update window across 60 FPS render frames
      this.turnRateYaw = totalYawDelta / faceDt;
      this.turnRatePitch = totalPitchDelta / faceDt;
      this.turnDurationRemaining = faceDt;
    }

    // Advance previous stable face position to current stable position
    this.prevFaceX = this.stableFaceX;
    this.prevFaceY = this.stableFaceY;

    // Update pose badge during active tracking
    if (snap.isFist) {
      this.updatePoseBadge('✊ FIST: SHOOTING', 'badge-fired');
    } else if (snap.hasFace && snap.hasHand) {
      this.updatePoseBadge('FACE + HAND ACTIVE', 'badge-tracking');
    } else {
      this.updatePoseBadge(this.isFaceMoving ? 'FACE: MOVING' : 'FACE: STILL', 'badge-ready');
    }
  }

  calculateFistScore(hand) {
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

  // --- CALIBRATION ACTION (STEP 2: CLEAN RE-CALIBRATION FLOW) ---

  calibrate() {
    if (!this.isActive) return;
    this.hasNeutralReference = false;
    this.calibrationSamples = [];
    this.isFaceMoving = false;
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;
    this.latestSnapshot.aimX = 0;
    this.latestSnapshot.aimY = 0;

    if (this.latestSnapshot.hasFace) {
      this.isCalibrating = true;
      this.state = FaceFistState.CALIBRATING;
      this.updatePoseBadge('CALIBRATING...', 'badge-ready');
    } else {
      this.isCalibrating = false;
      this.state = FaceFistState.WAITING_FOR_FACE;
      this.updatePoseBadge('WAITING FOR FACE', 'badge-not-detected');
    }
  }

  // --- GAME RENDER LOOP UPDATE (CALLED EVERY THREE.JS FRAME AT 60+ FPS) ---

  update(dt) {
    if (!this.isActive || !this.camera) return;

    this.diagnostics.renderFrameCount++;
    const snap = this.latestSnapshot;
    const now = performance.now();

    // 1. Measure Live Data Freshness & End-to-End Latency
    if (snap.faceTimestamp > 0) {
      this.diagnostics.faceAgeMs = Math.round(now - snap.faceTimestamp);
      this.diagnostics.faceLatencyMs = Math.round(now - (snap.faceCapturedAt || snap.faceTimestamp));
    }
    if (snap.handTimestamp > 0) {
      this.diagnostics.handAgeMs = Math.round(now - snap.handTimestamp);
      this.diagnostics.handLatencyMs = Math.round(now - (snap.handCapturedAt || snap.handTimestamp));
    }

    // 2. Track hardware video frames via currentTime change if requestVideoFrameCallback not supported
    if (this.video && this.video.currentTime !== this.lastObservedVideoTime) {
      this.lastObservedVideoTime = this.video.currentTime;
      if (!this.videoCallbackId) {
        this.videoFramesDelivered++;
      }
    }

    // 3. Stale Input Timeout Safety: Never apply inputs older than MAX_INPUT_AGE
    if (snap.faceTimestamp > 0 && (now - snap.faceTimestamp) > this.MAX_FACE_INPUT_AGE) {
      snap.aimX = 0;
      snap.aimY = 0;
      this.isFaceMoving = false;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
    }
    if (snap.handTimestamp > 0 && (now - snap.handTimestamp) > this.MAX_HAND_INPUT_AGE) {
      this.shootHeld = false;
      snap.isFist = false;
    }

    // 4. Apply Movement Delta (Smooth 60 FPS sub-frame rotation during movement, ZERO momentum when stopped)
    if (this.turnDurationRemaining > 0) {
      const stepTime = Math.min(dt, this.turnDurationRemaining);
      this.yaw += this.turnRateYaw * stepTime;
      this.pitch += this.turnRatePitch * stepTime;
      this.turnDurationRemaining -= stepTime;

      if (this.turnDurationRemaining <= 0) {
        this.turnRateYaw = 0;
        this.turnRatePitch = 0;
      }

      snap.aimX = 0;
      snap.aimY = 0;

      // Clamp vertical pitch (-83 to +83 deg: -1.45 to +1.45 rad)
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

      // Apply rotation to Three.js camera (Order: YXZ)
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;

      // Sync with controls instance if attached
      const ctrl = this.getControls ? this.getControls() : null;
      if (ctrl) {
        ctrl.yaw = this.yaw;
        ctrl.pitch = this.pitch;
      }
    } else if (snap.aimX !== 0 || snap.aimY !== 0) {
      // Direct impulse fallback (e.g. tests or instantaneous events)
      this.yaw += snap.aimX;
      this.pitch += snap.aimY;
      snap.aimX = 0;
      snap.aimY = 0;

      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;

      const ctrl = this.getControls ? this.getControls() : null;
      if (ctrl) {
        ctrl.yaw = this.yaw;
        ctrl.pitch = this.pitch;
      }
    }

    // 5. Weapon Hold-To-Fire Execution (Respects Game Fire Rate & Ammo Rules)
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.shootHeld && this.fireCooldown <= 0) {
      this.tryFire();
    }

    // 6. Update Preview Overlay at ~20 Hz (reduces 2D canvas GPU compositing contention)
    if (now - this.lastOverlayDrawTime >= 48) {
      this.lastOverlayDrawTime = now;
      this.drawPreviewOverlay();
    }

    // 7. Update Status UI
    this.updateStatusUI();
  }

  tryFire() {
    if (!this.onShoot) return;
    const shot = this.onShoot();
    if (shot === false) {
      // Cooldown wait if reload or pre-round gating rejected shot
      this.fireCooldown = 0.08;
      return;
    }
    this.fireCooldown = this.fireInterval;
  }

  // --- PREVIEW OVERLAY RENDERING (ZERO REDUNDANT VIDEO DRAWS) ---

  drawPreviewOverlay() {
    if (!this.canvasCtx || !this.dom.canvas) return;
    const ctx = this.canvasCtx;
    const w = this.dom.canvas.width;
    const h = this.dom.canvas.height;

    ctx.clearRect(0, 0, w, h);
    const snap = this.latestSnapshot;

    // Draw face bounding box if available
    if (snap.hasFace && this.faceTrackingEnabled && snap.box) {
      const b = snap.box;
      const bx = (1 - (b.x + b.w)) * w; // Mirrored video preview
      const by = b.y * h;
      const bw = b.w * w;
      const bh = b.h * h;

      ctx.strokeStyle = this.isCalibrating ? 'rgba(255, 235, 59, 0.7)' : (this.isFaceMoving ? 'rgba(0, 229, 255, 0.7)' : 'rgba(118, 255, 3, 0.6)');
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, bw, bh);
    }

    // Draw neutral center reticle & live face point
    if (snap.hasFace && this.faceTrackingEnabled) {
      const curX = (1 - snap.faceX) * w;
      const curY = snap.faceY * h;

      if (this.hasNeutralReference) {
        const neutX = (1 - this.neutralFaceX) * w;
        const neutY = this.neutralFaceY * h;

        ctx.strokeStyle = '#76ff03';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(neutX, neutY, 14, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(neutX, neutY);
        ctx.lineTo(curX, curY);
        ctx.stroke();
      }

      ctx.fillStyle = this.isCalibrating ? '#ffeb3b' : (this.isFaceMoving ? '#00e5ff' : '#76ff03');
      ctx.beginPath();
      ctx.arc(curX, curY, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw Hand / Fist indicator on preview
    if (snap.hasHand && this.handTrackingEnabled) {
      ctx.fillStyle = snap.isFist ? 'rgba(244, 67, 54, 0.85)' : 'rgba(76, 175, 80, 0.85)';
      ctx.fillRect(8, h - 28, 105, 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(snap.isFist ? '✊ FIST: FIRE' : '✋ HAND: OPEN', 14, h - 14);
    }
  }

  // --- UI UPDATES & REAL CAMERA DIAGNOSTICS (STEP 9 COMPLIANT) ---

  updateStatusUI() {
    const now = performance.now();
    if (now - this.diagnostics.lastStatusUpdate < 250) return; // 4 Hz UI updates
    this.diagnostics.lastStatusUpdate = now;

    const snap = this.latestSnapshot;
    const isFaceWorker = !!(this.faceWorker && this.faceWorkerReady);
    const isHandWorker = !!(this.handWorker && this.handWorkerReady);
    const mainThreadBlocking = (isFaceWorker && isHandWorker) ? 'NO (DUAL WORKERS)' : ((this.faceBusy || this.handBusy) ? 'YES (IN-THREAD)' : 'NO');
    const mainThreadStatus = (isFaceWorker && isHandWorker) ? 'OK (0ms)' : ((this.faceBusy || this.handBusy) ? 'BLOCKED' : 'OK');
    const isCamOn = !!(this.isActive && this.stream && this.stream.active);
    const readyState = this.video ? this.video.readyState : 0;
    const isPaused = this.video ? this.video.paused : true;
    const currentTime = this.video ? this.video.currentTime.toFixed(2) : '0.00';
    const isBusy = (this.faceWorkerBusy || this.handWorkerBusy || this.faceBusy || this.handBusy) ? 'YES' : 'NO';
    const shootState = this.shootHeld ? 'HELD' : 'OPEN';
    const faceStateStr = this.faceTrackingEnabled ? 'ON' : 'OFF';
    const handStateStr = this.handTrackingEnabled ? 'ON' : 'OFF';
    const faceDetectedStr = snap.hasFace ? 'DETECTED' : 'NOT DETECTED';
    const handDetectedStr = snap.hasHand ? 'DETECTED' : 'NOT DETECTED';
    const stateStr = !snap.hasFace ? 'WAITING' : (this.isCalibrating ? 'CALIBRATING' : 'TRACKING');
    const faceQueueCount = 0; // Latest result only, queue is always 0

    // 1. Hardware Video FPS Calculation
    const elapsedFpsSec = (now - this.lastVideoFpsCalcTime) / 1000;
    if (elapsedFpsSec >= 0.8) {
      this.diagnostics.cameraFps = Math.max(0, Math.round(this.videoFramesDelivered / elapsedFpsSec));
      this.videoFramesDelivered = 0;
      this.lastVideoFpsCalcTime = now;
    }

    // 2. Status Line: Exactly Step 9 format:
    // GAME: XX FPS · CAMERA: XX FPS · FACE: XX FPS · HAND: XX FPS
    if (this.dom.statusLine) {
      this.dom.statusLine.textContent = `GAME: ${this.diagnostics.gameFps} FPS · CAMERA: ${this.diagnostics.cameraFps} FPS · FACE: ${this.diagnostics.faceFps} FPS · HAND: ${this.diagnostics.handFps} FPS`;
    }

    // 3. Diagnostics Line (Phase 1 & 2 metrics):
    // GAME FPS: XX · FACE: XXms (XXfps) · HAND: XXms (XXfps) · MAIN: OK/BLOCKED
    if (now - this.diagnostics.lastDiagTime >= 400) {
      const elapsedSec = (now - this.diagnostics.lastDiagTime) / 1000;
      this.diagnostics.gameFps = Math.round(this.diagnostics.renderFrameCount / elapsedSec);
      this.diagnostics.faceFps = Math.round(this.diagnostics.faceFrameCount / elapsedSec);
      this.diagnostics.handFps = Math.round(this.diagnostics.handFrameCount / elapsedSec);
      this.diagnostics.renderFrameCount = 0;
      this.diagnostics.faceFrameCount = 0;
      this.diagnostics.handFrameCount = 0;
      this.diagnostics.lastDiagTime = now;

      if (this.dom.diag) {
        this.dom.diag.textContent = `GAME FPS: ${this.diagnostics.gameFps} · FACE: ${this.diagnostics.faceMs}ms (${this.diagnostics.faceFps}fps) · HAND: ${this.diagnostics.handMs}ms (${this.diagnostics.handFps}fps) · MAIN THREAD: ${mainThreadStatus} · MODE: ${this.testMode}`;
      }

      // Performance Report console log
      if (now - (this.diagnostics.lastConsoleLog || 0) >= 2000) {
        this.diagnostics.lastConsoleLog = now;
        console.log(
          `[PERFORMANCE REPORT]\n` +
          `  GAME FPS: ${this.diagnostics.gameFps}\n` +
          `  FACE FPS: ${this.diagnostics.faceFps}\n` +
          `  HAND FPS: ${this.diagnostics.handFps}\n` +
          `  FACE INFERENCE: ${this.diagnostics.faceMs} ms\n` +
          `  HAND INFERENCE: ${this.diagnostics.handMs} ms\n` +
          `  FACE RESULT AGE: ${this.diagnostics.faceAgeMs} ms\n` +
          `  HAND RESULT AGE: ${this.diagnostics.handAgeMs} ms\n` +
          `  MAIN THREAD: ${mainThreadStatus} (${mainThreadBlocking})\n` +
          `  VIDEO FPS: ${this.diagnostics.cameraFps}\n` +
          `  FACE: ${faceDetectedStr} | HAND: ${handDetectedStr} | STATE: ${stateStr}\n` +
          `  SHOOT: ${shootState} | MODE: ${this.testMode}\n` +
          `  FACE WORKER: ${isFaceWorker ? 'ACTIVE' : 'FALLBACK'} | HAND WORKER: ${isHandWorker ? 'ACTIVE' : 'FALLBACK'}`
        );
      }
    }
  }

  updateToggleButton(isActive) {
    if (this.dom.toggleBtn) {
      if (isActive) {
        this.dom.toggleBtn.classList.add('active');
        if (this.dom.toggleLabel) this.dom.toggleLabel.textContent = 'FACE + FIST AIM: ON';
      } else {
        this.dom.toggleBtn.classList.remove('active');
        if (this.dom.toggleLabel) this.dom.toggleLabel.textContent = 'FACE + FIST AIM: OFF';
      }
    }

    if (this.dom.mobileToggleBtn) {
      if (isActive) {
        this.dom.mobileToggleBtn.classList.add('active');
        if (this.dom.mobileToggleLabel) this.dom.mobileToggleLabel.textContent = 'FACE + FIST AIM: ON';
      } else {
        this.dom.mobileToggleBtn.classList.remove('active');
        if (this.dom.mobileToggleLabel) this.dom.mobileToggleLabel.textContent = 'FACE + FIST AIM: OFF';
      }
    }
  }

  updatePoseBadge(text, className) {
    if (!this.dom.poseBadge) return;
    this.dom.poseBadge.textContent = text;
    this.dom.poseBadge.className = 'camera-aim-pose-badge ' + (className || '');
  }

  showToast(text) {
    if (!this.dom.alertToast) return;
    this.dom.alertToast.textContent = text;
    this.dom.alertToast.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.dom.alertToast) this.dom.alertToast.classList.add('hidden');
    }, 2500);
  }
}
