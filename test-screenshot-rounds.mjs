import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:7891/', { waitUntil: 'networkidle' });

// Create a workout with rounds to screenshot
await page.click('#btn-new');
await page.fill('#field-name', 'Tabata');
await page.fill('#field-leadin', '5');
await page.fill('#field-rounds', '8');
// Turn off loop on warm-up by adding one at top... just show existing intervals
await page.screenshot({ path: '/tmp/hiit-edit-rounds.png' });

// Start to see timer with round display
await page.click('#btn-edit-save');
await page.click('.btn-play');
await page.waitForSelector('#view-timer.active');
await page.waitForTimeout(6200); // get past lead-in into first work interval
await page.screenshot({ path: '/tmp/hiit-timer-round.png' });
await browser.close();
