import { GRID_H, GRID_W } from './constants.ts';

/**
 * Shortest water path distance (in cells) from (sx, sy) to every cell, going
 * around islands. Divided by WAVE_SPEED this approximates when the direct or
 * diffracted wave front arrives. Land and unreachable cells are Infinity.
 */
export function waterDistanceField(land: Uint8Array, sx: number, sy: number): Float32Array {
  const w = GRID_W;
  const h = GRID_H;
  const dist = new Float32Array(w * h).fill(Infinity);
  const x0 = Math.round(sx);
  const y0 = Math.round(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h || land[y0 * w + x0]) return dist;

  const heap = new MinHeap(w * h);
  const start = y0 * w + x0;
  dist[start] = Math.hypot(sx - x0, sy - y0);
  heap.push(start, dist[start]);
  const done = new Uint8Array(w * h);
  while (heap.size > 0) {
    const idx = heap.pop();
    if (done[idx]) continue;
    done[idx] = 1;
    const x = idx % w;
    const y = (idx - x) / w;
    const d = dist[idx];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (land[n] || done[n]) continue;
        // No cutting diagonally between two land cells.
        if (dx !== 0 && dy !== 0 && (land[y * w + nx] || land[ny * w + x])) continue;
        const nd = d + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (nd < dist[n]) {
          dist[n] = nd;
          heap.push(n, nd);
        }
      }
    }
  }
  return dist;
}

class MinHeap {
  private ids: Int32Array;
  private keys: Float32Array;
  size = 0;

  constructor(capacity: number) {
    this.ids = new Int32Array(capacity * 2);
    this.keys = new Float32Array(capacity * 2);
  }

  push(id: number, key: number): void {
    if (this.size >= this.ids.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.keys[r] < this.keys[l] ? r : l;
      if (this.keys[c] >= lastKey) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = lastId;
    this.keys[i] = lastKey;
    return top;
  }

  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float32Array(this.keys.length * 2);
    ids.set(this.ids);
    keys.set(this.keys);
    this.ids = ids;
    this.keys = keys;
  }
}
