import {
  BASE_FUSE_STEP,
  BASE_MAX_FUSE,
  CITY_SHORE_RADIUS,
  DT,
  GRID_H,
  GRID_W,
  QUAKE_MIN_SEPARATION,
  RECIP_STEPS,
  SIM_STEPS,
  SPAWN_RADIUS,
  SPONGE,
  ZONE_RADIUS,
} from '../sim/constants.ts';
import { replayDamage, shoreHeight, type CitySpec } from '../sim/cities.ts';
import { buildWaveform, NO_MODS, type QuakeKind } from '../sim/quakes.ts';
import { makeRng, pick } from '../sim/rng.ts';
import { WaveSim } from '../sim/WaveSim.ts';
import { placementProblem } from './placement.ts';
import { distanceTo, generateIslands } from './terrain.ts';
import type { ChaosZone, LevelData, LevelRequest, QuakePlacement, SpawnArea } from './types.ts';

// Levels are built backwards from the cities using reciprocity: the crest a
// quake at P produces at city C (and when it arrives) equals what a quake at C
// produces at P. One reverse simulation per city and quake type tells us, for
// every spawn cell, how strong and how late its crest would be at the city.
// The witness solution picks strong spawn cells and *delays* them so their
// crests land together. Sea walls are set so no single quake can top them, and
// the same placements without delays are checked to fall short, which makes
// timing the heart of the puzzle.

const MAX_ATTEMPTS = 8;
/** Accept as soon as the undelayed witness deals at most this share of hp. */
const GOOD_TIMING_RATIO = 0.7;
const CITY_SEPARATION = 30;
const SPAWN_CITY_DISTANCE = 38;
const MIN_WALL = 1.5;
/** Share of the witness damage needed to ruin a city. */
const HP_FRACTION = 0.8;
/** Cities that would fall to a sliver of overflow are rejected as trivial. */
const MIN_WITNESS_DAMAGE = 2;

export function landFraction(index: number): number {
  return Math.min(0.28, 0.12 + index * 0.02);
}

/** City levels for a sea; a city of level L is ruined by about L+1 quakes. */
export function cityLevels(index: number, rng: () => number): number[] {
  const fixed = [[1], [1], [2], [1, 1], [1, 2], [2, 2]];
  if (index < fixed.length) return fixed[index];
  const options = [[1, 1, 2], [3, 1], [2, 3], [1, 1, 1], [3, 2]];
  return pick(rng, options);
}

function spawnCount(index: number): number {
  return index < 2 ? 2 : 3;
}

function quakeKindFor(index: number, rng: () => number): QuakeKind {
  if (index === 0) return 'small';
  const r = rng();
  if (index >= 4 && r < 0.12) return 'large';
  return r < 0.5 ? 'small' : 'medium';
}

const NAME_A = ['Restless', 'Hollow', 'Broken', 'Silent', 'Shivering', 'Drowned', 'Crooked', 'Salt', 'Iron', 'Glass', 'Sleeping', 'Pale'];
const NAME_B = ['Reach', 'Shoals', 'Narrows', 'Sound', 'Atoll', 'Strait', 'Deep', 'Basin', 'Expanse', 'Gulf', 'Reef', 'Passage'];
const CITY_A = ['Port', 'Fort', 'Saint', 'New', 'Old', 'Upper', 'Low', 'Bay'];
const CITY_B = ['Harrow', 'Calder', 'Mira', 'Vessa', 'Orrin', 'Talis', 'Brine', 'Kestrel', 'Morrow', 'Quay', 'Lumen', 'Gale', 'Selk', 'Dunmore'];

interface Response {
  peak: Float32Array;
  step: Uint16Array;
}

interface Site {
  x: number;
  y: number;
  shore: number[];
  /** Water cell the reverse simulation fires from. */
  mouth: number;
}

interface Candidate {
  cities: CitySpec[];
  spawns: SpawnArea[];
  witness: QuakePlacement[];
  inventory: QuakeKind[];
  timingRatio: number;
  peakField: Float32Array;
}

export function generateLevel(req: LevelRequest): LevelData {
  const rng = makeRng(req.seed);
  const land = req.land ?? generateIslands(rng, landFraction(req.index));
  const name = req.name ?? `${pick(rng, NAME_A)} ${pick(rng, NAME_B)}`;
  const levels = cityLevels(req.index, rng);
  const coast = distanceTo(land, 1, 32);

  let best: Candidate | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const c = tryBuild(rng, req.index, land, coast, levels);
    if (c && (!best || c.timingRatio < best.timingRatio)) best = c;
    if (best && best.timingRatio <= GOOD_TIMING_RATIO) break;
  }
  if (!best) throw new Error(`Could not generate level ${req.index} (seed ${req.seed})`);
  const zones = req.index >= 1 ? pickZones(land, coast, best) : [];
  return {
    index: req.index,
    name,
    seed: req.seed,
    land,
    cities: best.cities,
    spawns: best.spawns,
    zones,
    inventory: best.inventory,
    witness: best.witness,
    timingRatio: best.timingRatio,
  };
}

function tryBuild(rng: () => number, index: number, land: Uint8Array, coast: Uint8Array, levels: number[]): Candidate | null {
  const sites = pickCitySites(rng, land, levels.length);
  if (!sites) return null;
  const spawns = pickSpawns(rng, land, coast, sites, spawnCount(index), []);
  if (!spawns) return null;

  const groups = levels.map((lvl) => Array.from({ length: lvl + 1 }, () => quakeKindFor(index, rng)));
  const inventory = groups.flat();

  // Reverse simulations: one per city and quake type.
  const responses = sites.map((s) => {
    const byKind = new Map<QuakeKind, Response>();
    for (const kind of new Set(inventory)) {
      const sim = new WaveSim(land, { trackPeak: true, trackPeakTime: true });
      const mx = s.mouth % GRID_W;
      sim.addSource({ x: mx, y: (s.mouth - mx) / GRID_W, waveform: buildWaveform(kind, NO_MODS), startStep: 0 });
      sim.run(RECIP_STEPS);
      byKind.set(kind, { peak: sim.peak!, step: sim.peakStep! });
    }
    return byKind;
  });
  const spawnCells = cellsInSpawns(land, spawns);

  // Witness: strongest spawn cell per quake, then delays that line crests up.
  const witness: QuakePlacement[] = [];
  groups.forEach((group, c) => {
    const picks: { kind: QuakeKind; cell: number; step: number }[] = [];
    for (const kind of group) {
      const r = responses[c].get(kind)!;
      let bestCell = -1;
      for (const cell of spawnCells) {
        const x = cell % GRID_W;
        const y = (cell - x) / GRID_W;
        if (witness.some((q) => Math.hypot(q.x - x, q.y - y) < QUAKE_MIN_SEPARATION + 1)) continue;
        if (picks.some((p) => Math.hypot((p.cell % GRID_W) - x, Math.floor(p.cell / GRID_W) - y) < QUAKE_MIN_SEPARATION + 1)) continue;
        // Spread quakes over different epicenters when it costs little.
        const crowd = picks.filter((p) => sameSpawn(spawns, p.cell, cell)).length;
        const score = r.peak[cell] * (1 - 0.15 * crowd);
        if (bestCell < 0 || score > r.peak[bestCell] * (1 - 0.15 * picks.filter((p) => sameSpawn(spawns, p.cell, bestCell)).length)) {
          bestCell = cell;
        }
      }
      if (bestCell < 0) return;
      picks.push({ kind, cell: bestCell, step: r.step[bestCell] });
    }
    const latest = Math.max(...picks.map((p) => p.step));
    for (const p of picks) {
      const x = p.cell % GRID_W;
      const raw = (latest - p.step) * DT;
      const delay = Math.min(BASE_MAX_FUSE, Math.round(raw / BASE_FUSE_STEP) * BASE_FUSE_STEP);
      witness.push({ kind: p.kind, x, y: (p.cell - x) / GRID_W, delay, angle: 0 });
    }
  });
  if (witness.length !== inventory.length) return null;

  const timed = forwardSeries(land, sites, witness, true);
  const flat = forwardSeries(land, sites, witness, false);

  const cities: CitySpec[] = [];
  let timingRatio = Infinity;
  for (let c = 0; c < sites.length; c++) {
    const crest = Math.max(...timed.series[c]);
    // Best a single quake of any available type can do from any spawn cell.
    let single = 0;
    for (const r of responses[c].values()) for (const cell of spawnCells) single = Math.max(single, r.peak[cell]);
    const wall = Math.max(MIN_WALL, single * 1.1, crest * 0.5);
    if (wall >= crest * 0.92) return null;
    const damage = replayDamage(timed.series[c], wall);
    if (damage < MIN_WITNESS_DAMAGE) return null;
    const hp = Math.round(damage * HP_FRACTION * 10) / 10;
    timingRatio = Math.min(timingRatio, replayDamage(flat.series[c], wall) / hp);
    cities.push({
      name: `${pick(rng, CITY_A)} ${pick(rng, CITY_B)}`,
      x: sites[c].x,
      y: sites[c].y,
      level: levels[c],
      protection: Math.round(wall * 10) / 10,
      hp,
      shore: sites[c].shore,
    });
  }
  return { cities, spawns, witness, inventory, timingRatio, peakField: timed.peak };
}

function sameSpawn(spawns: readonly SpawnArea[], a: number, b: number): boolean {
  const which = (cell: number) => {
    const x = cell % GRID_W;
    const y = (cell - x) / GRID_W;
    return spawns.findIndex((s) => Math.hypot(s.x - x, s.y - y) <= s.r);
  };
  return which(a) === which(b);
}

function forwardSeries(land: Uint8Array, sites: readonly Site[], witness: readonly QuakePlacement[], useDelays: boolean) {
  const sim = new WaveSim(land, { trackPeak: true });
  for (const q of witness) {
    sim.addSource({
      x: q.x,
      y: q.y,
      waveform: buildWaveform(q.kind, NO_MODS),
      startStep: useDelays ? Math.round(q.delay / DT) : 0,
    });
  }
  const series = sites.map(() => new Float32Array(SIM_STEPS));
  for (let s = 0; s < SIM_STEPS; s++) {
    sim.step();
    sites.forEach((site, c) => (series[c][s] = shoreHeight(sim.u, site.shore)));
  }
  return { series, peak: sim.peak! };
}

function pickCitySites(rng: () => number, land: Uint8Array, count: number): Site[] | null {
  const margin = SPONGE + 3;
  const sites: Site[] = [];
  for (let tries = 0; tries < 3000 && sites.length < count; tries++) {
    const x = margin + Math.floor(rng() * (GRID_W - 2 * margin));
    const y = margin + Math.floor(rng() * (GRID_H - 2 * margin));
    if (!land[y * GRID_W + x]) continue;
    if (sites.some((s) => Math.hypot(s.x - x, s.y - y) < CITY_SEPARATION)) continue;
    const shore: number[] = [];
    let mouth = -1;
    let mouthD = Infinity;
    for (let dy = -CITY_SHORE_RADIUS; dy <= CITY_SHORE_RADIUS; dy++) {
      for (let dx = -CITY_SHORE_RADIUS; dx <= CITY_SHORE_RADIUS; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > CITY_SHORE_RADIUS) continue;
        const px = x + dx;
        const py = y + dy;
        if (px < SPONGE || py < SPONGE || px >= GRID_W - SPONGE || py >= GRID_H - SPONGE) continue;
        const idx = py * GRID_W + px;
        if (land[idx]) continue;
        shore.push(idx);
        if (d < mouthD) {
          mouthD = d;
          mouth = idx;
        }
      }
    }
    // A city needs open water in front of it, but must sit on the coast.
    if (shore.length < 10 || mouthD > 2.5) continue;
    sites.push({ x, y, shore, mouth });
  }
  return sites.length === count ? sites : null;
}

/** Picks epicenters far from cities; `existing` are kept clear of. */
export function pickSpawns(
  rng: () => number,
  land: Uint8Array,
  coast: Uint8Array,
  cities: readonly { x: number; y: number }[],
  count: number,
  existing: readonly SpawnArea[],
  radius = SPAWN_RADIUS,
): SpawnArea[] | null {
  const margin = SPONGE + Math.ceil(radius);
  const out: SpawnArea[] = [];
  for (let tries = 0; tries < 3000 && out.length < count; tries++) {
    const x = margin + Math.floor(rng() * (GRID_W - 2 * margin));
    const y = margin + Math.floor(rng() * (GRID_H - 2 * margin));
    if (coast[y * GRID_W + x] < 4) continue;
    if (cities.some((c) => Math.hypot(c.x - x, c.y - y) < SPAWN_CITY_DISTANCE)) continue;
    if ([...existing, ...out].some((s) => Math.hypot(s.x - x, s.y - y) < s.r + radius + 12)) continue;
    out.push({ x, y, r: radius });
  }
  return out.length === count ? out : null;
}

function cellsInSpawns(land: Uint8Array, spawns: readonly SpawnArea[]): number[] {
  const out: number[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!placementProblem(land, x, y, spawns, [])) out.push(y * GRID_W + x);
    }
  }
  return out;
}

/** A bonus ring where the witness produced a big crest out at sea. */
function pickZones(land: Uint8Array, coast: Uint8Array, c: Candidate): ChaosZone[] {
  const margin = SPONGE + 4;
  let bestIdx = -1;
  for (let y = margin; y < GRID_H - margin; y++) {
    for (let x = margin; x < GRID_W - margin; x++) {
      const idx = y * GRID_W + x;
      if (land[idx] || coast[idx] < 4) continue;
      if (c.spawns.some((s) => Math.hypot(s.x - x, s.y - y) < s.r + 8)) continue;
      if (c.cities.some((s) => Math.hypot(s.x - x, s.y - y) < 14)) continue;
      if (bestIdx < 0 || c.peakField[idx] > c.peakField[bestIdx]) bestIdx = idx;
    }
  }
  if (bestIdx < 0) return [];
  const x = bestIdx % GRID_W;
  const y = (bestIdx - x) / GRID_W;
  let peak = 0;
  for (let dy = -ZONE_RADIUS; dy <= ZONE_RADIUS; dy++) {
    for (let dx = -ZONE_RADIUS; dx <= ZONE_RADIUS; dx++) {
      if (dx * dx + dy * dy <= ZONE_RADIUS * ZONE_RADIUS) peak = Math.max(peak, c.peakField[(y + dy) * GRID_W + x + dx]);
    }
  }
  return [{ x, y, threshold: Math.floor(peak * 0.85 * 10) / 10, mult: 1.5 }];
}
