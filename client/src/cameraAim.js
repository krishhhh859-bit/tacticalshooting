/**
 * PARA SF: FOREST ACCURACY - CAMERA DETECTION + CAMERA MOVEMENT SYSTEM
 * 
 * High-Performance Hand & Index Finger Aim Controller with Fist Trigger
 * 
 * Pipeline:
 * 1. Hardware Webcam Capture: 640x480 @ 30 FPS direct playback on <video>
 * 2. Decoupled Web Worker Hand Tracking: MediaPipe HandLandmarker off-thread
 * 3. Fresh Frame Processing: Zero queue, latest frame only
 * 4. Full-Frame Landmark Tracking: Index finger & knuckle geometry across full frame
 * 5. Movement Calculation:
 *    raw landmark movement
 *    → jitter/deadzone filtering (filters sensor noise when hand is still)
 *    → intentional movement
 *    → sensitivity multiplier (user setting 0.5x - 3.0x, default 1.0x)
 *    → Three.js camera rotation
 * 6. Instant Zero-Drift Halting: When hand stops moving, rotation delta is 0 immediately
 * 7. Safe Freeze on Loss: When hand leaves frame, camera stops immediately without jumping
 * 8. Re-Anchor on Entry: When hand enters/re-enters, initial position anchors without jumping
 */

import { GAME_CONFIG } from './config.js';

export const FaceFistState = {
  DISABLED: 'DISABLED',
  CAMERA_STARTING: 'CAMERA_STARTING',
  WAITING_FOR_HAND: 'WAITING_FOR_HAND',
  WAITING_FOR_FACE: 'WAITING_FOR_FACE',
  CALIBRATING: 'CALIBRATING',
  TRACKING: 'TRACKING'
};

export const CameraAimState = FaceFistState;

export class CameraAimController {
  static activeInstance = null;

  constructor(camera, getControls, onShoot) {
    this.camera = camera;
    this.getControls = getControls; // Returns active PCControls or MobileControls
    this.onShoot = onShoot;         // Calls game.handleShoot(), returns boolean

    // Ensure any previously active controller is cleanly stopped before assigning this match instance
    if (CameraAimController.activeInstance && CameraAimController.activeInstance !== this) {
      console.log('[CAMERA AIM] Switching active CameraAimController instance to current match');
      try {
        CameraAimController.activeInstance.stop();
      } catch (_) {}
    }
    CameraAimController.activeInstance = this;
    if (typeof window !== 'undefined') {
      window.activeCameraAimController = this;
      window.CameraAimController = CameraAimController;
      window.getMultiplayerFaceDebug = () => CameraAimController.activeInstance ? CameraAimController.activeInstance.getMultiplayerFaceDebug() : null;
    }

    // State machine
    this.state = FaceFistState.DISABLED;
    this.isActive = false;
    this.isStarting = false;
    this.isSupported = !!(
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia
    );

    // In PC Mode, FACE movement is the ONLY camera rotation controller.
    // Hand tracking only detects fist clenches for weapon shooting.
    this.testMode = 'ALL';
    this.faceTrackingEnabled = true;
    this.handTrackingEnabled = true;
    this.isFaceDetectorInitialized = false;
    this.latestFrameProcessed = false;

    // Hardware & Streams (Exactly ONE active stream)
    this.stream = null;
    this.video = null;
    this.canvasCtx = null;
    this.actualTrackWidth = 640;
    this.actualTrackHeight = 480;
    this.actualTrackFps = 30;

    // MediaPipe HandLandmarker + FaceDetector models
    this.handLandmarker = null;
    this.faceDetector = null;
    this.faceLandmarker = null;
    this.useFaceDetector = true;
    this.isPipelineReady = false;
    this.handGpuErrorCount = 0;
    this.faceGpuErrorCount = 0;

    // Web Workers (Zero main-thread blocking)
    this.handWorker = null;
    this.handWorkerReady = false;
    this.handWorkerBusy = false;

    this.faceWorker = null;
    this.faceWorkerReady = false;
    this.faceWorkerBusy = false;

    // Mutex flags for decoupled execution
    this.handBusy = false;
    this.faceBusy = false;
    this.lastDirectHandTimestamp = -1;

    // Tracking intervals (~30 Hz for hand aim)
    this.handTrackingInterval = 33;
    this.faceTrackingInterval = 45;
    this.lastHandRunTime = 0;
    this.lastFaceRunTime = 0;
    this.lastOverlayDrawTime = 0;

    // Frame Scheduler Management
    this.trackingActive = false;
    this.videoCallbackId = null;
    this.trackingTimerId = null;

    // Hardware Video Presentation Metrics
    this.videoFramesDelivered = 0;
    this.lastVideoFrameTime = 0;
    this.lastVideoFpsCalcTime = performance.now();
    this.lastObservedVideoTime = -1;

    // User-Facing Camera Movement Sensitivity Setting
    // Range: 0.5x -> 3.0x, Default: 1.0x
    const savedSens = (typeof localStorage !== 'undefined') ? localStorage.getItem('para_sf_camera_sens') : null;
    const parsedSens = savedSens ? parseFloat(savedSens) : NaN;
    this.cameraSensitivity = (!isNaN(parsedSens) && parsedSens >= 0.5 && parsedSens <= 3.0) ? parsedSens : 1.0;
    this.baseHandSensitivity = 3.6; // Angular deflection multiplier calibrated for natural 1.0x feel

    // Hand Movement Anti-Jitter Filter & Deadzone
    // Micro landmark noise is typically < 0.005. Deadzone threshold discards this noise BEFORE sensitivity.
    this.HAND_DEADZONE = 0.0055;
    this.MAX_REASONABLE_DELTA = 0.35; // Clamp tracking glitch teleports
    this.stableHandX = null;
    this.stableHandY = null;
    this.prevHandX = null;
    this.prevHandY = null;
    this.isHandMoving = false;
    this.lastHandDeltaTime = performance.now();

    // Face Tracking Fallback State
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.faceWidth = 0.25;
    this.faceHeight = 0.30;
    this.isFaceMoving = false;
    this.sensitivityX = 2.4;
    this.sensitivityY = 2.0;
    this.DEADZONE_X = 0.0060;
    this.DEADZONE_Y = 0.0075;
    this.lastFaceDeltaTime = performance.now();

    // Fluid Sub-Frame Rotation (Smooth 60 FPS Camera Rotation without Stutter or Momentum)
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;

    // Stale Input Safety Bounds
    this.MAX_HAND_INPUT_AGE = 120; // ms: if hand result is older, stop look & shoot
    this.MAX_FACE_INPUT_AGE = 120; // ms

    // Reused Snapshot Object (Zero GC Allocation Churn)
    this.latestSnapshot = {
      hasFace: false,
      faceCount: 0,
      confidence: 0,
      faceX: 0.5,
      faceY: 0.5,
      aimX: 0,
      aimY: 0,
      box: null,
      faceTimestamp: 0,
      faceCapturedAt: 0,
      hasHand: false,
      handX: 0.5,
      handY: 0.5,
      landmarks: null,
      fistScore: 0,
      isFist: false,
      handTimestamp: 0,
      handCapturedAt: 0
    };

    // Camera Orientation
    this.yaw = 0;
    this.pitch = 0;

    // Weapon Hold-To-Fire & Fist Trigger State
    this.shootHeld = false;
    this.confirmedFist = false;
    this.FIST_ON_THRESHOLD = 0.65;
    this.FIST_OFF_THRESHOLD = 0.45;
    this.fireInterval = (GAME_CONFIG?.WEAPON?.FIRE_RATE_MS || 110) / 1000; // 0.11s TAR-21
    this.fireCooldown = 0;

    // Performance Diagnostics
    this.diagnostics = {
      cameraFps: 30,
      gameFps: 60,
      handFps: 30,
      faceFps: 0,
      handMs: 8,
      faceMs: 0,
      handAgeMs: 0,
      faceAgeMs: 0,
      renderFrameCount: 0,
      handFrameCount: 0,
      faceFrameCount: 0,
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
      modeHandBtn: null,
      widgetSens: null,
      widgetSensVal: null,
      settingSens: null,
      settingSensVal: null
    };

    this.initDOM();
  }

  // --- DOM INITIALIZATION ---

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
    this.dom.diagFaceInit = document.getElementById('diag-face-init');
    this.dom.diagCamRunning = document.getElementById('diag-cam-running');
    this.dom.diagFrameProcessed = document.getElementById('diag-frame-processed');
    this.dom.diagFaceCount = document.getElementById('diag-face-count');
    this.dom.diagFaceConf = document.getElementById('diag-face-conf');
    this.dom.diagFaceAge = document.getElementById('diag-face-age');
    this.dom.calibrateBtn = document.getElementById('btn-camera-aim-calibrate') || document.getElementById('cameraAimCalibrate');
    this.dom.stopBtn = document.getElementById('btn-camera-aim-stop') || document.getElementById('cameraAimStop');
    this.dom.alertToast = document.getElementById('camera-aim-alert') || document.getElementById('cameraAimToast');

    // Test mode buttons
    this.dom.modeAllBtn = document.getElementById('btn-aim-mode-all');
    this.dom.modeRawBtn = document.getElementById('btn-aim-mode-raw');
    this.dom.modeFaceBtn = document.getElementById('btn-aim-mode-face');
    this.dom.modeHandBtn = document.getElementById('btn-aim-mode-hand');

    // Camera Sensitivity Controls
    this.dom.widgetSens = document.getElementById('widget-camera-sens');
    this.dom.widgetSensVal = document.getElementById('widget-camera-sens-val');
    this.dom.settingSens = document.getElementById('setting-camera-sens');
    this.dom.settingSensVal = document.getElementById('setting-camera-sens-val');

    if (this.dom.modeAllBtn && !this.dom.modeAllBtn._hasHandler) {
      this.dom.modeAllBtn._hasHandler = true;
      this.dom.modeAllBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.setTestMode('ALL');
        }
      });
    }
    if (this.dom.modeRawBtn && !this.dom.modeRawBtn._hasHandler) {
      this.dom.modeRawBtn._hasHandler = true;
      this.dom.modeRawBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.setTestMode('RAW');
        }
      });
    }
    if (this.dom.modeFaceBtn && !this.dom.modeFaceBtn._hasHandler) {
      this.dom.modeFaceBtn._hasHandler = true;
      this.dom.modeFaceBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.setTestMode('FACE_ONLY');
        }
      });
    }
    if (this.dom.modeHandBtn && !this.dom.modeHandBtn._hasHandler) {
      this.dom.modeHandBtn._hasHandler = true;
      this.dom.modeHandBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.setTestMode('HAND_ONLY');
        }
      });
    }

    if (this.dom.canvas) {
      this.canvasCtx = this.dom.canvas.getContext('2d', { alpha: true });
    }

    // Bind sensitivity slider in the preview widget with active instance delegation
    if (this.dom.widgetSens && !this.dom.widgetSens._hasSensHandler) {
      this.dom.widgetSens._hasSensHandler = true;
      this.dom.widgetSens.addEventListener('input', (e) => {
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.setCameraSensitivity(parseFloat(e.target.value));
        }
      });
    }

    // Bind UI actions safely using active instance delegation so match transitions always control the current match
    const handleToggle = (e) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (CameraAimController.activeInstance) {
        CameraAimController.activeInstance.toggle();
      }
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
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.calibrate();
        }
      });
    }

    if (this.dom.stopBtn && !this.dom.stopBtn._hasCameraAimHandler) {
      this.dom.stopBtn._hasCameraAimHandler = true;
      this.dom.stopBtn.addEventListener('click', (e) => {
        e?.preventDefault();
        e?.stopPropagation();
        if (CameraAimController.activeInstance) {
          CameraAimController.activeInstance.explicitStop();
        }
      });
    }

    this.syncSensitivityUI(this.cameraSensitivity);
    this.updateToggleButton(this.isActive);
    this.updateTestModeUI();
  }

  // --- CAMERA SENSITIVITY SETTING ---

  setCameraSensitivity(val) {
    const num = parseFloat(val);
    if (isNaN(num)) return;
    const clamped = Math.max(0.5, Math.min(3.0, num));
    this.cameraSensitivity = clamped;
    try {
      localStorage.setItem('para_sf_camera_sens', clamped.toFixed(1));
    } catch (_) {}
    this.syncSensitivityUI(clamped);
  }

  syncSensitivityUI(val) {
    const formatted = `${val.toFixed(1)}x`;
    if (this.dom.widgetSens && parseFloat(this.dom.widgetSens.value) !== val) {
      this.dom.widgetSens.value = val;
    }
    if (this.dom.widgetSensVal) {
      this.dom.widgetSensVal.textContent = formatted;
    }
    if (this.dom.settingSens && parseFloat(this.dom.settingSens.value) !== val) {
      this.dom.settingSens.value = val;
    }
    if (this.dom.settingSensVal) {
      this.dom.settingSensVal.textContent = formatted;
    }
  }

  setTestMode(mode) {
    this.testMode = mode;
    switch (mode) {
      case 'RAW':
        this.faceTrackingEnabled = false;
        this.handTrackingEnabled = false;
        this.handleFaceLoss();
        this.handleHandLoss();
        this.showToast('TEST MODE: RAW WEBCAM ONLY (NO AI)');
        break;
      case 'FACE_ONLY':
        this.faceTrackingEnabled = true;
        this.handTrackingEnabled = false;
        this.handleHandLoss();
        this.showToast('MODE: FACE LOOK ONLY');
        break;
      case 'ALL':
      default:
        // Standard PC Mode: Face look + Fist shooting
        this.faceTrackingEnabled = true;
        this.handTrackingEnabled = true;
        this.showToast('MODE: FACE LOOK + FIST SHOOT');
        break;
    }
    this.updateTestModeUI();
    this.updateStatusUI();
  }

  updateTestModeUI() {
    const list = [
      { btn: this.dom.modeAllBtn, mode: 'ALL' },
      { btn: this.dom.modeFaceBtn, mode: 'FACE_ONLY' },
      { btn: this.dom.modeRawBtn, mode: 'RAW' }
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

  explicitStop() {
    try {
      localStorage.setItem('para_sf_camera_aim_enabled', 'false');
    } catch (_) {}
    this.stop();
  }

  async toggle() {
    if (this.isActive) {
      try {
        localStorage.setItem('para_sf_camera_aim_enabled', 'false');
      } catch (_) {}
      this.stop();
    } else {
      try {
        localStorage.setItem('para_sf_camera_aim_enabled', 'true');
      } catch (_) {}
      await this.start();
    }
  }

  async start() {
    if (this.isActive || this.isStarting) return;
    this.isStarting = true;

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

      // 2. Attach directly to webcam video element
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
        console.warn('[CAMERA AIM] video.play() warning:', playErr);
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

      // Reset anchors and ensure NO FACE DETECTED on start
      this.stableFaceX = null;
      this.stableFaceY = null;
      this.prevFaceX = null;
      this.prevFaceY = null;
      this.isFaceMoving = false;
      this.latestSnapshot.hasFace = false;
      this.latestSnapshot.faceCount = 0;
      this.latestSnapshot.confidence = 0;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.latestSnapshot.hasHand = false;
      this.latestSnapshot.isFist = false;
      this.latestFrameProcessed = false;
      this.shootHeld = false;
      this.confirmedFist = false;

      this.state = FaceFistState.WAITING_FOR_FACE;
      this.updatePoseBadge('NO FACE DETECTED', 'badge-not-detected');

      // Start hardware video presentation monitor
      this.startVideoPlaybackMonitoring();

      // 4. Initialize MediaPipe landmarkers & background workers
      await this.initLandmarkers();

      // 5. Start independent decoupled tracking scheduler
      this.startTrackingScheduler();

      this.showToast('CAMERA AIM ACTIVE');
      try {
        localStorage.setItem('para_sf_camera_aim_enabled', 'true');
      } catch (_) {}
      console.log(`[CAMERA AIM] Hardware video pipeline active: ${this.actualTrackWidth}x${this.actualTrackHeight} @ ~${this.actualTrackFps}fps`);
    } catch (err) {
      console.error('[CAMERA AIM] Failed to start webcam:', err);
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

    this.isHandMoving = false;
    this.stableHandX = null;
    this.stableHandY = null;
    this.prevHandX = null;
    this.prevHandY = null;

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
    this.latestSnapshot.faceCount = 0;
    this.latestSnapshot.confidence = 0;
    this.latestSnapshot.hasHand = false;
    this.latestSnapshot.landmarks = null;
    this.latestFrameProcessed = false;

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

    // 3. Close detectors and workers
    if (this.handWorker) {
      try {
        this.handWorker.postMessage({ type: 'CLOSE' });
        this.handWorker.terminate();
      } catch (_) {}
      this.handWorker = null;
    }
    this.handWorkerReady = false;
    this.handWorkerBusy = false;

    if (this.faceWorker) {
      try {
        this.faceWorker.postMessage({ type: 'CLOSE' });
        this.faceWorker.terminate();
      } catch (_) {}
      this.faceWorker = null;
    }
    this.faceWorkerReady = false;
    this.faceWorkerBusy = false;

    if (this.handLandmarker && typeof this.handLandmarker.close === 'function') {
      try { this.handLandmarker.close(); } catch (_) {}
      this.handLandmarker = null;
    }
    if (this.faceDetector && typeof this.faceDetector.close === 'function') {
      try { this.faceDetector.close(); } catch (_) {}
      this.faceDetector = null;
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
    console.log('[CAMERA AIM] Camera Aim cleanly stopped and all resources released.');
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

  // --- MEDIAPIPE MODEL INITIALIZATION ---

  async initLandmarkers() {
    if (this.isPipelineReady && ((this.faceWorker && this.faceWorkerReady) || this.faceDetector)) return;

    const tInitStart = performance.now();
    try {
      console.log('[CAMERA AIM] Initializing MediaPipe Face & Hand Models / Workers...');

      // 1. Initialize Decoupled Background Face Worker (PRIMARY CAMERA ROTATION)
      if (typeof Worker !== 'undefined') {
        if (!this.faceWorker) {
          try {
            this.faceWorker = new Worker('/src/cameraAimWorker.js');
            this.faceWorker.onmessage = (e) => this.handleWorkerMessage(e);
            this.faceWorker.onerror = (wErr) => {
              console.warn('[CAMERA AIM] Face Worker error:', wErr);
              this.faceWorkerReady = false;
              this.isFaceDetectorInitialized = false;
            };
            this.faceWorker.postMessage({
              type: 'INIT',
              wasmPath: '/lib/mediapipe/wasm',
              faceModelPath: '/assets/models/blaze_face_short_range.tflite',
              faceLandmarkerPath: '/assets/models/face_landmarker.task'
            });
            console.log('[CAMERA AIM] Spawning background Face Worker for primary camera look...');
          } catch (wErr) {
            console.warn('[CAMERA AIM] Could not spawn Face Worker:', wErr);
            this.faceWorker = null;
          }
        }

        // 2. Initialize Background Hand Worker (FIST SHOOTING TRIGGER ONLY)
        if (!this.handWorker) {
          try {
            this.handWorker = new Worker('/src/cameraAimHandWorker.js');
            this.handWorker.onmessage = (e) => this.handleHandWorkerMessage(e);
            this.handWorker.onerror = (wErr) => {
              console.warn('[CAMERA AIM] Hand Worker error:', wErr);
              this.handWorkerReady = false;
            };
            this.handWorker.postMessage({
              type: 'INIT',
              wasmPath: '/lib/mediapipe/wasm',
              handModelPath: '/assets/models/hand_landmarker.task'
            });
            console.log('[CAMERA AIM] Spawning background Hand Worker for fist trigger...');
          } catch (wErr) {
            console.warn('[CAMERA AIM] Could not spawn Hand Worker:', wErr);
            this.handWorker = null;
          }
        }
      }

      // 3. Fallback in-thread initialization if workers unavailable
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

        const { FilesetResolver, FaceDetector, FaceLandmarker, HandLandmarker } = vision;
        const fileset = await FilesetResolver.forVisionTasks('/lib/mediapipe/wasm');

        if (!this.faceWorker) {
          try {
            if (FaceLandmarker) {
              const landmarkerOpts = {
                baseOptions: {
                  modelAssetPath: '/assets/models/face_landmarker.task',
                  delegate: 'CPU'
                },
                runningMode: 'VIDEO',
                numFaces: 1,
                minFaceDetectionConfidence: 0.6,
                minFacePresenceConfidence: 0.6,
                minTrackingConfidence: 0.6
              };
              this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, landmarkerOpts);
              this.useFaceDetector = false;
              this.isFaceDetectorInitialized = true;
              console.log('[CAMERA AIM] In-thread FaceLandmarker initialized with 468 landmark verification.');
            }
          } catch (lmErr) {
            console.warn('[CAMERA AIM] In-thread FaceLandmarker failed, trying FaceDetector:', lmErr);
            if (FaceDetector) {
              const detectorOpts = {
                baseOptions: {
                  modelAssetPath: '/assets/models/blaze_face_short_range.tflite',
                  delegate: 'CPU'
                },
                runningMode: 'VIDEO',
                minDetectionConfidence: 0.75,
                minSuppressionThreshold: 0.3
              };
              this.faceDetector = await FaceDetector.createFromOptions(fileset, detectorOpts);
              this.useFaceDetector = true;
              this.isFaceDetectorInitialized = true;
              console.log('[CAMERA AIM] In-thread FaceDetector fallback initialized.');
            }
          }
        }

        if (!this.handWorker && HandLandmarker) {
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
      console.log(`[CAMERA AIM] Models initialized in ${initDuration} ms. Face worker: ${!!this.faceWorker}, Hand worker: ${!!this.handWorker}`);
    } catch (err) {
      console.error('[CAMERA AIM] Failed to initialize MediaPipe models:', err);
      throw err;
    }
  }

  // --- TRACKING SCHEDULER (NON-BLOCKING, ZERO-QUEUE) ---

  startTrackingScheduler() {
    this.cancelTrackingScheduler();

    const schedulerTick = () => {
      if (!this.trackingActive) return;

      const now = performance.now();

      if (this.testMode !== 'RAW') {
        // 1. FACE TRACKING (PRIMARY CAMERA MOVEMENT CONTROLLER)
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
                  }).catch(() => {
                    this.faceWorkerBusy = false;
                  });
                } else {
                  this.faceWorkerBusy = false;
                }
              }
            }
          } else if (this.faceDetector && !this.faceBusy) {
            if (now - this.lastFaceRunTime >= this.faceTrackingInterval) {
              this.lastFaceRunTime = now;
              this.runFaceInference(now);
            }
          }
        }

        // 2. HAND TRACKING (FIST SHOOTING TRIGGER ONLY)
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
                  }).catch(() => {
                    this.handWorkerBusy = false;
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

  // --- WORKER MESSAGE HANDLERS ---

  handleHandWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'INIT_OK') {
      this.handWorkerReady = true;
      this.handWorkerBusy = false;
      console.log('[CAMERA AIM] Hand Worker ready in background thread.');
    } else if (msg.type === 'INIT_ERROR') {
      console.warn('[CAMERA AIM] Hand Worker init error, falling back to in-thread:', msg.error);
      this.handWorkerReady = false;
      this.handWorkerBusy = false;
    } else if (msg.type === 'HAND_RESULT') {
      this.handWorkerBusy = false;
      const now = performance.now();
      const frameTimestamp = msg.capturedAt || msg.timestamp || now;
      this.diagnostics.handMs = msg.inferenceMs || 0;
      this.diagnostics.handFrameCount++;
      this.diagnostics.handAgeMs = Math.max(0, Math.round(now - frameTimestamp));

      if (!msg.hasHand || typeof msg.rawAimX !== 'number') {
        this.handleHandLoss();
        return;
      }

      this.handleHandResult(true, msg, now);
    }
  }

  handleWorkerMessage(e) {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'INIT_OK') {
      this.faceWorkerReady = true;
      this.faceWorkerBusy = false;
      this.useFaceDetector = !!msg.useFaceDetector;
      this.isFaceDetectorInitialized = true;
      console.log('[CAMERA AIM] Face Worker ready in background thread. Model mode:', this.useFaceDetector ? 'FaceDetector' : 'FaceLandmarker');
    } else if (msg.type === 'INIT_ERROR') {
      console.warn('[CAMERA AIM] Face Worker init error:', msg.error);
      this.faceWorkerReady = false;
      this.faceWorkerBusy = false;
      this.isFaceDetectorInitialized = false;
    } else if (msg.type === 'FACE_RESULT') {
      this.faceWorkerBusy = false;
      this.latestFrameProcessed = true;
      const now = performance.now();
      const frameTimestamp = msg.capturedAt || msg.timestamp || now;
      this.diagnostics.faceMs = msg.inferenceMs || 0;
      this.diagnostics.faceFrameCount++;
      this.diagnostics.faceAgeMs = Math.max(0, Math.round(now - frameTimestamp));

      const faceCount = typeof msg.faceCount === 'number' ? msg.faceCount : (msg.hasFace ? 1 : 0);
      const confidence = typeof msg.confidence === 'number' ? msg.confidence : (msg.hasFace ? 1.0 : 0);

      // Section 1, 2, 5: Check ACTUAL CURRENT FRAME detector result
      if (!msg.hasFace || faceCount === 0) {
        this.handleFaceLoss(now);
      } else {
        this.handleFaceResult(msg, now);
      }
    }
  }

  handleFaceLoss(now = performance.now()) {
    const snap = this.latestSnapshot;
    snap.hasFace = false;
    snap.faceCount = 0;
    snap.confidence = 0;
    snap.box = null;

    // Immediately zero camera movement delta
    snap.aimX = 0;
    snap.aimY = 0;
    this.isFaceMoving = false;
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;

    // Clear anchors so face re-entry anchors smoothly
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;

    this.updatePoseBadge('NO FACE DETECTED', 'badge-not-detected');
    this.updateStatusUI(true);
  }

  handleFaceResult(msg, now = performance.now()) {
    const snap = this.latestSnapshot;
    if (!msg.hasFace || (typeof msg.faceCount === 'number' && msg.faceCount === 0)) {
      this.handleFaceLoss(now);
      return;
    }

    snap.hasFace = true;
    snap.faceCount = typeof msg.faceCount === 'number' ? msg.faceCount : 1;
    snap.confidence = typeof msg.confidence === 'number' ? msg.confidence : 1.0;
    snap.box = msg.box || null;
    snap.faceTimestamp = now;
    snap.faceCapturedAt = msg.capturedAt || now;

    if (this.faceTrackingEnabled) {
      this.applyFaceMovementDelta(msg.rawFaceX, msg.rawFaceY, msg.faceWidth, msg.faceHeight, msg.box || null);
    }

    this.updatePoseBadge('FACE DETECTED', this.isFaceMoving ? 'badge-tracking' : 'badge-ready');
    this.updateStatusUI(true);
  }

  computeWholeFaceCentroid(face) {
    if (!face || face.length < 468) return null;
    const FOREHEAD_IDXS = [10, 109, 338];
    const LEFT_CHEEK_IDXS = [234, 93, 132];
    const RIGHT_CHEEK_IDXS = [454, 323, 361];
    const CHIN_IDXS = [152, 148, 377];
    const MIDFACE_IDXS = [168, 6, 2, 1];

    let fx = 0, fy = 0;
    for (let i = 0; i < FOREHEAD_IDXS.length; i++) { fx += face[FOREHEAD_IDXS[i]].x; fy += face[FOREHEAD_IDXS[i]].y; }
    fx /= FOREHEAD_IDXS.length; fy /= FOREHEAD_IDXS.length;

    let lx = 0, ly = 0;
    for (let i = 0; i < LEFT_CHEEK_IDXS.length; i++) { lx += face[LEFT_CHEEK_IDXS[i]].x; ly += face[LEFT_CHEEK_IDXS[i]].y; }
    lx /= LEFT_CHEEK_IDXS.length; ly /= LEFT_CHEEK_IDXS.length;

    let rx = 0, ry = 0;
    for (let i = 0; i < RIGHT_CHEEK_IDXS.length; i++) { rx += face[RIGHT_CHEEK_IDXS[i]].x; ry += face[RIGHT_CHEEK_IDXS[i]].y; }
    rx /= RIGHT_CHEEK_IDXS.length; ry /= RIGHT_CHEEK_IDXS.length;

    let cx = 0, cy = 0;
    for (let i = 0; i < CHIN_IDXS.length; i++) { cx += face[CHIN_IDXS[i]].x; cy += face[CHIN_IDXS[i]].y; }
    cx /= CHIN_IDXS.length; cy /= CHIN_IDXS.length;

    let mx = 0, my = 0;
    for (let i = 0; i < MIDFACE_IDXS.length; i++) { mx += face[MIDFACE_IDXS[i]].x; my += face[MIDFACE_IDXS[i]].y; }
    mx /= MIDFACE_IDXS.length; my /= MIDFACE_IDXS.length;

    const rawFaceX = (fx + lx + rx + cx + mx) * 0.2;
    const rawFaceY = (fy + ly + ry + cy + my) * 0.2;
    const faceWidth = Math.max(0.08, Math.hypot(face[454].x - face[234].x, face[454].y - face[234].y));
    const faceHeight = Math.max(0.08, Math.hypot(face[10].x - face[152].x, face[10].y - face[152].y));

    return { rawFaceX, rawFaceY, faceWidth, faceHeight };
  }

  // --- IN-THREAD FACE INFERENCE FALLBACK ---
  runFaceInference(now) {
    if (!this.video || this.video.readyState < 2 || (!this.faceDetector && !this.faceLandmarker)) return;
    this.faceBusy = true;
    try {
      const tStart = performance.now();
      this.latestFrameProcessed = true;

      if (!this.useFaceDetector && this.faceLandmarker) {
        const faceResults = this.faceLandmarker.detectForVideo(this.video, now);
        const duration = performance.now() - tStart;
        this.diagnostics.faceMs = Math.round(duration);
        this.diagnostics.faceFrameCount++;

        const faces = faceResults?.faceLandmarks;
        if (!faces || !Array.isArray(faces) || faces.length === 0 || faces[0].length < 468) {
          this.handleFaceLoss(now);
          return;
        }

        const centroid = this.computeWholeFaceCentroid(faces[0]);
        if (!centroid) {
          this.handleFaceLoss(now);
          return;
        }

        this.handleFaceResult({
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
          capturedAt: now
        }, now);
      } else if (this.faceDetector) {
        const detectRes = this.faceDetector.detectForVideo(this.video, now);
        const duration = performance.now() - tStart;
        this.diagnostics.faceMs = Math.round(duration);
        this.diagnostics.faceFrameCount++;

        const detections = detectRes?.detections;
        if (!detections || !Array.isArray(detections) || detections.length === 0) {
          this.handleFaceLoss(now);
          return;
        }

        const det = detections[0];
        const score = (det.categories && det.categories[0] && typeof det.categories[0].score === 'number')
          ? det.categories[0].score
          : 0;

        if (score < 0.75 || !det.keypoints || det.keypoints.length < 4) {
          this.handleFaceLoss(now);
          return;
        }

        const vw = this.actualTrackWidth || 640;
        const vh = this.actualTrackHeight || 480;
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

        this.handleFaceResult({
          hasFace: true,
          faceCount: detections.length,
          confidence: score,
          rawFaceX,
          rawFaceY,
          faceWidth: boxNormWidth,
          faceHeight: boxNormHeight,
          box: boxNorm,
          capturedAt: now
        }, now);
      }
    } catch (faceErr) {
      console.warn('[CAMERA AIM] In-thread face inference error:', faceErr);
      this.handleFaceLoss(now);
    } finally {
      this.faceBusy = false;
    }
  }

  // --- HAND DETECTION & FIST SHOOTING (DECOUPLED FROM CAMERA ROTATION) ---

  handleHandResult(hasHand, handData, timestamp) {
    const snap = this.latestSnapshot;
    if (!hasHand || !handData) {
      this.handleHandLoss();
      return;
    }

    snap.hasHand = true;
    snap.handTimestamp = performance.now();
    snap.handCapturedAt = timestamp;
    snap.fistScore = handData.fistScore || 0;
    snap.isFist = !!handData.isFist;
    this.confirmedFist = snap.isFist;
    this.shootHeld = snap.isFist;
    snap.landmarks = handData.landmarks || null;

    // SECTION 7: Hand movement NEVER rotates camera!
    // Hand tracking only triggers fist shooting.
  }

  handleHandLoss() {
    const snap = this.latestSnapshot;
    snap.hasHand = false;
    snap.landmarks = null;
    snap.isFist = false;
    snap.fistScore = 0;
    this.shootHeld = false;
    this.confirmedFist = false;
  }

  // --- IN-THREAD HAND INFERENCE FALLBACK ---

  runHandInference(now) {
    if (!this.video || this.video.readyState < 2) return;
    this.handBusy = true;

    try {
      let currentTimestamp = now;
      if (currentTimestamp <= this.lastDirectHandTimestamp) {
        currentTimestamp = this.lastDirectHandTimestamp + 1;
      }
      this.lastDirectHandTimestamp = currentTimestamp;

      const frameTimestamp = this.lastVideoFrameTime > 0 ? this.lastVideoFrameTime : currentTimestamp;
      const tStart = performance.now();
      const handRes = this.handLandmarker.detectForVideo(this.video, currentTimestamp);
      const completionTime = performance.now();
      const duration = completionTime - tStart;
      this.diagnostics.handMs = Math.round(duration);
      this.diagnostics.handFrameCount++;
      this.diagnostics.handAgeMs = Math.max(0, Math.round(completionTime - frameTimestamp));

      const hands = handRes?.landmarks;
      if (!hands || hands.length === 0 || hands[0].length < 21) {
        this.handleHandLoss();
        return;
      }

      const hand = hands[0];
      const fistScore = this.calculateFistScore(hand);
      const aimData = this.calculateHandAimPoint(hand);

      if (fistScore >= this.FIST_ON_THRESHOLD) {
        this.confirmedFist = true;
      } else if (fistScore <= this.FIST_OFF_THRESHOLD) {
        this.confirmedFist = false;
      }

      this.handleHandResult(true, {
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
        isFist: this.confirmedFist,
        landmarks: hand.map(pt => ({ x: pt.x, y: pt.y }))
      }, frameTimestamp);
    } catch (handErr) {
      console.warn('[CAMERA AIM] In-thread hand inference error:', handErr);
      this.handGpuErrorCount++;
    } finally {
      this.handBusy = false;
    }
  }

  calculateHandAimPoint(hand) {
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

    const extendedX = indexTip.x * 0.75 + indexMcp.x * 0.25;
    const extendedY = indexTip.y * 0.75 + indexMcp.y * 0.25;

    const fistX = indexMcp.x * 0.5 + middleMcp.x * 0.3 + wrist.x * 0.2;
    const fistY = indexMcp.y * 0.5 + middleMcp.y * 0.3 + wrist.y * 0.2;

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

    let rawScore = fourFingers * 0.70 + minCurl * 0.20 + cThumb * 0.10;
    if (cIndex < 0.55) {
      rawScore *= (cIndex / 0.55);
    }

    return Math.max(0, Math.min(1, rawScore));
  }

  // --- FACE TRACKING FALLBACK (FACE ONLY MODE) ---

  applyFaceMovementDelta(rawFaceX, rawFaceY, faceWidth, faceHeight, boxNorm = null) {
    const snap = this.latestSnapshot;
    const now = performance.now();
    snap.hasFace = true;
    snap.box = boxNorm;
    snap.faceTimestamp = now;

    if (this.stableFaceX === null || this.prevFaceX === null) {
      this.stableFaceX = rawFaceX;
      this.stableFaceY = rawFaceY;
      this.prevFaceX = rawFaceX;
      this.prevFaceY = rawFaceY;
      this.lastFaceDeltaTime = now;
      snap.faceX = rawFaceX;
      snap.faceY = rawFaceY;
      return;
    }

    const normDeltaX = (rawFaceX - this.prevFaceX) / Math.max(0.08, faceWidth);
    const normDeltaY = (rawFaceY - this.prevFaceY) / Math.max(0.08, faceHeight);
    const dist = Math.hypot(normDeltaX, normDeltaY);

    if (dist <= this.DEADZONE_X) {
      this.isFaceMoving = false;
      snap.aimX = 0;
      snap.aimY = 0;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
      return;
    }

    const scale = (dist - this.DEADZONE_X) / dist;
    const effDeltaX = normDeltaX * scale;
    const effDeltaY = normDeltaY * scale;

    this.prevFaceX = rawFaceX;
    this.prevFaceY = rawFaceY;

    const totalYawDelta = effDeltaX * this.sensitivityX * this.cameraSensitivity;
    const totalPitchDelta = -effDeltaY * this.sensitivityY * this.cameraSensitivity;

    snap.aimX = totalYawDelta;
    snap.aimY = totalPitchDelta;
    this.isFaceMoving = true;

    const faceDt = Math.max(0.016, Math.min(0.100, (now - this.lastFaceDeltaTime) / 1000));
    this.lastFaceDeltaTime = now;

    this.turnRateYaw = totalYawDelta / faceDt;
    this.turnRatePitch = totalPitchDelta / faceDt;
    this.turnDurationRemaining = faceDt;
  }

  // --- CALIBRATION / ANCHOR RESET ---

  calibrate() {
    if (!this.isActive) return;
    this.stableFaceX = null;
    this.stableFaceY = null;
    this.prevFaceX = null;
    this.prevFaceY = null;
    this.isFaceMoving = false;
    this.turnDurationRemaining = 0;
    this.turnRateYaw = 0;
    this.turnRatePitch = 0;
    this.latestSnapshot.aimX = 0;
    this.latestSnapshot.aimY = 0;

    const ctrl = this.getControls ? this.getControls() : null;
    if (ctrl) {
      this.yaw = ctrl.yaw || 0;
      this.pitch = ctrl.pitch || 0;
    }

    this.showToast('FACE ANCHOR RESET');
    if (this.latestSnapshot.hasFace) {
      this.updatePoseBadge('FACE DETECTED', 'badge-ready');
    } else {
      this.updatePoseBadge('NO FACE DETECTED', 'badge-not-detected');
    }
  }

  // --- GAME RENDER LOOP UPDATE (CALLED EVERY ANIMATION FRAME) ---

  update(dt) {
    if (!this.isActive || !this.camera) return;

    this.diagnostics.renderFrameCount++;
    const snap = this.latestSnapshot;
    const now = performance.now();

    // 1. Live Data Freshness & Stale Face Detection Timeout Safety:
    // If no fresh face result arrived within MAX_FACE_INPUT_AGE (120ms), immediately treat face as NOT DETECTED
    const faceAge = (snap.faceTimestamp > 0) ? (now - snap.faceTimestamp) : 9999;
    this.diagnostics.faceAgeMs = (snap.faceTimestamp > 0) ? Math.round(faceAge) : 9999;

    if (snap.hasFace && faceAge > this.MAX_FACE_INPUT_AGE) {
      this.handleFaceLoss(now);
    }

    if (snap.handTimestamp > 0 && (now - snap.handTimestamp) > this.MAX_HAND_INPUT_AGE) {
      this.handleHandLoss();
    }

    // 2. Video frames delivered monitor
    if (this.video && this.video.currentTime !== this.lastObservedVideoTime) {
      this.lastObservedVideoTime = this.video.currentTime;
      if (!this.videoCallbackId) {
        this.videoFramesDelivered++;
      }
    }

    // 3. Apply Camera Rotation Delta - ONLY when valid face is detected (Section 6)
    if (snap.hasFace && this.turnDurationRemaining > 0) {
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

      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;

      const ctrl = this.getControls ? this.getControls() : null;
      if (ctrl) {
        ctrl.yaw = this.yaw;
        ctrl.pitch = this.pitch;
      }
    } else if (snap.hasFace && (snap.aimX !== 0 || snap.aimY !== 0)) {
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
    } else if (!snap.hasFace) {
      // When NO FACE is detected, camera rotation delta is STRICTLY ZERO
      snap.aimX = 0;
      snap.aimY = 0;
      this.turnDurationRemaining = 0;
      this.turnRateYaw = 0;
      this.turnRatePitch = 0;
    }

    // 4. Weapon Hold-To-Fire Execution (triggered by fist clench)
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.shootHeld && this.fireCooldown <= 0) {
      this.tryFire();
    }

    // 5. Update Preview Overlay at ~20 Hz
    if (now - this.lastOverlayDrawTime >= 48) {
      this.lastOverlayDrawTime = now;
      this.drawPreviewOverlay();
    }

    // 6. Update Status UI
    this.updateStatusUI();
  }

  tryFire() {
    if (!this.onShoot) return;
    const shot = this.onShoot();
    if (shot === false) {
      this.fireCooldown = 0.08;
      return;
    }
    this.fireCooldown = this.fireInterval;
  }

  // --- PREVIEW OVERLAY RENDERING ---

  drawPreviewOverlay() {
    if (!this.canvasCtx || !this.dom.canvas) return;
    const ctx = this.canvasCtx;
    const w = this.dom.canvas.width;
    const h = this.dom.canvas.height;

    ctx.clearRect(0, 0, w, h);
    const snap = this.latestSnapshot;

    // 1. Draw Face Detection Target Box & Reticle
    if (snap.hasFace && this.faceTrackingEnabled) {
      const curX = (1.0 - snap.faceX) * w; // mirrored
      const curY = snap.faceY * h;

      if (snap.box) {
        const bx = (1.0 - (snap.box.x + snap.box.w)) * w;
        const by = snap.box.y * h;
        const bw = snap.box.w * w;
        const bh = snap.box.h * h;
        ctx.strokeStyle = this.isFaceMoving ? '#00e5ff' : '#76ff03';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, bw, bh);
      }

      const reticleColor = this.isFaceMoving ? '#00e5ff' : '#76ff03';
      ctx.strokeStyle = reticleColor;
      ctx.lineWidth = 1.8;

      ctx.beginPath();
      ctx.arc(curX, curY, 14, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(curX - 18, curY); ctx.lineTo(curX - 6, curY);
      ctx.moveTo(curX + 6, curY); ctx.lineTo(curX + 18, curY);
      ctx.moveTo(curX, curY - 18); ctx.lineTo(curX, curY - 6);
      ctx.moveTo(curX, curY + 6); ctx.lineTo(curX, curY + 18);
      ctx.stroke();

      ctx.fillStyle = reticleColor;
      ctx.beginPath();
      ctx.arc(curX, curY, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = this.isFaceMoving ? 'rgba(0, 229, 255, 0.85)' : 'rgba(76, 175, 80, 0.85)';
      ctx.fillRect(8, 8, 115, 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(`FACE: ${this.isFaceMoving ? 'MOVING' : 'STILL'} (${snap.faceCount})`, 12, 20);
    } else {
      ctx.strokeStyle = 'rgba(255, 152, 0, 0.4)';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(w * 0.25, h * 0.2, w * 0.5, h * 0.6);
      ctx.fillStyle = 'rgba(255, 152, 0, 0.8)';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('NO FACE DETECTED', w * 0.25 + 8, h * 0.2 - 6);
    }

    // 2. Draw Hand / Fist Indicator if hand visible
    if (snap.hasHand && this.handTrackingEnabled) {
      if (snap.landmarks && snap.landmarks.length > 0) {
        ctx.fillStyle = snap.isFist ? 'rgba(255, 82, 82, 0.6)' : 'rgba(0, 229, 255, 0.45)';
        for (const pt of snap.landmarks) {
          const px = (1 - pt.x) * w;
          const py = pt.y * h;
          ctx.beginPath();
          ctx.arc(px, py, 2.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.fillStyle = snap.isFist ? 'rgba(244, 67, 54, 0.85)' : 'rgba(76, 175, 80, 0.85)';
      ctx.fillRect(8, h - 24, 110, 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(snap.isFist ? '✊ FIST: FIRE' : '✋ HAND: READY', 12, h - 12);
    }
  }

  // --- UI UPDATES & REAL CAMERA DIAGNOSTICS ---

  updateStatusUI(force = false) {
    const now = performance.now();
    const snap = this.latestSnapshot;
    const isCamRunning = !!(this.isActive && this.stream && this.video && !this.video.paused);

    // Section 3: Diagnostic Display Fields - IMMEDIATELY updated in real time
    if (this.dom.diagFaceInit) {
      this.dom.diagFaceInit.textContent = this.isFaceDetectorInitialized ? 'YES' : 'NO';
    }
    if (this.dom.diagCamRunning) {
      this.dom.diagCamRunning.textContent = isCamRunning ? 'YES' : 'NO';
    }
    if (this.dom.diagFrameProcessed) {
      this.dom.diagFrameProcessed.textContent = this.latestFrameProcessed ? 'YES' : 'NO';
    }
    if (this.dom.diagFaceCount) {
      this.dom.diagFaceCount.textContent = snap.hasFace ? String(snap.faceCount) : '0';
    }
    if (this.dom.diagFaceConf) {
      this.dom.diagFaceConf.textContent = snap.hasFace ? (snap.confidence * 100).toFixed(0) + '%' : '0.00';
    }
    if (this.dom.diagFaceAge) {
      this.dom.diagFaceAge.textContent = (snap.hasFace && snap.faceTimestamp > 0)
        ? `${Math.max(0, Math.round(now - snap.faceTimestamp))} ms`
        : '-- ms';
    }

    // Status Line: Exact detector state - IMMEDIATELY updated in real time
    if (this.dom.statusLine) {
      const faceStatus = snap.hasFace ? `FACE: DETECTED (${snap.faceCount})` : 'FACE: NO FACE DETECTED';
      this.dom.statusLine.textContent = `${faceStatus} · CAMERA: ${this.diagnostics.cameraFps} FPS · SENS: ${this.cameraSensitivity.toFixed(1)}x`;
    }

    if (!force && (now - this.diagnostics.lastStatusUpdate < 200)) return;
    this.diagnostics.lastStatusUpdate = now;

    // 1. Hardware Video FPS Calculation
    const elapsedFpsSec = (now - this.lastVideoFpsCalcTime) / 1000;
    if (elapsedFpsSec >= 0.8) {
      this.diagnostics.cameraFps = Math.max(0, Math.round(this.videoFramesDelivered / elapsedFpsSec));
      this.videoFramesDelivered = 0;
      this.lastVideoFpsCalcTime = now;
    }

    // 3. Diagnostics Line
    if (now - this.diagnostics.lastDiagTime >= 400) {
      const elapsedSec = (now - this.diagnostics.lastDiagTime) / 1000;
      this.diagnostics.gameFps = Math.round(this.diagnostics.renderFrameCount / elapsedSec);
      this.diagnostics.faceFps = Math.round(this.diagnostics.faceFrameCount / elapsedSec);
      this.diagnostics.renderFrameCount = 0;
      this.diagnostics.faceFrameCount = 0;
      this.diagnostics.lastDiagTime = now;

      if (this.dom.diag) {
        this.dom.diag.textContent = `DETECTOR: ${this.isFaceDetectorInitialized ? 'READY' : 'INIT'} · CAM: ${isCamRunning ? 'RUNNING' : 'STOP'} · FACE: ${snap.faceCount} (${this.diagnostics.faceFps}fps) · GAME: ${this.diagnostics.gameFps} FPS`;
      }
    }

    // Section 12: MULTIPLAYER FACE DEBUG periodic logging
    const ctrl = this.getControls ? this.getControls() : null;
    const isCamStream = !!(this.stream && this.stream.active);
    const isVideoReady = !!(this.video && this.video.readyState >= 2 && !this.video.paused);
    const faceInit = this.isFaceDetectorInitialized ? 'INITIALIZED' : 'NOT INITIALIZED';
    const loopRunning = this.trackingActive ? 'RUNNING' : 'STOPPED';
    const latestFace = snap.hasFace ? 'FACE' : 'NO FACE';
    const faceAge = (snap.hasFace && snap.faceTimestamp > 0) ? `${Math.max(0, Math.round(now - snap.faceTimestamp))} ms` : '-- ms';
    const camCtrl = (this.isActive && ctrl && ctrl.isCameraAimActive) ? 'ACTIVE' : 'INACTIVE';

    if (now - this.diagnostics.lastConsoleLog >= 1500) {
      this.diagnostics.lastConsoleLog = now;
      console.log(
        `MULTIPLAYER FACE DEBUG\n` +
        `Camera stream: ${isCamStream ? 'YES' : 'NO'}\n` +
        `Video ready: ${isVideoReady ? 'YES' : 'NO'}\n` +
        `Face detector: ${faceInit}\n` +
        `Detection loop: ${loopRunning}\n` +
        `Latest face result: ${latestFace}\n` +
        `Face result age: ${faceAge}\n` +
        `Camera controller: ${camCtrl}`
      );
    }
  }

  getMultiplayerFaceDebug() {
    const now = performance.now();
    const snap = this.latestSnapshot;
    const isCamStream = !!(this.stream && this.stream.active);
    const isVideoReady = !!(this.video && this.video.readyState >= 2 && !this.video.paused);
    const faceInit = this.isFaceDetectorInitialized ? 'INITIALIZED' : 'NOT INITIALIZED';
    const loopRunning = this.trackingActive ? 'RUNNING' : 'STOPPED';
    const latestFace = snap.hasFace ? 'FACE' : 'NO FACE';
    const faceAge = (snap.hasFace && snap.faceTimestamp > 0) ? `${Math.max(0, Math.round(now - snap.faceTimestamp))} ms` : '-- ms';
    const ctrl = this.getControls ? this.getControls() : null;
    const camCtrl = (this.isActive && ctrl && ctrl.isCameraAimActive) ? 'ACTIVE' : 'INACTIVE';
    return {
      cameraStream: isCamStream ? 'YES' : 'NO',
      videoReady: isVideoReady ? 'YES' : 'NO',
      faceDetector: faceInit,
      detectionLoop: loopRunning,
      latestFaceResult: latestFace,
      faceResultAge: faceAge,
      cameraController: camCtrl
    };
  }

  updateToggleButton(isActive) {
    if (this.dom.toggleBtn) {
      if (isActive) {
        this.dom.toggleBtn.classList.add('active');
        if (this.dom.toggleLabel) this.dom.toggleLabel.textContent = 'CAMERA AIM: ON';
      } else {
        this.dom.toggleBtn.classList.remove('active');
        if (this.dom.toggleLabel) this.dom.toggleLabel.textContent = 'CAMERA AIM: OFF';
      }
    }

    if (this.dom.mobileToggleBtn) {
      if (isActive) {
        this.dom.mobileToggleBtn.classList.add('active');
        if (this.dom.mobileToggleLabel) this.dom.mobileToggleLabel.textContent = 'CAMERA AIM: ON';
      } else {
        this.dom.mobileToggleBtn.classList.remove('active');
        if (this.dom.mobileToggleLabel) this.dom.mobileToggleLabel.textContent = 'CAMERA AIM: OFF';
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
