/**
 * PARA SF: FOREST ACCURACY - Main Server
 * Express + Socket.IO Server
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const config = require('./config');
const RoomManager = require('./roomManager');
const scoreStore = require('./scoreStore');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000
});

const roomManager = new RoomManager(io);
const DEFAULT_PORT = Number(process.env.PORT) || config.PORT || 3000;

// Static client assets
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/lib/three/examples/jsm', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')));
app.use('/lib/three/addons', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')));
app.use('/lib/three', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));
app.use('/lib/mediapipe/wasm', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')));
app.use('/lib/mediapipe', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    game: 'PARA SF: Forest Accuracy',
    activeRooms: roomManager.rooms.size,
    timestamp: Date.now()
  });
});

// SPA fallback: serve index.html for GET HTML requests
app.get('*', (req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
    return res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
  }
  next();
});

// Socket.IO Communication Gateway
io.on('connection', (socket) => {
  // Helper to reliably resolve and bind persistent player ID
  const resolvePlayerId = (data) => {
    if (data && typeof data.playerId === 'string' && data.playerId.trim()) {
      socket.playerId = data.playerId.trim().slice(0, 64);
    } else if (!socket.playerId) {
      const authPid = (socket.handshake.auth && socket.handshake.auth.playerId) ||
                      (socket.handshake.query && socket.handshake.query.playerId);
      if (authPid && typeof authPid === 'string' && authPid.trim()) {
        socket.playerId = authPid.trim().slice(0, 64);
      }
    }
    return socket.playerId || socket.id;
  };

  // Extract initial identity if present in handshake
  const initialAuthId = (socket.handshake.auth && socket.handshake.auth.playerId) ||
                        (socket.handshake.query && socket.handshake.query.playerId);
  if (initialAuthId && typeof initialAuthId === 'string' && initialAuthId.trim()) {
    socket.playerId = initialAuthId.trim().slice(0, 64);
  } else {
    socket.playerId = null;
  }

  console.log(`[NET] Player connected: ${socket.id} (Initial PlayerID: ${socket.playerId || 'pending'})`);

  // Request player's personal score history (Authoritative, player-specific)
  socket.on('get_score_history', (data, callback) => {
    const targetPlayerId = resolvePlayerId(data);
    console.log(`[NET] Fetching score history for PlayerID: ${targetPlayerId}`);
    const history = scoreStore.getPlayerHistory(targetPlayerId);
    socket.emit('score_history_data', history);
    if (typeof callback === 'function') {
      callback(history);
    }
  });

  // Create new 2-player tactical room
  socket.on('create_room', (data) => {
    resolvePlayerId(data);
    roomManager.createRoom(socket, data);
  });

  // Start Solo Practice Range Match
  socket.on('create_solo_practice', (data) => {
    resolvePlayerId(data);
    roomManager.createSoloPractice(socket, data);
  });

  // Early finish or completion of Solo Training Mode
  socket.on('finish_solo_training', () => {
    const room = roomManager.getRoomBySocket(socket.id);
    if (room && room.isSolo && room.match) {
      console.log(`[SOLO] Player finished training session in room: ${room.code}`);
      room.match.endMatch();
    }
  });

  // Join existing tactical room
  socket.on('join_room', (data) => {
    resolvePlayerId(data);
    roomManager.joinRoom(socket, data.roomCode, data);
  });

  // Player position/look synchronization
  socket.on('player_move', (data) => {
    const room = roomManager.getRoomBySocket(socket.id);
    if (room && room.match) {
      room.match.handlePlayerMove(socket.id, data);
    }
  });

  // Player weapon fire request (Authoritative verification)
  socket.on('player_shoot', (data) => {
    const room = roomManager.getRoomBySocket(socket.id);
    if (room && room.match) {
      room.match.handlePlayerShoot(socket.id, data);
    }
  });

  // Player weapon reload request
  socket.on('player_reload', () => {
    const room = roomManager.getRoomBySocket(socket.id);
    if (room && room.match) {
      room.match.handlePlayerReload(socket.id);
    }
  });

  // Rematch / Play Again request
  socket.on('request_rematch', () => {
    roomManager.handleRematch(socket);
  });

  // Leave room to lobby
  socket.on('leave_room', () => {
    roomManager.leaveCurrentRoom(socket);
    socket.emit('left_room_success');
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    console.log(`[NET] Player disconnected: ${socket.id}`);
    roomManager.leaveCurrentRoom(socket);
  });
});

// Start Server & Show Local Network IPs for Easy Cross-Device (PC & Mobile) Connection
function startServer(port) {
  server.listen(port, '0.0.0.0', () => {
    config.PORT = port;
    process.env.PORT = String(port);

    console.log('====================================================');
    console.log('  PARA SF: FOREST ACCURACY - MULTIPLAYER SERVER');
    console.log('====================================================');
    console.log(`> Local Server:     http://localhost:${port}`);

    // Find Local IPv4 addresses
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`> Mobile/LAN Access: http://${iface.address}:${port}`);
        }
      }
    }
    console.log('====================================================');
    console.log('Ready for 2-player cross-platform matches (PC + Mobile).');
  });

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      if (!process.env.PORT && port < 3010) {
        console.warn(`[NET] Port ${port} is already in use. Retrying on port ${port + 1}...`);
        startServer(port + 1);
        return;
      }

      console.error(`[NET] Failed to start server: port ${port} is already in use.`);
      process.exit(1);
    }

    throw error;
  });
}

// Start Server if executed directly (e.g. node server/server.js or npm start)
if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = server;
module.exports.server = server;
module.exports.app = app;
module.exports.io = io;
module.exports.roomManager = roomManager;
