import { landFromRgba } from './terrain.ts';
import type { LevelData, LevelRequest } from './types.ts';

interface HandmadeEntry {
  name: string;
  image: string;
}

/**
 * Hand-made levels come from public/levels/levels.json: a list of alpha PNGs
 * (opaque = land, transparent = water). They open a run; procedural levels
 * follow. Targets and requirements are still verified by the generator.
 */
let manifest: Promise<HandmadeEntry[]> | null = null;

function loadManifest(): Promise<HandmadeEntry[]> {
  manifest ??= fetch(`${import.meta.env.BASE_URL}levels/levels.json`)
    .then((r) => (r.ok ? (r.json() as Promise<HandmadeEntry[]>) : []))
    .catch(() => []);
  return manifest;
}

async function loadLandFromImage(url: string): Promise<Uint8Array> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return landFromRgba(data, canvas.width, canvas.height);
}

export class LevelSource {
  private worker = new Worker(new URL('./genWorker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, { resolve: (l: LevelData) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<LevelData>>();
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

  /** Returns (and caches) the level for a run seed and index; call early to prefetch. */
  get(runSeed: number, index: number): Promise<LevelData> {
    const key = `${runSeed}:${index}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.build(runSeed, index);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  forgetRun(runSeed: number): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${runSeed}:`)) this.cache.delete(key);
  }

  private async build(runSeed: number, index: number): Promise<LevelData> {
    const req: LevelRequest = { index, seed: (runSeed * 31 + index * 7919) >>> 0 };
    const entries = await loadManifest();
    const entry = entries[index];
    if (entry) {
      try {
        req.land = await loadLandFromImage(`${import.meta.env.BASE_URL}levels/${entry.image}`);
        req.name = entry.name;
      } catch {
        // Fall back to a procedural level if the image is missing.
      }
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const transfer = req.land ? [req.land.buffer] : [];
      this.worker.postMessage({ id, req }, transfer);
    });
  }
}

