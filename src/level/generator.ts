import { DT, GRID_H, GRID_W, QUAKE_MIN_SEPARATION, SIM_STEPS, SPONGE, TARGET_RADIUS } from '../sim/constants.ts';
import { buildWaveform, NO_MODS, QUAKE_ORDER, QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { makeRng, pick } from '../sim/rng.ts';
import { WaveSim } from '../sim/WaveSim.ts';
import { placementProblem } from './placement.ts';
import { distanceTo, generateIslands } from './terrain.ts';
import type { LevelData, LevelRequest, QuakePlacement, TargetSpec } from './types.ts';

// Level generation works backwards from the target, using reciprocity: the
// crest a quake at P produces at target T (and when it arrives) equals what a
// quake at T produces at P. One simulation per quake type fired from the
// target therefore tells us, for every cell, how strong and how late that
// quake's crest would be at the target. From that we build a witness solution
// whose crests arrive together, verify it with a forward simulation, and
// compare against the best any single quake could do.

const MAX_ATTEMPTS = 3;
/** Stop searching once no single quake reaches this share of a requirement. */
const GOOD_SINGLE_RATIO = 1.15;
const TARGET_SEPARATION = 45;
/** Crests count as aligned within this fraction of a wave period. */
const ALIGN_TOLERANCE = 0.12;

export function landFraction(index: number): number {
  return Math.min(0.3, 0.1 + index * 0.02);
}

export function targetCount(index: number): number {
  return index < 3 ? 1 : 2;
}

/** Share of the verified witness height the player must reach. */
export function requireFraction(index: number): number {
  return Math.min(0.9, 0.78 + index * 0.012);
}

export function baseInventory(index: number, rng: () => number): QuakeKind[] {
  if (index === 0) return ['small', 'small'];
  if (index === 1) return ['small', 'small', 'medium'];
  if (index === 2) return ['small', 'medium', 'medium'];
  const n = index < 6 ? 4 : rng() < 0.5 ? 4 : 5;
  const out: QuakeKind[] = [];
  for (let k = 0; k < n; k++) {
    const r = rng();
    out.push(index >= 5 && r < 0.15 ? 'large' : r < 0.55 ? 'small' : 'medium');
  }
  return sortKinds(out);
}

function sortKinds(kinds: QuakeKind[]): QuakeKind[] {
  return kinds.sort((a, b) => QUAKE_ORDER.indexOf(a) - QUAKE_ORDER.indexOf(b));
}

const NAME_A = ['Restless', 'Hollow', 'Broken', 'Silent', 'Shivering', 'Drowned', 'Crooked', 'Salt', 'Iron', 'Glass', 'Sleeping', 'Pale'];
const NAME_B = ['Reach', 'Shoals', 'Narrows', 'Sound', 'Atoll', 'Strait', 'Deep', 'Basin', 'Expanse', 'Gulf', 'Reef', 'Passage'];

interface Response {
  peak: Float32Array;
  step: Uint16Array;
}

interface Candidate {
  targets: TargetSpec[];
  witness: QuakePlacement[];
  singleBest: number[];
  ratio: number;
}

export function generateLevel(req: LevelRequest): LevelData {
  const rng = makeRng(req.seed);
  const land = req.land ?? generateIslands(rng, landFraction(req.index));
  const inventory = baseInventory(req.index, rng);
  const name = req.name ?? `${pick(rng, NAME_A)} ${pick(rng, NAME_B)}`;
  const nTargets = targetCount(req.index);
  const frac = requireFraction(req.index);
  const coast = distanceTo(land, 1, 32);

  let best: Candidate | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const c = tryBuild(rng, land, coast, inventory, nTargets, frac);
    if (c && (!best || c.ratio > best.ratio)) best = c;
    if (best && best.ratio >= GOOD_SINGLE_RATIO) break;
  }
  if (!best) throw new Error(`Could not generate level ${req.index} (seed ${req.seed})`);
  return {
    index: req.index,
    name,
    seed: req.seed,
    land,
    targets: best.targets,
    inventory,
    witness: best.witness,
    singleBest: best.singleBest,
    soloRatio: best.ratio,
  };
}

function tryBuild(
  rng: () => number,
  land: Uint8Array,
  coast: Uint8Array,
  inventory: readonly QuakeKind[],
  nTargets: number,
  frac: number,
): Candidate | null {
  const spots = pickTargetSpots(rng, land, coast, nTargets);
  if (!spots) return null;

  const responses = spots.map((t) => {
    const byKind = new Map<QuakeKind, Response>();
    for (const kind of new Set(inventory)) byKind.set(kind, reciprocalResponse(land, t, kind));
    return byKind;
  });

  // Deal quakes to targets strongest first, round-robin.
  const strongestFirst = [...inventory].reverse();
  const groups: QuakeKind[][] = spots.map(() => []);
  strongestFirst.forEach((k, i) => groups[i % spots.length].push(k));

  const witness: QuakePlacement[] = [];
  for (let t = 0; t < spots.length; t++) {
    let refStep = -1;
    for (const kind of groups[t]) {
      const r = responses[t].get(kind)!;
      const cell = chooseCell(rng, land, coast, spots, witness, r, kind, refStep);
      if (cell < 0) return null;
      if (refStep < 0) refStep = r.step[cell];
      const x = cell % GRID_W;
      witness.push({ kind, x, y: (cell - x) / GRID_W });
    }
  }

  // Verify with the real forward simulation (also captures cross-talk
  // between groups and any reflections the estimate missed).
  const sim = new WaveSim(land, { trackPeak: true });
  for (const q of witness) sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, NO_MODS), startStep: 0 });
  sim.run(SIM_STEPS);
  const targets = spots.map((s) => {
    const peak = sim.maxInRadius(sim.peak!, s.x, s.y, TARGET_RADIUS);
    return { x: s.x, y: s.y, required: Math.floor(peak * frac * 10) / 10 };
  });

  // Best single-quake crest per target and quake type, over every legal spot.
  const singleByKind = responses.map((byKind) => {
    const out = new Map<QuakeKind, number>();
    for (const [kind, r] of byKind) {
      let best = 0;
      for (let idx = 0; idx < r.peak.length; idx++) {
        const v = r.peak[idx];
        if (v <= best) continue;
        const x = idx % GRID_W;
        if (placementProblem(land, x, (idx - x) / GRID_W, spots, [])) continue;
        best = v;
      }
      out.set(kind, best);
    }
    return out;
  });
  const singleBest = singleByKind.map((m) => Math.max(...m.values()));
  return { targets, witness, singleBest, ratio: soloRatio(targets, inventory, singleByKind) };
}

/**
 * How far the best "one quake per target" plan falls short: 1.2 means even
 * the best assignment of distinct single quakes reaches only 1/1.2 of the
 * weakest requirement. Below 1 the level can be solved without interference.
 */
function soloRatio(targets: readonly TargetSpec[], inventory: readonly QuakeKind[], single: Map<QuakeKind, number>[]): number {
  let bestCover = 0;
  const assign = (t: number, used: Set<number>, cover: number) => {
    if (t === targets.length) {
      bestCover = Math.max(bestCover, cover);
      return;
    }
    inventory.forEach((kind, i) => {
      if (used.has(i)) return;
      used.add(i);
      assign(t + 1, used, Math.min(cover, single[t].get(kind)! / Math.max(targets[t].required, 1e-3)));
      used.delete(i);
    });
  };
  assign(0, new Set(), Infinity);
  return 1 / bestCover;
}

function pickTargetSpots(rng: () => number, land: Uint8Array, coast: Uint8Array, count: number): { x: number; y: number }[] | null {
  const margin = SPONGE + 6;
  const spots: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 500 && spots.length < count; tries++) {
    const x = margin + Math.floor(rng() * (GRID_W - 2 * margin));
    const y = margin + Math.floor(rng() * (GRID_H - 2 * margin));
    const idx = y * GRID_W + x;
    if (land[idx] || coast[idx] < 4) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < TARGET_SEPARATION)) continue;
    spots.push({ x, y });
  }
  return spots.length === count ? spots : null;
}

function reciprocalResponse(land: Uint8Array, at: { x: number; y: number }, kind: QuakeKind): Response {
  const sim = new WaveSim(land, { trackPeak: true, trackPeakTime: true });
  sim.addSource({ x: at.x, y: at.y, waveform: buildWaveform(kind, NO_MODS), startStep: 0 });
  sim.run(SIM_STEPS);
  return { peak: sim.peak!, step: sim.peakStep! };
}

/**
 * First quake of a group: a random strong cell (variety between levels).
 * Later quakes: the strongest cell whose crest arrives with the first one.
 */
function chooseCell(
  rng: () => number,
  land: Uint8Array,
  coast: Uint8Array,
  targets: readonly { x: number; y: number }[],
  placed: readonly QuakePlacement[],
  r: Response,
  kind: QuakeKind,
  refStep: number,
): number {
  const tolSteps = (ALIGN_TOLERANCE * QUAKE_TYPES[kind].period) / DT;
  const valid: number[] = [];
  let maxPeak = 0;
  for (let y = SPONGE; y < GRID_H - SPONGE; y++) {
    for (let x = SPONGE; x < GRID_W - SPONGE; x++) {
      const idx = y * GRID_W + x;
      if (coast[idx] < 2) continue;
      if (placementProblem(land, x, y, targets, placed, QUAKE_MIN_SEPARATION + 2)) continue;
      valid.push(idx);
      if (r.peak[idx] > maxPeak) maxPeak = r.peak[idx];
    }
  }
  if (valid.length === 0) return -1;
  if (refStep < 0) {
    const strong = valid.filter((idx) => r.peak[idx] >= maxPeak * 0.75);
    return strong[Math.floor(rng() * strong.length)];
  }
  let best = -1;
  let bestScore = -Infinity;
  for (const idx of valid) {
    const off = Math.abs(r.step[idx] - refStep);
    // Aligned cells win outright; otherwise prefer the closest timing.
    const score = off <= tolSteps ? r.peak[idx] : -off;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}
