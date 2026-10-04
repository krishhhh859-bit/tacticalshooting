const assert = require('assert');
const { io } = require('socket.io-client');

async function runFullRangeMatchTest() {
  const port = Number(process.env.PORT) || 3000;
  const socket = io(`http://localhost:${port}`, { transports: ['websocket'] });
  const rounds = new Set();
  let matchStartedAt = 0;
  let movingStartedAt = 0;
  let endedAt = 0;
  let postEndTargetUpdates = 0;

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });

  const ended = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The 240-second match did not end')), 260000);

    socket.on('match_started', (data) => {
      matchStartedAt = Date.now();
      assert.equal(data.duration, 240);
      assert.equal(data.targetRound.round, 1);
      assert.equal(data.targetRound.targets.length, 8);
      rounds.add(data.targetRound.round);
      console.log('[FULL MATCH TEST] Round 1 active immediately with eight targets.');
    });

    socket.on('range_targets_update', (state) => {
      if (endedAt) {
        postEndTargetUpdates += 1;
        return;
      }
      rounds.add(state.round);
      if (state.movingTargets && !movingStartedAt) {
        movingStartedAt = Date.now();
        console.log(`[FULL MATCH TEST] Moving targets began at ${state.roundEndsAt - state.serverTime}ms remaining in the round.`);
      }
    });

    socket.on('timer_update', (state) => {
      if (state.timeRemaining === 60) {
        console.log('[FULL MATCH TEST] Authoritative clock reached 01:00.');
      }
      if (state.timeRemaining === 0) {
        console.log('[FULL MATCH TEST] Authoritative clock reached 00:00.');
      }
    });

    socket.once('match_ended', (summary) => {
      clearTimeout(timeout);
      endedAt = Date.now();
      resolve(summary);
    });
  });

  const roomCreated = new Promise((resolve) => socket.once('room_created', resolve));
  socket.emit('create_solo_practice', { name: 'Full Range Test', device: 'pc' });
  await roomCreated;

  const summary = await ended;
  const elapsed = endedAt - matchStartedAt;
  assert(elapsed >= 239000 && elapsed <= 242000, `Unexpected match duration: ${elapsed}ms`);
  assert(rounds.has(1) && rounds.has(48), 'Expected rounds 1 through 48');
  for (let round = 1; round <= 48; round += 1) {
    assert(rounds.has(round), `Missing target round ${round}`);
  }
  assert(movingStartedAt > 0, 'Moving targets did not activate during the final minute');
  assert(Math.abs(movingStartedAt - (matchStartedAt + 180000)) <= 1500, 'Moving targets did not start at 60 seconds remaining');
  assert.equal(postEndTargetUpdates, 0, 'Targets updated after match end');
  assert.equal(summary.result, 'DRAW');

  console.log(JSON.stringify({
    elapsedMs: elapsed,
    roundsObserved: rounds.size,
    movingActivationOffsetMs: movingStartedAt - matchStartedAt,
    postEndTargetUpdates,
    result: summary.result
  }));
  socket.disconnect();
  process.exit(0);
}

runFullRangeMatchTest().catch((error) => {
  console.error('[FULL MATCH TEST] Failed:', error);
  process.exit(1);
});
