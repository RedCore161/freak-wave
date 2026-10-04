// Shared helpers for the headless scripts.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { parseMapImage } from '../src/level/mapImage.ts';
import { generateLevel } from '../src/level/generator.ts';
import type { LevelData } from '../src/level/types.ts';

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
