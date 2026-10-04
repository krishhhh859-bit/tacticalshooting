/**
 * Automated Multiplayer End-to-End Test for PARA SF: Forest Accuracy
 */

const { io } = require('socket.io-client');

async function runTest() {
  console.log('--- STARTING PARA SF GAMEPLAY & MULTIPLAYER E2E TEST ---');
  const port = Number(process.env.PORT) || 3000;
  const serverUrl = `http://localhost:${port}`;

  // 1. Connect Player 1 (PC)
  const socket1 = io(serverUrl, { transports: ['websocket'] });
  await new Promise((resolve) => socket1.on('connect', resolve));
  console.log('✔ Player 1 (PC) connected, Socket ID:', socket1.id);

  // 2. Connect Player 2 (Mobile)
  const socket2 = io(serverUrl, { transports: ['websocket'] });
  await new Promise((resolve) => socket2.on('connect', resolve));
  console.log('✔ Player 2 (Mobile) connected, Socket ID:', socket2.id);

  // 3. Player 1 creates room
  let roomCode = null;
  const roomCreatedPromise = new Promise((resolve) => {
    socket1.on('room_created', (data) => {
      console.log('✔ Room created successfully. Code:', data.roomCode);
      roomCode = data.roomCode;
      resolve(data);
    });
  });

  socket1.emit('create_room', { name: 'Commando 1 (Host)', device: 'pc' });
  await roomCreatedPromise;

  // 4. Player 2 joins room
  const bothReadyPromise = new Promise((resolve) => {
    socket1.on('both_players_ready', (data) => {
      console.log('✔ Both players connected and ready. Players:', data.players.map(p => `${p.name} (${p.device})`).join(' vs '));
      resolve(data);
    });
  });

  socket2.emit('join_room', { roomCode, name: 'Commando 2', device: 'mobile' });
  await bothReadyPromise;

  // 5. Verify countdown events and pre-match shooting rejection
  let shotDuringCountdownFired = false;
  socket1.on('ammo_update', () => { shotDuringCountdownFired = true; });

  const countdownTicks = [];
  const countdownPromise = new Promise((resolve) => {
    socket1.on('countdown_started', (data) => {
      console.log(`✔ Match countdown started (${data.seconds}s)...`);
      if (data.seconds !== 5) throw new Error(`Expected 5 seconds countdown, got ${data.seconds}`);
      // Attempt shot during countdown - must be rejected by server
      socket1.emit('player_shoot', {
        origin: { x: -4, y: 1.7, z: 0 },
        direction: { x: 0, y: 0, z: -1 },
        targetId: 'fake-target'
      });
    });
    socket1.on('countdown_tick', (data) => {
      console.log(`  [Countdown]: ${data.count}`);
      countdownTicks.push(data.count);
    });
    socket1.on('match_started', (data) => {
      console.log('✔ Match Started! Initial targets:', data.targetRound.targets.length, 'duration:', data.duration);
      if (data.duration !== 240) throw new Error(`Expected 240s duration, got ${data.duration}`);
      if (shotDuringCountdownFired) throw new Error('Shot during countdown should not consume ammo or be processed by server');
      console.log('✔ Verified shooting during countdown was rejected by server');
      resolve(data);
    });
  });

  const matchData = await countdownPromise;
  if (!countdownTicks.includes('BEGIN!')) throw new Error('Countdown did not conclude with BEGIN!');

  // 6. Test authoritative board hit detection and one-point hit-once scoring.
  const firstRound = matchData.targetRound;
  if (!firstRound || firstRound.targets.length === 0) throw new Error('Match did not start with active targets');

  let confirmedHit = null;
  const onHit = (hitData) => { confirmedHit = hitData; };
  socket1.on('hit_confirmed', onHit);
  const scoreUpdatePromise = new Promise((resolve) => {
    socket2.once('score_update', resolve);
  });

  let successfulShot = null;
  for (const target of firstRound.targets) {
    const origin = { x: -4, y: 1.7, z: 0 };
    const point = { x: target.x, y: target.y + 2.1, z: target.z + 0.12 };
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const dz = point.z - origin.z;
    const length = Math.hypot(dx, dy, dz);
    const shot = {
      origin,
      direction: { x: dx / length, y: dy / length, z: dz / length },
      targetId: target.id
    };
    const ammoPromise = new Promise(resolve => socket1.once('ammo_update', resolve));
    socket1.emit('player_shoot', shot);
    await ammoPromise;
    await new Promise(resolve => setTimeout(resolve, 15));
    if (confirmedHit) {
      successfulShot = shot;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 110));
  }

  if (!confirmedHit || !successfulShot) throw new Error('No target board ray hit was confirmed');
  socket1.off('hit_confirmed', onHit);
  if (confirmedHit.points !== 1) throw new Error(`Expected +1 point, got ${confirmedHit.points}`);
  const scoreData = await scoreUpdatePromise;
  if (scoreData.allScores[1].score !== 1) throw new Error('Opponent did not receive synchronized target score');
  console.log(`✔ Server confirmed ${confirmedHit.targetId}; opponent score sync: ${scoreData.allScores[1].score}`);

  let duplicateHit = false;
  const onDuplicateHit = () => { duplicateHit = true; };
  socket1.on('hit_confirmed', onDuplicateHit);
  await new Promise(resolve => setTimeout(resolve, 110));
  const duplicateAmmo = new Promise(resolve => socket1.once('ammo_update', resolve));
  socket1.emit('player_shoot', successfulShot);
  await duplicateAmmo;
  await new Promise(resolve => setTimeout(resolve, 30));
  socket1.off('hit_confirmed', onDuplicateHit);
  if (duplicateHit) throw new Error('A previously hit board awarded points twice');
  console.log('✔ Duplicate hit correctly ignored');

  // 8. Test Reloading
  console.log('Testing reload sequence...');
  await new Promise(r => setTimeout(r, 200));
  const reloadPromise = new Promise((resolve) => {
    socket1.once('reload_completed', (ammoData) => {
      console.log(`✔ Reload completed! Magazine restored to ${ammoData.magazine}`);
      resolve(ammoData);
    });
  });
  socket1.emit('player_reload');
  await reloadPromise;

  console.log('--- ALL MULTIPLAYER & GAMEPLAY E2E TESTS PASSED SUCCESSFULLY! ---');

  socket1.disconnect();
  socket2.disconnect();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
