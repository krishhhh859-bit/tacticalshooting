/**
 * PARA SF: FOREST ACCURACY - Authoritative Score Store
 * Persistent server-side score history with 24-hour rolling retention.
 */

const fs = require('fs');
const path = require('path');

class ScoreStore {
  constructor(customFilePath = null) {
    this.dataFilePath = customFilePath || path.join(__dirname, 'data', 'scores.json');
    this.dataDir = path.dirname(this.dataFilePath);
    this.scores = {}; // { [playerId]: [ { score, timestamp, matchId } ] }
    this.RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      if (fs.existsSync(this.dataFilePath)) {
        const raw = fs.readFileSync(this.dataFilePath, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.scores = parsed;
          }
        }
      }
    } catch (err) {
      console.warn('[SCORE_STORE] Error reading existing score store file:', err.message);
      this.scores = {};
    }

    this.prune();
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      const tmpPath = this.dataFilePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.scores, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.dataFilePath);
    } catch (err) {
      console.error('[SCORE_STORE] Error persisting scores to file:', err.message);
    }
  }

  prune() {
    const now = Date.now();
    let changed = false;

    for (const [playerId, records] of Object.entries(this.scores)) {
      if (!Array.isArray(records)) {
        delete this.scores[playerId];
        changed = true;
        continue;
      }

      const valid = records.filter(r => {
        return r &&
          typeof r.score === 'number' &&
          Number.isFinite(r.score) &&
          typeof r.timestamp === 'number' &&
          (now - r.timestamp) <= this.RETENTION_MS;
      });

      if (valid.length !== records.length) {
        changed = true;
      }

      if (valid.length === 0) {
        delete this.scores[playerId];
        changed = true;
      } else {
        this.scores[playerId] = valid;
      }
    }

    if (changed) {
      this.save();
    }
  }

  addScore(playerId, score, matchId = null, mode = 'multiplayer') {
    if (!playerId || typeof playerId !== 'string') return null;
    const cleanId = playerId.trim();
    if (!cleanId) return null;

    const numScore = Number(score);
    if (!Number.isFinite(numScore) || numScore < 0) return null;

    this.prune();

    if (!this.scores[cleanId]) {
      this.scores[cleanId] = [];
    }

    // Prevent duplicate recording if same matchId was already recorded for this player
    if (matchId) {
      const alreadySaved = this.scores[cleanId].some(r => r.matchId === matchId);
      if (alreadySaved) {
        return this.getPlayerHistory(cleanId);
      }
    }

    const cleanMode = (mode === 'solo' || mode === 'Solo Training') ? 'solo' : 'multiplayer';

    this.scores[cleanId].push({
      score: Math.round(numScore),
      mode: cleanMode,
      timestamp: Date.now(),
      matchId: matchId || null
    });

    this.save();
    return this.getPlayerHistory(cleanId);
  }

  getPlayerHistory(playerId) {
    if (!playerId || typeof playerId !== 'string') {
      return { highestScore: 0, scores: [] };
    }
    const cleanId = playerId.trim();
    if (!cleanId) {
      return { highestScore: 0, scores: [] };
    }

    this.prune();

    const records = this.scores[cleanId] || [];
    // Sort descending chronologically (newest first)
    const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);

    let highest = 0;
    for (const r of sorted) {
      if (r.score > highest) {
        highest = r.score;
      }
    }

    return {
      highestScore: highest,
      scores: sorted.map(r => ({
        score: r.score,
        mode: (r.mode === 'solo' || r.mode === 'Solo Training') ? 'solo' : 'multiplayer',
        timestamp: r.timestamp
      }))
    };
  }

  clearAll() {
    this.scores = {};
    this.save();
  }
}

// Export singleton instance as well as the class
const defaultScoreStore = new ScoreStore();
defaultScoreStore.ScoreStore = ScoreStore;

module.exports = defaultScoreStore;
