/**
 * PARA SF: FOREST ACCURACY - UI Manager
 * Handles screen transitions, tactical HUD overlays, copy actions, modals, and scoreboard
 */

import { soundEngine } from './audio.js';

export class UIManager {
  constructor() {
    this.screens = {
      deviceSelect: document.getElementById('screen-device-select'),
      mobileFullscreen: document.getElementById('screen-mobile-fullscreen'),
      loading: document.getElementById('screen-loading'),
      lobby: document.getElementById('screen-lobby'),
      room: document.getElementById('screen-room'),
      gameHud: document.getElementById('game-hud'),
      results: document.getElementById('screen-results')
    };

    this.modals = {
      howToPlay: document.getElementById('modal-how-to-play'),
      settings: document.getElementById('modal-settings'),
      joinDialog: document.getElementById('modal-join'),
      scoreHistory: document.getElementById('modal-score-history')
    };

    this.countdownOverlay = document.getElementById('countdown-overlay');
    this.countdownHeader = document.getElementById('countdown-header');
    this.countdownText = document.getElementById('countdown-text');
    this.countdownSub = document.getElementById('countdown-sub');
    this.countdownHideTimeout = null;
    this.hitmarkerEl = document.getElementById('hitmarker');
    this.scopeOverlay = document.getElementById('scope-overlay');
    this.steadyAimOverlay = document.getElementById('steady-aim-indicator');

    this.hitmarkerTimeout = null;
    this.initButtonsAudio();
  }

  initButtonsAudio() {
    // Add tactical click & hover audio to all interactive buttons
    document.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => soundEngine.playUIClick());
      btn.addEventListener('mouseenter', () => soundEngine.playUIHover());
    });
  }

  hideAllScreens() {
    Object.values(this.screens).forEach(screen => {
      if (screen) screen.classList.add('hidden');
    });
  }

  showScreen(screenName) {
    this.hideAllScreens();
    if (this.screens[screenName]) {
      this.screens[screenName].classList.remove('hidden');
    }
  }

  showDeviceSelect() {
    this.showScreen('deviceSelect');
  }

  showMobileFullscreen() {
    this.showScreen('mobileFullscreen');
  }

  showLoading(progress = 0, statusText = 'INITIALIZING MISSION') {
    this.showScreen('loading');
    this.updateLoadingProgress(progress, statusText);
  }

  updateLoadingProgress(progress, statusText) {
    const bar = document.getElementById('loading-bar-fill');
    const text = document.getElementById('loading-status-text');
    const percent = document.getElementById('loading-percent-text');

    if (bar) bar.style.width = `${progress}%`;
    if (text) text.textContent = statusText;
    if (percent) percent.textContent = `${Math.round(progress)}%`;
  }

  showLobby() {
    this.showScreen('lobby');
  }

  showRoomWaiting(roomCode, players = [], isHost = false) {
    this.showScreen('room');
    
    const codeEl = document.getElementById('room-code-display');
    if (codeEl) codeEl.textContent = roomCode;

    // Render player 1 & player 2 slots
    const p1Card = document.getElementById('p1-card');
    const p2Card = document.getElementById('p2-card');

    const p1 = players.find(p => p.slot === 1);
    const p2 = players.find(p => p.slot === 2);

    if (p1Card) {
      p1Card.innerHTML = `
        <div class="player-slot-badge">PLAYER 1 ${p1?.isHost ? '(HOST)' : ''}</div>
        <div class="player-name">${p1 ? p1.name : 'Waiting for Player...'}</div>
        <div class="player-device-tag">${p1 ? p1.device.toUpperCase() : ''}</div>
        <div class="player-status ${p1 ? 'status-ready' : 'status-waiting'}">
          ${p1 ? '● READY' : '○ WAITING'}
        </div>
      `;
    }

    if (p2Card) {
      p2Card.innerHTML = `
        <div class="player-slot-badge">PLAYER 2</div>
        <div class="player-name">${p2 ? p2.name : 'Waiting for Player...'}</div>
        <div class="player-device-tag">${p2 ? p2.device.toUpperCase() : ''}</div>
        <div class="player-status ${p2 ? 'status-ready' : 'status-waiting'}">
          ${p2 ? '● READY' : '○ WAITING FOR SECOND PLAYER...'}
        </div>
      `;
    }
  }

  showCountdown(count) {
    if (!this.countdownOverlay || !this.countdownText) return;

    this.countdownOverlay.classList.remove('hidden');

    const isBegin = (count === 'BEGIN!' || count === 'GO' || count === 0);
    this.countdownText.textContent = count;

    if (this.countdownHeader) {
      this.countdownHeader.textContent = isBegin ? 'MISSION COMMENCED' : 'GAME STARTS IN';
    }
    if (this.countdownSub) {
      this.countdownSub.textContent = isBegin ? 'ENGAGE ALL TARGETS' : 'GET READY FOR TARGET ENGAGEMENT';
    }

    if (isBegin) {
      this.countdownText.classList.add('is-begin');
    } else {
      this.countdownText.classList.remove('is-begin');
    }

    this.countdownText.classList.remove('pulse-anim');
    void this.countdownText.offsetWidth; // Trigger reflow
    this.countdownText.classList.add('pulse-anim');

    soundEngine.playCountdownBeep(isBegin);

    if (isBegin) {
      if (this.countdownHideTimeout) clearTimeout(this.countdownHideTimeout);
      this.countdownHideTimeout = setTimeout(() => {
        this.hideCountdown();
      }, 800);
    }
  }

  hideCountdown() {
    if (this.countdownHideTimeout) {
      clearTimeout(this.countdownHideTimeout);
      this.countdownHideTimeout = null;
    }
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.add('hidden');
    }
  }

  showGameHUD() {
    this.showScreen('gameHud');
    // Note: countdownOverlay visibility is controlled authoritatively by showCountdown/hideCountdown
  }

  updateHUD(timeFormatted, mySlot, allScores, ammo, reserveAmmo) {
    const timerEl = document.getElementById('hud-timer');
    if (timerEl) timerEl.textContent = timeFormatted;

    const p1ScoreEl = document.getElementById('hud-p1-score');
    const p2ScoreEl = document.getElementById('hud-p2-score');

    if (allScores) {
      if (p1ScoreEl && allScores[1]) p1ScoreEl.textContent = allScores[1].score;
      if (p2ScoreEl && allScores[2]) p2ScoreEl.textContent = allScores[2].score;
    }

    const ammoEl = document.getElementById('hud-ammo-count');
    if (ammoEl) ammoEl.textContent = `${ammo} / ${reserveAmmo}`;
  }

  updateTargetRound(state) {
    const status = document.getElementById('hud-round-status');
    if (!status || !state) return;
    if (state.movingTargets) {
      status.textContent = `MOVING TARGETS · ROUND ${String(state.round || 1).padStart(2, '0')}`;
      return;
    }
    const seconds = Math.max(0, Math.ceil((state.roundEndsAt - state.serverTime) / 1000));
    status.textContent = `ROUND ${String(state.round || 1).padStart(2, '0')} · ${seconds}S`;
  }

  showHitmarker(isHeadshot = false) {
    if (!this.hitmarkerEl) return;
    this.hitmarkerEl.className = 'hitmarker active' + (isHeadshot ? ' headshot' : '');
    soundEngine.playHitmarker(isHeadshot);

    if (this.hitmarkerTimeout) clearTimeout(this.hitmarkerTimeout);
    this.hitmarkerTimeout = setTimeout(() => {
      this.hitmarkerEl.className = 'hitmarker';
    }, 180);
  }

  setScopeVisual(isScoped) {
    if (this.scopeOverlay) {
      if (isScoped) {
        this.scopeOverlay.classList.remove('hidden');
      } else {
        this.scopeOverlay.classList.add('hidden');
      }
    }
  }

  showCameraMode(mode = 'FIRST PERSON') {
    const indicator = document.getElementById('camera-mode-indicator');
    if (!indicator) return;
    indicator.textContent = mode;
    indicator.classList.toggle('third-person', mode === 'THIRD PERSON');
  }

  setSteadyAimVisual(isAiming) {
    if (this.steadyAimOverlay) {
      if (isAiming) {
        this.steadyAimOverlay.classList.remove('hidden');
      } else {
        this.steadyAimOverlay.classList.add('hidden');
      }
    }
  }

  showReloading(isReloading) {
    const reloadBadge = document.getElementById('reloading-indicator');
    if (reloadBadge) {
      if (isReloading) {
        reloadBadge.classList.remove('hidden');
      } else {
        reloadBadge.classList.add('hidden');
      }
    }
  }

  showResults(summary) {
    this.showScreen('results');
    soundEngine.playMatchEnd(summary.winnerSlot !== null);

    const bannerEl = document.getElementById('results-banner');
    const winnerNameEl = document.getElementById('results-winner-text');

    if (summary.isSolo) {
      if (bannerEl) bannerEl.textContent = 'SOLO PRACTICE COMPLETE';
      if (winnerNameEl) winnerNameEl.textContent = `TARGETS ENGAGED · SCORE: ${summary.player1.score}`;
    } else if (summary.result === 'DRAW') {
      if (bannerEl) bannerEl.textContent = 'MATCH DRAW';
      if (winnerNameEl) winnerNameEl.textContent = 'EVEN ACCURACY BETWEEN PLAYERS';
    } else {
      if (bannerEl) bannerEl.textContent = 'MATCH COMPLETE';
      if (winnerNameEl) winnerNameEl.textContent = `WINNER: ${summary.winnerName.toUpperCase()}`;
    }

    // P1 Stats
    const p1 = summary.player1;
    document.getElementById('res-p1-name').textContent = p1.name;
    document.getElementById('res-p1-score').textContent = p1.score;
    document.getElementById('res-p1-shots').textContent = p1.totalShots;
    document.getElementById('res-p1-acc').textContent = `${p1.accuracy}%`;

    // P2 Stats
    const p2 = summary.player2;
    document.getElementById('res-p2-name').textContent = p2.name;
    document.getElementById('res-p2-score').textContent = p2.score;
    document.getElementById('res-p2-shots').textContent = p2.totalShots;
    document.getElementById('res-p2-acc').textContent = `${p2.accuracy}%`;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `tactical-toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 3200);
  }

  openModal(modalName) {
    if (this.modals[modalName]) {
      this.modals[modalName].classList.remove('hidden');
    }
  }

  closeModal(modalName) {
    if (this.modals[modalName]) {
      this.modals[modalName].classList.add('hidden');
    }
  }

  showScoreHistoryLoading() {
    const highestEl = document.getElementById('score-history-highest');
    const listEl = document.getElementById('score-history-list');
    if (highestEl) highestEl.textContent = '--';
    if (listEl) {
      listEl.innerHTML = '<div class="score-history-loading"><span class="pulse-dot"></span> RETRIEVING TACTICAL ARCHIVES...</div>';
    }
  }

  renderScoreHistory(data = {}) {
    const highestEl = document.getElementById('score-history-highest');
    const listEl = document.getElementById('score-history-list');

    const highestScore = (typeof data.highestScore === 'number') ? data.highestScore : 0;
    if (highestEl) {
      highestEl.textContent = String(highestScore);
    }

    if (!listEl) return;

    const scores = Array.isArray(data.scores) ? data.scores : [];
    if (scores.length === 0) {
      listEl.innerHTML = `
        <div class="score-history-empty">
          <div class="empty-icon">🎖️</div>
          <div class="empty-text">NO PREVIOUS SCORES RECORDED IN THE LAST 24 HOURS</div>
          <div class="empty-subtext">Complete a Solo Training or Multiplayer match to log scores.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = scores.map(item => {
      const formattedTime = this.formatScoreTime(item.timestamp);
      const isSolo = item.mode === 'solo' || item.mode === 'Solo Training';
      const modeLabel = isSolo ? 'Solo Training' : 'Multiplayer';
      const modeClass = isSolo ? 'badge-solo' : 'badge-multiplayer';
      return `
        <div class="score-history-row">
          <div class="score-history-score">${item.score}</div>
          <div class="score-history-mode ${modeClass}">${modeLabel}</div>
          <div class="score-history-time">${formattedTime}</div>
        </div>
      `;
    }).join('');
  }

  formatScoreTime(timestamp) {
    if (!timestamp) return '--';
    const date = new Date(timestamp);
    const now = new Date();
    const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

    const isToday = date.getDate() === now.getDate() &&
                    date.getMonth() === now.getMonth() &&
                    date.getFullYear() === now.getFullYear();

    if (isToday) {
      return timeStr;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = date.getDate() === yesterday.getDate() &&
                        date.getMonth() === yesterday.getMonth() &&
                        date.getFullYear() === yesterday.getFullYear();

    if (isYesterday) {
      return `Yesterday, ${timeStr}`;
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[date.getMonth()]} ${date.getDate()}, ${timeStr}`;
  }
}

export const ui = new UIManager();
