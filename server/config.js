/**
 * PARA SF: FOREST ACCURACY - Server Configuration
 */

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  
  // Match settings
  MATCH_DURATION_SECONDS: 240, // Exactly 4 minutes
  COUNTDOWN_SECONDS: 5,        // Exactly 5 seconds: 5, 4, 3, 2, 1, BEGIN!
  TICK_RATE_HZ: 30,             // 30 target & state updates per second
  
  // Weapon authoritative constraints
  WEAPON: {
    MAGAZINE_CAPACITY: 30,
    TOTAL_RESERVE_AMMO: 120,
    MIN_FIRE_INTERVAL_MS: 100, // ~600 RPM max fire rate
    RELOAD_DURATION_MS: 3480,  // Authoritative reload delay matching reloading-gun.mp3 duration (~3.48s)
    BASE_DAMAGE: 100
  },

  RANGE_TARGETS: {
    // Normal target board active existence duration before cycling (ms)
    EXISTENCE_DURATION_MS: 5000,
    // Per-target independent cooldown after being hit (ms)
    HIT_COOLDOWN_MS: 6000,
    // Number of targets active simultaneously throughout the whole match
    SIMULTANEOUS_TARGETS: 8,
    BOARD_WIDTH: 2.8,
    BOARD_HEIGHT: 4.2,
    // Playable firing range boundary (expanded for 30m movement)
    BOUNDS: { minX: -32, maxX: 32, minZ: -80, maxZ: -8 },
    // Spawn candidate positions — wide spread to allow ~20–40m movement paths
    SPAWNS: [
      // Near zone — z: -10 to -22
      { x: -10, z: -12 }, { x: 0,   z: -13 }, { x: 10,  z: -12 },
      { x: -6,  z: -18 }, { x: 6,   z: -18 }, { x: 0,   z: -21 },
      // Mid zone — z: -26 to -46
      { x: -14, z: -28 }, { x: 2,   z: -30 }, { x: 15,  z: -28 },
      { x: -5,  z: -38 }, { x: 8,   z: -40 }, { x: -18, z: -44 },
      // Far zone — z: -50 to -74
      { x: -2,  z: -50 }, { x: 13,  z: -52 }, { x: -13, z: -55 },
      { x: 0,   z: -62 }, { x: 16,  z: -60 }, { x: -8,  z: -68 },
      { x: 5,   z: -72 }, { x: -16, z: -74 }
    ],
    // Tree trunks that block shots — updated for new wider spacing
    TREE_BLOCKERS: [
      // Left flank
      [-22, -28], [-30, -36], [-16, -46], [-32, -54], [-24, -64],
      [-36, -24], [-18, -22], [-40, -45], [-14, -56], [-30, -68],
      // Right flank
      [22, -28], [30, -34], [18, -44], [32, -50], [26, -60],
      [36, -26], [16, -20], [40, -42], [14, -54], [30, -70],
      // Central/background
      [-8, -38], [10, -36], [-3, -52], [5, -62], [-10, -66],
      [18, -74], [-18, -76], [0, -78], [22, -80], [-24, -84],
      // Rear perimeter
      [-20, 4], [20, 4], [-26, 8], [26, 8], [-22, 12], [22, 12]
    ],
    ROCK_BLOCKERS: [
      [-9, -27, 1.4], [11, -29, 1.6], [-15, -45, 2.2], [18, -48, 1.9],
      [2, -38, 1.3], [-22, -36, 1.8], [24, -38, 2.0], [0, -56, 2.4]
    ],
    COVER_BLOCKERS: [[-16, -28], [12, -32], [20, -42], [-22, -36]]
  },

  // Scoring
  SCORING: {
    HIT_POINTS: 1
  }
};
