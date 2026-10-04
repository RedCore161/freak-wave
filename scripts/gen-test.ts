// Generates a few levels headlessly and reports timing and difficulty.
// Run with: node scripts/gen-test.ts
import { generateLevel } from '../src/level/generator.ts';

for (let index = 0; index < 9; index++) {
  const t0 = performance.now();
  const level = generateLevel({ index, seed: 1000 + index * 7919 });
  const ms = performance.now() - t0;
  const cities = level.cities.map((c) => `L${c.level} wall ${c.protection}m hp ${c.hp}`).join(' | ');
  console.log(
    `#${index} ${level.name.padEnd(18)} ${ms.toFixed(0).padStart(5)} ms  timing ${level.timingRatio.toFixed(2)}  ` +
      `quakes ${level.inventory.length}  delays ${level.witness.map((q) => q.delay.toFixed(1)).join(',')}  ${cities}`,
  );
}
