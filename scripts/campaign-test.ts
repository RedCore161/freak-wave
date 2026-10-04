// Parses every campaign map, generates its level and checks it plays fair:
// the witness solution works, timing matters, and estimates line up.
// Run with: node scripts/campaign-test.ts
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseMapImage } from '../src/level/mapImage.ts';
import { generateLevel } from '../src/level/generator.ts';

/** Minimal decoder for the 8-bit RGBA, filter-0 PNGs that make-levels writes. */
function readPng(path: string) {
  const buf = readFileSync(path);
  let o = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  return { px, w, h };
}

const seedFor = (index: number) => (Math.imul(index + 1, 2654435761) ^ 0x5eed) >>> 0;
const entries = JSON.parse(readFileSync('public/levels/levels.json', 'utf8'));
entries.forEach((e: { name: string; image: string; quakes?: string[]; inventory?: string[] }, index: number) => {
  const { px, w, h } = readPng(`public/levels/${e.image}`);
  const map = parseMapImage(px, w, h);
  const t0 = performance.now();
  try {
    const level = generateLevel({ index, seed: seedFor(index), map, name: e.name, quakes: e.quakes as never, inventory: e.inventory as never });
    const ms = performance.now() - t0;
    const cities = level.cities.map((c) => `${c.bonus ? "B" : "L"}${c.level} wall ${c.protection} hp ${c.hp}`).join(" | ") + ` (need ${level.required})`;
    console.log(
      `#${index + 1} ${e.name.padEnd(16)} ${ms.toFixed(0).padStart(5)} ms  timing ${level.timingRatio.toFixed(2)}  ` +
        `spawns ${map.spawns.length} zones ${level.zones.map((z) => z.threshold).join(',') || '-'}  ` +
        `inv ${level.inventory.length} delays ${level.witness.map((q) => q.delay.toFixed(1)).join(',')}  ${cities}`,
    );
  } catch (err) {
    console.log(`#${index + 1} ${e.name}: FAILED ${err}`);
  }
});
