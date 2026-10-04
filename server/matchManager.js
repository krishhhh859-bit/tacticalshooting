/**
 * PARA SF: FOREST ACCURACY - Match Manager
 * Server-Authoritative Game Match Controller
 */

const config = require('./config');

class MatchManager {
  constructor(room, io) {
    this.room = room;
    this.io = io;
    this.state = 'WAITING'; // WAITING, COUNTDOWN, PLAYING, ENDED

    this.countdownTimer = null;
    this.countdownSeconds = config.COUNTDOWN_SECONDS;

    this.matchTimer = null;
    this.tickInterval = null;
    this.timeRemaining = config.MATCH_DURATION_SECONDS;
    this.startTime = null;
    this.endTime = null;
    this.targetCycleStartTime = null;
    this.targetCyclePhase = 'ACTIVE'; // 'ACTIVE' | 'COOLDOWN'

    this.playerStats = {};
    for (const socketId of Object.keys(room.players)) {
      this.initPlayerStats(socketId);
    }

    this.rangeTargets = [];
    this.movingTargetsActive = false;
  }

  initPlayerStats(socketId) {
    const player = this.room.players[socketId];
    this.playerStats[socketId] = {
      socketId,
      slot: player.slot,
      name: player.name || ('Player ' + player.slot),
      score: 0,
      magazine: config.WEAPON.MAGAZINE_CAPACITY,
      reserveAmmo: config.WEAPON.TOTAL_RESERVE_AMMO,
      isReloading: false,
      reloadTimeout: null,
      lastShotTimestamp: 0,
      totalShots: 0,
      hits: 0,
      position: { x: (player.slot === 1 ? -4 : 4), y: 1.7, z: 0 },
      rotation: { x: 0, y: 0 }
    };
  }

  startCountdown() {
    this.state = 'COUNTDOWN';
    this.countdownSeconds = config.COUNTDOWN_SECONDS;
    console.log('[MATCH] Starting ' + this.countdownSeconds + 's countdown for room ' + this.room.code + '...');
    this.io.to(this.room.code).emit('countdown_started', { seconds: this.countdownSeconds });

    this.countdownTimer = setInterval(() => {
      this.countdownSeconds -= 1;
      if (this.countdownSeconds > 0) {
        console.log('[MATCH] Countdown: ' + this.countdownSeconds);
        this.io.to(this.room.code).emit('countdown_tick', { count: this.countdownSeconds });
      } else if (this.countdownSeconds === 0) {
        console.log('[MATCH] Countdown: BEGIN!');
        this.io.to(this.room.code).emit('countdown_tick', { count: 'BEGIN!' });
        clearInterval(this.countdownTimer);
        setTimeout(() => { this.startMatch(); }, 800);
      }
    }, 1000);
  }

  startMatch() {
    this.state = 'PLAYING';
    this.timeRemaining = config.MATCH_DURATION_SECONDS;
    this.startTime = Date.now();
    this.endTime = this.startTime + (this.timeRemaining * 1000);
    this.targetCycleStartTime = this.startTime;
    this.targetCyclePhase = 'ACTIVE';

    // Spawn all targets immediately - movement begins from match start
    this.spawnInitialTargets(this.startTime);
    console.log('[MATCH] Match ACTIVE in room ' + this.room.code + '! 240s clock running.');

    this.io.to(this.room.code).emit('match_started', {
      duration: this.timeRemaining,
      targetRound: this.getRangeTargetState(this.startTime),
      players: this.getPlayersState()
    });

    // 1-second authoritative clock broadcast
    this.matchTimer = setInterval(() => {
      const now = Date.now();
      const remainingMs = Math.max(0, this.endTime - now);
      this.timeRemaining = Math.ceil(remainingMs / 1000);
      this.io.to(this.room.code).emit('timer_update', {
        timeRemaining: this.timeRemaining,
        formattedTime: this.formatTime(this.timeRemaining)
      });
      if (remainingMs <= 0) this.endMatch();
    }, 1000);

    // Target update + broadcast tick at TICK_RATE_HZ
    const tickIntervalMs = Math.round(1000 / config.TICK_RATE_HZ);
    let lastTickTime = Date.now();
    this.tickInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTickTime) / 1000;
      lastTickTime = now;
      if (this.state === 'PLAYING') {
        if (now >= this.endTime) { this.endMatch(); return; }
        this.updateRangeTargets(dt, now);
        this.broadcastRangeTargetState(now);
      }
    }, tickIntervalMs);
  }

  // ------- TARGET GENERATION -----------------------------------------------

  buildMovementPath(spawnX, spawnZ, pathType) {
    const rng = (min, max) => min + Math.random() * (max - min);
    // halfAmp 10-20 m -> full cycle travel 20-40 m
    const halfAmp = rng(10, 20);
    const speed   = rng(0.12, 0.28); // rad/s
    const phase   = Math.random() * Math.PI * 2;
    return {
      pathType: (pathType || 0) % 6,
      baseX: spawnX,
      baseZ: spawnZ,
      halfAmpX: halfAmp,
      halfAmpZ: halfAmp * rng(0.4, 0.7),
      speed,
      phase
    };
  }

  spawnInitialTargets(now) {
    const rc = config.RANGE_TARGETS;
    const clearSpawns = rc.SPAWNS
      .map((s, i) => Object.assign({}, s, { index: i }))
      .filter(s => this.isClearTargetSpawn(s));

    // Fisher-Yates shuffle
    for (let i = clearSpawns.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = clearSpawns[i]; clearSpawns[i] = clearSpawns[j]; clearSpawns[j] = tmp;
    }

    const count = Math.min(rc.SIMULTANEOUS_TARGETS, clearSpawns.length);
    this.rangeTargets = [];
    this.movingTargetsActive = true;
    for (let i = 0; i < count; i++) {
      this.rangeTargets.push(this.createTarget(clearSpawns[i], i, now));
    }
  }

  createTarget(spawn, pathIndex, now) {
    const path = this.buildMovementPath(spawn.x, spawn.z, pathIndex);
    const elapsed = this.startTime ? (now - this.startTime) / 1000 : 0;
    const pos = this.evalTargetPos(path, elapsed);
    return {
      id: 'target-' + spawn.index + '-' + now,
      spawnIndex: spawn.index,
      path,
      x: pos.x,
      y: this.terrainHeight(pos.x, pos.z),
      z: pos.z,
      active: true,
      hitboxDisabled: false,
      yaw: 0,
      state: 'ACTIVE', // ACTIVE | FALLING | COOLDOWN | RESPAWN
      hitAt: 0,
      cooldownMs: config.RANGE_TARGETS.HIT_COOLDOWN_MS
    };
  }

  evalTargetPos(path, matchElapsedSec) {
    const rc = config.RANGE_TARGETS;
    const t = matchElapsedSec * path.speed + path.phase;
    let x = path.baseX, z = path.baseZ;
    switch (path.pathType) {
      case 0: x = path.baseX + Math.sin(t) * path.halfAmpX; break;
      case 1: z = path.baseZ + Math.sin(t) * path.halfAmpZ; break;
      case 2:
        x = path.baseX + Math.sin(t) * path.halfAmpX;
        z = path.baseZ + Math.sin(t) * path.halfAmpZ;
        break;
      case 3:
        x = path.baseX + Math.cos(t) * path.halfAmpX;
        z = path.baseZ + Math.sin(t) * path.halfAmpZ;
        break;
      case 4:
        x = path.baseX + Math.sin(t) * path.halfAmpX;
        z = path.baseZ + Math.sin(t * 2) * (path.halfAmpX * 0.45);
        break;
      case 5:
        x = path.baseX + Math.sin(t * 0.7) * path.halfAmpX;
        z = path.baseZ + Math.cos(t * 0.5) * path.halfAmpZ;
        break;
    }
    x = Math.max(rc.BOUNDS.minX + 1, Math.min(rc.BOUNDS.maxX - 1, x));
    z = Math.max(rc.BOUNDS.minZ + 1, Math.min(rc.BOUNDS.maxZ - 1, z));
    return { x, z };
  }

  chooseRespawnSpawn(excludeId) {
    const rc = config.RANGE_TARGETS;
    const activePos = this.rangeTargets
      .filter(t => t.state === 'ACTIVE' && t.id !== excludeId)
      .map(t => ({ x: t.x, z: t.z }));
    const clear = rc.SPAWNS
      .map((s, i) => Object.assign({}, s, { index: i }))
      .filter(s => this.isClearTargetSpawn(s))
      .filter(s => !activePos.some(p => Math.hypot(s.x - p.x, s.z - p.z) < 6));
    if (!clear.length) {
      const fallback = rc.SPAWNS
        .map((s, i) => Object.assign({}, s, { index: i }))
        .filter(s => this.isClearTargetSpawn(s));
      if (!fallback.length) return null;
      return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return clear[Math.floor(Math.random() * clear.length)];
  }

  // ------- TARGET TICK -----------------------------------------------------

  updateRangeTargets(dt, now) {
    if (now >= this.endTime) return;
    const cycleElapsed = now - this.targetCycleStartTime;

    if (this.targetCyclePhase === 'ACTIVE') {
      if (cycleElapsed >= 3000) {
        // Transition to COOLDOWN: clear all targets
        this.targetCyclePhase = 'COOLDOWN';
        this.targetCycleStartTime = now;
        for (const target of this.rangeTargets) {
          target.active = false;
          target.hitboxDisabled = true;
          target.state = 'FALLING';
          if (!target.hitAt) target.hitAt = now;
        }
        console.log('[TARGET] Cycle → COOLDOWN (3s empty range)');
        return;
      }
      // Move active targets
      const elapsed = (now - this.startTime) / 1000;
      for (const target of this.rangeTargets) {
        if (target.state === 'ACTIVE') {
          const pos = this.evalTargetPos(target.path, elapsed);
          target.x = pos.x; target.z = pos.z;
          target.y = this.terrainHeight(target.x, target.z);
        }
      }
    } else {
      // COOLDOWN phase
      if (cycleElapsed >= 3000) {
        // Transition to ACTIVE: spawn fresh target set
        this.targetCyclePhase = 'ACTIVE';
        this.targetCycleStartTime = now;
        this.spawnInitialTargets(now);
        console.log('[TARGET] Cycle → ACTIVE (new target set spawned)');
      }
      // During cooldown the rangeTargets array stays empty/fallen — nothing to update
    }
  }

  // ------- HELPERS ---------------------------------------------------------

  terrainHeight(x, z) {
    if (z >= -15 && z <= 10 && Math.abs(x) <= 18) return 0;
    return Math.sin(x * 0.08) * Math.cos(z * 0.08) * 1.1 + Math.sin(x * 0.03 + z * 0.04) * 1.4;
  }

  isClearTargetSpawn(spawn) {
    const b = config.RANGE_TARGETS;
    if (spawn.x < b.BOUNDS.minX || spawn.x > b.BOUNDS.maxX || spawn.z < b.BOUNDS.minZ || spawn.z > b.BOUNDS.maxZ) return false;
    if (b.TREE_BLOCKERS.some(t => Math.hypot(spawn.x - t[0], spawn.z - t[1]) < 5.5)) return false;
    if (b.ROCK_BLOCKERS.some(r => Math.hypot(spawn.x - r[0], spawn.z - r[1]) < r[2] * 1.8 + 1.1)) return false;
    if (b.COVER_BLOCKERS.some(c => Math.hypot(spawn.x - c[0], spawn.z - c[1]) < 4.2)) return false;
    return true;
  }

  getRangeTargetState(now) {
    if (now === undefined) now = Date.now();
    return {
      round: 1,
      roundEndsAt: this.endTime || 0,
      movingTargets: true,
      serverTime: now,
      targets: this.rangeTargets
        .filter(t => t.state === 'ACTIVE')
        .map(t => ({
          id: t.id,
          x: Number(t.x.toFixed(3)),
          y: Number(t.y.toFixed(3)),
          z: Number(t.z.toFixed(3)),
          yaw: t.yaw,
          active: true,
          moving: true
        }))
    };
  }

  broadcastRangeTargetState(now) {
    if (now === undefined) now = Date.now();
    this.io.to(this.room.code).emit('range_targets_update', this.getRangeTargetState(now));
  }

  // ------- SHOT BLOCKING ---------------------------------------------------

  isRangeShotBlocked(origin, direction, maxDistance) {
    const b = config.RANGE_TARGETS;
    const circleHit = (cx, cz, radius, maxY) => {
      const ox = origin.x - cx, oz = origin.z - cz;
      const a = direction.x * direction.x + direction.z * direction.z;
      if (a < 1e-8) return false;
      const bv = 2 * (ox * direction.x + oz * direction.z);
      const c = ox * ox + oz * oz - radius * radius;
      const disc = bv * bv - 4 * a * c;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      const d1 = (-bv - sq) / (2 * a);
      const d2 = (-bv + sq) / (2 * a);
      return [d1, d2].some(d => {
        if (d <= 0.05 || d >= maxDistance - 0.1) return false;
        const y = origin.y + direction.y * d;
        return y >= 0 && y <= maxY;
      });
    };

    // Tree trunks: radius ~0.65m (environment trunks are 0.25 to 0.45 * scale)
    for (const t of b.TREE_BLOCKERS) {
      if (circleHit(t[0], t[1], 0.65, 12)) return true;
    }
    // Rocks: radius ~r[2]*0.9, height ~r[2]*1.1
    for (const r of b.ROCK_BLOCKERS) {
      if (circleHit(r[0], r[1], r[2] * 0.9, r[2] * 1.1)) return true;
    }
    // Sandbag covers: width ~2.5m, radius 1.6m, height 1.2m
    for (const c of b.COVER_BLOCKERS) {
      if (circleHit(c[0], c[1], 1.6, 1.2)) return true;
    }

    // Terrain: only block if ray dips under terrain between shooter and target
    for (let d = 0.8; d < maxDistance - 0.8; d += 0.5) {
      const x = origin.x + direction.x * d;
      const y = origin.y + direction.y * d;
      const z = origin.z + direction.z * d;
      if (y <= this.terrainHeight(x, z) - 0.15) return true;
    }

    // Sandbag firing line rail at player zone (z ~ -0.5, height 0.65m)
    if (Math.abs(direction.z) > 1e-8) {
      const railD = (-0.5 - origin.z) / direction.z;
      if (railD > 0.05 && railD < maxDistance - 0.1) {
        const rx = origin.x + direction.x * railD;
        const ry = origin.y + direction.y * railD;
        if (rx >= -14.8 && rx <= 14.8 && ry >= 0 && ry <= 0.65) return true;
      }
    }
    return false;
  }

  // ------- RAY VS ORIENTED TARGET BOARD INTERSECTION -----------------------

  intersectRayTarget(origin, dir, targetPos, yaw = 0) {
    const boardW = config.RANGE_TARGETS.BOARD_WIDTH || 2.8;
    const boardH = config.RANGE_TARGETS.BOARD_HEIGHT || 4.2;
    // Forgiving hitbox dimensions: board width + 0.15m on each side, board height + 0.15m top/bottom, depth 0.35m
    const hx = (boardW / 2) + 0.15;
    const hy = (boardH / 2) + 0.15;
    const hz = 0.35; // half-depth

    // Target center in world space
    // Board group is positioned at (targetPos.x, targetPos.y, targetPos.z)
    // Board mesh center is at y = boardH / 2, z offset ~0.015
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    const centerX = targetPos.x + 0.015 * sinY;
    const centerY = targetPos.y + (boardH / 2);
    const centerZ = targetPos.z + 0.015 * cosY;

    // Vector from box center to ray origin
    const dx = origin.x - centerX;
    const dy = origin.y - centerY;
    const dz = origin.z - centerZ;

    // Transform into box local coordinate system
    // Local axes in world space:
    // ux = (cosY, 0, -sinY)
    // uy = (0, 1, 0)
    // uz = (sinY, 0, cosY)
    const pX = dx * cosY - dz * sinY;
    const pY = dy;
    const pZ = dx * sinY + dz * cosY;

    const dX = dir.x * cosY - dir.z * sinY;
    const dY = dir.y;
    const dZ = dir.x * sinY + dir.z * cosY;

    let tMin = -Infinity;
    let tMax = Infinity;

    // X slab
    if (Math.abs(dX) > 1e-9) {
      let t1 = (-hx - pX) / dX;
      let t2 = (hx - pX) / dX;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    } else {
      if (pX < -hx || pX > hx) return null;
    }

    // Y slab
    if (Math.abs(dY) > 1e-9) {
      let t1 = (-hy - pY) / dY;
      let t2 = (hy - pY) / dY;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    } else {
      if (pY < -hy || pY > hy) return null;
    }

    // Z slab
    if (Math.abs(dZ) > 1e-9) {
      let t1 = (-hz - pZ) / dZ;
      let t2 = (hz - pZ) / dZ;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    } else {
      if (pZ < -hz || pZ > hz) return null;
    }

    if (tMax < 0.05) return null; // Box is behind ray origin
    const hitDist = tMin > 0.05 ? tMin : tMax;
    if (hitDist > 250) return null; // Weapon maximum effective distance

    return {
      dist: hitDist,
      hitPoint: {
        x: origin.x + dir.x * hitDist,
        y: origin.y + dir.y * hitDist,
        z: origin.z + dir.z * hitDist
      }
    };
  }

  // ------- HIT VALIDATION --------------------------------------------------

  validateRangeTargetHit(shotData) {
    if (!shotData || !shotData.origin || !shotData.direction) return null;
    const origin = shotData.origin;
    const dirLen = Math.hypot(shotData.direction.x, shotData.direction.y, shotData.direction.z);
    if (!dirLen || isNaN(dirLen)) return null;
    const dir = {
      x: shotData.direction.x / dirLen,
      y: shotData.direction.y / dirLen,
      z: shotData.direction.z / dirLen
    };

    const activeTargets = this.rangeTargets.filter(
      t => t.state === 'ACTIVE' && !t.hitboxDisabled
    );
    if (!activeTargets.length) return null;

    let candidateTargets = [];
    if (shotData.targetId) {
      const explicitTarget = this.rangeTargets.find(t => t.id === shotData.targetId);
      // If the targeted board was already hit (FALLING or COOLDOWN), do not re-hit or pass through
      if (explicitTarget && (explicitTarget.state !== 'ACTIVE' || explicitTarget.hitboxDisabled)) {
        return null;
      }
      if (explicitTarget && explicitTarget.state === 'ACTIVE' && !explicitTarget.hitboxDisabled) {
        candidateTargets = [explicitTarget];
      } else {
        candidateTargets = activeTargets;
      }
    } else {
      candidateTargets = activeTargets;
    }

    const now = Date.now();
    const elapsed = this.startTime ? (now - this.startTime) / 1000 : 0;
    // Latency compensation sample times: current, 40ms ago, 80ms ago, 120ms ago
    const timeOffsets = [0, 0.04, 0.08, 0.12];

    let bestCandidate = null;
    let bestDist = Infinity;

    for (const target of candidateTargets) {
      let targetHit = null;
      for (const offset of timeOffsets) {
        let pos;
        if (offset === 0) {
          pos = { x: target.x, y: target.y, z: target.z };
        } else if (target.path) {
          const pastElapsed = Math.max(0, elapsed - offset);
          const p = this.evalTargetPos(target.path, pastElapsed);
          pos = { x: p.x, y: this.terrainHeight(p.x, p.z), z: p.z };
        } else {
          continue;
        }

        const res = this.intersectRayTarget(origin, dir, pos, target.yaw || 0);
        if (res && res.dist < bestDist) {
          if (!this.isRangeShotBlocked(origin, dir, res.dist)) {
            targetHit = res;
            break;
          }
        }
      }

      if (targetHit && targetHit.dist < bestDist) {
        bestDist = targetHit.dist;
        bestCandidate = { target, hitPoint: targetHit.hitPoint };
        if (target.id === shotData.targetId) {
          break;
        }
      }
    }

    return bestCandidate;
  }

  // ------- PLAYER STATE ----------------------------------------------------

  getPlayersState() {
    const result = {};
    for (const [id, stats] of Object.entries(this.playerStats)) {
      result[id] = {
        slot: stats.slot, name: stats.name, score: stats.score,
        magazine: stats.magazine, reserveAmmo: stats.reserveAmmo,
        isReloading: stats.isReloading, position: stats.position, rotation: stats.rotation
      };
    }
    return result;
  }

  handlePlayerMove(socketId, data) {
    const stats = this.playerStats[socketId];
    if (!stats) return;
    if (data.position) {
      stats.position = { x: Number(data.position.x)||0, y: Number(data.position.y)||1.7, z: Number(data.position.z)||0 };
    }
    if (data.rotation) {
      stats.rotation = { x: Number(data.rotation.x)||0, y: Number(data.rotation.y)||0 };
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.to(this.room.code).emit('opponent_move', {
        socketId, slot: stats.slot, position: stats.position, rotation: stats.rotation
      });
    }
  }

  handlePlayerShoot(socketId, shotData) {
    if (this.state !== 'PLAYING' || Date.now() >= this.endTime) {
      if (this.state === 'PLAYING' && Date.now() >= this.endTime) this.endMatch();
      console.log('[WEAPON] Shoot ignored: Match state is ' + this.state);
      return;
    }
    if (!shotData || !shotData.origin || !shotData.direction) return;
    const stats = this.playerStats[socketId];
    if (!stats || stats.isReloading) return;
    if (stats.magazine <= 0) {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) socket.emit('weapon_dry_fire');
      return;
    }
    const now = Date.now();
    if (now - stats.lastShotTimestamp < config.WEAPON.MIN_FIRE_INTERVAL_MS) return;
    stats.lastShotTimestamp = now;
    stats.magazine -= 1;
    stats.totalShots += 1;
    console.log('[WEAPON] Shot fired by Player ' + stats.slot + '. Ammo: ' + stats.magazine + '/' + stats.reserveAmmo);

    this.io.to(this.room.code).emit('player_fired_effect', {
      socketId, slot: stats.slot, origin: shotData.origin, direction: shotData.direction
    });
    const shooterSocket = this.io.sockets.sockets.get(socketId);
    if (shooterSocket) shooterSocket.emit('ammo_update', { magazine: stats.magazine, reserveAmmo: stats.reserveAmmo });

    // Sync positions to current moment before validating
    this.updateRangeTargets(0, now);
    const hit = this.validateRangeTargetHit(shotData);

    if (hit) {
      // Immediately lock target to prevent double-scoring
      hit.target.hitboxDisabled = true;
      hit.target.active = false;
      hit.target.state = 'FALLING';
      hit.target.hitAt = now;
      stats.hits += 1;
      stats.score += config.SCORING.HIT_POINTS;
      console.log('[TARGET] BOARD HIT! Player ' + stats.slot + ' score: ' + stats.score);
      if (shooterSocket) {
        shooterSocket.emit('hit_confirmed', {
          points: config.SCORING.HIT_POINTS, totalScore: stats.score,
          hitPoint: hit.hitPoint, targetId: hit.target.id
        });
      }
      this.io.to(this.room.code).emit('range_target_hit', {
        targetId: hit.target.id, round: 1, slot: stats.slot, score: stats.score, hitPoint: hit.hitPoint
      });
      this.io.to(this.room.code).emit('score_update', {
        socketId, slot: stats.slot, score: stats.score, allScores: this.getCurrentScores()
      });
      this.broadcastRangeTargetState(now);
    }
  }

  handlePlayerReload(socketId) {
    if (this.state !== 'PLAYING') return;
    const stats = this.playerStats[socketId];
    if (!stats || stats.isReloading) return;
    if (stats.magazine >= config.WEAPON.MAGAZINE_CAPACITY || stats.reserveAmmo <= 0) return;
    stats.isReloading = true;
    console.log('[WEAPON] Player ' + stats.slot + ' initiated reload.');
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('reload_started', { duration: config.WEAPON.RELOAD_DURATION_MS });
      socket.to(this.room.code).emit('opponent_reloading', { slot: stats.slot });
    }
    stats.reloadTimeout = setTimeout(() => {
      if (this.state !== 'PLAYING') return;
      const needed = config.WEAPON.MAGAZINE_CAPACITY - stats.magazine;
      const amt = Math.min(needed, stats.reserveAmmo);
      stats.magazine += amt; stats.reserveAmmo -= amt; stats.isReloading = false;
      console.log('[WEAPON] Player ' + stats.slot + ' reload complete. Mag: ' + stats.magazine + '/' + stats.reserveAmmo);
      if (socket) socket.emit('reload_completed', { magazine: stats.magazine, reserveAmmo: stats.reserveAmmo });
    }, config.WEAPON.RELOAD_DURATION_MS);
  }

  getCurrentScores() {
    const scores = {};
    for (const [id, stats] of Object.entries(this.playerStats)) {
      scores[stats.slot] = { socketId: id, name: stats.name, score: stats.score };
    }
    return scores;
  }

  endMatch() {
    if (this.state === 'ENDED') return;
    this.state = 'ENDED';
    this.timeRemaining = 0;
    this.io.to(this.room.code).emit('timer_update', { timeRemaining: 0, formattedTime: '00:00' });
    console.log('[MATCH] Match ENDED at 00:00 in room ' + this.room.code + '!');
    clearInterval(this.matchTimer);
    clearInterval(this.tickInterval);
    clearInterval(this.countdownTimer);
    for (const stats of Object.values(this.playerStats)) {
      if (stats.reloadTimeout) clearTimeout(stats.reloadTimeout);
    }
    const playerList = Object.values(this.playerStats);
    const p1 = playerList.find(p => p.slot === 1) || { name: 'Player 1', score: 0, hits: 0, totalShots: 0 };
    const p2 = playerList.find(p => p.slot === 2) || { name: 'Player 2', score: 0, hits: 0, totalShots: 0 };
    let result = 'DRAW', winnerSlot = null, winnerName = 'DRAW';
    if (p1.score > p2.score) { result = 'WINNER'; winnerSlot = 1; winnerName = p1.name; }
    else if (p2.score > p1.score) { result = 'WINNER'; winnerSlot = 2; winnerName = p2.name; }
    this.io.to(this.room.code).emit('match_ended', {
      result, winnerSlot, winnerName,
      player1: { name: p1.name, slot: 1, score: p1.score, hits: p1.hits, totalShots: p1.totalShots,
        accuracy: p1.totalShots > 0 ? Math.round((p1.hits / p1.totalShots) * 100) : 0 },
      player2: { name: p2.name, slot: 2, score: p2.score, hits: p2.hits, totalShots: p2.totalShots,
        accuracy: p2.totalShots > 0 ? Math.round((p2.hits / p2.totalShots) * 100) : 0 }
    });
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  cleanup() {
    clearInterval(this.matchTimer);
    clearInterval(this.tickInterval);
    clearInterval(this.countdownTimer);
    for (const stats of Object.values(this.playerStats)) {
      if (stats.reloadTimeout) clearTimeout(stats.reloadTimeout);
    }
  }
}

module.exports = MatchManager;
