import { DT, GRID_H, GRID_W, SPONGE, WAVE_SPEED } from './constants.ts';

// Linear 2D wave equation, leapfrog integration, isotropic 9-point Laplacian.
// Land cells mirror the neighbouring water value (reflective coast); water
// cells next to land get extra damping so reflections lose energy.
// The step uses only + - * / so results are bit-identical on every device.

const C2 = (WAVE_SPEED * DT) ** 2;
/** Open-water damping per step. Low, so waves carry across the map. */
export const DEFAULT_OPEN_DAMP = 0.00015;
const SPONGE_DAMP = 0.12;
const ENV_DECAY = 0.965;
export const DEFAULT_COAST_ABSORB = 0.05;
const FOOTPRINT_SIGMA = 1.6;
const FOOTPRINT_RADIUS = 4;

/** Cell classes used to pick the fast path in the step loop. */
const OPEN = 0;
const COAST = 1;
const SOLID = 2;

export interface SimOptions {
  coastAbsorb?: number;
  openDamp?: number;
  /** Keep a decaying |height| envelope for rendering. */
  trackEnvelope?: boolean;
  /** Keep the maximum crest height ever seen per cell. */
  trackPeak?: boolean;
  /** With trackPeak: also record the step at which each cell peaked. */
  trackPeakTime?: boolean;
}

export interface SourceSpec {
  x: number;
  y: number;
  /** Forcing added per step, starting at startStep. */
  waveform: Float32Array;
  startStep: number;
  /** Line source (rift): length in cells and orientation in radians. */
  length?: number;
  angle?: number;
}

interface Source {
  cells: Int32Array;
  weights: Float32Array;
  waveform: Float32Array;
  startStep: number;
}

export class WaveSim {
  readonly w = GRID_W;
  readonly h = GRID_H;
  readonly land: Uint8Array;
  readonly damp: Float32Array;
  readonly env: Float32Array | null;
  readonly peak: Float32Array | null;
  readonly peakStep: Uint16Array | null;
  u: Float32Array;
  private prev: Float32Array;
  private next: Float32Array;
  private cls: Uint8Array;
  private sources: Source[] = [];
  stepIndex = 0;

  constructor(land: Uint8Array, opts: SimOptions = {}) {
    const n = this.w * this.h;
    this.land = land;
    this.u = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.next = new Float32Array(n);
    this.damp = buildDamping(land, opts.coastAbsorb ?? DEFAULT_COAST_ABSORB, opts.openDamp ?? DEFAULT_OPEN_DAMP);
    this.cls = classify(land);
    this.env = opts.trackEnvelope ? new Float32Array(n) : null;
    this.peak = opts.trackPeak ? new Float32Array(n) : null;
    this.peakStep = opts.trackPeak && opts.trackPeakTime ? new Uint16Array(n) : null;
  }

  get time(): number {
    return this.stepIndex * DT;
  }

  addSource(spec: SourceSpec): void {
    const cells: number[] = [];
    const weights: number[] = [];
    const len = spec.length ?? 0;
    const ax = Math.cos(spec.angle ?? 0) * len * 0.5;
    const ay = Math.sin(spec.angle ?? 0) * len * 0.5;
    const reach = FOOTPRINT_RADIUS + Math.ceil(len / 2);
    // Normalised against the full open-water footprint, so a quake hugging the
    // coast loses the part of its energy that would land on the island. A
    // line source spreads the same total forcing along its length.
    const s2 = FOOTPRINT_SIGMA * FOOTPRINT_SIGMA;
    const norm = 2 * Math.PI * s2 + Math.sqrt(2 * Math.PI) * FOOTPRINT_SIGMA * len;
    const cx = Math.round(spec.x);
    const cy = Math.round(spec.y);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= this.w - 1 || y >= this.h - 1) continue;
        const idx = y * this.w + x;
        if (this.land[idx]) continue;
        const d2 = segmentDist2(x - spec.x, y - spec.y, ax, ay);
        const wgt = Math.exp(-d2 / (2 * s2));
        if (wgt < 0.01) continue;
        cells.push(idx);
        weights.push(wgt / norm);
      }
    }
    this.sources.push({
      cells: Int32Array.from(cells),
      weights: Float32Array.from(weights),
      waveform: spec.waveform,
      startStep: spec.startStep,
    });
  }

  /** True once every source has finished emitting. */
  get sourcesDone(): boolean {
    return this.sources.every((s) => this.stepIndex >= s.startStep + s.waveform.length);
  }

  step(): void {
    const { w, h, land, damp, cls } = this;
    const u = this.u;
    const prev = this.prev;
    const next = this.next;
    for (let j = 1; j < h - 1; j++) {
      let idx = j * w + 1;
      for (let i = 1; i < w - 1; i++, idx++) {
        const k = cls[idx];
        const c = u[idx];
        const iN = idx - w;
        const iS = idx + w;
        let lap: number;
        if (k === OPEN) {
          lap = (4 * (u[iN] + u[iS] + u[idx + 1] + u[idx - 1]) + u[iN + 1] + u[iN - 1] + u[iS + 1] + u[iS - 1] - 20 * c) / 6;
        } else if (k === COAST) {
          const n = land[iN] ? c : u[iN];
          const s = land[iS] ? c : u[iS];
          const e = land[idx + 1] ? c : u[idx + 1];
          const wv = land[idx - 1] ? c : u[idx - 1];
          const ne = land[iN + 1] ? c : u[iN + 1];
          const nw = land[iN - 1] ? c : u[iN - 1];
          const se = land[iS + 1] ? c : u[iS + 1];
          const sw = land[iS - 1] ? c : u[iS - 1];
          lap = (4 * (n + s + e + wv) + ne + nw + se + sw - 20 * c) / 6;
        } else {
          next[idx] = 0;
          continue;
        }
        next[idx] = c + (c - prev[idx]) * (1 - damp[idx]) + C2 * lap;
      }
    }
    const t = this.stepIndex;
    for (const src of this.sources) {
      const k = t - src.startStep;
      if (k < 0 || k >= src.waveform.length) continue;
      const f = src.waveform[k];
      const { cells, weights } = src;
      for (let m = 0; m < cells.length; m++) next[cells[m]] += f * weights[m];
    }
    this.prev = u;
    this.u = next;
    this.next = prev;
    this.stepIndex++;

    const cur = this.u;
    const env = this.env;
    if (env) {
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i] < 0 ? -cur[i] : cur[i];
        const d = env[i] * ENV_DECAY;
        env[i] = a > d ? a : d;
      }
    }
    const peak = this.peak;
    const peakStep = this.peakStep;
    if (peak && peakStep) {
      const step = this.stepIndex;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i] > peak[i]) {
          peak[i] = cur[i];
          peakStep[i] = step;
        }
      }
    } else if (peak) {
      for (let i = 0; i < cur.length; i++) if (cur[i] > peak[i]) peak[i] = cur[i];
    }
  }

  run(steps: number): void {
    for (let s = 0; s < steps; s++) this.step();
  }

  /** Highest value of `field` within radius r of (x, y). */
  maxInRadius(field: Float32Array, x: number, y: number, r: number): number {
    let best = -Infinity;
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || py < 0 || px >= this.w || py >= this.h) continue;
        const v = field[py * this.w + px];
        if (v > best) best = v;
      }
    }
    return best;
  }

  /** Mean absolute height over a sparse sample of the sea (for audio). */
  activity(): number {
    const env = this.env ?? this.u;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < env.length; i += 7) {
      const v = env[i];
      sum += v < 0 ? -v : v;
      n++;
    }
    return sum / n;
  }
}

/** Squared distance from (px, py) to the segment from -a to +a. */
function segmentDist2(px: number, py: number, ax: number, ay: number): number {
  const len2 = ax * ax + ay * ay;
  if (len2 === 0) return px * px + py * py;
  // Project onto the segment, parametrised from -1 to 1.
  let t = (px * ax + py * ay) / len2;
  if (t > 1) t = 1;
  else if (t < -1) t = -1;
  const dx = px - ax * t;
  const dy = py - ay * t;
  return dx * dx + dy * dy;
}

function classify(land: Uint8Array): Uint8Array {
  const w = GRID_W;
  const h = GRID_H;
  const cls = new Uint8Array(w * h).fill(SOLID);
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const idx = j * w + i;
      if (land[idx]) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (land[idx + dy * w + dx]) near = true;
      cls[idx] = near ? COAST : OPEN;
    }
  }
  return cls;
}

function buildDamping(land: Uint8Array, coastAbsorb: number, openDamp: number): Float32Array {
  const w = GRID_W;
  const h = GRID_H;
  const d = new Float32Array(w * h).fill(openDamp);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const idx = j * w + i;
      const e = Math.min(i, j, w - 1 - i, h - 1 - j);
      if (e < SPONGE) {
        const s = (SPONGE - e) / SPONGE;
        d[idx] += SPONGE_DAMP * s * s;
      }
      if (land[idx]) continue;
      let ring = 3;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = i + dx;
          const y = j + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (land[y * w + x]) ring = Math.min(ring, Math.max(Math.abs(dx), Math.abs(dy)));
        }
      }
      if (ring === 1) d[idx] += coastAbsorb;
      else if (ring === 2) d[idx] += coastAbsorb * 0.4;
      if (d[idx] > 0.5) d[idx] = 0.5;
    }
  }
  return d;
}
