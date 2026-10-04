import type { QuakeKind } from '../sim/quakes.ts';

/** Quakes the player may place per sea. */
export const MAX_PLACED = 3;
/** This many quakes of one kind merge into one of the next tier. */
export const MERGE_COUNT = 3;
export const MERGE_INTO: Record<QuakeKind, QuakeKind | null> = {
  small: 'medium',
  medium: 'large',
  large: null,
  rift: null,
  pulse: null,
};

/** Every quake kind reachable from an inventory by merging. */
export function obtainableKinds(inventory: readonly QuakeKind[]): Set<QuakeKind> {
  const counts = new Map<QuakeKind, number>();
  for (const k of inventory) counts.set(k, (counts.get(k) ?? 0) + 1);
  const out = new Set(inventory);
  for (const k of ['small', 'medium'] as const) {
    const made = Math.floor((counts.get(k) ?? 0) / MERGE_COUNT);
    const next = MERGE_INTO[k]!;
    if (made > 0) {
      out.add(next);
      counts.set(next, (counts.get(next) ?? 0) + made);
    }
  }
  return out;
}

/**
 * Which placed quakes each city's crest relies on. One city: all of them.
 * Two cities: they share the middle quake, so city A lines up quakes 0+1 and
 * city B lines up 1+2. Three quakes cannot be timed for three cities at once.
 */
export function planGroups(cities: number, quakes: number): number[][] {
  const all = Array.from({ length: quakes }, (_, i) => i);
  if (cities <= 1) return [all];
  return [
    [0, 1],
    [1, Math.min(2, quakes - 1)],
  ];
}

/**
 * Delays that make each group's crests arrive together. `arrival[q][c]` is
 * when quake q's crest would reach city c if fired at t = 0 (seconds).
 * Groups are chained through shared quakes; the earliest fires at 0.
 */
export function alignDelays(arrival: readonly number[][], groups: readonly number[][], maxFuse: number, step: number): number[] {
  const t: (number | null)[] = arrival.map(() => null);
  if (t.length === 0) return [];
  groups.forEach((group, c) => {
    if (group.length === 0) return;
    // Anchor on a quake already timed by an earlier group, else on the latest arrival.
    let anchor = group.find((q) => t[q] !== null);
    if (anchor === undefined) {
      anchor = group.reduce((a, b) => (arrival[b][c] > arrival[a][c] ? b : a));
      t[anchor] = 0;
    }
    for (const q of group) {
      if (t[q] !== null) continue;
      const a = arrival[anchor][c];
      const b = arrival[q][c];
      t[q] = Number.isFinite(a) && Number.isFinite(b) ? t[anchor]! + a - b : t[anchor]!;
    }
  });
  const times = t.map((v) => v ?? 0);
  const earliest = Math.min(...times);
  return times.map((v) => Math.min(maxFuse, Math.round((v - earliest) / step) * step));
}

/**
 * Stable pseudo-random offset in [-1, 1] for a quake's crest mark at a city.
 * Scaled by the Seismograph precision it makes marks honest but fuzzy: the
 * true arrival lies within +/- precision of the mark, and the error only
 * changes when the quake moves.
 */
export function markOffset(x: number, y: number, city: number, kind: string): number {
  let h = Math.imul(Math.round(x) * 73856093, 1) ^ Math.imul(Math.round(y), 19349663) ^ Math.imul(city + 1, 83492791);
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
