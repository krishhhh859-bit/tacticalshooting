/**
 * PARA SF: FOREST ACCURACY - Main Game Controller
 * Orchestrates 3D Forest Scene, First-Person Weapon, Moving Target, Networking & Controls
 */

import * as THREE from '/lib/three/three.module.js';
import { GAME_CONFIG } from './config.js';
import { ForestEnvironment } from './environment.js';
import { WeaponSystem } from './weapon.js';
import { TargetBoardSystem } from './targetBoards.js';
import { CommandoModel } from './playerModel.js';
import { PCControls } from './controls.js';
import { MobileControls } from './mobileControls.js';
import { soundEngine } from './audio.js';
import { net } from './networking.js';
import { ui } from './ui.js';
import { CameraAimController } from './cameraAim.js';

export class GameMatch {
  constructor(canvasContainer, deviceType = 'pc', mySlot = 1) {
    this.container = canvasContainer;
    this.deviceType = deviceType;
    this.mySlot = mySlot;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.clock = new THREE.Clock();

    this.environment = null;
    this.weapon = null;
    this.targetManager = null;
    this.opponentModel = null;
    this.playerModel = null;
    this.controls = null;
    this.cameraAim = null;
    this.tracers = [];

    this.playerPosition = new THREE.Vector3(mySlot === 1 ? -4 : 4, GAME_CONFIG.PLAYER.HEIGHT, 0);
    // Locked firing position — player never moves from this point.
    this.firingPosition = this.playerPosition.clone();
    this.opponentPosition = new THREE.Vector3(mySlot === 1 ? 4 : -4, 0, 0);
    this.opponentTargetPos = this.opponentPosition.clone();
    this.opponentTargetRotY = 0;
    this.isSoloPractice = !!net.isSolo;

    this.isActive = false;
    this.isThirdPerson = (this.deviceType === 'mobile');
    this.thirdPersonCameraModes = {
      normal: { back: 5.0, height: 2.2, shoulder: 0.65 },
      aim: { back: 5.2, height: 2.0, shoulder: 0.85 },
      scope: { back: 2.8, height: 1.55, shoulder: 1.7 }
    };
    this.thirdPersonScopeRaycaster = new THREE.Raycaster();
    this.thirdPersonScopeHiddenMeshes = new Map();
    this.pendingThirdPersonScopeDebug = false;
    this.magazine = GAME_CONFIG.WEAPON.MAGAZINE_SIZE;
    this.reserveAmmo = GAME_CONFIG.WEAPON.TOTAL_RESERVE;
    this.scores = { 1: { score: 0 }, 2: { score: 0 } };
    this.timeFormatted = '04:00';
    this.isRoundActive = false;
    this.netHandlers = [];

    this.lastNetSendTime = 0;
  }

  init() {
    console.log('[GAME] Initializing 3D Game Match...');
    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(GAME_CONFIG.GRAPHICS.SKY_COLOR);

    this.camera = new THREE.PerspectiveCamera(
      GAME_CONFIG.WEAPON.NORMAL_FOV,
      width / height,
      0.05,
      300
    );
    this.camera.position.copy(this.playerPosition);
    this.scene.add(this.camera);

    // 2. WebGL Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    // 3. Build 3D Forest Environment
    this.environment = new ForestEnvironment(this.scene);
    this.environment.build();
    console.log('[GAME] 3D Forest Environment built.');

    // 4. Build First-Person TAR-21 Weapon
    this.weapon = new WeaponSystem(this.camera);
    console.log('[GAME] First-Person Weapon initialized.');

    // 5. Build synchronized physical range targets.
    this.targetManager = new TargetBoardSystem(this.scene);

    // 6. Build Local & Remote Commando Characters
    this.playerModel = new CommandoModel(false);
    this.playerModel.group.position.set(this.playerPosition.x, 0, this.playerPosition.z);
    this.playerModel.group.visible = this.isThirdPerson;
    this.scene.add(this.playerModel.group);

    this.opponentModel = new CommandoModel(true);
    this.opponentModel.group.position.copy(this.opponentPosition);
    this.scene.add(this.opponentModel.group);

    // 7. Setup Controls based on selected device
    if (this.deviceType === 'mobile') {
      this.controls = new MobileControls(
        this.camera,
        () => this.handleShoot(),
        (scoped) => this.handleScope(scoped),
        (aiming) => this.handleAim(aiming),
        () => this.handleReload(),
        () => this.toggleCameraMode()
      );
      this.controls.show();
    } else {
      this.controls = new PCControls(
        this.camera,
        this.renderer.domElement,
        () => this.handleShoot(),
        (scoped) => this.handleScope(scoped),
        (aiming) => this.handleAim(aiming),
        () => this.handleReload(),
        () => this.toggleCameraMode()
      );
    }

    if (this.isThirdPerson) {
      if (this.weapon && this.weapon.viewmodel) {
        this.weapon.viewmodel.visible = false;
      }
      this.updateThirdPersonCamera(0);
      ui.showCameraMode('THIRD PERSON');
    } else {
      ui.showCameraMode('FIRST PERSON');
    }

    const labelCamToggle = document.getElementById('mobile-camera-toggle-label');
    if (labelCamToggle) {
      labelCamToggle.textContent = this.isThirdPerson ? '📷 VIEW: 3P' : '📷 VIEW: 1P';
    }

    // 8. Setup Optional Camera / Finger-Gun Aim Controller
    this.cameraAim = new CameraAimController(
      this.camera,
      () => this.controls,
      () => this.handleShoot()
    );

    // 9. Register Network Listeners
    this.setupNetworkHandlers();

    // 10. Window resize handler
    window.addEventListener('resize', () => this.handleResize());
    console.log('[GAME] Match initialization complete.');
  }

  registerNet(event, fn) {
    net.on(event, fn);
    this.netHandlers.push({ event, fn });
  }

  handleRoundStart(data) {
    console.log('[GAME] Match round officially started! Targets and firing enabled.');
    this.isRoundActive = true;
    this.isSoloPractice = !!net.isSolo;
    if (data?.targetRound && this.targetManager) {
      this.targetManager.setState(data.targetRound);
      ui.updateTargetRound(data.targetRound);
    }
  }

  setupNetworkHandlers() {
    this.registerNet('timer_update', (data) => {
      this.timeFormatted = data.formattedTime;
      ui.updateHUD(this.timeFormatted, this.mySlot, this.scores, this.magazine, this.reserveAmmo);
    });

    this.registerNet('room_created', (data) => {
      this.isSoloPractice = !!data?.isSolo;
    });

    this.registerNet('match_started', (data) => {
      this.handleRoundStart(data);
    });

    this.registerNet('range_targets_update', (data) => {
      if (!this.targetManager) return;
      this.targetManager.setState(data);
      ui.updateTargetRound(data);
    });

    this.registerNet('hit_confirmed', (data) => {
      console.log(`[TARGET] Hit Confirmed by Server: +${data.points}`);
      ui.showHitmarker(data.isHeadshot);
    });

    this.registerNet('score_update', (data) => {
      if (data.allScores) {
        this.scores = data.allScores;
        console.log(`[SCORE] Score updated:`, this.scores);
        ui.updateHUD(this.timeFormatted, this.mySlot, this.scores, this.magazine, this.reserveAmmo);
      }
    });

    this.registerNet('range_target_hit', (data) => {
      if (this.targetManager) this.targetManager.markHit(data.targetId);
      if (data.slot === this.mySlot) ui.showHitmarker(false);
    });

    this.registerNet('ammo_update', (data) => {
      this.magazine = data.magazine;
      this.reserveAmmo = data.reserveAmmo;
      ui.updateHUD(this.timeFormatted, this.mySlot, this.scores, this.magazine, this.reserveAmmo);
    });

    this.registerNet('reload_started', (data) => {
      const duration = (data && data.duration) ? data.duration : (soundEngine.getReloadDuration() * 1000 || GAME_CONFIG.WEAPON.RELOAD_TIME_MS);
      if (this.weapon) {
        this.weapon.reloadDuration = duration;
        this.weapon.startReload();
      }
      ui.showReloading(true);
      soundEngine.playReload();
    });

    this.registerNet('reload_completed', (data) => {
      if (this.weapon) this.weapon.finishReload();
      ui.showReloading(false);
      soundEngine.stopReload();
      this.magazine = data.magazine;
      this.reserveAmmo = data.reserveAmmo;
      ui.updateHUD(this.timeFormatted, this.mySlot, this.scores, this.magazine, this.reserveAmmo);
    });

    this.registerNet('weapon_dry_fire', () => {
      soundEngine.playDryFire();
    });

    this.registerNet('player_fired_effect', (data) => {
      soundEngine.playGunshot();
    });

    this.registerNet('opponent_move', (data) => {
      if (this.opponentModel && data.position) {
        this.opponentTargetPos.set(data.position.x, 0, data.position.z);
        if (data.rotation) {
          this.opponentTargetRotY = data.rotation.y || 0;
        }
      }
    });
  }

  toggleCameraMode() {
    if (!this.camera || !this.controls) return;

    this.isThirdPerson = !this.isThirdPerson;
    if (this.weapon) this.weapon.viewmodel.visible = !this.isThirdPerson;
    if (this.playerModel) this.playerModel.group.visible = this.isThirdPerson;
    if (!this.isThirdPerson) this.restoreThirdPersonScopeObstructions();

    const labelCamToggle = document.getElementById('mobile-camera-toggle-label');

    if (this.isThirdPerson) {
      this.updateThirdPersonCamera(0);
      console.log('[3P DEBUG] third person active');
      console.log('[3P DEBUG] third person camera position:', this.camera.position.toArray());
      console.log('[3P DEBUG] player position:', this.playerPosition.toArray());
      console.log('[3P DEBUG] player visible:', this.playerModel ? this.playerModel.group.visible : false);
      console.log('[3P DEBUG] weapon visible:', this.weapon ? this.weapon.viewmodel.visible : false);
      ui.showCameraMode('THIRD PERSON');
      if (labelCamToggle) labelCamToggle.textContent = '📷 VIEW: 3P';
    } else {
      ui.showCameraMode('FIRST PERSON');
      if (labelCamToggle) labelCamToggle.textContent = '📷 VIEW: 1P';
    }
  }

  updateThirdPersonCamera(dt) {
    if (!this.camera || !this.playerModel) return;

    const yaw = this.controls ? this.controls.yaw || 0 : 0;
    const pitch = this.controls ? this.controls.pitch || 0 : 0;
    const cosPitch = Math.cos(pitch);
    const aimDirection = new THREE.Vector3(
      -Math.sin(yaw) * cosPitch,
      Math.sin(pitch),
      -Math.cos(yaw) * cosPitch
    ).normalize();
    const cameraRight = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const mode = this.weapon && this.weapon.isScoped
      ? 'scope'
      : (this.controls && this.controls.isAiming ? 'aim' : 'normal');
    const basePose = this.thirdPersonCameraModes[mode];

    // Responsive camera framing: In narrow portrait viewports, pull back slightly and adjust shoulder
    // so the commando character remains nicely framed and visible without clipping the view.
    const isPortrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth;
    const shoulderOffset = isPortrait ? basePose.shoulder * 0.72 : basePose.shoulder;
    const backOffset = isPortrait ? Math.max(basePose.back, 5.8) : basePose.back;
    const heightOffset = isPortrait ? basePose.height + 0.12 : basePose.height;

    const groundOrigin = this.playerPosition.clone();
    groundOrigin.y = 0;

    this.camera.position.copy(groundOrigin)
      .addScaledVector(cameraRight, shoulderOffset)
      .add(new THREE.Vector3(0, heightOffset, 0))
      .addScaledVector(aimDirection, -backOffset);
    const scopeTarget = this.camera.position.clone().addScaledVector(aimDirection, 100);
    this.camera.lookAt(scopeTarget);
    this.camera.updateMatrixWorld(true);

    let playerObstructionDetected = false;
    if (mode === 'scope' && this.playerModel.group.visible) {
      this.restoreThirdPersonScopeObstructions();
      this.playerModel.group.updateMatrixWorld(true);
      this.thirdPersonScopeRaycaster.set(this.camera.position, aimDirection);
      this.thirdPersonScopeRaycaster.near = 0.1;
      this.thirdPersonScopeRaycaster.far = 100;
      const obstructionHits = this.thirdPersonScopeRaycaster.intersectObject(this.playerModel.group, true);
      for (const hit of obstructionHits) {
        if (!hit.object.isMesh || this.thirdPersonScopeHiddenMeshes.has(hit.object)) continue;
        playerObstructionDetected = true;
        this.thirdPersonScopeHiddenMeshes.set(hit.object, hit.object.visible);
        hit.object.visible = false;
      }
    } else {
      this.restoreThirdPersonScopeObstructions();
    }

    if (this.pendingThirdPersonScopeDebug) {
      const cameraAimDirection = this.camera.getWorldDirection(new THREE.Vector3()).normalize();
      console.log('[3P SCOPE DEBUG] third-person scope active');
      console.log('[3P SCOPE DEBUG] scope camera position:', this.camera.position.toArray());
      console.log('[3P SCOPE DEBUG] scope camera target:', scopeTarget.toArray());
      console.log('[3P SCOPE DEBUG] weapon aim direction:', aimDirection.toArray());
      console.log('[3P SCOPE DEBUG] camera aim direction:', cameraAimDirection.toArray());
      console.log('[3P SCOPE DEBUG] player obstruction detected:', playerObstructionDetected);
      console.log('[3P SCOPE DEBUG] aim alignment dot:', aimDirection.dot(cameraAimDirection));
      this.pendingThirdPersonScopeDebug = false;
    }
  }

  restoreThirdPersonScopeObstructions() {
    for (const [mesh, wasVisible] of this.thirdPersonScopeHiddenMeshes) {
      mesh.visible = wasVisible;
    }
    this.thirdPersonScopeHiddenMeshes.clear();
  }

  start() {
    this.isActive = true;
    this.isRoundActive = false;
    this.clock.start();
    soundEngine.startForestAmbience();
    console.log('[GAME] Animation loop started.');
    this.animate();
  }

  stop() {
    this.isActive = false;
    this.isRoundActive = false;
    soundEngine.stopForestAmbience();
    soundEngine.stopReload();
    if (this.controls && this.controls.unlock) {
      this.controls.unlock();
    }
    if (this.controls && this.controls.dispose) {
      this.controls.dispose();
    }
    if (this.cameraAim) {
      this.cameraAim.stop();
    }
    if (this.targetManager) this.targetManager.dispose();
    if (this.netHandlers) {
      this.netHandlers.forEach(({ event, fn }) => net.off(event, fn));
      this.netHandlers = [];
    }
  }

  handleShoot() {
    if (!this.isActive || !this.isRoundActive || (this.weapon && this.weapon.isReloading)) return false;

    if (this.magazine <= 0) {
      soundEngine.playDryFire();
      return false;
    }

    // 1. Trigger weapon visual recoil & muzzle flash
    this.weapon.fireVisual();

    // 2. Play gunshot sound locally
    soundEngine.playGunshot();

    // 3. Raycast forward from camera center
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);

    const origin = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z
    };

    const dirObj = {
      x: direction.x,
      y: direction.y,
      z: direction.z
    };

    // 4. Create visual bullet tracer line
    this.spawnBulletTracer(this.camera.position, direction);
    const targetId = this.targetManager
      ? this.targetManager.findHitTarget(this.camera.position, direction, this.environment)
      : null;

    // 5. Send authoritative shot request to server
    net.sendShoot(origin, dirObj, targetId);

    // 6. Client optimistic ammo decrement
    this.magazine = Math.max(0, this.magazine - 1);
    ui.updateHUD(this.timeFormatted, this.mySlot, this.scores, this.magazine, this.reserveAmmo);
    return true;
  }

  spawnBulletTracer(startPos, dir) {
    const tracerMat = new THREE.LineBasicMaterial({ color: 0xffeb3b, linewidth: 2 });
    const points = [];
    const gunMuzzlePos = startPos.clone().add(dir.clone().multiplyScalar(0.6));
    points.push(gunMuzzlePos);
    points.push(gunMuzzlePos.clone().add(dir.clone().multiplyScalar(60)));

    const tracerGeo = new THREE.BufferGeometry().setFromPoints(points);
    const tracerLine = new THREE.Line(tracerGeo, tracerMat);
    this.scene.add(tracerLine);

    this.tracers.push({
      line: tracerLine,
      life: 0.08
    });
  }

  handleScope(isScoped) {
    console.log('[SCOPE DEBUG] scope activated', isScoped);
    console.log('[SCOPE DEBUG] camera mode =', this.isThirdPerson ? 'THIRD_PERSON' : 'FIRST_PERSON');
    if (this.camera) {
      console.log('[SCOPE DEBUG] camera position', this.camera.position.toArray());
      console.log('[SCOPE DEBUG] camera FOV', this.camera.fov);
      this.camera.near = isScoped && !this.isThirdPerson ? 0.03 : 0.05;
      this.camera.updateProjectionMatrix();
    }
    if (this.weapon) {
      console.log('[SCOPE DEBUG] weapon position', this.weapon.viewmodel.position.toArray());
      if (this.weapon.scopeOccluder) {
        console.log('[SCOPE DEBUG] scope position', this.weapon.scopeOccluder.position.toArray());
        console.log('[SCOPE DEBUG] scope scale', this.weapon.scopeOccluder.scale.toArray());
      }
    }
    this.weapon && this.weapon.setScope(isScoped);
    ui.setSteadyAimVisual(!!(this.controls && this.controls.isAiming && !isScoped));
    if (this.isThirdPerson && isScoped) {
      this.pendingThirdPersonScopeDebug = true;
    }
    if (!isScoped) this.restoreThirdPersonScopeObstructions();
    ui.setScopeVisual(isScoped);
  }

  handleAim(isAiming) {
    if (this.weapon) this.weapon.setAim(isAiming);
    ui.setSteadyAimVisual(isAiming && !(this.weapon && this.weapon.isScoped));
  }

  handleReload() {
    if (!this.isActive || !this.isRoundActive) return;
    if (this.magazine >= GAME_CONFIG.WEAPON.MAGAZINE_SIZE || this.reserveAmmo <= 0) return;
    if (this.weapon && this.weapon.isReloading) return;
    if (this.controls && this.controls.stopFiring) this.controls.stopFiring();
    net.sendReload();
  }

  animate() {
    if (!this.isActive) return;
    requestAnimationFrame(() => this.animate());

    const dt = Math.min(this.clock.getDelta(), 0.1);

    // 1. Update Controls & Player Position
    let ctrlResult = { isMoving: false, delta: { x: 0, y: 0 } };
    if (this.controls) {
      ctrlResult = this.controls.update(dt, this.playerPosition);
    }

    // 1b. Update Camera Aim (Runs lightweight smoothing & continuous fire in the game loop)
    if (this.cameraAim && this.cameraAim.isActive) {
      this.cameraAim.update(dt);
    }
    // Belt-and-suspenders: always clamp position back to the designated firing spot.
    this.playerPosition.x = this.firingPosition.x;
    this.playerPosition.z = this.firingPosition.z;
    this.playerPosition.y = GAME_CONFIG.PLAYER.HEIGHT;
    if (this.camera && !this.isThirdPerson) {
      this.camera.position.copy(this.playerPosition);
    }

    // 2. Update visible local player avatar and camera mode
    if (this.playerModel) {
      const avatarPos = new THREE.Vector3(this.playerPosition.x, 0, this.playerPosition.z);
      this.playerModel.group.position.copy(avatarPos);
      this.playerModel.group.visible = this.isThirdPerson;
      this.playerModel.group.rotation.y = this.controls ? this.controls.yaw || 0 : 0;
      this.playerModel.update(dt, ctrlResult.isMoving, this.controls ? this.controls.yaw || 0 : 0);
    }

    if (this.isThirdPerson) {
      this.updateThirdPersonCamera(dt);
    }

    // 3. Update First-Person Weapon viewmodel
    if (this.weapon) {
      this.weapon.update(dt, ctrlResult.delta, ctrlResult.isMoving);
      this.weapon.viewmodel.visible = !this.isThirdPerson;
    }

    // 4. Animate server-synchronized physical target boards.
    if (this.targetManager) this.targetManager.update(dt);

    // 5. Update Remote Opponent Character
    if (this.opponentModel) {
      this.opponentPosition.lerp(this.opponentTargetPos, dt * 10);
      this.opponentModel.group.position.copy(this.opponentPosition);
      this.opponentModel.group.rotation.y = this.opponentTargetRotY;
      const oppIsMoving = this.opponentPosition.distanceTo(this.opponentTargetPos) > 0.05;
      this.opponentModel.update(dt, oppIsMoving);
    }

    // 6. Update Bullet Tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= dt;
      if (tr.life <= 0) {
        this.scene.remove(tr.line);
        if (tr.line.geometry) tr.line.geometry.dispose();
        if (tr.line.material) tr.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }

    // 7. Send Network Position Update (throttled to 20Hz)
    const now = performance.now();
    if (now - this.lastNetSendTime > 50) {
      this.lastNetSendTime = now;
      net.sendMove(
        { x: this.playerPosition.x, y: this.playerPosition.y, z: this.playerPosition.z },
        { x: this.camera.rotation.x, y: this.camera.rotation.y }
      );
    }

    // 8. Render Scene
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  handleResize() {
    if (!this.camera || !this.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
