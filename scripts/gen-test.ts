// Generates a few levels headlessly and reports timing and difficulty.
// Run with: node scripts/gen-test.ts
import { generateLevel } from '../src/level/generator.ts';

for (let index = 0; index < 8; index++) {
  const t0 = performance.now();
  const level = generateLevel({ index, seed: 1000 + index * 7919 });
  const ms = performance.now() - t0;
  const land = level.land.reduce((a, b) => a + b, 0) / level.land.length;
  console.log(
    `#${index} ${level.name.padEnd(20)} ${ms.toFixed(0).padStart(5)} ms  land ${(land * 100).toFixed(0)}%  ` +
      `solo ${level.soloRatio.toFixed(2)}  quakes ${level.inventory.join(',')}  targets ${level.targets.map((t, k) => `${t.required}m (single best ${level.singleBest[k].toFixed(1)})`).join(' ')}`,
  );
}
