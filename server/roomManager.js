/**
 * PARA SF: FOREST ACCURACY - Room Manager
 * Manages 2-Player Tactical Multiplayer Rooms & Life Cycles
 */

const MatchManager = require('./matchManager');

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> room object
    this.playerRoomMap = new Map(); // socketId -> code
  }

  generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    let attempts = 0;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      attempts++;
    } while (this.rooms.has(code) && attempts < 100);
    return code;
  }

  createRoom(socket, playerData = {}) {
    // Leave previous room if any
    this.leaveCurrentRoom(socket);

    const roomCode = this.generateRoomCode();
    const resolvedPlayerId = (playerData && playerData.playerId && String(playerData.playerId).trim()) || socket.playerId || socket.id;
    socket.playerId = resolvedPlayerId;
    const player = {
      socketId: socket.id,
      playerId: resolvedPlayerId,
      slot: 1,
      name: playerData.name || 'Player 1',
      device: playerData.device || 'pc',
      isHost: true,
      ready: true
    };

    const room = {
      code: roomCode,
      createdAt: Date.now(),
      status: 'WAITING', // WAITING, READY, COUNTDOWN, PLAYING, ENDED
      players: {
        [socket.id]: player
      },
      match: null
    };

    this.rooms.set(roomCode, room);
    this.playerRoomMap.set(socket.id, roomCode);

    socket.join(roomCode);

    socket.emit('room_created', {
      roomCode,
      player,
      players: [player],
      status: room.status
    });

    return room;
  }

  createSoloPractice(socket, playerData = {}) {
    this.leaveCurrentRoom(socket);

    const roomCode = 'SOLO-' + this.generateRoomCode().slice(0, 4);
    const resolvedPlayerId = (playerData && playerData.playerId && String(playerData.playerId).trim()) || socket.playerId || socket.id;
    socket.playerId = resolvedPlayerId;
    const player = {
      socketId: socket.id,
      playerId: resolvedPlayerId,
      slot: 1,
      name: playerData.name || 'Solo Commando',
      device: playerData.device || 'pc',
      isHost: true,
      ready: true
    };

    const room = {
      code: roomCode,
      createdAt: Date.now(),
      status: 'READY',
      isSolo: true,
      players: {
        [socket.id]: player
      },
      match: null
    };

    this.rooms.set(roomCode, room);
    this.playerRoomMap.set(socket.id, roomCode);
    socket.join(roomCode);

    socket.emit('room_created', {
      roomCode,
      player,
      players: [player],
      status: room.status,
      isSolo: true
    });

    room.match = new MatchManager(room, this.io);
    setTimeout(() => {
      if (room && room.match) {
        room.match.startCountdown();
      }
    }, 600);

    return room;
  }

  joinRoom(socket, roomCode, playerData = {}) {
    if (!roomCode) {
      socket.emit('join_error', { message: 'Please enter a valid room code.' });
      return;
    }

    const cleanCode = roomCode.trim().toUpperCase();
    const room = this.rooms.get(cleanCode);

    if (!room) {
      socket.emit('join_error', { message: 'Room not found. Check code and try again.' });
      return;
    }

    const currentCount = Object.keys(room.players).length;
    if (currentCount >= 2) {
      socket.emit('join_error', { message: 'ROOM FULL. Match already has 2 players.' });
      return;
    }

    if (room.status === 'PLAYING') {
      socket.emit('join_error', { message: 'Match is already in progress.' });
      return;
    }

    this.leaveCurrentRoom(socket);

    const resolvedPlayerId = (playerData && playerData.playerId && String(playerData.playerId).trim()) || socket.playerId || socket.id;
    socket.playerId = resolvedPlayerId;
    const player = {
      socketId: socket.id,
      playerId: resolvedPlayerId,
      slot: 2,
      name: playerData.name || 'Player 2',
      device: playerData.device || 'mobile',
      isHost: false,
      ready: true
    };

    room.players[socket.id] = player;
    this.playerRoomMap.set(socket.id, cleanCode);
    socket.join(cleanCode);

    const playerList = Object.values(room.players);

    // Notify joining player
    socket.emit('room_joined', {
      roomCode: cleanCode,
      player,
      players: playerList,
      status: room.status
    });

    // Notify other player in room
    socket.to(cleanCode).emit('player_joined', {
      player,
      players: playerList
    });

    // Both players connected -> initialize match manager and start countdown
    if (playerList.length === 2) {
      room.status = 'READY';
      this.io.to(cleanCode).emit('both_players_ready', {
        players: playerList
      });

      // Initialize match manager
      room.match = new MatchManager(room, this.io);
      
      // Short dramatic pause then begin 3, 2, 1, GO countdown
      setTimeout(() => {
        if (room && room.status === 'READY' && Object.keys(room.players).length === 2) {
          room.match.startCountdown();
        }
      }, 1200);
    }
  }

  handleRematch(socket) {
    const roomCode = this.playerRoomMap.get(socket.id);
    if (!roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);

    const playerList = Object.values(room.players);
    this.io.to(roomCode).emit('rematch_voted', {
      voterSocketId: socket.id,
      votesCount: room.rematchVotes.size,
      totalNeeded: playerList.length
    });

    if (room.rematchVotes.size === playerList.length && playerList.length === 2) {
      // Both want rematch -> restart match
      room.rematchVotes.clear();
      if (room.match) {
        room.match.cleanup();
      }
      room.match = new MatchManager(room, this.io);
      room.status = 'READY';
      this.io.to(roomCode).emit('rematch_starting');
      setTimeout(() => {
        if (room.match) room.match.startCountdown();
      }, 1000);
    }
  }

  leaveCurrentRoom(socket) {
    const roomCode = this.playerRoomMap.get(socket.id);
    if (!roomCode) return;

    const room = this.rooms.get(roomCode);
    if (room) {
      const leavingPlayer = room.players[socket.id];
      delete room.players[socket.id];
      socket.leave(roomCode);

      if (room.match) {
        room.match.cleanup();
      }

      const remainingPlayers = Object.values(room.players);
      if (remainingPlayers.length === 0) {
        // Room empty - delete
        this.rooms.delete(roomCode);
      } else {
        // Notify remaining player
        this.io.to(roomCode).emit('player_disconnected', {
          disconnectedPlayer: leavingPlayer,
          message: `${leavingPlayer?.name || 'Player'} disconnected.`
        });
        room.status = 'WAITING';
      }
    }

    this.playerRoomMap.delete(socket.id);
  }

  getRoomBySocket(socketId) {
    const code = this.playerRoomMap.get(socketId);
    if (!code) return null;
    return this.rooms.get(code) || null;
  }
}

module.exports = RoomManager;
