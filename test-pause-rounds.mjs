import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto('http://localhost:7891/', { waitUntil: 'networkidle' });

// ── Create a workout with rounds ───────────────────────────────────────────
await page.click('#btn-new');
await page.fill('#field-name', 'Round Test');
await page.fill('#field-leadin', '3');
await page.fill('#field-rounds', '3');

// Default 2 intervals (Work/Rest) should both be in-loop
const loopBtns = await page.$$('.btn-loop-toggle');
const loopStates = await Promise.all(loopBtns.map(b => b.evaluate(el => el.classList.contains('in-loop'))));
console.log(`Loop toggles on default intervals: ${loopStates}`); // expect [true, true]

// Add a cool-down interval NOT in the loop
await page.click('#btn-add-interval');
const rows = await page.$$('.interval-row');
const allLabels    = await page.$$('.inp-label');
const allDurations = await page.$$('.inp-duration');
const allLoopBtns2 = await page.$$('.btn-loop-toggle');
await allLabels[2].fill('Cool Down');
await allDurations[2].fill('15');
const lastLoop = allLoopBtns2[2];
// Toggle it OFF (it defaults to in-loop since we set loop=true by default)
const isInLoop = await lastLoop.evaluate(el => el.classList.contains('in-loop'));
if (isInLoop) await lastLoop.click(); // turn it off
const finalLoopState = await lastLoop.evaluate(el => el.classList.contains('in-loop'));
console.log(`Cool Down loop state (should be false): ${finalLoopState}`);

await page.click('#btn-edit-save');
await page.waitForSelector('#view-list.active');

// Check meta — should show "3 intervals × 3 · ..."
const meta = await page.$eval('.workout-card-meta', el => el.textContent);
console.log(`Card meta: "${meta}"`);
// Work(20) + Rest(10) = 30s loop × 3 = 90s + lead-in 3s + cool-down 15s = 108s = 1m 48s
// Expect: "3 intervals × 3 · 1m 48s"

// ── Start timer and verify lead-in ─────────────────────────────────────────
await page.click('.btn-play');
await page.waitForSelector('#view-timer.active');
const label0 = await page.$eval('#timer-segment-label', el => el.textContent);
const round0 = await page.$eval('#timer-round', el => el.textContent);
console.log(`At start — label: "${label0}", round: "${round0}"`);
// During lead-in, round should be empty

// ── Pause immediately (during lead-in) and verify countdown doesn't reset ──
await page.waitForTimeout(1200); // let 1.2s pass
const countBefore = await page.$eval('#timer-countdown', el => el.textContent);
await page.click('#btn-pause-resume');
await page.waitForTimeout(300);

const countPaused = await page.$eval('#timer-countdown', el => el.textContent);
console.log(`Before pause: "${countBefore}", while paused: "${countPaused}"`);

await page.waitForTimeout(500); // wait 500ms while paused — count should NOT change
const countStillPaused = await page.$eval('#timer-countdown', el => el.textContent);
console.log(`500ms later (paused): "${countStillPaused}" (should equal "${countPaused}")`);

// ── Resume — verify we continue from where we left off, NOT from 0 ──────────
await page.click('#btn-pause-resume');
await page.waitForTimeout(200);
const countAfterResume = await page.$eval('#timer-countdown', el => el.textContent);
console.log(`After resume: "${countAfterResume}" (should be close to "${countPaused}", not "0:02")`);

// The resumed countdown should be ≤ paused countdown (time is moving forward)
// Parse and compare
const parse = s => { const [m, sec] = s.split(':').map(Number); return m * 60 + sec; };
const pausedSecs  = parse(countPaused);
const resumedSecs = parse(countAfterResume);
const diff = pausedSecs - resumedSecs;
console.log(`Diff (should be 0-1): ${diff}s`);
if (diff < 0 || diff > 2) {
  console.log('FAIL: Timer did not resume from paused position!');
} else {
  console.log('PASS: Pause/resume working correctly');
}

// ── Let timer run into first work interval, check round indicator ──────────
// Lead-in is 3s, we've already used ~2s. Wait for it to transition.
await page.waitForTimeout(3000);
const labelWork  = await page.$eval('#timer-segment-label', el => el.textContent);
const roundWork  = await page.$eval('#timer-round', el => el.textContent);
console.log(`In work interval — label: "${labelWork}", round: "${roundWork}"`);
// Should show "Round 1 / 3"

// ── Stop and clean up ──────────────────────────────────────────────────────
page.once('dialog', d => d.accept());
await page.click('#btn-timer-stop');
await page.waitForSelector('#view-list.active');

if (errors.length) {
  console.log('JS ERRORS:', errors);
} else {
  console.log('No JS errors.');
}

await browser.close();
