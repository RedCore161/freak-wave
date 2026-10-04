import { DT, WAVE_SPEED } from './constants.ts';

export type QuakeKind = 'small' | 'medium' | 'large';

export interface QuakeType {
  kind: QuakeKind;
  name: string;
  /** Seconds per wave; wavelength = period * WAVE_SPEED. */
  period: number;
  /** Number of waves in the train. */
  cycles: number;
  amplitude: number;
  color: string;
  size: number;
}

export const QUAKE_TYPES: Record<QuakeKind, QuakeType> = {
  small: { kind: 'small', name: 'Tremor', period: 0.9, cycles: 2.5, amplitude: 1, color: '#7fd4ff', size: 1 },
  medium: { kind: 'medium', name: 'Quake', period: 1.2, cycles: 2.5, amplitude: 1.6, color: '#ffd166', size: 1.3 },
  large: { kind: 'large', name: 'Megaquake', period: 1.6, cycles: 2, amplitude: 2.6, color: '#ff6b6b', size: 1.7 },
};

export const QUAKE_ORDER: readonly QuakeKind[] = ['small', 'medium', 'large'];

export interface QuakeMods {
  ampMul: number;
  periodMul: number;
}

export const NO_MODS: QuakeMods = { ampMul: 1, periodMul: 1 };

/** Calibrated (scripts/calibrate.ts) so a Tremor gives ~3 m at 30 cells in open water. */
const FORCE_SCALE = 50;

export function quakePeriod(kind: QuakeKind, mods: QuakeMods): number {
  return QUAKE_TYPES[kind].period * mods.periodMul;
}

export function quakeDuration(kind: QuakeKind, mods: QuakeMods): number {
  return quakePeriod(kind, mods) * QUAKE_TYPES[kind].cycles;
}

export function buildWaveform(kind: QuakeKind, mods: QuakeMods, strength = 1): Float32Array {
  const type = QUAKE_TYPES[kind];
  const T = quakePeriod(kind, mods);
  const D = T * type.cycles;
  const steps = Math.ceil(D / DT);
  // Per-step additions accumulate like a velocity kick, so we inject the
  // discrete derivative of the desired surface motion s(t). s is forced to
  // zero mean, otherwise a net mound of water is left behind and rings forever.
  const s = new Float64Array(steps);
  const env = new Float64Array(steps);
  let sumS = 0;
  let sumE = 0;
  for (let k = 0; k < steps; k++) {
    const t = k * DT;
    env[k] = Math.sin((Math.PI * t) / D) ** 2;
    s[k] = env[k] * Math.sin((2 * Math.PI * t) / T);
    sumS += s[k];
    sumE += env[k];
  }
  const a = type.amplitude * mods.ampMul * strength * FORCE_SCALE;
  const out = new Float32Array(steps + 1);
  let last = 0;
  for (let k = 0; k < steps; k++) {
    const v = s[k] - (sumS / sumE) * env[k];
    out[k] = a * (v - last);
    last = v;
  }
  out[steps] = -a * last;
  return out;
}

/** Estimated time after the quake fires until its biggest crest reaches a point. */
export function crestArrival(kind: QuakeKind, mods: QuakeMods, distCells: number): number {
  // Empirical fit from scripts/calibrate.ts: the strongest crest trails the
  // wave front by about 1.14 periods for every quake type.
  return distCells / WAVE_SPEED + quakePeriod(kind, mods) * 1.14;
}
