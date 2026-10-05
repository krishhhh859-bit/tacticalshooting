// client/src/mobileControls.js

/**
 * MobileControls
 *
 * Handles mobile input for PARA SF: FOREST ACCURACY:
 * - Virtual Joystick camera look (yaw + pitch rotation, proportional speed)
 * - Optional Gyroscope / DeviceOrientation camera look with landscape transformation
 * - Relative gyro orientation with calibration reference and zero camera snap
 * - Touch swipe look on the right half of the screen
 * - Touch shooting (FIRE)
 * - Scope toggle (SCOPE)
 * - Steady aim toggle (AIM)
 * - Reload (RELOAD)
 * - Fullscreen toggle button with landscape orientation lock
 *
 * IMPORTANT:
 * - The player remains strictly fixed at the designated shooting stall.
 * - The joystick and gyroscope control ONLY camera rotation, NOT player position.
 * - WASD / translation movements are disabled on mobile.
 */

import * as THREE from '/lib/three/three.module.js';

/* ============================================================
   DEVICE & VIEWPORT HELPERS
   ============================================================ */

export function isMobileDevice() {
  return (
    typeof navigator !== 'undefined' &&
    (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      ('ontouchstart' in window) ||
      (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0))
  );
}

export async function enterFullscreen() {
  try {
    const docEl = document.documentElement;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen({ navigationUI: 'hide' });
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    }
  } catch (err) {
    console.warn('[MOBILE] Fullscreen request failed:', err);
  }
}

export async function exitFullscreen() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      } else if (document.msExitFullscreen) {
        await document.msExitFullscreen();
      }
    }
  } catch (err) {
    console.warn('[MOBILE] Exit fullscreen failed:', err);
  }
}

export async function lockLandscape() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      await screen.orientation.lock('landscape');
    }
  } catch (err) {
    console.warn('[MOBILE] Landscape lock unavailable:', err);
  }
}

export async function unlockOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch (err) {
    // Ignore unlock errors
  }
}

export async function autoInitMobile() {
  if (!isMobileDevice()) return;

  document.body.classList.add('phone-mode');

  // Attempt landscape lock if supported (without forced automatic fullscreen)
  await lockLandscape();

  // Notify listeners and resize Three.js renderer & camera aspect ratio
  window.dispatchEvent(new CustomEvent('phone-mode-enabled'));
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
}

export async function enterPhoneMode() {
  await autoInitMobile();
}


/* ============================================================
   GYROSCOPE COORDINATE TRANSFORMATION HELPERS
   ============================================================ */

const DEG2RAD = Math.PI / 180;
// Rotation to align device coordinates (-Z forward out of screen instead of +Y top)
const qMinus90X = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const zeeAxis = new THREE.Vector3(0, 0, 1);

/**
 * Returns current screen orientation angle (0, 90, 180, 270).
 */
export function getScreenOrientationAngle() {
  let angle = 0;
  if (typeof screen !== 'undefined' && screen.orientation && Number.isFinite(screen.orientation.angle)) {
    angle = screen.orientation.angle;
  } else if (typeof window !== 'undefined' && typeof window.orientation === 'number') {
    angle = window.orientation;
  }
  angle = ((angle % 360) + 360) % 360;

  // Fallback: If device is in landscape based on viewport dimensions but reports 0
  if (angle === 0 && typeof window !== 'undefined' && window.innerWidth > window.innerHeight) {
    angle = 90;
  }
  return angle;
}

/**
 * Transforms W3C DeviceOrientation angles (alpha, beta, gamma) and screen orientation
 * into a standard 3D camera coordinate quaternion.
 *
 * Landscape:
 * - physical left/right rotation -> camera yaw left/right
 * - physical up/down tilt -> camera pitch up/down
 */
export function getDeviceQuaternion(alphaDeg, betaDeg, gammaDeg, orientDeg) {
  const alpha = (alphaDeg || 0) * DEG2RAD;
  const beta = (betaDeg || 0) * DEG2RAD;
  const gamma = (gammaDeg || 0) * DEG2RAD;
  const orient = (orientDeg || 0) * DEG2RAD;

  // 1. Device Tait-Bryan intrinsic Z-X'-Y'' rotation
  const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
  const q = new THREE.Quaternion().setFromEuler(euler);

  // 2. Adjust camera forward vector (-Z out of screen)
  q.multiply(qMinus90X);

  // 3. Screen orientation adjustment around camera Z
  const qScreen = new THREE.Quaternion().setFromAxisAngle(zeeAxis, -orient);
  q.multiply(qScreen);

  return q;
}

/**
 * Safe permission request for DeviceOrientationEvent on iOS / modern browsers.
 */
export async function requestDeviceOrientationPermission() {
  if (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  ) {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      return state === 'granted';
    } catch (e) {
      console.warn('[GYRO] Permission request error:', e);
      return false;
    }
  }
  // Android Chrome and browsers without explicit requestPermission
  return true;
}


/* ============================================================
   MOBILE CONTROLS CLASS
   ============================================================ */

export class MobileControls {
  constructor(camera, playerPositionOrShoot, callbacksOrScope = {}, onAim, onReload, onToggleCamera) {
    this.camera = camera;

    // Handle flexible parameter signatures
    if (typeof playerPositionOrShoot === 'function') {
      this.playerPosition = null;
      this.callbacks = {
        onShoot: playerPositionOrShoot,
        onScope: callbacksOrScope,
        onAim: onAim,
        onReload: onReload,
        onToggleCamera: onToggleCamera
      };
    } else {
      this.playerPosition = playerPositionOrShoot;
      this.callbacks = callbacksOrScope || {};
    }

    this.enabled = false;

    // Camera viewing angles in radians
    this.yaw = 0;   // Horizontal look: + = left, - = right
    this.pitch = 0; // Vertical look: + = up, - = down (clamped to [-1.45, 1.45])

    // Base viewing direction (driven by joystick and touch swipe)
    this.baseYaw = 0;
    this.basePitch = 0;

    // Relative Gyroscope State
    this.gyroActive = false;
    this.gyroListenerActive = false;
    this.hasGyroOrientation = false;
    this.needsCalibration = true;
    const savedSens = (typeof localStorage !== 'undefined') ? localStorage.getItem('para_sf_gyro_sens') : null;
    this.gyroSensitivity = savedSens ? parseFloat(savedSens) / 100 : 1.0;
    if (!Number.isFinite(this.gyroSensitivity) || this.gyroSensitivity <= 0) {
      this.gyroSensitivity = 1.0;
    }

    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this._targetGyroYaw = 0;
    this._targetGyroPitch = 0;
    this.isCameraAimActive = false;

    this.qCalib = new THREE.Quaternion();
    this.qCalibInv = new THREE.Quaternion();
    this._tempQ = new THREE.Quaternion();
    this._tempEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._boundOnDeviceOrientation = this._onDeviceOrientation.bind(this);
    this._calibTimer = null;
    this._quickCalibTimer = null;

    // Virtual Joystick Look State
    this.joystickZone = null;
    this.joystickBase = null;
    this.joystickKnob = null;
    this.joystickTouchId = null;
    this.joystickOriginX = 0;
    this.joystickOriginY = 0;
    this.joystickVector = { x: 0, y: 0 }; // Normalized deflection: x in [-1, 1], y in [-1, 1]
    this.joystickMaxRadius = 45;          // Maximum knob travel radius in pixels
    this.joystickSensitivity = 1.0;
    this.baseYawSpeed = 2.4;              // Max yaw rotation speed (radians/sec) ~ 137 deg/s
    this.basePitchSpeed = 1.8;            // Max pitch rotation speed (radians/sec) ~ 103 deg/s
    this.isMouseJoystickActive = false;

    // Touch Swipe Look State (right screen)
    this.lookTouchId = null;
    this.lastTouchX = 0;
    this.lastTouchY = 0;
    this.lookSensitivity = 0.0035;

    // Action button states
    this._shooting = false;
    this._scoping = false;
    this._aiming = false;

    // Initialize subsystems
    this._setupJoystick();
    this._setupTouchLook();
    this._setupUIButtons();
    this._setupFullscreenButton();
    this._setupGyroButtons();
    this._setupSettingsModal();
    this._setupPhoneMode();

    // Re-calibrate gyro reference if orientation changes
    window.addEventListener('orientationchange', () => {
      if (this.gyroActive) {
        this.needsCalibration = true;
        this.hasGyroOrientation = false;
      }
    });
  }


  /* ==========================================================
     PHONE MODE
     ========================================================== */

  _setupPhoneMode() {
    window.addEventListener('phone-mode-enabled', () => {
      document.body.classList.add('phone-mode');
    });
  }


  /* ==========================================================
     VIRTUAL JOYSTICK (LOOK / AIM ONLY)
     ========================================================== */

  _setupJoystick() {
    this.joystickZone = document.getElementById('joystick-zone');
    this.joystickBase = document.getElementById('joystick-base');
    this.joystickKnob = document.getElementById('joystick-knob');

    if (!this.joystickZone || !this.joystickBase || !this.joystickKnob) {
      console.warn('[MOBILE] Joystick DOM elements not found.');
      return;
    }

    // Touch Start on Joystick Zone
    this.joystickZone.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      if (this.joystickTouchId !== null) return; // Already tracking a joystick touch

      for (const touch of e.changedTouches) {
        this.joystickTouchId = touch.identifier;

        // Position base centered on the touch point
        const rect = this.joystickZone.getBoundingClientRect();
        this.joystickOriginX = touch.clientX;
        this.joystickOriginY = touch.clientY;

        this.joystickBase.style.left = `${touch.clientX - rect.left}px`;
        this.joystickBase.style.top = `${touch.clientY - rect.top}px`;
        this.joystickBase.style.display = 'block';
        this.joystickKnob.style.transform = 'translate(0px, 0px)';

        this.joystickVector.x = 0;
        this.joystickVector.y = 0;

        e.preventDefault();
        e.stopPropagation();
        break;
      }
    }, { passive: false });

    // Touch Move on Window (handles thumb sliding beyond initial zone)
    window.addEventListener('touchmove', (e) => {
      if (!this.enabled || this.joystickTouchId === null) return;

      for (const touch of e.changedTouches) {
        if (touch.identifier !== this.joystickTouchId) continue;

        const dx = touch.clientX - this.joystickOriginX;
        const dy = touch.clientY - this.joystickOriginY;
        const dist = Math.hypot(dx, dy);

        let clampedX = dx;
        let clampedY = dy;
        if (dist > this.joystickMaxRadius && dist > 0) {
          clampedX = (dx / dist) * this.joystickMaxRadius;
          clampedY = (dy / dist) * this.joystickMaxRadius;
        }

        this.joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;

        // Normalized deflection vector (-1 to +1)
        this.joystickVector.x = clampedX / this.joystickMaxRadius;
        this.joystickVector.y = clampedY / this.joystickMaxRadius;

        e.preventDefault();
        break;
      }
    }, { passive: false });

    // Touch End / Cancel
    const endJoystick = (e) => {
      if (this.joystickTouchId === null) return;

      for (const touch of e.changedTouches) {
        if (touch.identifier === this.joystickTouchId) {
          this.joystickTouchId = null;
          this.joystickVector.x = 0;
          this.joystickVector.y = 0;
          this.joystickBase.style.display = 'none';
          this.joystickKnob.style.transform = 'translate(0px, 0px)';
          break;
        }
      }
    };

    window.addEventListener('touchend', endJoystick, { passive: false });
    window.addEventListener('touchcancel', endJoystick, { passive: false });

    // Mouse fallback on joystick zone for desktop emulation / browser testing
    this.joystickZone.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.isMouseJoystickActive = true;
      const rect = this.joystickZone.getBoundingClientRect();
      this.joystickOriginX = e.clientX;
      this.joystickOriginY = e.clientY;

      this.joystickBase.style.left = `${e.clientX - rect.left}px`;
      this.joystickBase.style.top = `${e.clientY - rect.top}px`;
      this.joystickBase.style.display = 'block';
      this.joystickKnob.style.transform = 'translate(0px, 0px)';
      this.joystickVector.x = 0;
      this.joystickVector.y = 0;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isMouseJoystickActive) return;

      const dx = e.clientX - this.joystickOriginX;
      const dy = e.clientY - this.joystickOriginY;
      const dist = Math.hypot(dx, dy);

      let clampedX = dx;
      let clampedY = dy;
      if (dist > this.joystickMaxRadius && dist > 0) {
        clampedX = (dx / dist) * this.joystickMaxRadius;
        clampedY = (dy / dist) * this.joystickMaxRadius;
      }

      this.joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
      this.joystickVector.x = clampedX / this.joystickMaxRadius;
      this.joystickVector.y = clampedY / this.joystickMaxRadius;
    });

    window.addEventListener('mouseup', () => {
      if (!this.isMouseJoystickActive) return;
      this.isMouseJoystickActive = false;
      this.joystickVector.x = 0;
      this.joystickVector.y = 0;
      this.joystickBase.style.display = 'none';
      this.joystickKnob.style.transform = 'translate(0px, 0px)';
    });
  }


  /* ==========================================================
     TOUCH SWIPE LOOK (RIGHT SCREEN)
     ========================================================== */

  _setupTouchLook() {
    window.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;

      for (const touch of e.changedTouches) {
        // Ignore touches on UI buttons, joystick, or inputs
        const target = document.elementFromPoint(touch.clientX, touch.clientY);
        if (
          target &&
          target.closest &&
          target.closest('button, input, select, textarea, .mobile-buttons-cluster, .mobile-top-bar, .mobile-settings-modal, #joystick-zone')
        ) {
          continue;
        }

        // Use the right 60% of the screen for touch swipe looking
        if (touch.clientX > window.innerWidth * 0.4) {
          this.lookTouchId = touch.identifier;
          this.lastTouchX = touch.clientX;
          this.lastTouchY = touch.clientY;
        }
      }
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!this.enabled || this.lookTouchId === null) return;

      for (const touch of e.changedTouches) {
        if (touch.identifier !== this.lookTouchId) continue;

        const dx = touch.clientX - this.lastTouchX;
        const dy = touch.clientY - this.lastTouchY;

        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;

        const lookFactor = (this._scoping ? 0.4 : (this._aiming ? 0.65 : 1.0));

        // Swipe right (dx > 0) -> camera looks right (yaw decreases)
        // Swipe left (dx < 0) -> camera looks left (yaw increases)
        this.baseYaw -= dx * this.lookSensitivity * lookFactor;

        // Swipe down (dy > 0) -> camera looks down (pitch decreases)
        // Swipe up (dy < 0) -> camera looks up (pitch increases)
        this.basePitch -= dy * this.lookSensitivity * lookFactor;

        // Clamp base pitch
        this.basePitch = Math.max(-1.45, Math.min(1.45, this.basePitch));

        e.preventDefault();
        break;
      }
    }, { passive: false });

    const endLook = (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.lookTouchId) {
          this.lookTouchId = null;
          break;
        }
      }
    };

    window.addEventListener('touchend', endLook, { passive: false });
    window.addEventListener('touchcancel', endLook, { passive: false });
  }


  /* ==========================================================
     ACTION BUTTONS SETUP (FIRE, SCOPE, AIM, RELOAD)
     ========================================================== */

  _setupUIButtons() {
    // Fire / Shoot Button
    const btnShoot = document.getElementById('btn-mobile-shoot');
    if (btnShoot) {
      const startFiring = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startShoot();
        if (navigator.vibrate) {
          try { navigator.vibrate(20); } catch (_) {}
        }
      };
      const stopFiring = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.stopShoot();
      };
      btnShoot.addEventListener('touchstart', startFiring, { passive: false });
      btnShoot.addEventListener('touchend', stopFiring, { passive: false });
      btnShoot.addEventListener('touchcancel', stopFiring, { passive: false });
      btnShoot.addEventListener('mousedown', startFiring);
      btnShoot.addEventListener('mouseup', stopFiring);
    }

    // Scope Button (Toggle)
    const btnScope = document.getElementById('btn-mobile-scope');
    if (btnScope) {
      const toggleScope = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._scoping) {
          this.stopScope();
          btnScope.classList.remove('active');
        } else {
          this.startScope();
          btnScope.classList.add('active');
        }
      };
      btnScope.addEventListener('touchstart', toggleScope, { passive: false });
      btnScope.addEventListener('click', toggleScope);
    }

    // Aim Button (Toggle Steady Aim)
    const btnAim = document.getElementById('btn-mobile-aim');
    if (btnAim) {
      const toggleAim = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._aiming = !this._aiming;
        btnAim.classList.toggle('active', this._aiming);
        if (typeof this.callbacks.onAim === 'function') {
          this.callbacks.onAim(this._aiming);
        }
      };
      btnAim.addEventListener('touchstart', toggleAim, { passive: false });
      btnAim.addEventListener('click', toggleAim);
    }

    // Reload Button
    const btnReload = document.getElementById('btn-mobile-reload');
    if (btnReload) {
      const doReload = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.reload();
      };
      btnReload.addEventListener('touchstart', doReload, { passive: false });
      btnReload.addEventListener('click', doReload);
    }

    // Camera Mode Toggle Button (3P / 1P View)
    const btnCamToggle = document.getElementById('btn-mobile-camera-toggle');
    if (btnCamToggle) {
      const handleToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof this.callbacks.onToggleCamera === 'function') {
          this.callbacks.onToggleCamera();
        }
      };
      btnCamToggle.addEventListener('touchstart', handleToggle, { passive: false });
      btnCamToggle.addEventListener('click', handleToggle);
    }
  }


  /* ==========================================================
     FULLSCREEN UI BUTTON & ORIENTATION
     ========================================================== */

  _setupFullscreenButton() {
    const btnFs = document.getElementById('btn-mobile-fullscreen');
    const labelFs = document.getElementById('mobile-fullscreen-label');

    const updateLabel = () => {
      const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );

      if (labelFs) {
        labelFs.textContent = isFs ? 'EXIT FULLSCREEN' : 'ENTER FULLSCREEN';
      }
      if (btnFs) {
        btnFs.classList.toggle('active', isFs);
      }

      // Re-trigger Three.js and viewport resize when fullscreen changes
      setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
      setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
    };

    document.addEventListener('fullscreenchange', updateLabel);
    document.addEventListener('webkitfullscreenchange', updateLabel);

    if (btnFs) {
      const handleToggle = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const isFs = !!(
          document.fullscreenElement ||
          document.webkitFullscreenElement ||
          document.mozFullScreenElement ||
          document.msFullscreenElement
        );

        if (!isFs) {
          await enterFullscreen();
          await lockLandscape();
        } else {
          await exitFullscreen();
          await unlockOrientation();
        }

        updateLabel();
      };

      btnFs.addEventListener('touchstart', handleToggle, { passive: false });
      btnFs.addEventListener('click', handleToggle);
    }
  }


  /* ==========================================================
     GYROSCOPE CONTROLS & LIFECYCLE
     ========================================================== */

  _setupGyroButtons() {
    const btnToggle = document.getElementById('btn-gyro-toggle');
    const btnCalib = document.getElementById('btn-gyro-calibrate');

    if (btnToggle) {
      const handleToggle = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.toggleGyro();
      };
      btnToggle.addEventListener('touchstart', handleToggle, { passive: false });
      btnToggle.addEventListener('click', handleToggle);
    }

    if (btnCalib) {
      const handleCalib = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.calibrateGyro();
      };
      btnCalib.addEventListener('touchstart', handleCalib, { passive: false });
      btnCalib.addEventListener('click', handleCalib);
    }
  }

  async toggleGyro() {
    if (this.gyroActive) {
      this.disableGyro();
    } else {
      const granted = await requestDeviceOrientationPermission();
      if (granted) {
        this.enableGyro();
      } else {
        console.warn('[GYRO] Sensor permission not granted.');
      }
    }
    this._updateGyroUI();
  }

  enableGyro() {
    this.gyroActive = true;

    // Snapshot current camera look as base so there is no sudden snap
    this.baseYaw = this.yaw;
    this.basePitch = this.pitch;
    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this._targetGyroYaw = 0;
    this._targetGyroPitch = 0;
    this.needsCalibration = true;
    this.hasGyroOrientation = false;

    // Attach single listener if not already active
    if (!this.gyroListenerActive) {
      window.addEventListener('deviceorientation', this._boundOnDeviceOrientation, { passive: true });
      this.gyroListenerActive = true;
    }

    this._updateGyroUI();
  }

  disableGyro() {
    this.gyroActive = false;

    // Preserve the current camera look
    this.baseYaw = this.yaw;
    this.basePitch = this.pitch;
    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this._targetGyroYaw = 0;
    this._targetGyroPitch = 0;

    // Remove listener when gyro is OFF
    if (this.gyroListenerActive) {
      window.removeEventListener('deviceorientation', this._boundOnDeviceOrientation);
      this.gyroListenerActive = false;
    }

    this._updateGyroUI();
  }

  calibrateGyro() {
    // Current total camera orientation becomes the neutral reference
    this.baseYaw = this.yaw;
    this.basePitch = this.pitch;
    this.gyroYaw = 0;
    this.gyroPitch = 0;
    this._targetGyroYaw = 0;
    this._targetGyroPitch = 0;
    this.needsCalibration = true;
    this.hasGyroOrientation = false;

    if (navigator.vibrate) {
      try { navigator.vibrate(15); } catch (_) {}
    }

    // Flash status on the calibration button inside settings modal
    const label = document.getElementById('gyro-calibrate-label');
    if (label) {
      label.textContent = '✓ GYRO CALIBRATED';
      if (this._calibTimer) clearTimeout(this._calibTimer);
      this._calibTimer = setTimeout(() => {
        label.textContent = 'CALIBRATE GYRO';
      }, 1200);
    }

    // Flash status on the quick calibration button in top bar
    const quickLabel = document.getElementById('gyro-calibrate-quick-label');
    if (quickLabel) {
      quickLabel.textContent = '✓ CALIBRATED';
      if (this._quickCalibTimer) clearTimeout(this._quickCalibTimer);
      this._quickCalibTimer = setTimeout(() => {
        quickLabel.textContent = '🎯 CALIBRATE';
      }, 1200);
    }
  }

  _updateGyroUI() {
    const btnToggle = document.getElementById('btn-gyro-toggle');
    const labelToggle = document.getElementById('gyro-toggle-label');
    const btnCalib = document.getElementById('btn-gyro-calibrate');
    const btnQuickCalib = document.getElementById('btn-gyro-calibrate-quick');

    if (labelToggle) {
      labelToggle.textContent = this.gyroActive ? 'GYRO AIM: ON' : 'GYRO AIM: OFF';
    }
    if (btnToggle) {
      btnToggle.classList.toggle('active', this.gyroActive);
    }
    if (btnCalib) {
      btnCalib.disabled = !this.gyroActive;
      btnCalib.style.opacity = this.gyroActive ? '1' : '0.55';
    }
    if (btnQuickCalib) {
      if (this.gyroActive) {
        btnQuickCalib.classList.remove('hidden');
      } else {
        btnQuickCalib.classList.add('hidden');
      }
    }
  }

  /* ==========================================================
     MOBILE SETTINGS MODAL & SLIDER
     ========================================================== */

  _setupSettingsModal() {
    const modal = document.getElementById('mobile-settings-modal');
    const btnOpen = document.getElementById('btn-mobile-settings');
    const btnClose = document.getElementById('btn-mobile-settings-close');
    const btnCloseX = document.getElementById('btn-mobile-settings-close-x');
    const sliderSens = document.getElementById('gyro-sens-slider');
    const labelSensVal = document.getElementById('gyro-sens-val');

    // Sync initial slider display
    const currentPercent = Math.round(this.gyroSensitivity * 100);
    if (sliderSens) {
      sliderSens.value = currentPercent;
    }
    if (labelSensVal) {
      labelSensVal.textContent = `${currentPercent}%`;
    }

    const openModal = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (modal) {
        modal.classList.remove('hidden');
      }
    };

    const closeModal = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (modal) {
        modal.classList.add('hidden');
      }
    };

    if (btnOpen) {
      btnOpen.addEventListener('touchstart', openModal, { passive: false });
      btnOpen.addEventListener('click', openModal);
    }

    if (btnClose) {
      btnClose.addEventListener('touchstart', closeModal, { passive: false });
      btnClose.addEventListener('click', closeModal);
    }

    if (btnCloseX) {
      btnCloseX.addEventListener('touchstart', closeModal, { passive: false });
      btnCloseX.addEventListener('click', closeModal);
    }

    // Dismiss when tapping outside the modal card
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(e);
      });
      modal.addEventListener('touchstart', (e) => {
        if (e.target === modal) closeModal(e);
      }, { passive: false });
    }

    // Sensitivity Slider
    if (sliderSens) {
      const onSensChange = (e) => {
        const val = parseInt(e.target.value, 10);
        if (Number.isFinite(val) && val > 0) {
          this.gyroSensitivity = val / 100;
          if (labelSensVal) {
            labelSensVal.textContent = `${val}%`;
          }
          try {
            localStorage.setItem('para_sf_gyro_sens', val.toString());
          } catch (_) {}
        }
      };
      sliderSens.addEventListener('input', onSensChange);
      sliderSens.addEventListener('change', onSensChange);
    }

    // Quick calibrate in top bar
    const btnQuickCalib = document.getElementById('btn-gyro-calibrate-quick');
    if (btnQuickCalib) {
      const handleQuickCalib = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.calibrateGyro();
      };
      btnQuickCalib.addEventListener('touchstart', handleQuickCalib, { passive: false });
      btnQuickCalib.addEventListener('click', handleQuickCalib);
    }
  }

  _onDeviceOrientation(event) {
    if (!this.gyroActive) return;
    if (event.beta == null || event.gamma == null) return;

    const alpha = Number(event.alpha || 0);
    const beta = Number(event.beta);
    const gamma = Number(event.gamma);
    const orient = getScreenOrientationAngle();

    // 3D camera coordinate quaternion accounting for landscape orientation
    const qCurrent = getDeviceQuaternion(alpha, beta, gamma, orient);

    // Initial capture or manual calibration reference
    if (!this.hasGyroOrientation || this.needsCalibration) {
      this.qCalib.copy(qCurrent);
      this.qCalibInv.copy(qCurrent).invert();
      this.hasGyroOrientation = true;
      this.needsCalibration = false;
      this.gyroYaw = 0;
      this.gyroPitch = 0;
      this._targetGyroYaw = 0;
      this._targetGyroPitch = 0;
      return;
    }

    // Relative rotation in local camera coordinate frame: qRel = qCalibInv * qCurrent
    const qRel = this._tempQ.copy(this.qCalibInv).multiply(qCurrent);
    this._tempEuler.setFromQuaternion(qRel, 'YXZ');

    // Scale by sensitivity and scope/aim fine-aim factor
    const lookMultiplier = (this._scoping ? 0.4 : (this._aiming ? 0.65 : 1.0));
    const effectiveSensitivity = this.gyroSensitivity * lookMultiplier;

    // Euler X = pitch (+ = tilt up, - = tilt down)
    // Euler Y = yaw   (+ = rotate left, - = rotate right)
    this._targetGyroPitch = this._tempEuler.x * effectiveSensitivity;
    this._targetGyroYaw = this._tempEuler.y * effectiveSensitivity;
  }


  /* ==========================================================
     UPDATE (CALLED EVERY FRAME)
     ========================================================== */

  update(dt, playerPosition) {
    if (!this.enabled) return { isMoving: false, delta: { x: 0, y: 0 } };

    if (!this.isCameraAimActive) {
      // 1. JOYSTICK CAMERA ROTATION (Updates base viewing direction)
      const lookMultiplier = (this._scoping ? 0.4 : (this._aiming ? 0.65 : 1.0));
      const yawRate = this.baseYawSpeed * this.joystickSensitivity * lookMultiplier;
      const pitchRate = this.basePitchSpeed * this.joystickSensitivity * lookMultiplier;

      if (this.joystickVector.x !== 0) {
        // Pushed LEFT  (x < 0) -> camera turns LEFT (yaw increases)
        // Pushed RIGHT (x > 0) -> camera turns RIGHT (yaw decreases)
        this.baseYaw -= this.joystickVector.x * yawRate * dt;
      }

      if (this.joystickVector.y !== 0) {
        // Pushed UP    (y < 0) -> camera looks UP (pitch increases)
        // Pushed DOWN  (y > 0) -> camera looks DOWN (pitch decreases)
        this.basePitch -= this.joystickVector.y * pitchRate * dt;
      }

      // 2. COMBINE BASE LOOK (JOYSTICK/SWIPE) + RELATIVE GYROSCOPE ORIENTATION
      if (this.gyroActive && this.hasGyroOrientation) {
        // Smooth filter to suppress micro-tremor while preserving responsive aiming
        this.gyroYaw += (this._targetGyroYaw - this.gyroYaw) * 0.35;
        this.gyroPitch += (this._targetGyroPitch - this.gyroPitch) * 0.35;

        this.yaw = this.baseYaw + this.gyroYaw;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.basePitch + this.gyroPitch));
      } else {
        this.yaw = this.baseYaw;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.basePitch));
      }

      // 3. APPLY ROTATION TO THREE.JS CAMERA (Euler order YXZ)
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    }

    // 4. FIXED PLAYER POSITION
    // IMPORTANT: Player NEVER translates in X or Z.
    // The player remains fixed at the shooting station stall.
    const pos =
      playerPosition ||
      (this.playerPosition && typeof this.playerPosition.copy === 'function'
        ? this.playerPosition
        : null);

    if (pos) {
      this.camera.position.copy(pos);

      if (
        typeof GAME_CONFIG !== 'undefined' &&
        GAME_CONFIG.PLAYER &&
        Number.isFinite(GAME_CONFIG.PLAYER.HEIGHT)
      ) {
        this.camera.position.y = GAME_CONFIG.PLAYER.HEIGHT;
      }
    }

    // Return zero movement translation (no WASD movement on mobile)
    return { isMoving: false, delta: { x: 0, y: 0 } };
  }


  /* ==========================================================
     SHOOTING ACTIONS
     ========================================================== */

  startShoot() {
    if (this._shooting) return;
    this._shooting = true;
    if (typeof this.callbacks.onShoot === 'function') {
      this.callbacks.onShoot();
    }
  }

  stopShoot() {
    this._shooting = false;
    if (typeof this.callbacks.onStopShoot === 'function') {
      this.callbacks.onStopShoot();
    }
  }


  /* ==========================================================
     SCOPING ACTIONS
     ========================================================== */

  startScope() {
    if (this._scoping) return;
    this._scoping = true;
    if (typeof this.callbacks.onScope === 'function') {
      this.callbacks.onScope(true);
    }
  }

  stopScope() {
    this._scoping = false;
    if (typeof this.callbacks.onScope === 'function') {
      this.callbacks.onScope(false);
    }
  }

  get isScoped() {
    return !!this._scoping;
  }



  /* ==========================================================
     RELOAD ACTION
     ========================================================== */

  reload() {
    if (typeof this.callbacks.onReload === 'function') {
      this.callbacks.onReload();
    }
  }


  /* ==========================================================
     VISIBILITY & ACTIVATION
     ========================================================== */

  async enable() {
    this.show();
    if (isMobileDevice()) {
      await autoInitMobile();
    }
    return true;
  }

  disable() {
    this.hide();
  }

  show() {
    this.enabled = true;
    document.body.classList.add('mobile-controls-visible');
    document.body.classList.add('phone-mode');

    const layer = document.getElementById('mobile-controls-layer');
    if (layer) {
      layer.style.display = 'block';
    }

    // Re-verify fullscreen button label
    const labelFs = document.getElementById('mobile-fullscreen-label');
    const btnFs = document.getElementById('btn-mobile-fullscreen');
    const isFs = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
    if (labelFs) {
      labelFs.textContent = isFs ? 'EXIT FULLSCREEN' : 'ENTER FULLSCREEN';
    }
    if (btnFs) {
      btnFs.classList.toggle('active', isFs);
    }

    this._updateGyroUI();

    // Trigger canvas & camera aspect resize to fill screen
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  }

  hide() {
    this.enabled = false;
    this.joystickVector = { x: 0, y: 0 };
    this.joystickTouchId = null;
    this.lookTouchId = null;

    if (this.joystickBase) {
      this.joystickBase.style.display = 'none';
    }

    this.disableGyro();

    // Dismiss settings modal if open
    const modal = document.getElementById('mobile-settings-modal');
    if (modal) {
      modal.classList.add('hidden');
    }

    document.body.classList.remove('mobile-controls-visible');

    const layer = document.getElementById('mobile-controls-layer');
    if (layer) {
      layer.style.display = 'none';
    }
  }

  dispose() {
    this.hide();
  }
}


/* ============================================================
   GLOBAL PHONE MODE ACTIVATION & RESIZE RESPONSIVENESS
   ============================================================ */

if (isMobileDevice()) {
  // Initial automatic sequence on startup
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      autoInitMobile();
    });
  } else {
    autoInitMobile();
  }
}

// Ensure Three.js renderer and camera aspect ratio are recalculated
// whenever orientation, fullscreen, or browser viewport changes.
window.addEventListener('orientationchange', () => {
  setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
});

if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.addEventListener === 'function') {
  screen.orientation.addEventListener('change', () => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  });
}