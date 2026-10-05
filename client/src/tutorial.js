/**
 * PARA SF: FOREST ACCURACY - Interactive Tutorial System
 * User-paced, device-specific interactive tutorial with Speech Synthesis,
 * UI highlighting, real gameplay action verification, Face+Fist training,
 * and dynamic non-overlapping layout.
 */

export class TutorialSpeech {
  constructor() {
    this.synth = (typeof window !== 'undefined' && 'speechSynthesis' in window) ? window.speechSynthesis : null;
    this.voices = [];
    this.selectedVoice = null;
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.lastText = '';

    if (this.synth) {
      this.loadVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this.loadVoices();
      }
    }
  }

  loadVoices() {
    if (!this.synth) return;
    this.voices = this.synth.getVoices() || [];
    this.selectFemaleVoice();
  }

  selectFemaleVoice() {
    if (!this.voices || this.voices.length === 0) return;

    // Female name keywords per specification
    const femalePattern = /(female|woman|girl|samantha|victoria|karen|susan|ava|zira|aria|jenny|google.*female)/i;

    // 1. English female voices
    let found = this.voices.find(v => (v.lang && v.lang.startsWith('en')) && femalePattern.test(v.name));
    
    // 2. Any female voice
    if (!found) {
      found = this.voices.find(v => femalePattern.test(v.name));
    }

    // 3. Best natural English voice
    if (!found) {
      found = this.voices.find(v => v.lang && v.lang.startsWith('en'));
    }

    // 4. Fallback to first available voice
    if (!found) {
      found = this.voices[0] || null;
    }

    this.selectedVoice = found;
    if (this.selectedVoice) {
      console.log(`[TUTORIAL TTS] Selected voice: "${this.selectedVoice.name}" (${this.selectedVoice.lang})`);
    }
  }

  speak(text, onStart = null, onEnd = null) {
    if (!this.synth) {
      if (typeof onStart === 'function') onStart();
      if (typeof onEnd === 'function') setTimeout(onEnd, 1200);
      return;
    }

    this.stop();
    this.lastText = text;

    if (!this.selectedVoice) {
      this.loadVoices();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (this.selectedVoice) {
      utterance.voice = this.selectedVoice;
    }
    utterance.rate = 1.0;
    utterance.pitch = 1.1;
    utterance.volume = 1.0;

    this.currentUtterance = utterance;
    this.isSpeaking = true;

    utterance.onstart = () => {
      this.isSpeaking = true;
      if (typeof onStart === 'function') onStart();
    };

    const finish = () => {
      this.isSpeaking = false;
      this.currentUtterance = null;
      if (typeof onEnd === 'function') onEnd();
    };

    utterance.onend = finish;
    utterance.onerror = (e) => {
      console.warn('[TUTORIAL TTS] Utterance error or cancelled:', e);
      finish();
    };

    try {
      this.synth.speak(utterance);
    } catch (err) {
      console.warn('[TUTORIAL TTS] Speak failed:', err);
      finish();
    }
  }

  repeat(onStart = null, onEnd = null) {
    if (this.lastText) {
      this.speak(this.lastText, onStart, onEnd);
    }
  }

  stop() {
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch (_) {}
    }
    this.isSpeaking = false;
    this.currentUtterance = null;
  }
}

export class TutorialManager {
  constructor(app) {
    this.app = app;
    this.speech = new TutorialSpeech();
    this.isActive = false;
    this.deviceType = 'pc';
    this.steps = [];
    this.currentStepIndex = 0;
    this.currentStep = null;

    // Step state tracking
    this.speechDone = false;
    this.actionDone = false;
    this.isAdvancing = false;
    this.checkInterval = null;

    // Context tracking for detecting real gameplay deltas
    this.initialYaw = 0;
    this.initialPitch = 0;
    this.shotFiredThisStep = false;
    this.reloadStartedThisStep = false;
    this.faceMovementDetected = false;
    this.fistClenchDetected = false;
    this.fistReleaseDetected = false;

    // Bound DOM references
    this.dom = {
      overlay: null,
      panel: null,
      stepTag: null,
      title: null,
      explanation: null,
      actionText: null,
      statusBadge: null,
      btnRepeat: null,
      btnSkip: null,
      completeBox: null,
      btnLobby: null
    };

    this.initDOM();
  }

  initDOM() {
    this.dom.overlay = document.getElementById('tutorial-overlay');
    this.dom.panel = document.getElementById('tutorial-panel');
    this.dom.stepTag = document.getElementById('tutorial-step-tag');
    this.dom.title = document.getElementById('tutorial-title');
    this.dom.explanation = document.getElementById('tutorial-explanation');
    this.dom.actionText = document.getElementById('tutorial-action-text');
    this.dom.statusBadge = document.getElementById('tutorial-status-badge');
    this.dom.btnRepeat = document.getElementById('btn-tutorial-repeat');
    this.dom.btnSkip = document.getElementById('btn-tutorial-skip');
    this.dom.completeBox = document.getElementById('tutorial-complete-box');
    this.dom.btnLobby = document.getElementById('btn-tutorial-lobby');

    if (this.dom.btnRepeat) {
      this.dom.btnRepeat.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.speech.repeat(
          () => this.updateSpeechStatus(true),
          () => this.onSpeechFinished()
        );
      };
    }

    if (this.dom.btnSkip) {
      this.dom.btnSkip.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.skip();
      };
    }

    if (this.dom.btnLobby) {
      this.dom.btnLobby.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.finish();
      };
    }
  }

  buildDesktopSteps() {
    return [
      {
        id: 'look_pc',
        title: 'CAMERA / AIM',
        explanation: 'Move your mouse to look around and aim.',
        voiceText: 'Move your mouse to look around and aim.',
        actionPrompt: 'TRY IT — MOVE MOUSE TO LOOK AROUND',
        targetUI: '.hud-center-aim',
        preferredPos: 'top',
        init: (game) => {
          this.initialYaw = game.controls ? game.controls.yaw || 0 : 0;
          this.initialPitch = game.controls ? game.controls.pitch || 0 : 0;
        },
        check: (game) => {
          if (!game || !game.controls) return false;
          const deltaYaw = Math.abs((game.controls.yaw || 0) - this.initialYaw);
          const deltaPitch = Math.abs((game.controls.pitch || 0) - this.initialPitch);
          return (deltaYaw >= 0.12 || deltaPitch >= 0.08);
        }
      },
      {
        id: 'shoot_pc',
        title: 'SHOOT',
        explanation: 'Press the left mouse button to fire your weapon.',
        voiceText: 'Press the left mouse button to fire your weapon.',
        actionPrompt: 'TRY IT — PRESS LEFT MOUSE BUTTON',
        targetUI: '.hud-center-aim',
        preferredPos: 'top',
        init: () => {
          this.shotFiredThisStep = false;
        },
        check: () => {
          return this.shotFiredThisStep;
        }
      },
      {
        id: 'scope_pc',
        title: 'SCOPE',
        explanation: 'Hold the right mouse button to aim down sights.',
        voiceText: 'Hold the right mouse button to aim down sights.',
        actionPrompt: 'TRY IT — HOLD RIGHT MOUSE BUTTON',
        targetUI: '.hud-center-aim',
        preferredPos: 'bottom',
        check: (game) => {
          return !!(game && game.controls && game.controls.isScoped);
        }
      },
      {
        id: 'reload_pc',
        title: 'RELOAD',
        explanation: 'Press R to reload your weapon.',
        voiceText: 'Press R to reload your weapon.',
        actionPrompt: 'TRY IT — PRESS R TO RELOAD',
        targetUI: '.hud-bottom-right',
        preferredPos: 'top',
        init: () => {
          this.reloadStartedThisStep = false;
        },
        check: (game) => {
          return this.reloadStartedThisStep || !!(game && game.weapon && game.weapon.isReloading);
        }
      },
      {
        id: 'face_aim',
        title: 'FACE + FIST MODE',
        explanation: 'Face and Fist mode lets you control the camera using your face and shoot using your fist. Move your face left and right to control the camera horizontally. Move your face up and down to control vertical aim.',
        voiceText: 'Face and Fist mode lets you control the camera using your face and shoot using your fist. Move your face left and right to control the camera horizontally. Move your face up and down to control vertical aim.',
        actionPrompt: 'TRY IT — MOVE YOUR FACE TO AIM',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        onEnter: async (game) => {
          this.faceMovementDetected = false;
          if (game && game.cameraAim && !game.cameraAim.isActive) {
            await game.cameraAim.start();
          }
        },
        check: (game) => {
          if (!game || !game.cameraAim || !game.cameraAim.isActive) return false;
          const snap = game.cameraAim.latestSnapshot;
          if (snap && snap.hasFace && (Math.abs(snap.aimX) > 0.015 || Math.abs(snap.aimY) > 0.015)) {
            this.faceMovementDetected = true;
          }
          return this.faceMovementDetected;
        }
      },
      {
        id: 'fist_shoot',
        title: 'CLENCH YOUR FIST → SHOOT',
        explanation: 'Now clench your fist to shoot.',
        voiceText: 'Now clench your fist to shoot.',
        actionPrompt: 'TRY IT — CLENCH YOUR FIST TO SHOOT',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        init: () => {
          this.fistClenchDetected = false;
        },
        check: (game) => {
          if (!game || !game.cameraAim) return false;
          if (game.cameraAim.shootHeld && this.shotFiredThisStep) {
            this.fistClenchDetected = true;
          }
          return this.fistClenchDetected;
        }
      },
      {
        id: 'fist_release',
        title: 'OPEN YOUR FIST → STOP',
        explanation: 'Now open your fist to stop shooting.',
        voiceText: 'Now open your fist to stop shooting.',
        actionPrompt: 'TRY IT — OPEN YOUR FIST TO STOP',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        init: () => {
          this.fistReleaseDetected = false;
        },
        check: (game) => {
          if (!game || !game.cameraAim) return false;
          if (this.fistClenchDetected && !game.cameraAim.shootHeld) {
            this.fistReleaseDetected = true;
          }
          return this.fistReleaseDetected;
        },
        onExit: (game) => {
          if (game && game.cameraAim && game.cameraAim.isActive) {
            game.cameraAim.stop();
          }
        }
      }
    ];
  }

  buildMobileSteps() {
    return [
      {
        id: 'touch_look',
        title: 'TOUCH CAMERA',
        explanation: 'Drag the virtual joystick on the lower left or swipe on the right screen to look around.',
        voiceText: 'Move your finger on the screen or joystick to look around.',
        actionPrompt: 'TRY IT — DRAG THE JOYSTICK TO AIM',
        targetUI: '#joystick-zone',
        preferredPos: 'top',
        init: (game) => {
          this.initialYaw = game.controls ? game.controls.yaw || 0 : 0;
          this.initialPitch = game.controls ? game.controls.pitch || 0 : 0;
        },
        check: (game) => {
          if (!game || !game.controls) return false;
          const deltaYaw = Math.abs((game.controls.yaw || 0) - this.initialYaw);
          const deltaPitch = Math.abs((game.controls.pitch || 0) - this.initialPitch);
          return (deltaYaw >= 0.12 || deltaPitch >= 0.08);
        }
      },
      {
        id: 'shoot_mobile',
        title: 'SHOOT',
        explanation: 'Press the fire button on the bottom right to fire your weapon.',
        voiceText: 'Press the fire button to fire your weapon.',
        actionPrompt: 'TRY IT — TAP FIRE',
        targetUI: '#btn-mobile-shoot',
        preferredPos: 'top',
        init: () => {
          this.shotFiredThisStep = false;
        },
        check: () => {
          return this.shotFiredThisStep;
        }
      },
      {
        id: 'scope_mobile',
        title: 'SCOPE',
        explanation: 'Tap the Scope button to aim down sights.',
        voiceText: 'Tap the Scope button to aim down sights.',
        actionPrompt: 'TRY IT — TAP SCOPE',
        targetUI: '#btn-mobile-scope',
        preferredPos: 'top',
        check: (game) => {
          if (!game) return false;
          // Verify actual existing scope state:
          // 1. MobileControls internal scoping state or getter
          if (game.controls && (game.controls._scoping || game.controls.isScoped)) {
            return true;
          }
          // 2. Weapon ADS / scoped state in 3D game
          if (game.weapon && game.weapon.isScoped) {
            return true;
          }
          // 3. Active UI state on existing mobile scope button
          const btnScope = document.getElementById('btn-mobile-scope');
          if (btnScope && btnScope.classList.contains('active')) {
            return true;
          }
          return false;
        }
      },
      {
        id: 'reload_mobile',
        title: 'RELOAD',
        explanation: 'Press the reload button to reload ammunition into your rifle.',
        voiceText: 'Press the reload button to reload your weapon.',
        actionPrompt: 'TRY IT — TAP RELOAD',
        targetUI: '#btn-mobile-reload',
        preferredPos: 'top',
        init: () => {
          this.reloadStartedThisStep = false;
        },
        check: (game) => {
          return this.reloadStartedThisStep || !!(game && game.weapon && game.weapon.isReloading);
        }
      },
      {
        id: 'gyro_mobile',
        title: 'GYRO',
        explanation: 'Move your phone to aim the camera with gyroscope sensors.',
        voiceText: 'Move your phone to aim the camera with gyroscope sensors.',
        actionPrompt: 'TRY IT — TILT YOUR DEVICE',
        targetUI: '#btn-mobile-settings',
        preferredPos: 'top',
        onEnter: async (game) => {
          if (game && game.controls && typeof game.controls.enableGyro === 'function') {
            game.controls.enableGyro();
          }
          this.initialYaw = game.controls ? game.controls.yaw || 0 : 0;
        },
        check: (game) => {
          if (!game || !game.controls) return false;
          const delta = Math.abs((game.controls.yaw || 0) - this.initialYaw);
          return delta >= 0.08 || !!game.controls.hasGyroOrientation;
        },
        onExit: (game) => {
          if (game && game.controls && typeof game.controls.disableGyro === 'function') {
            game.controls.disableGyro();
          }
        }
      },
      {
        id: 'face_aim',
        title: 'FACE + FIST MODE',
        explanation: 'Face and Fist mode lets you control the camera using your face and shoot using your fist. Move your face left and right to control the camera horizontally. Move your face up and down to control vertical aim.',
        voiceText: 'Face and Fist mode lets you control the camera using your face and shoot using your fist. Move your face left and right to control the camera horizontally. Move your face up and down to control vertical aim.',
        actionPrompt: 'TRY IT — MOVE YOUR FACE TO AIM',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        onEnter: async (game) => {
          this.faceMovementDetected = false;
          if (game && game.cameraAim && !game.cameraAim.isActive) {
            await game.cameraAim.start();
          }
        },
        check: (game) => {
          if (!game || !game.cameraAim || !game.cameraAim.isActive) return false;
          const snap = game.cameraAim.latestSnapshot;
          if (snap && snap.hasFace && (Math.abs(snap.aimX) > 0.015 || Math.abs(snap.aimY) > 0.015)) {
            this.faceMovementDetected = true;
          }
          return this.faceMovementDetected;
        }
      },
      {
        id: 'fist_shoot',
        title: 'CLENCH YOUR FIST → SHOOT',
        explanation: 'Now clench your fist to shoot.',
        voiceText: 'Now clench your fist to shoot.',
        actionPrompt: 'TRY IT — CLENCH YOUR FIST TO SHOOT',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        init: () => {
          this.fistClenchDetected = false;
        },
        check: (game) => {
          if (!game || !game.cameraAim) return false;
          if (game.cameraAim.shootHeld && this.shotFiredThisStep) {
            this.fistClenchDetected = true;
          }
          return this.fistClenchDetected;
        }
      },
      {
        id: 'fist_release',
        title: 'OPEN YOUR FIST → STOP',
        explanation: 'Now open your fist to stop shooting.',
        voiceText: 'Now open your fist to stop shooting.',
        actionPrompt: 'TRY IT — OPEN YOUR FIST TO STOP',
        targetUI: '#camera-aim-widget',
        preferredPos: 'bottom',
        init: () => {
          this.fistReleaseDetected = false;
        },
        check: (game) => {
          if (!game || !game.cameraAim) return false;
          if (this.fistClenchDetected && !game.cameraAim.shootHeld) {
            this.fistReleaseDetected = true;
          }
          return this.fistReleaseDetected;
        },
        onExit: (game) => {
          if (game && game.cameraAim && game.cameraAim.isActive) {
            game.cameraAim.stop();
          }
        }
      }
    ];
  }

  start(deviceType = 'pc') {
    this.initDOM();
    this.deviceType = deviceType;
    this.isActive = true;
    this.currentStepIndex = 0;
    this.isAdvancing = false;

    this.steps = (deviceType === 'mobile')
      ? this.buildMobileSteps()
      : this.buildDesktopSteps();

    if (this.dom.overlay) {
      this.dom.overlay.classList.remove('hidden');
    }
    if (this.dom.completeBox) {
      this.dom.completeBox.classList.add('hidden');
    }
    if (this.dom.panel) {
      this.dom.panel.classList.remove('hidden');
    }

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.add('tutorial-active');
    }

    this.attachGameplayHooks();
    this.runStep(0);
    this.startCheckLoop();
  }

  attachGameplayHooks() {
    const game = this.app.currentGame;
    if (!game) return;

    // Observe real shoot actions
    const originalShoot = game.handleShoot.bind(game);
    game.handleShoot = () => {
      const res = originalShoot();
      this.shotFiredThisStep = true;
      return res;
    };

    // Observe real reload actions
    const originalReload = game.handleReload.bind(game);
    game.handleReload = () => {
      this.reloadStartedThisStep = true;
      return originalReload();
    };
  }

  async runStep(index) {
    if (!this.isActive) return;

    if (index >= this.steps.length) {
      this.showComplete();
      return;
    }

    this.currentStepIndex = index;
    const step = this.steps[index];
    this.currentStep = step;

    this.speechDone = false;
    this.actionDone = false;
    this.isAdvancing = false;

    // Run step enter handler if any
    if (typeof step.onEnter === 'function') {
      try {
        await step.onEnter(this.app.currentGame);
      } catch (err) {
        console.warn('[TUTORIAL] Step onEnter error:', err);
      }
    }

    if (typeof step.init === 'function') {
      step.init(this.app.currentGame);
    }

    // Update UI elements
    if (this.dom.stepTag) {
      this.dom.stepTag.textContent = `STEP ${index + 1} OF ${this.steps.length}`;
    }
    if (this.dom.title) {
      this.dom.title.textContent = step.title;
    }
    if (this.dom.explanation) {
      this.dom.explanation.textContent = step.explanation;
    }
    if (this.dom.actionText) {
      this.dom.actionText.textContent = step.actionPrompt;
    }
    if (this.dom.statusBadge) {
      this.dom.statusBadge.textContent = 'IN PROGRESS';
      this.dom.statusBadge.className = 'tutorial-badge badge-progress';
    }

    // Highlight target element & position panel away from target UI
    this.highlight(step.targetUI, step.preferredPos);

    // Speak female voice narration
    this.speech.speak(
      step.voiceText,
      () => this.updateSpeechStatus(true),
      () => this.onSpeechFinished()
    );
  }

  highlight(selector, preferredPos = 'top') {
    // Remove previous highlights
    document.querySelectorAll('.tutorial-highlight').forEach(el => {
      el.classList.remove('tutorial-highlight');
    });

    if (!selector) return;

    const target = document.querySelector(selector);
    if (!target) return;

    target.classList.add('tutorial-highlight');

    // Dynamic non-overlap positioning:
    // Inspect bounding rect of target UI and place tutorial panel so it never covers it
    this.positionPanel(target, preferredPos);
  }

  positionPanel(targetEl, preferredPos = 'top') {
    if (!this.dom.panel) return;

    const rect = targetEl ? targetEl.getBoundingClientRect() : null;
    const vh = window.innerHeight;

    // If target is in lower half of screen, panel goes to top
    if (rect && rect.top > vh * 0.45) {
      this.dom.panel.setAttribute('data-pos', 'top');
    } else if (rect && rect.bottom < vh * 0.55) {
      // If target is in upper half of screen, panel goes to bottom
      this.dom.panel.setAttribute('data-pos', 'bottom');
    } else {
      // Otherwise use step preference
      this.dom.panel.setAttribute('data-pos', preferredPos || 'top');
    }
  }

  updateSpeechStatus(speaking) {
    if (this.dom.btnRepeat) {
      this.dom.btnRepeat.classList.toggle('speaking', speaking);
    }
  }

  onSpeechFinished() {
    this.speechDone = true;
    this.updateSpeechStatus(false);

    // If action was already passed while voice was speaking, advance now!
    if (this.actionDone && !this.isAdvancing) {
      this.advanceToNextStep();
    }
  }

  startCheckLoop() {
    if (this.checkInterval) clearInterval(this.checkInterval);

    this.checkInterval = setInterval(() => {
      if (!this.isActive || !this.currentStep || this.actionDone) return;

      const passed = this.currentStep.check(this.app.currentGame);
      if (passed) {
        this.onActionSuccess();
      }
    }, 60);
  }

  onActionSuccess() {
    if (this.actionDone) return;
    this.actionDone = true;

    // Show immediate success feedback
    if (this.dom.statusBadge) {
      if (this.currentStep && (this.currentStep.id === 'scope_mobile' || this.currentStep.id === 'scope_pc')) {
        this.dom.statusBadge.textContent = '✓ SCOPE COMPLETE';
      } else {
        this.dom.statusBadge.textContent = '✓ FEATURE COMPLETE';
      }
      this.dom.statusBadge.className = 'tutorial-badge badge-complete';
    }

    // Clear target UI highlight
    document.querySelectorAll('.tutorial-highlight').forEach(el => {
      el.classList.remove('tutorial-highlight');
    });

    // For mobile scope step: immediately proceed without requiring speech to complete,
    // extra taps, releasing scope, or waiting for a timer.
    if (this.currentStep && this.currentStep.id === 'scope_mobile') {
      this.speech.stop();
      this.speechDone = true;
      if (!this.isAdvancing) {
        this.advanceToNextStep();
      }
      return;
    }

    // If speech has also finished, advance to next step smoothly
    if (this.speechDone && !this.isAdvancing) {
      this.advanceToNextStep();
    }
  }

  advanceToNextStep() {
    if (this.isAdvancing) return;
    this.isAdvancing = true;

    // Clean exit of current step
    if (this.currentStep && typeof this.currentStep.onExit === 'function') {
      try {
        this.currentStep.onExit(this.app.currentGame);
      } catch (err) {
        console.warn('[TUTORIAL] Step onExit error:', err);
      }
    }

    setTimeout(() => {
      this.runStep(this.currentStepIndex + 1);
    }, 600);
  }

  showComplete() {
    if (this.checkInterval) clearInterval(this.checkInterval);

    // Remove any remaining highlights
    document.querySelectorAll('.tutorial-highlight').forEach(el => {
      el.classList.remove('tutorial-highlight');
    });

    if (this.dom.panel) {
      this.dom.panel.classList.add('hidden');
    }

    if (this.dom.completeBox) {
      this.dom.completeBox.classList.remove('hidden');
    }

    this.speech.speak('Tutorial complete. You are ready to play.');
  }

  finish() {
    this.cleanup();
    // Return to the existing normal lobby
    this.app.onTutorialFinished();
  }

  skip() {
    this.cleanup();
    // Immediate return to existing normal lobby
    this.app.onTutorialFinished();
  }

  cleanup() {
    this.isActive = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.speech.stop();

    // Clean any step exit handler
    if (this.currentStep && typeof this.currentStep.onExit === 'function') {
      try {
        this.currentStep.onExit(this.app.currentGame);
      } catch (_) {}
    }

    document.querySelectorAll('.tutorial-highlight').forEach(el => {
      el.classList.remove('tutorial-highlight');
    });

    if (this.dom.overlay) {
      this.dom.overlay.classList.add('hidden');
    }

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('tutorial-active');
    }
  }
}
