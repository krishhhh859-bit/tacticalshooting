/**
 * PARA SF: FOREST ACCURACY - Vercel Serverless Function & WebSocket Gateway
 *
 * Exposes the existing Express + Socket.IO HTTP server for Vercel deployment.
 * Reuses 100% of the authoritative RoomManager, MatchManager, and TargetManager
 * logic from server/server.js without duplication.
 */

const server = require('../server/server');

module.exports = server;
