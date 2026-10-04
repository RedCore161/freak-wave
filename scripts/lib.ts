// Shared helpers for the headless scripts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseMapImage } from '../src/level/mapImage.ts';
import { generateLevel } from '../src/level/generator.ts';
import type { LevelData } from '../src/level/types.ts';
import { CONFIG } from '../src/config.ts';

/** Minimal decoder for the 8-bit RGBA, filter-0 PNGs that make-levels writes. */
export function readPng(path: string) {
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


export const seedFor = (index: number) => (Math.imul(index + 1, 2654435761) ^ 0x5eed) >>> 0;

/** Generates the hand-made campaign exactly as the game does. */
export function loadCampaign(only?: number): LevelData[] {
  const entries = JSON.parse(readFileSync('public/levels/levels.json', 'utf8'));
  return entries
    .map((e: { name: string; image: string; quakes?: string[]; inventory?: string[] }, index: number) => {
      if (only !== undefined && only !== index) return null;
      const { px, w, h } = readPng(`public/levels/${e.image}`);
      return generateLevel({ index, seed: seedFor(index), map: parseMapImage(px, w, h), name: e.name, quakes: e.quakes as never, inventory: e.inventory as never });
    })
    .filter(Boolean);
}

const CACHE_SOURCES = [
  'public/levels/levels.json',
  'src/level/generator.ts',
  'src/level/plan.ts',
  'src/level/mapImage.ts',
  'src/level/placement.ts',
  'src/sim/WaveSim.ts',
  'src/sim/quakes.ts',
  'src/sim/cities.ts',
  'src/sim/constants.ts',
];

/**
 * Same as loadCampaign, cached in .cache/ keyed by a hash of everything that
 * affects generation (maps, generator code, the config's generator section).
 */
export function loadCampaignCached(): LevelData[] {
  const hash = createHash('sha1');
  for (const f of CACHE_SOURCES) hash.update(readFileSync(f));
  for (const f of readdirSync('public/levels').filter((n) => n.endsWith('.png')).sort()) hash.update(readFileSync(`public/levels/${f}`));
  hash.update(JSON.stringify(CONFIG.generator) + JSON.stringify(CONFIG.rules));
  const file = `.cache/campaign-${hash.digest('hex').slice(0, 12)}.json`;
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as (Omit<LevelData, 'land'> & { land: number[] })[];
    return raw.map((l) => ({ ...l, land: Uint8Array.from(l.land) }));
  }
  const levels = loadCampaign();
  mkdirSync('.cache', { recursive: true });
  writeFileSync(file, JSON.stringify(levels.map((l) => ({ ...l, land: Array.from(l.land) }))));
  return levels;
}
