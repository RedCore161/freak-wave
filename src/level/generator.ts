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
import { waterDistanceField } from '../sim/arrival.ts';
import { replayDamage, shoreHeight, type CitySpec } from '../sim/cities.ts';
import { buildWaveform, crestArrival, NO_MODS, type QuakeKind } from '../sim/quakes.ts';
import { makeRng, pick } from '../sim/rng.ts';
import { WaveSim } from '../sim/WaveSim.ts';
import { placementProblem, quakePower } from './placement.ts';
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
//
// Hand-made maps fix land, cities, epicenters and rings; the generator then
// only chooses quake types and computes walls and hp. Everything is seeded per
// level, so a sea plays the same in every run.

const MAX_ATTEMPTS = 8;
/** Accept as soon as the undelayed witness deals at most this share of hp. */
const GOOD_TIMING_RATIO = 0.7;
const CITY_SEPARATION = 30;
const SPAWN_CITY_DISTANCE = 38;
const MIN_WALL = 1.5;
/** HP never exceeds this share of the witness damage, so the solution always wins. */
const HP_FRACTION = 0.85;
/** Imperfect plans played per level to calibrate walls and hp. */
const SAMPLE_PLANS = 8;
/** Single quakes stay below the wall by this factor (unless that makes the level unfair). */
const WALL_OVER_SINGLE = 1.05;
/** Cities that would fall to a sliver of overflow are rejected as trivial. */
const MIN_WITNESS_DAMAGE = 2;
export const ZONE_MULT = 1.5;

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

/**
 * Share of reasonable-but-imperfect plans that should win: quakes anywhere
 * inside the right epicenters, delays lined up from the timeline estimates.
 * Generous at first, tighter later.
 */
export function winShare(index: number): number {
  return Math.max(0.3, 0.85 - index * 0.05);
}

function quantile(sorted: readonly number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)));
  return sorted[i];
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

interface Layout {
  sites: Site[];
  levels: number[];
  spawns: SpawnArea[];
  /** Fixed ring positions from a map, or null to choose them. */
  zoneSpots: { x: number; y: number }[] | null;
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
  const map = req.map;
  const land = map?.land ?? generateIslands(rng, landFraction(req.index));
  const name = req.name ?? `${pick(rng, NAME_A)} ${pick(rng, NAME_B)}`;
  const coast = distanceTo(land, 1, 32);

  let fixed: Layout | null = null;
  if (map && map.cities.length > 0) {
    const sites = map.cities.map((c) => siteAt(land, c.x, c.y, 3));
    if (sites.some((s) => !s)) throw new Error(`${name}: a city marker is not on a coast`);
    const spawns = map.spawns.length > 0 ? map.spawns : pickSpawns(rng, land, coast, sites as Site[], 3, []);
    if (!spawns) throw new Error(`${name}: could not place epicenters`);
    fixed = { sites: sites as Site[], levels: map.cities.map((c) => c.level), spawns, zoneSpots: map.zones };
  }

  let best: Candidate | null = null;
  // A fixed map only varies in quake types (and not at all if those are fixed too).
  const attempts = fixed ? (req.quakes ? 2 : 4) : MAX_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const relaxed = attempt === attempts - 1 && !best;
    const layout = fixed ?? randomLayout(rng, req.index, land, coast);
    if (!layout) continue;
    const c = tryBuild(rng, req.index, land, layout, relaxed, req.quakes);
    if (c && (!best || c.timingRatio < best.timingRatio)) best = c;
    if (best && best.timingRatio <= GOOD_TIMING_RATIO) break;
  }
  if (!best) throw new Error(`Could not generate level ${req.index} (seed ${req.seed})`);
  const zones = fixed ? zonesAt(fixed.zoneSpots ?? [], best) : req.index >= 1 ? pickZones(land, coast, best) : [];
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
    hint: req.hint,
  };
}

function randomLayout(rng: () => number, index: number, land: Uint8Array, coast: Uint8Array): Layout | null {
  const levels = cityLevels(index, rng);
  const sites = pickCitySites(rng, land, levels.length);
  if (!sites) return null;
  const spawns = pickSpawns(rng, land, coast, sites, spawnCount(index), []);
  if (!spawns) return null;
  return { sites, levels, spawns, zoneSpots: null };
}

function tryBuild(
  rng: () => number,
  index: number,
  land: Uint8Array,
  layout: Layout,
  relaxed: boolean,
  quakes?: QuakeKind[],
): Candidate | null {
  const { sites, levels, spawns } = layout;
  const sizes = levels.map((l) => l + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  // A map may fix the exact quake types; otherwise roll them per group.
  const fixedKinds = quakes && quakes.length === total ? [...quakes] : null;
  const groups = sizes.map((n) => Array.from({ length: n }, () => (fixedKinds ? fixedKinds.shift()! : quakeKindFor(index, rng))));
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
  const spawnCells = cellsInSpawns(land, spawns, sites);
  const reach = reachableCells(land, spawns, sites);
  if (spawnCells.length === 0) return null;

  // Witness: strongest spawn cell per quake, then delays that line crests up.
  const witness: QuakePlacement[] = [];
  const crowdIn = (picks: { cell: number }[], cell: number) => picks.filter((p) => sameSpawn(spawns, p.cell, cell)).length;
  groups.forEach((group, c) => {
    const picks: { kind: QuakeKind; cell: number; step: number }[] = [];
    for (const kind of group) {
      const r = responses[c].get(kind)!;
      let bestCell = -1;
      let bestScore = -Infinity;
      for (const cell of spawnCells) {
        const x = cell % GRID_W;
        const y = (cell - x) / GRID_W;
        const tooClose = (qx: number, qy: number) => Math.hypot(qx - x, qy - y) < QUAKE_MIN_SEPARATION + 1;
        if (witness.some((q) => tooClose(q.x, q.y))) continue;
        if (picks.some((p) => tooClose(p.cell % GRID_W, Math.floor(p.cell / GRID_W)))) continue;
        // Spread quakes over different epicenters when it costs little.
        const score = r.peak[cell] * (1 - 0.15 * crowdIn(picks, cell));
        if (score > bestScore) {
          bestScore = score;
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
  const samples = samplePlans(rng, land, sites, spawns, witness, sizes);
  // With several cities every one must fall, so each needs a higher share.
  const share = Math.pow(winShare(index), 1 / sites.length);

  const cities: CitySpec[] = [];
  let timingRatio = Infinity;
  for (let c = 0; c < sites.length; c++) {
    const crest = Math.max(...timed.series[c]);
    // Best a single quake of any available type can do from any spawn cell.
    let single = 0;
    // Quakes outside epicenters are allowed but weaker, so weigh every legal cell by its power.
    for (const r of responses[c].values()) reach.cells.forEach((cell, i) => (single = Math.max(single, r.peak[cell] * reach.power[i])));
    // Crest that the target share of imperfect plans reaches.
    const sampleCrests = samples.map((sm) => Math.max(...sm[c])).sort((a, b) => a - b);
    const typical = quantile(sampleCrests, 1 - share);
    let wall = Math.min(Math.max(MIN_WALL, single * WALL_OVER_SINGLE), typical * 0.85, crest * 0.9);
    if (wall < crest * 0.35) {
      if (!relaxed) return null;
    }
    wall = Math.max(0.5, wall);
    const damage = replayDamage(timed.series[c], wall);
    if (damage < (relaxed ? 0.3 : MIN_WITNESS_DAMAGE)) return null;
    const sampleDamage = samples.map((sm) => replayDamage(sm[c], wall)).sort((a, b) => a - b);
    const target = quantile(sampleDamage, 1 - share) * 0.95;
    let hp = Math.max(0.8, Math.min(damage * HP_FRACTION, target));
    const flatDamage = replayDamage(flat.series[c], wall);
    // From the third sea on, firing everything at once should not be enough,
    // as long as that keeps most of the intended share of fair plans winning.
    if (index >= 2) {
      const fairCap = quantile(sampleDamage, 1 - share * 0.6) * 0.95;
      hp = Math.max(hp, Math.min(flatDamage * 1.1, damage * HP_FRACTION, fairCap));
    }
    hp = Math.round(hp * 10) / 10;
    timingRatio = Math.min(timingRatio, flatDamage / hp);
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

/**
 * Plays imperfect versions of the witness: each quake at a random spot in the
 * same epicenter, delays set by lining up the timeline's crest estimates per
 * city. Returns each plan's shoreline series per city.
 */
function samplePlans(
  rng: () => number,
  land: Uint8Array,
  sites: readonly Site[],
  spawns: readonly SpawnArea[],
  witness: readonly QuakePlacement[],
  sizes: readonly number[],
): Float32Array[][] {
  const out: Float32Array[][] = [];
  for (let n = 0; n < SAMPLE_PLANS; n++) {
    const plan = witness.map((w) => {
      const sp = spawns.find((s) => Math.hypot(s.x - w.x, s.y - w.y) <= s.r + 0.5);
      let x = w.x;
      let y = w.y;
      for (let k = 0; sp && k < 40; k++) {
        const a = rng() * Math.PI * 2;
        const r = Math.sqrt(rng()) * sp.r;
        const nx = sp.x + Math.cos(a) * r;
        const ny = sp.y + Math.sin(a) * r;
        if (!land[Math.round(ny) * GRID_W + Math.round(nx)]) {
          x = nx;
          y = ny;
          break;
        }
      }
      return { ...w, x, y };
    });
    let k = 0;
    sizes.forEach((size, c) => {
      const group = plan.slice(k, (k += size));
      const arrive = group.map((q) => crestArrival(q.kind, NO_MODS, waterDistanceField(land, q.x, q.y)[sites[c].mouth]));
      const latest = Math.max(...arrive.filter(Number.isFinite));
      group.forEach((q, i) => {
        q.delay = Number.isFinite(arrive[i]) ? Math.min(BASE_MAX_FUSE, Math.round((latest - arrive[i]) / BASE_FUSE_STEP) * BASE_FUSE_STEP) : 0;
      });
    });
    out.push(forwardSeries(land, sites, plan, true).series);
  }
  return out;
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

/** Shoreline cells of a city at (x, y), or null if it has no sea in front. */
function siteAt(land: Uint8Array, x: number, y: number, minShore: number): Site | null {
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
  if (shore.length < minShore || mouthD > 2.5) return null;
  return { x, y, shore, mouth };
}

function pickCitySites(rng: () => number, land: Uint8Array, count: number): Site[] | null {
  const margin = SPONGE + 3;
  const sites: Site[] = [];
  for (let tries = 0; tries < 3000 && sites.length < count; tries++) {
    const x = margin + Math.floor(rng() * (GRID_W - 2 * margin));
    const y = margin + Math.floor(rng() * (GRID_H - 2 * margin));
    if (!land[y * GRID_W + x]) continue;
    if (sites.some((s) => Math.hypot(s.x - x, s.y - y) < CITY_SEPARATION)) continue;
    // A city needs open water in front of it, but must sit on the coast.
    const site = siteAt(land, x, y, 10);
    if (site) sites.push(site);
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

/** Legal cells at full power (inside an epicenter). */
function cellsInSpawns(land: Uint8Array, spawns: readonly SpawnArea[], cities: readonly { x: number; y: number }[]): number[] {
  const out: number[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (quakePower(spawns, x, y) >= 1 && !placementProblem(land, x, y, cities, [])) out.push(y * GRID_W + x);
    }
  }
  return out;
}

/** Every legal cell with the power a quake would have there. */
function reachableCells(land: Uint8Array, spawns: readonly SpawnArea[], cities: readonly { x: number; y: number }[]) {
  const cells: number[] = [];
  const power: number[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (placementProblem(land, x, y, cities, [])) continue;
      cells.push(y * GRID_W + x);
      power.push(quakePower(spawns, x, y));
    }
  }
  return { cells, power };
}

function peakAround(field: Float32Array, x: number, y: number): number {
  let peak = 0;
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let dy = -ZONE_RADIUS; dy <= ZONE_RADIUS; dy++) {
    for (let dx = -ZONE_RADIUS; dx <= ZONE_RADIUS; dx++) {
      if (dx * dx + dy * dy > ZONE_RADIUS * ZONE_RADIUS) continue;
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= GRID_W || py >= GRID_H) continue;
      peak = Math.max(peak, field[py * GRID_W + px]);
    }
  }
  return peak;
}

/** Rings at fixed map positions; the threshold is what the witness reached there. */
function zonesAt(spots: readonly { x: number; y: number }[], c: Candidate): ChaosZone[] {
  return spots.map((s) => ({
    x: s.x,
    y: s.y,
    threshold: Math.max(1.5, Math.floor(peakAround(c.peakField, s.x, s.y) * 0.85 * 10) / 10),
    mult: ZONE_MULT,
  }));
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
  return zonesAt([{ x, y: (bestIdx - x) / GRID_W }], c);
}
