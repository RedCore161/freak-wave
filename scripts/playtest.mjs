// Automated playtest against the dev server: starts a run, places the
// generator's verified witness solution, runs the simulation and saves
// screenshots. Usage: npm run dev (in another shell), then
//   node scripts/playtest.mjs [url] [width] [height]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 800);
const out = process.env.SHOTS ?? 'playtest-shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url);
await page.waitForSelector('.title-panel');
await page.screenshot({ path: `${out}/1-menu.png` });

await page.click('text=Start run');
const levels = Number(process.env.LEVELS ?? 1);
for (let lvl = 0; lvl < levels; lvl++) {
if (lvl > 0) await page.click('text=Next sea');
await page.waitForSelector('.tray .btn.primary', { timeout: 30000 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/2-placing-${lvl}.png` });

// Place the witness solution by clicking where each quake belongs.
const clicks = await page.evaluate(() => {
  const { game, view } = window.__freakwave;
  const level = game.level;
  const rect = view.renderer.domElement.getBoundingClientRect();
  return level.witness.map((q) => {
    const p = view.project(q.x, q.y);
    return { kind: q.kind, x: p.x + rect.left, y: p.y + rect.top };
  });
});
for (const c of clicks) {
  await page.click(`.quake-card:has-text("${{ small: 'Tremor', medium: 'Quake', large: 'Megaquake' }[c.kind]}")`);
  await page.mouse.click(c.x, c.y);
}
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/3-placed-${lvl}.png` });

await page.click('text=Unleash');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/4-running-${lvl}.png` });
await page.waitForSelector('.overlay:not([hidden]) .panel', { timeout: 60000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/5-result-${lvl}.png` });
const result = await page.textContent('.overlay .panel');
console.log(`Level ${lvl + 1}:`, result?.replace(/\s+/g, ' ').slice(0, 200));
}

await page.click('text=Skill tree');
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/6-skills.png` });

console.log(errors.length ? `Errors:\n${errors.join('\n')}` : 'No page errors');
await browser.close();
