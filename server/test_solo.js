const { io } = require('socket.io-client');

async function testSolo() {
  console.log('Testing Solo Practice Range mode...');
  const port = Number(process.env.PORT) || 3000;
  const socket = io(`http://localhost:${port}`, { transports: ['websocket'] });
  await new Promise(r => socket.on('connect', r));

  const roomPromise = new Promise(r => {
    socket.on('room_created', (data) => {
      console.log('✔ Solo Room Created:', data.roomCode);
      r(data);
    });
  });

  socket.emit('create_solo_practice', { name: 'Solo Commando', device: 'pc' });
  await roomPromise;

  const countdownPromise = new Promise(r => {
    socket.on('countdown_tick', (data) => {
      console.log('  [Countdown]:', data.count);
      if (data.count === 'BEGIN!' || data.count === 'GO') r();
    });
  });
  await countdownPromise;

  const matchStartedPromise = new Promise(r => {
    socket.on('match_started', (data) => {
      console.log('✔ Solo Match Started! Duration:', data.duration);
      r(data);
    });
  });
  await matchStartedPromise;

  console.log('✔ Solo practice mode verified successfully!');
  socket.disconnect();
  process.exit(0);
}

testSolo().catch(e => {
  console.error(e);
  process.exit(1);
});
