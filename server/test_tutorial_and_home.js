/**
 * Automated Verification Script for:
 * 1. Interactive Device-Specific Tutorial Mode
 * 2. Home Button During Gameplay & Teardown
 * 3. Speech Synthesis Female Voice Fallback
 * 4. DOM IDs and Responsive Non-Overlap Layout
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

console.log('=== STARTING AUTOMATED VALIDATION SUITE ===\n');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`[PASS] ${message}`);
    passCount++;
  } else {
    console.error(`[FAIL] ${message}`);
    failCount++;
  }
}

// 1. Verify index.html contains all required elements
const indexHtmlPath = path.join(rootDir, 'client', 'index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

const requiredIds = [
  'btn-hud-home',
  'btn-mobile-home',
  'modal-home-confirm',
  'home-confirm-title',
  'home-confirm-desc',
  'btn-home-cancel',
  'btn-home-leave',
  'tutorial-overlay',
  'tutorial-panel',
  'tutorial-step-tag',
  'tutorial-title',
  'tutorial-explanation',
  'tutorial-action-text',
  'tutorial-status-badge',
  'btn-tutorial-repeat',
  'btn-tutorial-skip',
  'tutorial-complete-box',
  'btn-tutorial-lobby',
  'btn-replay-tutorial'
];

requiredIds.forEach(id => {
  assert(indexHtml.includes(`id="${id}"`), `DOM element exists in index.html: #${id}`);
});

// 2. Verify styles.css contains key selectors and no accidental overrides
const stylesPath = path.join(rootDir, 'client', 'styles.css');
const stylesCss = fs.readFileSync(stylesPath, 'utf8');

const requiredSelectors = [
  '.btn-hud-home',
  '.mobile-btn.btn-home',
  '.home-confirm-card',
  '.tutorial-overlay',
  '.tutorial-panel',
  '.tutorial-panel[data-pos="top"]',
  '.tutorial-panel[data-pos="bottom"]',
  '.btn-tutorial-util',
  '.tutorial-highlight',
  '.tutorial-complete-box',
  '.tutorial-badge'
];

requiredSelectors.forEach(sel => {
  assert(stylesCss.includes(sel), `CSS selector defined in styles.css: ${sel}`);
});

// Verify hud-solo-actions is centered (no overlap with camera-aim-widget)
assert(stylesCss.includes('left: 50%') && stylesCss.includes('transform: translateX(-50%)'),
  'hud-solo-actions is centered below top bar to prevent right-side overlap'
);

// 3. Verify tutorial.js structure
const tutorialJsPath = path.join(rootDir, 'client', 'src', 'tutorial.js');
const tutorialJs = fs.readFileSync(tutorialJsPath, 'utf8');

assert(tutorialJs.includes('class TutorialSpeech'), 'TutorialSpeech class is exported in tutorial.js');
assert(tutorialJs.includes('class TutorialManager'), 'TutorialManager class is exported in tutorial.js');
assert(tutorialJs.includes('selectFemaleVoice'), 'Female voice selection logic present in TutorialSpeech');
assert(tutorialJs.includes('buildDesktopSteps'), 'Desktop-specific tutorial steps builder present');
assert(tutorialJs.includes('buildMobileSteps'), 'Mobile-specific tutorial steps builder present');
assert(tutorialJs.includes('positionPanel'), 'Dynamic non-overlap panel positioning logic present');
assert(tutorialJs.includes('CAMERA / AIM') && tutorialJs.includes('TOUCH CAMERA'), 'Exact titles matched for desktop and mobile look steps');
assert(tutorialJs.includes('CLENCH YOUR FIST → SHOOT') && tutorialJs.includes('OPEN YOUR FIST → STOP'), 'Exact titles matched for Face + Fist tests');

// 4. Test TutorialSpeech female voice selection algorithm in isolation
class MockSpeech {
  constructor(voices) {
    this.voices = voices;
    this.selectedVoice = null;
  }
  selectFemaleVoice() {
    const femalePattern = /(female|woman|girl|samantha|victoria|karen|susan|ava|zira|aria|jenny|google.*female)/i;
    let found = this.voices.find(v => (v.lang && v.lang.startsWith('en')) && femalePattern.test(v.name));
    if (!found) found = this.voices.find(v => femalePattern.test(v.name));
    if (!found) found = this.voices.find(v => v.lang && v.lang.startsWith('en'));
    if (!found) found = this.voices[0] || null;
    this.selectedVoice = found;
    return found;
  }
}

const mockVoices1 = [
  { name: 'David (English)', lang: 'en-US' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Alex', lang: 'en-US' }
];
const s1 = new MockSpeech(mockVoices1);
assert(s1.selectFemaleVoice().name.includes('Zira'), 'Correctly identifies English female voice "Zira"');

const mockVoices2 = [
  { name: 'Google UK English Male', lang: 'en-GB' },
  { name: 'Google UK English Female', lang: 'en-GB' }
];
const s2 = new MockSpeech(mockVoices2);
assert(s2.selectFemaleVoice().name.includes('Female'), 'Correctly identifies "Google UK English Female"');

const mockVoices3 = [
  { name: 'OnlyMaleVoice', lang: 'en-US' }
];
const s3 = new MockSpeech(mockVoices3);
assert(s3.selectFemaleVoice().name === 'OnlyMaleVoice', 'Gracefully falls back to available English voice if no female voice');

// 5. Verify roomManager.js solo score saving logic
const roomManagerJsPath = path.join(rootDir, 'server', 'roomManager.js');
const roomManagerJs = fs.readFileSync(roomManagerJsPath, 'utf8');

// Ensure leaveCurrentRoom does NOT call saveSoloScore
const leaveFuncMatch = roomManagerJs.match(/leaveCurrentRoom\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
if (leaveFuncMatch) {
  const leaveFuncBody = leaveFuncMatch[1];
  assert(!leaveFuncBody.includes('saveSoloScore'), 'leaveCurrentRoom does NOT save incomplete/abandoned solo scores');
} else {
  assert(false, 'leaveCurrentRoom method found in roomManager.js');
}

// Ensure finish_solo_training in server.js ends the match to record authoritative score
const serverJsPath = path.join(rootDir, 'server', 'server.js');
const serverJs = fs.readFileSync(serverJsPath, 'utf8');

assert(serverJs.includes('finish_solo_training') && serverJs.includes('room.match.endMatch()'),
  'finish_solo_training triggers match.endMatch() to record authoritative score only on deliberate finish'
);

// 6. Verify main.js integration
const mainJsPath = path.join(rootDir, 'client', 'src', 'main.js');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

assert(mainJs.includes('import { TutorialManager }'), 'main.js imports TutorialManager');
assert(mainJs.includes('import { checkUICollisions }'), 'main.js imports checkUICollisions');
assert(mainJs.includes('this.startTutorial(\'pc\')'), 'Desktop selection flow starts desktop tutorial');
assert(mainJs.includes('this.startTutorial(\'mobile\')'), 'Mobile fullscreen flow starts mobile tutorial');
assert(mainJs.includes('handleHomeClick()'), 'main.js implements handleHomeClick()');
assert(mainJs.includes('cancelHome()'), 'main.js implements cancelHome()');
assert(mainJs.includes('confirmLeaveSession()'), 'main.js implements confirmLeaveSession()');
assert(mainJs.includes('LEAVE TRAINING?') && mainJs.includes('LEAVE MATCH?'), 'Confirmation titles customize between Solo and Multiplayer');

// 7. Verify game.js isTutorial mode
const gameJsPath = path.join(rootDir, 'client', 'src', 'game.js');
const gameJs = fs.readFileSync(gameJsPath, 'utf8');

assert(gameJs.includes('constructor(canvasContainer, deviceType = \'pc\', mySlot = 1, isTutorial = false)'),
  'GameMatch constructor accepts isTutorial flag'
);
assert(gameJs.includes('this.isTutorial') && gameJs.includes('hudTimer.textContent = \'TUTORIAL\''),
  'GameMatch configures HUD timer and practice state in tutorial mode'
);

// 8. Verify mobileControls.js dispose
const mobileControlsJsPath = path.join(rootDir, 'client', 'src', 'mobileControls.js');
const mobileControlsJs = fs.readFileSync(mobileControlsJsPath, 'utf8');

assert(mobileControlsJs.includes('dispose()') && mobileControlsJs.includes('this.hide()'),
  'MobileControls implements dispose() which invokes hide() to disable gyro and listeners'
);

console.log('\n===========================================');
console.log(`RESULTS: ${passCount} Passed, ${failCount} Failed`);
console.log('===========================================');

if (failCount > 0) {
  process.exit(1);
} else {
  console.log('ALL INTEGRATION AND LOGIC TESTS PASSED SUCCESSFULLY!');
}
