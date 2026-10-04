import { GRID_H, GRID_W, SPONGE } from '../sim/constants.ts';

const W = GRID_W;
const H = GRID_H;

/** Seeded value noise with fractal octaves, roughly in [0, 1]. */
function makeNoise(rng: () => number): (x: number, y: number) => number {
  const size = 256;
  const table = new Float32Array(size * size);
  for (let i = 0; i < table.length; i++) table[i] = rng();
  const at = (x: number, y: number) => table[(y & (size - 1)) * size + (x & (size - 1))];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx;
    return a + (b - a) * ty;
  };
  return (x, y) => value(x, y) * 0.6 + value(x * 2.1 + 17, y * 2.1 + 9) * 0.3 + value(x * 4.3 + 5, y * 4.3 + 31) * 0.1;
}

/**
 * Procedural archipelago. `landFraction` is the share of the interior that
 * becomes land. The absorbing border is always open water.
 */
export function generateIslands(rng: () => number, landFraction: number): Uint8Array {
  const noise = makeNoise(rng);
  const scale = 1 / (18 + rng() * 14);
  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const margin = SPONGE + 4;
  const field = new Float32Array(W * H);
  const interior: number[] = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const edge = Math.min(i, j, W - 1 - i, H - 1 - j);
      const fade = Math.min(1, Math.max(0, (edge - margin) / 8));
      const v = noise(i * scale + ox, j * scale + oy) * fade - (1 - fade);
      field[j * W + i] = v;
      if (edge >= margin) interior.push(v);
    }
  }
  interior.sort((a, b) => b - a);
  const threshold = interior[Math.min(interior.length - 1, Math.floor(interior.length * landFraction))];
  const land = new Uint8Array(W * H);
  for (let i = 0; i < land.length; i++) land[i] = field[i] > threshold ? 1 : 0;
  cleanup(land);
  return land;
}

/** Removes specks of land too small to simulate well and fills enclosed lakes. */
export function cleanup(land: Uint8Array, minIsland = 12): void {
  const comp = labelComponents(land, 1);
  for (const cells of comp) if (cells.length < minIsland) for (const c of cells) land[c] = 0;
  const lakes = labelComponents(land, 0);
  if (lakes.length <= 1) return;
  // The largest water body is the ocean; everything else is a lake.
  lakes.sort((a, b) => b.length - a.length);
  for (let k = 1; k < lakes.length; k++) for (const c of lakes[k]) land[c] = 1;
}

function labelComponents(land: Uint8Array, value: number): number[][] {
  const seen = new Uint8Array(W * H);
  const out: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < land.length; s++) {
    if (seen[s] || land[s] !== value) continue;
    const cells: number[] = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = c % W;
      const y = (c - x) / W;
      const nbrs = [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1];
      for (const n of nbrs) {
        if (n < 0 || seen[n] || land[n] !== value) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    out.push(cells);
  }
  return out;
}

/**
 * Chebyshev distance (in cells) from every cell to the nearest cell where
 * mask === value, capped at `cap`.
 */
export function distanceTo(mask: Uint8Array, value: number, cap = 32): Uint8Array {
  const d = new Uint8Array(W * H).fill(cap);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === value) {
      d[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const c = queue[head++];
    const x = c % W;
    const y = (c - x) / W;
    const nd = d[c] + 1;
    if (nd >= cap) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (d[n] > nd) {
          d[n] = nd;
          queue[tail++] = n;
        }
      }
    }
  }
  return d;
}

/**
 * Converts RGBA pixels of any size into the simulation grid.
 * Opaque pixels (alpha > 50%) are land, transparent pixels are water.
 */
export function landFromRgba(data: Uint8ClampedArray, imgW: number, imgH: number): Uint8Array {
  const land = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // Majority vote over the source pixels covering this cell.
      const x0 = Math.floor((i * imgW) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * imgW) / W));
      const y0 = Math.floor((j * imgH) / H);
      const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * imgH) / H));
      let opaque = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * imgW + x) * 4 + 3] > 127) opaque++;
          total++;
        }
      }
      land[j * W + i] = opaque * 2 > total ? 1 : 0;
    }
  }
  cleanup(land);
  return land;
}
