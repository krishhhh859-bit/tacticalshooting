/**
 * PARA SF: FOREST ACCURACY - Main Entry Point
 * Orchestrates Device Selection, Asset Loading, Lobby, Match Life Cycle, and Scoreboards
 */

import * as THREE from '/lib/three/three.module.js';
window.THREE = THREE; // Ensure global availability

import { ui } from './ui.js';
import { net } from './networking.js';
import { soundEngine } from './audio.js';
import { AssetLoader } from './loading.js';
import { LobbyManager } from './lobby.js';
import { GameMatch } from './game.js';
import { enterFullscreen, lockLandscape } from './mobileControls.js';

class App {
  constructor() {
    this.selectedDevice = localStorage.getItem('para_sf_device') || null;
    this.playerName = localStorage.getItem('para_sf_player_name') || 'Commando';
    this.lobbyManager = null;
    this.currentGame = null;
    this.currentRoomCode = null;
    this.mySlot = 1;
    this.isHost = false;
    this.assetsReady = false;

    console.log('[GAME] PARA SF App initializing...');
    this.init();
  }

  init() {
    this.bindDOMEvents();

    if (this.selectedDevice) {
      if (this.selectedDevice === 'mobile') {
        document.body.classList.add('phone-mode');
      }
      this.proceedToLobby();
    } else {
      ui.showDeviceSelect();
    }
  }

  bindDOMEvents() {
    // 1. Device Selection Screen
    const btnPC = document.getElementById('btn-select-pc');
    const btnMobile = document.getElementById('btn-select-mobile');

    if (btnPC) {
      btnPC.addEventListener('click', () => {
        this.selectDevice('pc');
      });
    }

    if (btnMobile) {
      btnMobile.addEventListener('click', () => {
        this.selectDevice('mobile');
      });
    }

    // 1b. Mobile Dedicated Fullscreen Prompt Screen Button
    const btnEnterFsPrompt = document.getElementById('btn-enter-fullscreen-prompt');
    if (btnEnterFsPrompt) {
      const handleEnterFsPrompt = async (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }

        // Explicit user gesture: Attempt fullscreen and landscape orientation lock
        try {
          await enterFullscreen();
        } catch (err) {
          console.warn('[MOBILE] Fullscreen request rejected or unavailable:', err);
        }
        try {
          await lockLandscape();
        } catch (err) {
          console.warn('[MOBILE] Landscape orientation lock rejected or unavailable:', err);
        }

        document.body.classList.add('phone-mode');
        window.dispatchEvent(new Event('resize'));

        // Continue to the normal existing lobby page
        this.proceedToLobby();
      };

      btnEnterFsPrompt.addEventListener('click', handleEnterFsPrompt);
      btnEnterFsPrompt.addEventListener('touchstart', handleEnterFsPrompt, { passive: false });
    }

    // 2. Lobby Action Buttons
    const btnSolo = document.getElementById('btn-solo-practice');
    const btnCreate = document.getElementById('btn-create-match');
    const btnJoinModal = document.getElementById('btn-join-modal-open');
    const btnHowToPlay = document.getElementById('btn-how-to-play');
    const btnSettings = document.getElementById('btn-settings');

    if (btnSolo) {
      btnSolo.addEventListener('click', () => {
        console.log('[GAME] Starting Solo Practice Range...');
        this.startSoloPractice();
      });
    }

    if (btnCreate) {
      btnCreate.addEventListener('click', () => {
        this.createRoom();
      });
    }

    if (btnJoinModal) {
      btnJoinModal.addEventListener('click', () => {
        ui.openModal('joinDialog');
      });
    }

    if (btnHowToPlay) {
      btnHowToPlay.addEventListener('click', () => {
        this.updateHowToPlayContent();
        ui.openModal('howToPlay');
      });
    }

    if (btnSettings) {
      btnSettings.addEventListener('click', () => {
        ui.openModal('settings');
      });
    }

    // Modal Close Buttons
    document.querySelectorAll('.modal-close-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modal = e.target.closest('.modal-overlay');
        if (modal) modal.classList.add('hidden');
      });
    });

    // Join Match Confirmation inside Modal
    const btnConfirmJoin = document.getElementById('btn-confirm-join');
    const inputRoomCode = document.getElementById('input-room-code');

    if (btnConfirmJoin && inputRoomCode) {
      btnConfirmJoin.addEventListener('click', () => {
        const code = inputRoomCode.value.trim().toUpperCase();
        if (code) {
          ui.closeModal('joinDialog');
          this.joinRoom(code);
        } else {
          ui.showToast('Please enter a 6-character room code', 'warning');
        }
      });

      inputRoomCode.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          btnConfirmJoin.click();
        }
      });
    }

    // 3. Room Waiting Screen Action Buttons
    const btnCopyCode = document.getElementById('btn-copy-code');
    const btnCopyInvite = document.getElementById('btn-copy-invite');
    const btnLeaveRoom = document.getElementById('btn-leave-room');

    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', () => {
        if (this.currentRoomCode) {
          navigator.clipboard.writeText(this.currentRoomCode);
          ui.showToast(`Room code copied: ${this.currentRoomCode}`, 'success');
        }
      });
    }

    if (btnCopyInvite) {
      btnCopyInvite.addEventListener('click', () => {
        if (this.currentRoomCode) {
          const url = `${window.location.origin}${window.location.pathname}?room=${this.currentRoomCode}`;
          navigator.clipboard.writeText(url);
          ui.showToast('Invite link copied to clipboard!', 'success');
        }
      });
    }

    if (btnLeaveRoom) {
      btnLeaveRoom.addEventListener('click', () => {
        net.leaveRoom();
        this.returnToLobby();
      });
    }

    // 4. Results Screen Action Buttons
    const btnPlayAgain = document.getElementById('btn-play-again');
    const btnResultLobby = document.getElementById('btn-result-lobby');

    if (btnPlayAgain) {
      btnPlayAgain.addEventListener('click', () => {
        net.requestRematch();
        btnPlayAgain.disabled = true;
        btnPlayAgain.textContent = 'WAITING FOR OPPONENT...';
      });
    }

    if (btnResultLobby) {
      btnResultLobby.addEventListener('click', () => {
        this.returnToLobby();
      });
    }

    // 5. Settings Screen Inputs
    const volumeSlider = document.getElementById('setting-volume');
    const mouseSensSlider = document.getElementById('setting-mouse-sens');
    const btnChangeDevice = document.getElementById('btn-change-device');

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        soundEngine.setVolume(parseFloat(e.target.value));
      });
    }

    if (mouseSensSlider) {
      mouseSensSlider.addEventListener('input', (e) => {
        const sens = parseFloat(e.target.value);
        if (this.currentGame && this.currentGame.controls) {
          this.currentGame.controls.sensitivity = sens;
        }
      });
    }

    if (btnChangeDevice) {
      btnChangeDevice.addEventListener('click', () => {
        ui.closeModal('settings');
        localStorage.removeItem('para_sf_device');
        this.selectedDevice = null;
        if (this.lobbyManager) this.lobbyManager.stop();
        if (this.currentGame) this.currentGame.stop();
        ui.showDeviceSelect();
      });
    }

    // Check for auto-join URL param (?room=CODE)
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam && inputRoomCode) {
      inputRoomCode.value = roomParam.toUpperCase();
    }

    // 6. Network Event Listeners for Match Coordination
    this.setupAppNetworkListeners();
  }

  selectDevice(deviceType) {
    this.selectedDevice = deviceType;
    localStorage.setItem('para_sf_device', deviceType);
    if (deviceType === 'mobile') {
      ui.showMobileFullscreen();
    } else {
      document.body.classList.remove('phone-mode');
      this.proceedToLobby();
    }
  }

  proceedToLobby() {
    if (this.assetsReady) {
      this.openLobby();
    } else {
      this.startLoadingScreen();
    }
  }

  startLoadingScreen() {
    ui.showLoading(0, 'INITIALIZING MISSION');
    soundEngine.init();

    const loader = new AssetLoader(
      (progress, statusText) => {
        ui.updateLoadingProgress(progress, statusText);
      },
      () => {
        this.onAssetsLoaded();
      }
    );

    loader.loadAll();
  }

  onAssetsLoaded() {
    this.assetsReady = true;
    console.log('[GAME] Assets ready. Opening lobby...');
    this.openLobby();
  }

  openLobby() {
    console.log('[GAME] Opening lobby...');
    ui.showLobby();
    if (!this.lobbyManager) {
      this.lobbyManager = new LobbyManager('character-viewer-container');
    }
    this.lobbyManager.start();

    // Auto-join if room param in URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      this.joinRoom(roomParam.toUpperCase());
    }
  }

  startSoloPractice() {
    net.createSoloPractice({
      name: 'Solo Commando',
      device: this.selectedDevice
    });
  }

  createRoom() {
    net.createRoom({
      name: `Commando ${Math.floor(100 + Math.random() * 900)}`,
      device: this.selectedDevice
    });
  }

  joinRoom(code) {
    net.joinRoom(code, {
      name: `Operator ${Math.floor(100 + Math.random() * 900)}`,
      device: this.selectedDevice
    });
  }

  setupAppNetworkListeners() {
    net.on('room_created', (data) => {
      this.currentRoomCode = data.roomCode;
      this.mySlot = data.player.slot;
      this.isHost = true;
      if (!data.isSolo) {
        ui.showRoomWaiting(data.roomCode, data.players, true);
      }
    });

    net.on('room_joined', (data) => {
      this.currentRoomCode = data.roomCode;
      this.mySlot = data.player.slot;
      this.isHost = false;
      ui.showRoomWaiting(data.roomCode, data.players, false);
    });

    net.on('join_error', (data) => {
      ui.showToast(data.message || 'Error joining room', 'error');
    });

    net.on('player_joined', (data) => {
      ui.showRoomWaiting(this.currentRoomCode, data.players, this.isHost);
      ui.showToast('Player 2 connected! Preparing match...', 'success');
    });

    net.on('both_players_ready', (data) => {
      ui.showRoomWaiting(this.currentRoomCode, data.players, this.isHost);
    });

    net.on('countdown_started', (data) => {
      if (this.lobbyManager) this.lobbyManager.stop();
      if (!this.currentGame || !this.currentGame.isActive) {
        this.startActiveMatch();
      }
      ui.showCountdown(data.seconds);
    });

    net.on('countdown_tick', (data) => {
      ui.showCountdown(data.count);
    });

    net.on('match_started', (data) => {
      console.log('[GAME] match_started event received from server.');
      if (!this.currentGame || !this.currentGame.isActive) {
        this.startActiveMatch();
      }
      if (this.currentGame) {
        this.currentGame.handleRoundStart(data);
      }
    });

    net.on('match_ended', (summary) => {
      console.log('[GAME] match_ended event received. Showing results.');
      ui.hideCountdown();
      if (this.currentGame) {
        this.currentGame.stop();
      }
      ui.showResults(summary);
    });

    net.on('rematch_voted', (data) => {
      ui.showToast(`Rematch vote recorded (${data.votesCount}/${data.totalNeeded})`, 'info');
    });

    net.on('rematch_starting', () => {
      const btnPlayAgain = document.getElementById('btn-play-again');
      if (btnPlayAgain) {
        btnPlayAgain.disabled = false;
        btnPlayAgain.textContent = 'PLAY AGAIN';
      }
      ui.showToast('Rematch accepted! Starting match...', 'success');
    });

    net.on('player_disconnected', (data) => {
      ui.hideCountdown();
      ui.showToast(data.message || 'Opponent disconnected.', 'warning');
      if (this.currentGame && this.currentGame.isActive) {
        this.currentGame.stop();
        ui.showToast('Match aborted: Opponent left room.', 'warning');
        setTimeout(() => this.returnToLobby(), 2500);
      }
    });
  }

  startActiveMatch() {
    if (this.currentGame && this.currentGame.isActive) {
      return;
    }
    ui.showGameHUD();

    const canvasContainer = document.getElementById('game-canvas-container');
    this.currentGame = new GameMatch(canvasContainer, this.selectedDevice, this.mySlot);
    this.currentGame.init();
    this.currentGame.start();

    // PC: immediately request pointer lock so mouse aim works without any
    // extra click gate. The browser allows this since it follows a user gesture
    // (the lobby button click that triggered startActiveMatch).
    if (this.selectedDevice === 'pc' && this.currentGame.controls && this.currentGame.controls.requestLock) {
      this.currentGame.controls.requestLock();
    }
  }

  returnToLobby() {
    ui.hideCountdown();
    if (this.currentGame) {
      this.currentGame.stop();
      this.currentGame = null;
    }
    const canvasContainer = document.getElementById('game-canvas-container');
    if (canvasContainer) canvasContainer.innerHTML = '';

    const btnPlayAgain = document.getElementById('btn-play-again');
    if (btnPlayAgain) {
      btnPlayAgain.disabled = false;
      btnPlayAgain.textContent = 'PLAY AGAIN';
    }

    ui.showLobby();
    if (this.lobbyManager) {
      this.lobbyManager.start();
    }
  }

  updateHowToPlayContent() {
    const pcGuide = document.getElementById('how-to-play-pc');
    const mobileGuide = document.getElementById('how-to-play-mobile');
    if (pcGuide && mobileGuide) {
      if (this.selectedDevice === 'mobile') {
        pcGuide.style.display = 'none';
        mobileGuide.style.display = 'block';
      } else {
        pcGuide.style.display = 'block';
        mobileGuide.style.display = 'none';
      }
    }
  }
}

// Instantiate on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
