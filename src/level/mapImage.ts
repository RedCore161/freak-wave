import { GRID_H, GRID_W } from '../sim/constants.ts';
import { cleanup } from './terrain.ts';
import type { SpawnArea } from './types.ts';

// Level maps are RGBA images. Transparent pixels are water, opaque pixels are
// land, and a few marker colours place gameplay elements:
//
//   #FF0000 red      city, level 1   (draw on the coast; counts as land)
//   #FF8000 orange   city, level 2
//   #FF00FF magenta  city, level 3
//   #00FFFF cyan     bonus city (harder; optional), level 2
//   #00FF00 green    epicenter: a filled disc; its size sets the radius (water)
//   #FFFF00 yellow   golden chaos ring: a small dot (water)
//
// Colours are matched loosely so antialiased edges still count.

export interface MapMarkers {
  land: Uint8Array;
  cities: { x: number; y: number; level: number; bonus: boolean }[];
  spawns: SpawnArea[];
  zones: { x: number; y: number }[];
}

type Marker = 'city1' | 'city2' | 'city3' | 'bonus2' | 'spawn' | 'zone';

const LEGEND: { marker: Marker; rgb: [number, number, number] }[] = [
  { marker: 'city1', rgb: [255, 0, 0] },
  { marker: 'city2', rgb: [255, 128, 0] },
  { marker: 'city3', rgb: [255, 0, 255] },
  { marker: 'bonus2', rgb: [0, 255, 255] },
  { marker: 'spawn', rgb: [0, 255, 0] },
  { marker: 'zone', rgb: [255, 255, 0] },
];
const MATCH_DIST2 = 70 * 70;

/** Pixel classes: 0 water, 1 land, 2+ marker index into LEGEND. */
function classify(data: Uint8ClampedArray | Uint8Array, n: number): Uint8Array {
  const cls = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    if (data[o + 3] <= 127) continue;
    cls[p] = 1;
    for (let k = 0; k < LEGEND.length; k++) {
      const [r, g, b] = LEGEND[k].rgb;
      const d2 = (data[o] - r) ** 2 + (data[o + 1] - g) ** 2 + (data[o + 2] - b) ** 2;
      if (d2 < MATCH_DIST2) {
        cls[p] = 2 + k;
        break;
      }
    }
  }
  return cls;
}

export function parseMapImage(data: Uint8ClampedArray | Uint8Array, imgW: number, imgH: number): MapMarkers {
  const cls = classify(data, imgW * imgH);
  const isLand = (c: number) => c === 1 || (c >= 2 && /^(city|bonus)/.test(LEGEND[c - 2].marker));

  // Land by majority vote over the pixels covering each grid cell.
  const land = new Uint8Array(GRID_W * GRID_H);
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const x0 = Math.floor((i * imgW) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * imgW) / GRID_W));
      const y0 = Math.floor((j * imgH) / GRID_H);
      const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * imgH) / GRID_H));
      let solid = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (isLand(cls[y * imgW + x])) solid++;
          total++;
        }
      }
      land[j * GRID_W + i] = solid * 2 > total ? 1 : 0;
    }
  }
  cleanup(land);

  const sx = GRID_W / imgW;
  const sy = GRID_H / imgH;
  const toGrid = (px: number, py: number) => ({ x: (px + 0.5) * sx - 0.5, y: (py + 0.5) * sy - 0.5 });
  const out: MapMarkers = { land, cities: [], spawns: [], zones: [] };
  for (const blob of blobs(cls, imgW, imgH)) {
    const marker = LEGEND[blob.cls - 2].marker;
    const c = toGrid(blob.cx, blob.cy);
    if (marker === 'spawn') {
      const r = Math.max(4, Math.sqrt(blob.count / Math.PI) * sx);
      out.spawns.push({ x: c.x, y: c.y, r });
    } else if (marker === 'zone') {
      out.zones.push(c);
    } else {
      const bonus = marker.startsWith('bonus');
      const level = Number(marker.slice(bonus ? 5 : 4));
      out.cities.push({ ...snapToLand(land, Math.round(c.x), Math.round(c.y)), level, bonus });
    }
  }
  return out;
}

/** Connected marker regions with their centroid and pixel count. */
function blobs(cls: Uint8Array, w: number, h: number): { cls: number; cx: number; cy: number; count: number }[] {
  const seen = new Uint8Array(cls.length);
  const out: { cls: number; cx: number; cy: number; count: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < cls.length; s++) {
    if (seen[s] || cls[s] < 2) continue;
    const k = cls[s];
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      sumX += x;
      sumY += y;
      count++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (seen[q] || cls[q] !== k) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({ cls: k, cx: sumX / count, cy: sumY / count, count });
  }
  return out;
}

/** Cities must sit on land; nudge a marker that resampled onto water. */
function snapToLand(land: Uint8Array, x: number, y: number): { x: number; y: number } {
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= GRID_W || py >= GRID_H) continue;
        if (land[py * GRID_W + px]) return { x: px, y: py };
      }
    }
  }
  return { x, y };
}
