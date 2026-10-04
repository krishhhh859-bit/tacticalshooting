/**
 * PARA SF: FOREST ACCURACY - PC Controls System
 * PointerLock FPS Controls: WASD, Mouse Look, LMB Shoot, RMB Scope, Q Aim, R Reload
 */

import * as THREE from '/lib/three/three.module.js';
import { GAME_CONFIG } from './config.js';

export class PCControls {
  constructor(camera, domElement, onShoot, onScope, onAim, onReload, onToggleCamera) {
    this.camera = camera;
    this.domElement = domElement || document.body;
    this.onShoot = onShoot;
    this.onScope = onScope;
    this.onAim = onAim;
    this.onReload = onReload;
    this.onToggleCamera = onToggleCamera;

    this.isLocked = false;
    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false
    };

    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.mouseDelta = { x: 0, y: 0 };

    // Read sensitivity from UI setting slider if already modified, else fallback to GAME_CONFIG
    const sensSlider = document.getElementById('setting-mouse-sens');
    const sensVal = sensSlider ? parseFloat(sensSlider.value) : NaN;
    this.sensitivity = (!isNaN(sensVal) && sensVal > 0) ? sensVal : GAME_CONFIG.PLAYER.MOUSE_SENSITIVITY;

    this.pitch = 0; // X rotation (vertical look)
    this.yaw = 0;   // Y rotation (horizontal look, 0 = forward -Z)

    this.isScoped = false;
    this.isAiming = false;
    this.isFiring = false;
    this.fireCooldown = 0;
    this.fireInterval = GAME_CONFIG.WEAPON.FIRE_RATE_MS / 1000;
    this.enabled = true;
    this.isCameraAimActive = false;

    // Bound listeners for clean removal on dispose()
    this.boundOnPointerLockChange = this.onPointerLockChange.bind(this);
    this.boundOnPointerLockError = this.onPointerLockError.bind(this);
    this.boundOnMouseMove = this.onMouseMove.bind(this);
    this.boundOnKeyDown = this.onKeyDown.bind(this);
    this.boundOnKeyUp = this.onKeyUp.bind(this);
    this.boundOnMouseDown = this.onMouseDown.bind(this);
    this.boundOnMouseUp = this.onMouseUp.bind(this);
    this.boundOnClick = this.onClick.bind(this);
    this.boundOnWindowMouseUp = this.onWindowMouseUp.bind(this);
    this.boundOnBlur = this.onBlur.bind(this);
    this.boundOnVisibilityChange = this.onVisibilityChange.bind(this);
    this.boundOnContextMenu = this.onContextMenu.bind(this);

    this.initEventListeners();
  }

  isUIElement(target) {
    if (!target || !(target instanceof Element)) return false;
    return !!target.closest(
      'button, input, select, textarea, a, label, ' +
      '.modal-overlay, .modal-card, .hud-top-bar, .hud-score-card, .hud-timer-container, ' +
      '#camera-aim-widget, .camera-aim-btn, .camera-aim-preview-box, ' +
      '.mobile-top-bar, .mobile-controls-container, .mobile-settings-modal, ' +
      '.screen:not(#game-hud), #screen-room, #screen-lobby, #screen-device-select, #screen-results, ' +
      '.toast-container, .hud-bottom-right, .ammo-panel'
    );
  }

  isGameplayElement(target) {
    if (!target || !(target instanceof Element)) return false;
    if (this.isUIElement(target)) return false;
    const canvasContainer = document.getElementById('game-canvas-container');
    const gameHud = document.getElementById('game-hud');
    return target === this.domElement ||
           target === this.domElement.parentElement ||
           target === canvasContainer ||
           target === gameHud ||
           (canvasContainer && canvasContainer.contains(target));
  }

  initEventListeners() {
    // 1. Pointer Lock state changes
    document.addEventListener('pointerlockchange', this.boundOnPointerLockChange);
    document.addEventListener('pointerlockerror', this.boundOnPointerLockError);

    // 2. Mouse look (active only when pointer lock is engaged)
    document.addEventListener('mousemove', this.boundOnMouseMove);

    // 3. Gameplay arena / canvas interaction (LMB shoot, RMB scope, click to acquire lock)
    // Attach directly to the 3D canvas and canvas container — NOT globally on window
    this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
    this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
    this.domElement.addEventListener('click', this.boundOnClick);
    this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);

    const parent = this.domElement.parentElement;
    if (parent && parent !== this.domElement && parent !== document.body) {
      parent.addEventListener('mousedown', this.boundOnMouseDown);
      parent.addEventListener('mouseup', this.boundOnMouseUp);
      parent.addEventListener('click', this.boundOnClick);
      parent.addEventListener('contextmenu', this.boundOnContextMenu);
    }

    // 4. Safety release listeners (stops firing if mouse is released anywhere or window loses focus)
    window.addEventListener('mouseup', this.boundOnWindowMouseUp);
    window.addEventListener('blur', this.boundOnBlur);
    document.addEventListener('visibilitychange', this.boundOnVisibilityChange);
    window.addEventListener('contextmenu', this.boundOnContextMenu);

    // 5. Keyboard bindings
    window.addEventListener('keydown', this.boundOnKeyDown);
    window.addEventListener('keyup', this.boundOnKeyUp);
  }

  removeEventListeners() {
    document.removeEventListener('pointerlockchange', this.boundOnPointerLockChange);
    document.removeEventListener('pointerlockerror', this.boundOnPointerLockError);
    document.removeEventListener('mousemove', this.boundOnMouseMove);

    if (this.domElement) {
      this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
      this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
      this.domElement.removeEventListener('click', this.boundOnClick);
      this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);

      const parent = this.domElement.parentElement;
      if (parent && parent !== this.domElement && parent !== document.body) {
        parent.removeEventListener('mousedown', this.boundOnMouseDown);
        parent.removeEventListener('mouseup', this.boundOnMouseUp);
        parent.removeEventListener('click', this.boundOnClick);
        parent.removeEventListener('contextmenu', this.boundOnContextMenu);
      }
    }

    window.removeEventListener('mouseup', this.boundOnWindowMouseUp);
    window.removeEventListener('blur', this.boundOnBlur);
    document.removeEventListener('visibilitychange', this.boundOnVisibilityChange);
    window.removeEventListener('contextmenu', this.boundOnContextMenu);

    window.removeEventListener('keydown', this.boundOnKeyDown);
    window.removeEventListener('keyup', this.boundOnKeyUp);
  }

  onPointerLockChange() {
    const lockEl = document.pointerLockElement;
    const canvasContainer = document.getElementById('game-canvas-container');
    const wasLocked = this.isLocked;

    this.isLocked = !!(lockEl && (
      lockEl === this.domElement ||
      lockEl === this.domElement?.parentElement ||
      lockEl === canvasContainer ||
      lockEl === document.body
    ));

    console.log('[CONTROLS] Pointer lock changed:', this.isLocked);

    if (!this.isLocked && wasLocked) {
      this.stopFiring();
      if (this.isScoped) {
        this.isScoped = false;
        if (this.onScope) this.onScope(false);
      }
    }
  }

  onPointerLockError(err) {
    console.warn('[CONTROLS] Pointer lock error:', err);
    this.isLocked = false;
    this.stopFiring();
  }

  onMouseMove(e) {
    if (!this.isLocked || !this.enabled || this.isCameraAimActive) return;
    const factor = (this.isScoped ? 0.4 : (this.isAiming ? 0.65 : 1.0));
    const movementX = e.movementX ?? e.mozMovementX ?? e.webkitMovementX ?? 0;
    const movementY = e.movementY ?? e.mozMovementY ?? e.webkitMovementY ?? 0;

    this.yaw -= movementX * this.sensitivity * factor;
    this.pitch -= movementY * this.sensitivity * factor;

    // Clamp vertical pitch (-85 to +85 deg: -1.45 to +1.45 rad)
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    this.mouseDelta.x = movementX;
    this.mouseDelta.y = movementY;
  }

  onMouseDown(e) {
    if (!this.enabled || this.isCameraAimActive) return;

    // Prevent duplicate handling if event bubbles from canvas to parent container
    if (e._pcHandled) return;
    e._pcHandled = true;

    // Ignore clicks on UI elements (buttons, HUD, modals, etc.)
    if (this.isUIElement(e.target)) return;

    // If pointer lock is NOT yet active:
    // User is clicking into the gameplay canvas to acquire lock.
    // IMPORTANT: Request pointer lock, but DO NOT fire a shot!
    if (!this.isLocked) {
      if (this.isGameplayElement(e.target) || e.target === this.domElement) {
        this.requestLock();
      }
      return;
    }

    // Pointer lock IS active: Process legitimate in-game controls
    if (e.button === 0) {
      // LMB: Weapon Shoot
      if (!this.isFiring) {
        console.log('[COMBAT DEBUG] player LMB DOWN');
        this.isFiring = true;
        this.fireCooldown = 0;
        this.tryFire();
      }
    } else if (e.button === 2) {
      // RMB: Scope
      console.log('[SCOPE DEBUG] scope activated from controls');
      this.isScoped = true;
      if (this.onScope) this.onScope(true);
    }
  }

  onMouseUp(e) {
    if (e.button === 0) {
      this.stopFiring();
    } else if (e.button === 2) {
      if (this.isScoped) {
        this.isScoped = false;
        if (this.onScope) this.onScope(false);
      }
    }
  }

  onClick(e) {
    if (!this.enabled || this.isCameraAimActive) return;
    if (e._pcClickHandled) return;
    e._pcClickHandled = true;

    if (this.isUIElement(e.target)) return;

    // Ensure pointer lock is requested on click if not already locked
    if (!this.isLocked) {
      this.requestLock();
    }
  }

  onWindowMouseUp(e) {
    if (e.button === 0) {
      this.stopFiring();
    }
  }

  onBlur() {
    this.stopFiring();
  }

  onVisibilityChange() {
    if (document.hidden) {
      this.stopFiring();
    }
  }

  onContextMenu(e) {
    // Only prevent default context menu on gameplay area or while locked
    if (this.isLocked || this.isGameplayElement(e.target)) {
      e.preventDefault();
    }
  }

  onKeyDown(e) {
    if (!this.enabled) return;
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.backward = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = true;
        break;
      case 'KeyR':
        if (this.onReload) this.onReload();
        break;
      case 'KeyQ':
        this.isAiming = !this.isAiming;
        if (this.onAim) this.onAim(this.isAiming);
        break;
      case 'KeyI':
        if (this.onToggleCamera) this.onToggleCamera();
        break;
    }
  }

  onKeyUp(e) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.backward = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = false;
        break;
    }
  }

  tryFire() {
    if (!this.isFiring || this.fireCooldown > 0) return;
    // Strict requirement: Only allow shooting when pointer lock is active
    if (!this.isLocked) {
      this.stopFiring();
      return;
    }
    if (!this.onShoot) {
      this.stopFiring();
      return;
    }

    console.log('[COMBAT DEBUG] player firing');
    if (this.onShoot() === false) {
      this.stopFiring();
      return;
    }
    this.fireCooldown = this.fireInterval;
  }

  stopFiring() {
    if (!this.isFiring) return;
    this.isFiring = false;
    console.log('[COMBAT DEBUG] player LMB UP');
  }

  requestLock() {
    if (!this.enabled || this.isCameraAimActive) return;
    const target = this.domElement || document.getElementById('game-canvas-container') || document.body;
    if (!target || !target.requestPointerLock) return;

    try {
      const p = target.requestPointerLock();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          console.debug('[CONTROLS] Pointer lock request rejected or deferred:', err?.message || err);
        });
      }
    } catch(e) {
      console.debug('[CONTROLS] requestPointerLock threw error:', e);
    }
  }

  unlock() {
    this.stopFiring();
    if (this.isScoped) {
      this.isScoped = false;
      if (this.onScope) this.onScope(false);
    }
    if (document.exitPointerLock && document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch(e) {}
    }
  }

  dispose() {
    this.enabled = false;
    this.unlock();
    this.removeEventListeners();
    this.domElement = null;
    this.camera = null;
    this.onShoot = null;
    this.onScope = null;
    this.onAim = null;
    this.onReload = null;
    this.onToggleCamera = null;
  }

  update(dt, playerPosition) {
    if (!this.enabled) return { isMoving: false, delta: { x: 0, y: 0 } };

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.isFiring && this.fireCooldown <= 0) this.tryFire();

    // Apply pitch & yaw to camera rotation (Order: YXZ) — look still works
    if (!this.isCameraAimActive) {
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = this.yaw;
      this.camera.rotation.x = this.pitch;
    }

    // MOVEMENT LOCKED: This is a fixed firing-position game.
    // WASD / arrow keys are intentionally ignored for translation.
    // playerPosition is always the designated firing position — never modified here.
    // The locked position is set by GameMatch and passed in each frame.
    playerPosition.y = GAME_CONFIG.PLAYER.HEIGHT;
    this.camera.position.copy(playerPosition);

    // Zero out any residual velocity so keys pressed have no effect if lock is bypassed.
    this.velocity.set(0, 0, 0);

    const currentMouseDelta = { ...this.mouseDelta };
    this.mouseDelta = { x: 0, y: 0 };

    return { isMoving: false, delta: currentMouseDelta };
  }
}
