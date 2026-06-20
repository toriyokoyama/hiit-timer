import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Capture console errors
const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push(err.message));

await page.goto('http://localhost:7891/', { waitUntil: 'networkidle' });

// ── Screenshot 1: Workout list (empty state) ──────────────────────────────
await page.screenshot({ path: '/tmp/hiit-01-empty.png' });
console.log('1. Empty list loaded');

// ── Create a workout ──────────────────────────────────────────────────────
await page.click('#btn-new');
await page.waitForSelector('#view-edit.active');
await page.screenshot({ path: '/tmp/hiit-02-edit-new.png' });
console.log('2. Edit view opened');

await page.fill('#field-name', 'Tabata 20/10');
await page.fill('#field-leadin', '5');

// The two default intervals (Work 20s, Rest 10s) should already be there
// Verify they're present
const rows = await page.$$('.interval-row');
console.log(`   Interval rows: ${rows.length}`);

// Add a third interval
await page.click('#btn-add-interval');
const newRows = await page.$$('.interval-row');
console.log(`   After add: ${newRows.length} rows`);

// Fill the third interval
const labels = await page.$$('.inp-label');
const durations = await page.$$('.inp-duration');
await labels[2].fill('Cool Down');
await durations[2].fill('30');

await page.screenshot({ path: '/tmp/hiit-03-edit-filled.png' });
console.log('3. Intervals filled');

// ── Save the workout ──────────────────────────────────────────────────────
await page.click('#btn-edit-save');
await page.waitForSelector('#view-list.active');
await page.screenshot({ path: '/tmp/hiit-04-list-with-workout.png' });
console.log('4. Workout saved, list shown');

// Verify it appears
const cardName = await page.$eval('.workout-card-name', el => el.textContent);
const cardMeta = await page.$eval('.workout-card-meta', el => el.textContent);
console.log(`   Card: "${cardName}" — ${cardMeta}`);

// ── Start the timer ───────────────────────────────────────────────────────
await page.click('.btn-play');
await page.waitForSelector('#view-timer.active');
await page.screenshot({ path: '/tmp/hiit-05-timer-start.png' });

const label = await page.$eval('#timer-segment-label', el => el.textContent);
const countdown = await page.$eval('#timer-countdown', el => el.textContent);
const nextTxt = await page.$eval('#timer-next', el => el.textContent);
console.log(`5. Timer started — segment: "${label}", countdown: "${countdown}", next: "${nextTxt}"`);

// Wait 1.5s and re-check countdown decremented
await page.waitForTimeout(1500);
const countdown2 = await page.$eval('#timer-countdown', el => el.textContent);
console.log(`   After 1.5s: "${countdown2}"`);
await page.screenshot({ path: '/tmp/hiit-06-timer-running.png' });

// ── Pause ─────────────────────────────────────────────────────────────────
await page.click('#btn-pause-resume');
await page.waitForTimeout(200);
const pauseBtn = await page.$eval('#btn-pause-resume', el => el.textContent);
await page.screenshot({ path: '/tmp/hiit-07-timer-paused.png' });
console.log(`6. Paused — button says: "${pauseBtn}"`);

// ── Resume ────────────────────────────────────────────────────────────────
await page.click('#btn-pause-resume');
await page.waitForTimeout(200);
const resumeBtn = await page.$eval('#btn-pause-resume', el => el.textContent);
await page.screenshot({ path: '/tmp/hiit-08-timer-resumed.png' });
console.log(`7. Resumed — button says: "${resumeBtn}"`);

// ── Stop ──────────────────────────────────────────────────────────────────
page.once('dialog', d => d.accept());
await page.click('#btn-timer-stop');
await page.waitForSelector('#view-list.active');
await page.screenshot({ path: '/tmp/hiit-09-back-to-list.png' });
console.log('8. Stopped — back to list');

// ── Edit existing workout ─────────────────────────────────────────────────
await page.click('[data-action="edit"]');
await page.waitForSelector('#view-edit.active');
const heading = await page.$eval('#edit-heading', el => el.textContent);
await page.screenshot({ path: '/tmp/hiit-10-edit-existing.png' });
console.log(`9. Editing existing — heading: "${heading}"`);
await page.click('#btn-edit-cancel');

// ── Delete workout ────────────────────────────────────────────────────────
page.once('dialog', d => d.accept());
await page.click('[data-action="delete"]');
await page.waitForSelector('.empty-state:not(.hidden)');
await page.screenshot({ path: '/tmp/hiit-11-deleted-empty.png' });
console.log('10. Workout deleted — empty state shown');

// ── Summary ───────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.log('\nJS ERRORS:');
  errors.forEach(e => console.log('  ERR:', e));
} else {
  console.log('\nNo JS errors detected.');
}

await browser.close();
