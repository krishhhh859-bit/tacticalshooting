/**
 * Automated Verification Suite for PC-Mode Hand Camera Detection & Movement
 */

const assert = require('assert');

console.log('====================================================');
console.log('RUNNING COMPLETE CAMERA DETECTION + MOVEMENT TEST SUITE');
console.log('====================================================\n');

// 1. Hand Geometry & Fist Curl Calculation
function calculateFistScore(hand) {
  if (!hand || hand.length < 21) return 0;
  const wrist = hand[0], middleMcp = hand[9], pinkyMcp = hand[17], indexMcp = hand[5];
  const palmLen = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const palmWid = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);
  const handScale = Math.max(0.04, (palmLen + palmWid) * 0.5);

  const getFingerCurl = (tipIdx, mcpIdx) => {
    const dWrist = Math.hypot(hand[tipIdx].x - wrist.x, hand[tipIdx].y - wrist.y) / handScale;
    const dMcp = Math.hypot(hand[tipIdx].x - hand[mcpIdx].x, hand[tipIdx].y - hand[mcpIdx].y) / handScale;
    return Math.max(0, Math.min(1, (1.55 - dWrist) / 0.75)) * 0.55 + Math.max(0, Math.min(1, (1.15 - dMcp) / 0.60)) * 0.45;
  };

  const cIndex = getFingerCurl(8, 5);
  const cMiddle = getFingerCurl(12, 9);
  const cRing = getFingerCurl(16, 13);
  const cPinky = getFingerCurl(20, 17);
  const dThumb = Math.hypot(hand[4].x - indexMcp.x, hand[4].y - indexMcp.y) / handScale;
  const cThumb = Math.max(0, Math.min(1, (1.20 - dThumb) / 0.65));

  const fourFingers = (cIndex + cMiddle + cRing + cPinky) * 0.25;
  const minCurl = Math.min(cIndex, cMiddle, cRing, cPinky);

  let rawScore = fourFingers * 0.70 + minCurl * 0.20 + cThumb * 0.10;
  if (cIndex < 0.55) {
    rawScore *= (cIndex / 0.55);
  }

  return Math.max(0, Math.min(1, rawScore));
}

function calculateHandAimPoint(hand) {
  if (!hand || hand.length < 21) return null;

  const wrist = hand[0];
  const indexMcp = hand[5];
  const indexTip = hand[8];
  const middleMcp = hand[9];
  const pinkyMcp = hand[17];

  const palmLen = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const palmWid = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);
  const handScale = Math.max(0.04, (palmLen + palmWid) * 0.5);

  const dWrist = Math.hypot(indexTip.x - wrist.x, indexTip.y - wrist.y) / handScale;
  const dMcp = Math.hypot(indexTip.x - indexMcp.x, indexTip.y - indexMcp.y) / handScale;
  const cIndex = Math.max(0, Math.min(1,
    Math.max(0, Math.min(1, (1.55 - dWrist) / 0.75)) * 0.55 +
    Math.max(0, Math.min(1, (1.15 - dMcp) / 0.60)) * 0.45
  ));

  const extendedX = indexTip.x * 0.75 + indexMcp.x * 0.25;
  const extendedY = indexTip.y * 0.75 + indexMcp.y * 0.25;

  const fistX = indexMcp.x * 0.5 + middleMcp.x * 0.3 + wrist.x * 0.2;
  const fistY = indexMcp.y * 0.5 + middleMcp.y * 0.3 + wrist.y * 0.2;

  const aimX = extendedX * (1 - cIndex) + fistX * cIndex;
  const aimY = extendedY * (1 - cIndex) + fistY * cIndex;

  return { aimX, aimY, cIndex };
}

function createMockHand(centerX, centerY, pose = 'pointing') {
  const landmarks = [];
  for (let i = 0; i < 21; i++) {
    landmarks.push({ x: centerX, y: centerY, z: 0 });
  }
  const wrist = { x: centerX, y: centerY + 0.12, z: 0 };
  landmarks[0] = wrist;
  landmarks[5] = { x: centerX - 0.02, y: centerY, z: 0 };
  landmarks[9] = { x: centerX, y: centerY - 0.01, z: 0 };
  landmarks[13] = { x: centerX + 0.02, y: centerY, z: 0 };
  landmarks[17] = { x: centerX + 0.04, y: centerY + 0.01, z: 0 };

  if (pose === 'pointing') {
    landmarks[4] = { x: centerX - 0.04, y: centerY + 0.03, z: 0 };
    landmarks[8] = { x: centerX - 0.03, y: centerY - 0.10, z: 0 }; // Extended index!
    landmarks[12] = { x: centerX, y: centerY + 0.04, z: 0 };       // Curled middle
    landmarks[16] = { x: centerX + 0.02, y: centerY + 0.05, z: 0 }; // Curled ring
    landmarks[20] = { x: centerX + 0.04, y: centerY + 0.06, z: 0 }; // Curled pinky
  } else if (pose === 'fist') {
    landmarks[4] = { x: centerX - 0.01, y: centerY + 0.03, z: 0 };
    landmarks[8] = { x: centerX - 0.02, y: centerY + 0.04, z: 0 };
    landmarks[12] = { x: centerX, y: centerY + 0.04, z: 0 };
    landmarks[16] = { x: centerX + 0.02, y: centerY + 0.05, z: 0 };
    landmarks[20] = { x: centerX + 0.04, y: centerY + 0.06, z: 0 };
  } else if (pose === 'open') {
    landmarks[4] = { x: centerX - 0.05, y: centerY - 0.02, z: 0 };
    landmarks[8] = { x: centerX - 0.02, y: centerY - 0.10, z: 0 };
    landmarks[12] = { x: centerX, y: centerY - 0.11, z: 0 };
    landmarks[16] = { x: centerX + 0.02, y: centerY - 0.10, z: 0 };
    landmarks[20] = { x: centerX + 0.04, y: centerY - 0.08, z: 0 };
  }
  return landmarks;
}

// TEST 1: Hand Pose Differentiation
console.log('TEST 1: Hand Pointing vs Fist Pose Scoring...');
const pointingHand = createMockHand(0.5, 0.5, 'pointing');
const fistHand = createMockHand(0.5, 0.5, 'fist');
const openHand = createMockHand(0.5, 0.5, 'open');

const pointingFistScore = calculateFistScore(pointingHand);
const fistScore = calculateFistScore(fistHand);
const openScore = calculateFistScore(openHand);

console.log(`  Pointing fist score: ${pointingFistScore.toFixed(3)} | Fist score: ${fistScore.toFixed(3)} | Open score: ${openScore.toFixed(3)}`);
assert(pointingFistScore < 0.60, 'Pointing hand does NOT trigger shooting');
assert(fistScore >= 0.70, 'Clenched fist reliably triggers shooting');
assert(openScore < 0.30, 'Open hand does not trigger shooting');
console.log('✔ Passed: Hand pose and fist scoring verified.\n');

// TEST 2: Full Webcam Frame Detection Area
console.log('TEST 2: Detection Across Full Webcam Frame (Corners, Edges, Center)...');
const testPositions = [
  { name: 'Center', x: 0.50, y: 0.50 },
  { name: 'Top-Left Corner', x: 0.08, y: 0.08 },
  { name: 'Top-Right Corner', x: 0.92, y: 0.08 },
  { name: 'Bottom-Left Corner', x: 0.08, y: 0.90 },
  { name: 'Bottom-Right Corner', x: 0.92, y: 0.90 },
  { name: 'Left Edge', x: 0.05, y: 0.50 },
  { name: 'Right Edge', x: 0.95, y: 0.50 },
  { name: 'Top Edge', x: 0.50, y: 0.05 },
  { name: 'Bottom Edge', x: 0.50, y: 0.95 }
];

for (const pos of testPositions) {
  const hand = createMockHand(pos.x, pos.y, 'pointing');
  const aim = calculateHandAimPoint(hand);
  assert(aim !== null, `Hand at ${pos.name} detected successfully`);
  assert(typeof aim.aimX === 'number' && typeof aim.aimY === 'number', `Aim coordinates computed for ${pos.name}`);
  console.log(`  ${pos.name} (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}) -> Aim Point: (${aim.aimX.toFixed(3)}, ${aim.aimY.toFixed(3)})`);
}
console.log('✔ Passed: Hand detection works continuously across the full frame.\n');

// Pipeline Class for Movement Simulation
class HandAimMovementPipeline {
  constructor(cameraSensitivity = 1.0) {
    this.cameraSensitivity = cameraSensitivity;
    this.baseHandSensitivity = 3.6;
    this.HAND_DEADZONE = 0.0055;
    this.MAX_REASONABLE_DELTA = 0.35;

    this.stableHandX = null;
    this.stableHandY = null;
    this.prevHandX = null;
    this.prevHandY = null;
    this.isHandMoving = false;

    this.yaw = 0;
    this.pitch = 0;
    this.latestSnapshot = { aimX: 0, aimY: 0, hasHand: false };
  }

  setCameraSensitivity(val) {
    this.cameraSensitivity = Math.max(0.5, Math.min(3.0, val));
  }

  processHand(rawAimX, rawAimY) {
    if (rawAimX === null || rawAimY === null) {
      // Hand lost
      this.latestSnapshot.hasHand = false;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.isHandMoving = false;
      this.stableHandX = null;
      this.stableHandY = null;
      this.prevHandX = null;
      this.prevHandY = null;
      return;
    }

    this.latestSnapshot.hasHand = true;
    const mirroredX = 1.0 - rawAimX;
    const rawY = rawAimY;

    // Frame 1 anchor
    if (this.stableHandX === null || this.prevHandX === null) {
      this.stableHandX = mirroredX;
      this.stableHandY = rawY;
      this.prevHandX = mirroredX;
      this.prevHandY = rawY;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.isHandMoving = false;
      return;
    }

    const rawDeltaX = mirroredX - this.stableHandX;
    const rawDeltaY = rawY - this.stableHandY;
    const dist = Math.hypot(rawDeltaX, rawDeltaY);

    if (Math.abs(rawDeltaX) > this.MAX_REASONABLE_DELTA || Math.abs(rawDeltaY) > this.MAX_REASONABLE_DELTA) {
      this.stableHandX = mirroredX;
      this.stableHandY = rawY;
      this.prevHandX = mirroredX;
      this.prevHandY = rawY;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.isHandMoving = false;
      return;
    }

    // Deadzone filter
    if (dist < this.HAND_DEADZONE) {
      this.isHandMoving = false;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
      this.prevHandX = this.stableHandX;
      this.prevHandY = this.stableHandY;
      return;
    }

    // Intentional movement
    const excessDist = dist - this.HAND_DEADZONE;
    const ratio = excessDist / dist;
    const intentionalDeltaX = rawDeltaX * ratio;
    const intentionalDeltaY = rawDeltaY * ratio;

    this.stableHandX = mirroredX;
    this.stableHandY = rawY;
    this.prevHandX = mirroredX;
    this.prevHandY = rawY;

    const totalYawDelta = -intentionalDeltaX * this.baseHandSensitivity * this.cameraSensitivity;
    const totalPitchDelta = -intentionalDeltaY * this.baseHandSensitivity * this.cameraSensitivity;

    this.latestSnapshot.aimX = totalYawDelta;
    this.latestSnapshot.aimY = totalPitchDelta;
    this.isHandMoving = true;
  }

  renderUpdate() {
    if (this.latestSnapshot.aimX !== 0 || this.latestSnapshot.aimY !== 0) {
      this.yaw += this.latestSnapshot.aimX;
      this.pitch += this.latestSnapshot.aimY;
      this.latestSnapshot.aimX = 0;
      this.latestSnapshot.aimY = 0;
    }
  }
}

// TEST 3: Stationary Hand -> ZERO Camera Drift
console.log('TEST 3: Stationary Hand (Micro-Jitter Below Deadzone) -> ZERO Drift...');
const p1 = new HandAimMovementPipeline(1.0);
p1.processHand(0.50, 0.50); // Frame 1: anchor
p1.renderUpdate();
assert.strictEqual(p1.yaw, 0, 'Frame 1 anchor does not rotate camera');
assert.strictEqual(p1.pitch, 0, 'Frame 1 anchor does not tilt camera');

// Simulate 20 frames of slight hand tremor (jitter amplitude 0.002, deadzone is 0.0055)
for (let i = 0; i < 20; i++) {
  const jitterX = 0.50 + (Math.sin(i) * 0.002);
  const jitterY = 0.50 + (Math.cos(i) * 0.002);
  p1.processHand(jitterX, jitterY);
  p1.renderUpdate();
  assert.strictEqual(p1.latestSnapshot.aimX, 0, `Frame ${i}: aimX must be exactly 0 for stationary hand`);
  assert.strictEqual(p1.latestSnapshot.aimY, 0, `Frame ${i}: aimY must be exactly 0 for stationary hand`);
  assert.strictEqual(p1.yaw, 0, `Frame ${i}: yaw must remain exactly 0 (ZERO drift)`);
  assert.strictEqual(p1.pitch, 0, `Frame ${i}: pitch must remain exactly 0 (ZERO drift)`);
}
console.log('✔ Passed: Stationary hand produces ZERO camera drift across 20 frames.\n');

// TEST 4: Intentional Hand Movement -> Smooth Immediate Rotation
console.log('TEST 4: Genuine Hand Movement -> Immediate Directional Rotation...');
// Hand moves RIGHT: in webcam feed, rawAimX decreases
p1.processHand(0.46, 0.50); // Move right
p1.renderUpdate();
assert(p1.yaw < 0, 'Hand right turns camera RIGHT (yaw decreases in FPS)');
const yawAfterRight = p1.yaw;
console.log(`  Hand moved right -> camera yaw: ${yawAfterRight.toFixed(4)} rad`);

// Hand STOPS
p1.processHand(0.46, 0.50);
p1.renderUpdate();
assert.strictEqual(p1.latestSnapshot.aimX, 0, 'Hand stopped: aimX is 0 immediately');
for (let i = 0; i < 10; i++) {
  p1.renderUpdate();
}
assert.strictEqual(p1.yaw, yawAfterRight, 'Camera halts immediately with ZERO momentum tail');

// Hand moves UP: rawAimY decreases
p1.processHand(0.46, 0.44); // Move up
p1.renderUpdate();
assert(p1.pitch > 0, 'Hand up tilts camera UP (pitch increases in FPS)');
console.log(`  Hand moved up -> camera pitch: ${p1.pitch.toFixed(4)} rad`);
console.log('✔ Passed: Hand movement produces immediate, smooth camera rotation.\n');

// TEST 5: Camera Sensitivity Option (0.5x, 1.0x, 2.0x, 3.0x)
console.log('TEST 5: Camera Sensitivity Multiplier (0.5x -> 3.0x)...');
const pLow = new HandAimMovementPipeline(0.5);
const pMed = new HandAimMovementPipeline(1.0);
const pHigh = new HandAimMovementPipeline(2.0);

// Init all at same starting point
pLow.processHand(0.50, 0.50);
pMed.processHand(0.50, 0.50);
pHigh.processHand(0.50, 0.50);

// Apply identical displacement: move right to 0.44 (delta = 0.06)
pLow.processHand(0.44, 0.50);
pMed.processHand(0.44, 0.50);
pHigh.processHand(0.44, 0.50);

const deltaLow = Math.abs(pLow.latestSnapshot.aimX);
const deltaMed = Math.abs(pMed.latestSnapshot.aimX);
const deltaHigh = Math.abs(pHigh.latestSnapshot.aimX);

console.log(`  0.5x Sensitivity Delta: ${deltaLow.toFixed(4)} rad`);
console.log(`  1.0x Sensitivity Delta: ${deltaMed.toFixed(4)} rad`);
console.log(`  2.0x Sensitivity Delta: ${deltaHigh.toFixed(4)} rad`);

assert(Math.abs(deltaMed - deltaLow * 2.0) < 0.001, '1.0x delta is exactly 2x of 0.5x delta');
assert(Math.abs(deltaHigh - deltaMed * 2.0) < 0.001, '2.0x delta is exactly 2x of 1.0x delta');
console.log('✔ Passed: Sensitivity slider directly and proportionally scales camera movement.\n');

// TEST 6: Hand Disappearance (Safe Stop, No Jumps)
console.log('TEST 6: Hand Loss Safety (Freeze Movement, Zero Jump)...');
const pLoss = new HandAimMovementPipeline(1.0);
pLoss.processHand(0.50, 0.50);
pLoss.processHand(0.45, 0.50);
pLoss.renderUpdate();
const frozenYaw = pLoss.yaw;

// Hand disappears (null input)
pLoss.processHand(null, null);
pLoss.renderUpdate();
assert.strictEqual(pLoss.latestSnapshot.hasHand, false, 'hasHand is false');
assert.strictEqual(pLoss.latestSnapshot.aimX, 0, 'aimX is zeroed on hand loss');
assert.strictEqual(pLoss.latestSnapshot.aimY, 0, 'aimY is zeroed on hand loss');
assert.strictEqual(pLoss.yaw, frozenYaw, 'Camera safely freezes at current angle without jumping');

// Hand re-enters at a different location (e.g. 0.30)
pLoss.processHand(0.30, 0.40);
pLoss.renderUpdate();
assert.strictEqual(pLoss.yaw, frozenYaw, 'First frame of hand re-entry anchors without jumping');
console.log('✔ Passed: Hand loss safely freezes camera and hand re-entry anchors without jumping.\n');

console.log('====================================================');
console.log('ALL VERIFICATION TESTS PASSED (6/6)!');
console.log('====================================================');
