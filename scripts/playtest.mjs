// Automated playtest against the dev server: starts a run, places one quake by
// clicking (to exercise input), then applies the generator's verified witness
// solution (with delays), unleashes and records the outcome per level.
// Usage: npm run dev (in another shell), then
//   LEVELS=3 node scripts/playtest.mjs [url] [width] [height]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 800);
const levels = Number(process.env.LEVELS ?? 1);
const out = process.env.SHOTS ?? 'playtest-shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url);
await page.waitForSelector('.title-panel');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/1-menu.png` });
await page.click('.title-panel .btn.primary');
// First run shows the tutorial: page through it once.
await page.waitForSelector('.tutorial-panel');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/1b-tutorial.png` });
for (let i = 0; i < 4; i++) await page.click('.tutorial-panel .btn.primary');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/1c-tutorial-last.png` });
await page.click('.tutorial-panel .btn.primary');

for (let lvl = 0; lvl < levels; lvl++) {
  if (lvl > 0) await page.click('text=Next sea');
  await page.waitForSelector('.tray .btn.primary', { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/2-level-${lvl}.png` });

  // Click inside the first epicenter to check placement works.
  const spot = await page.evaluate(() => {
    const { game, view } = window.__freakwave;
    const s = game.spawns[0];
    const rect = view.renderer.domElement.getBoundingClientRect();
    const p = view.project(s.x, s.y);
    return { x: p.x + rect.left, y: p.y + rect.top };
  });
  await page.mouse.click(spot.x, spot.y);
  const placed = await page.evaluate(() => window.__freakwave.game.quakes.length);
  console.log(`Level ${lvl + 1}: click placement ${placed === 1 ? 'ok' : 'FAILED'}`);

  await page.evaluate(() => window.__freakwave.game.debugApplyWitness());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/3-planned-${lvl}.png` });
  await page.click('text=Unleash');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}/4-running-${lvl}.png` });
  await page.waitForSelector('.overlay:not([hidden]) .result', { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/5-result-${lvl}.png` });
  const result = await page.textContent('.overlay .panel');
  console.log(`Level ${lvl + 1}:`, result?.replace(/\s+/g, ' ').slice(0, 220));
  if (!result?.includes('Next sea')) break;
}

await page.click('text=Skill tree');
await page.waitForTimeout(600);
await page.hover('.skill:nth-of-type(2)');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/6-skills.png` });
await page.click('.skill.buyable, .skill');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/7-skill-detail.png` });

// Back to the menu, then open settings from its corner gear.
await page.click('text=Done');
await page.waitForTimeout(400);
await page.click('text=Give up');
await page.waitForSelector('.title-panel .corner');
await page.click('.title-panel .corner');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/8-settings.png` });
await page.click('.settings-panel .btn.primary');
await page.waitForTimeout(400);
await page.click('.title-panel .btn.primary');
await page.waitForSelector('.level-grid');
await page.waitForTimeout(700);
await page.screenshot({ path: out + '/9-levels.png' });
// Replay sea 1 and fail on purpose with a single quake far outside the epicenters.
await page.click('.level-card');
await page.waitForSelector('.tray .btn.primary', { timeout: 60000 });
await page.waitForTimeout(1500);
const far = await page.evaluate(() => {
  const { view } = window.__freakwave;
  const rect = view.renderer.domElement.getBoundingClientRect();
  const p = view.project(60, 85);
  return { x: p.x + rect.left, y: p.y + rect.top };
});
await page.mouse.move(far.x, far.y);
await page.waitForTimeout(200);
await page.mouse.click(far.x, far.y);
await page.waitForTimeout(300);
await page.screenshot({ path: out + '/10-weak-quake.png' });
await page.click('text=Unleash');
await page.waitForSelector('.overlay:not([hidden]) .result', { timeout: 90000 });
await page.waitForTimeout(1500);
console.log('Failed attempt:', (await page.textContent('.overlay .panel')).replace(/s+/g, ' ').slice(0, 200));
console.log(errors.length ? `Errors:\n${errors.join('\n')}` : 'No page errors');
await browser.close();
