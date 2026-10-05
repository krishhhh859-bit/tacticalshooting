/**
 * PARA SF: FOREST ACCURACY - Networking Client (Socket.IO)
 */

class NetworkClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.listeners = new Map();
    this.roomCode = null;
    this.mySlot = 1;
    this.isHost = false;
    this.isSolo = false;
  }

  getPlayerId() {
    if (typeof localStorage === 'undefined') return 'guest_' + Math.random().toString(36).slice(2, 8);
    let pid = localStorage.getItem('para_sf_player_id');
    if (!pid || typeof pid !== 'string' || !pid.trim()) {
      pid = 'commando_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try {
        localStorage.setItem('para_sf_player_id', pid);
      } catch (_) {}
    }
    return pid;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        // Use global io from socket.io.js
        if (typeof window.io === 'undefined') {
          console.warn('Socket.IO library not loaded yet');
          reject(new Error('Socket.IO not loaded'));
          return;
        }

        const playerId = this.getPlayerId();
        this.socket = window.io({
          auth: { playerId },
          query: { playerId },
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000
        });

        this.socket.on('connect', () => {
          console.log('[NET] Connected to server, ID:', this.socket.id, 'PlayerID:', playerId);
          this.connected = true;
          resolve(this.socket);
        });

        this.socket.on('connect_error', (err) => {
          console.warn('[NET] Connection error:', err);
          // Don't reject if already resolved
        });

        this.socket.on('disconnect', (reason) => {
          console.log('[NET] Disconnected:', reason);
          this.connected = false;
          this.emitInternal('disconnect', reason);
        });

        // Register core event relays
        const events = [
          'room_created', 'room_joined', 'join_error', 'player_joined',
          'both_players_ready', 'countdown_started', 'countdown_tick',
          'match_started', 'timer_update', 'range_targets_update', 'range_target_hit', 'player_fired_effect',
          'ammo_update', 'reload_started', 'reload_completed', 'hit_confirmed',
          'score_update', 'opponent_move', 'opponent_reloading',
          'match_ended', 'rematch_voted', 'rematch_starting', 'player_disconnected',
          'left_room_success',
          'score_history_data'
        ];

        events.forEach(evt => {
          this.socket.on(evt, (data) => {
            this.emitInternal(evt, data);
          });
        });

      } catch (e) {
        reject(e);
      }
    });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const arr = this.listeners.get(event);
    const idx = arr.indexOf(callback);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emitInternal(event, data) {
    if (event === 'room_created') {
      this.isSolo = !!data?.isSolo;
      this.roomCode = data?.roomCode || null;
    }
    if (event === 'match_started') {
      this.isSolo = !!this.isSolo || !!data?.isSolo;
    }
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error(`Error in network listener for "${event}":`, e);
        }
      });
    }
  }

  // --- Outgoing Requests ---
  createRoom(playerData = {}) {
    if (!this.socket) return;
    this.socket.emit('create_room', { playerId: this.getPlayerId(), ...playerData });
  }

  createSoloPractice(playerData = {}) {
    if (!this.socket) return;
    this.socket.emit('create_solo_practice', { playerId: this.getPlayerId(), ...playerData });
  }

  joinRoom(roomCode, playerData = {}) {
    if (!this.socket) return;
    this.socket.emit('join_room', { roomCode, playerId: this.getPlayerId(), ...playerData });
  }

  getScoreHistory(callback = null) {
    const pid = this.getPlayerId();
    const handleData = (data) => {
      this.emitInternal('score_history_data', data);
      if (typeof callback === 'function') callback(data);
    };

    if (!this.socket || !this.connected) {
      this.connect().then(() => {
        if (this.socket) {
          this.socket.emit('get_score_history', { playerId: pid }, (ack) => {
            if (ack) handleData(ack);
          });
        }
      }).catch(err => {
        console.warn('[NET] Could not connect to fetch score history:', err);
        handleData({ highestScore: 0, scores: [] });
      });
      return;
    }
    this.socket.emit('get_score_history', { playerId: pid }, (ack) => {
      if (ack) handleData(ack);
    });
  }

  finishSoloTraining() {
    if (!this.socket) return;
    this.socket.emit('finish_solo_training');
  }

  sendMove(position, rotation) {
    if (!this.socket) return;
    this.socket.emit('player_move', { position, rotation });
  }

  sendShoot(origin, direction, targetId = null) {
    if (!this.socket) return;
    this.socket.emit('player_shoot', { origin, direction, targetId });
  }

  sendReload() {
    if (!this.socket) return;
    this.socket.emit('player_reload');
  }

  requestRematch() {
    if (!this.socket) return;
    this.socket.emit('request_rematch');
  }

  leaveRoom() {
    if (!this.socket) return;
    this.socket.emit('leave_room');
  }
}

export const net = new NetworkClient();
