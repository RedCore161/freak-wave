import type { QuakeKind } from '../sim/quakes.ts';
import { parseMapImage, type MapMarkers } from './mapImage.ts';
import type { LevelData, LevelRequest } from './types.ts';

interface HandmadeEntry {
  name: string;
  image: string;
  quakes?: QuakeKind[];
  inventory?: QuakeKind[];
  hint?: string;
}

/**
 * The campaign: hand-made maps from public/levels/levels.json in order, then
 * procedural seas. Every level has a fixed seed, so a sea is identical in
 * every run. The game is about skill, not luck.
 */
let manifest: Promise<HandmadeEntry[]> | null = null;

function loadManifest(): Promise<HandmadeEntry[]> {
  manifest ??= fetch(`${import.meta.env.BASE_URL}levels/levels.json`)
    .then((r) => (r.ok ? (r.json() as Promise<HandmadeEntry[]>) : []))
    .catch(() => []);
  return manifest;
}

/** Names of the hand-made seas, in campaign order. */
export async function campaignNames(): Promise<string[]> {
  return (await loadManifest()).map((e) => e.name);
}

async function loadMap(url: string): Promise<MapMarkers> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return parseMapImage(data, canvas.width, canvas.height);
}

/** Fixed seed per level index. */
export function levelSeed(index: number): number {
  return (Math.imul(index + 1, 2654435761) ^ 0x5eed) >>> 0;
}

export class LevelSource {
  private worker = new Worker(new URL('./genWorker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, { resolve: (l: LevelData) => void; reject: (e: Error) => void }>();
  private cache = new Map<number, Promise<LevelData>>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; level?: LevelData; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.level) p.resolve(e.data.level);
      else p.reject(new Error(e.data.error ?? 'Level generation failed'));
    };
  }

  /** Returns (and caches) a level; call early to prefetch. */
  get(index: number): Promise<LevelData> {
    let p = this.cache.get(index);
    if (!p) {
      p = this.build(index);
      this.cache.set(index, p);
      p.catch(() => this.cache.delete(index));
    }
    return p;
  }

  private async build(index: number): Promise<LevelData> {
    const req: LevelRequest = { index, seed: levelSeed(index) };
    const entries = await loadManifest();
    const entry = entries[index];
    if (entry) {
      req.map = await loadMap(`${import.meta.env.BASE_URL}levels/${entry.image}`);
      req.name = entry.name;
      req.quakes = entry.quakes;
      req.inventory = entry.inventory;
      req.hint = entry.hint;
    }
    return new Promise<LevelData>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, req });
    });
  }
}
