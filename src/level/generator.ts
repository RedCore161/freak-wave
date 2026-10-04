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
import { alignDelays, MAX_PLACED, MERGE_COUNT, MERGE_INTO, obtainableKinds, planGroups } from './plan.ts';
import { distanceTo, generateIslands } from './terrain.ts';
import type { ChaosZone, LevelData, LevelRequest, QuakePlacement, SpawnArea } from './types.ts';
import { CONFIG } from '../config.ts';

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
// Tunables (config.json "generator"): minWall; hpFraction (hp never exceeds this
// share of the witness damage, so the solution always wins); samplePlans
// (imperfect plans played per level); wallOverSingle (single quakes stay below
// the wall by this factor); bonus* (how much harder bonus cities are).
const G = () => CONFIG.generator;
/** Cities that would fall to a sliver of overflow are rejected as trivial. */
const MIN_WITNESS_DAMAGE = 2;

export function landFraction(index: number): number {
  return Math.min(0.28, 0.12 + index * 0.02);
}

/** City levels for a sea; a city of level L is ruined by about L+1 quakes. */
export function cityLevels(index: number, rng: () => number): number[] {
  const fixed = [[1], [1], [2], [1, 1], [1, 2], [2, 2]];
  if (index < fixed.length) return fixed[index];
  const options = [[3], [1, 3], [2, 3], [3, 3], [2, 2]];
  return pick(rng, options);
}

/**
 * Share of reasonable-but-imperfect plans that should win: quakes anywhere
 * inside the right epicenters, delays lined up from the timeline estimates.
 * Generous at first, tighter later.
 */
export function winShare(index: number): number {
  return Math.max(G().winShareMin, G().winShareStart - index * G().winShareStep);
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
  /** Optional harder cities; not part of the verified solution. */
  bonusSites: Site[];
  bonusLevels: number[];
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
  groups: number[][];
}

/** Quake kinds the verified solution places (two for the very first sea, else three). */
function solutionKinds(index: number, cities: number, rng: () => number): QuakeKind[] {
  const n = cities === 1 && index === 0 ? 2 : MAX_PLACED;
  return Array.from({ length: n }, () => quakeKindFor(index, rng));
}

/** Sometimes hand out a Quake as three Tremors (or a Megaquake as three Quakes) to merge. */
function unmergeOne(kinds: QuakeKind[], rng: () => number): QuakeKind[] {
  const i = kinds.findIndex((k) => k === 'medium' || k === 'large');
  if (i < 0 || rng() < 0.5) return kinds;
  const lower = kinds[i] === 'large' ? 'medium' : 'small';
  return [...kinds.slice(0, i), ...kinds.slice(i + 1), ...Array.from({ length: MERGE_COUNT }, () => lower as QuakeKind)];
}

export function generateLevel(req: LevelRequest): LevelData {
  const rng = makeRng(req.seed);
  const map = req.map;
  const land = map?.land ?? generateIslands(rng, landFraction(req.index));
  const name = req.name ?? `${pick(rng, NAME_A)} ${pick(rng, NAME_B)}`;
  const coast = distanceTo(land, 1, 32);

  let fixed: Layout | null = null;
  if (map && map.cities.some((c) => !c.bonus)) {
    const core = map.cities.filter((c) => !c.bonus);
    const extra = map.cities.filter((c) => c.bonus);
    const sites = core.map((c) => siteAt(land, c.x, c.y, 3));
    const bonusSites = extra.map((c) => siteAt(land, c.x, c.y, 3));
    if ([...sites, ...bonusSites].some((s) => !s)) throw new Error(`${name}: a city marker is not on a coast`);
    if (sites.length > 2) throw new Error(`${name}: at most two core cities per sea (three quakes)`);
    const spawns = map.spawns.length > 0 ? map.spawns : pickSpawns(rng, land, coast, sites as Site[], 3, []);
    if (!spawns) throw new Error(`${name}: could not place epicenters`);
    fixed = {
      sites: sites as Site[],
      levels: core.map((c) => c.level),
      bonusSites: bonusSites as Site[],
      bonusLevels: extra.map((c) => c.level),
      spawns,
      zoneSpots: map.zones,
    };
  }

  let best: Candidate | null = null;
  // A fixed map only varies in quake types (and not at all if those are fixed too).
  const attempts = fixed ? (req.quakes ? 2 : 4) : MAX_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const relaxed = attempt === attempts - 1 && !best;
    const layout = fixed ?? randomLayout(rng, req.index, land, coast);
    if (!layout) continue;
    const c = tryBuild(rng, req.index, land, layout, relaxed, req.quakes, req.inventory);
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
    groups: best.groups,
    required: Math.max(1, Math.ceil(best.cities.length * CONFIG.rules.passShare - 1e-9)),
    hint: req.hint,
  };
}

function randomLayout(rng: () => number, index: number, land: Uint8Array, coast: Uint8Array): Layout | null {
  const levels = cityLevels(index, rng);
  const sites = pickCitySites(rng, land, levels.length, []);
  if (!sites) return null;
  // As many bonus cities as core ones, so passing means ruining one of each pair.
  const bonusSites = index >= 1 ? pickCitySites(rng, land, levels.length, sites) ?? [] : [];
  const spawns = pickSpawns(rng, land, coast, [...sites, ...bonusSites], spawnCount(index), []);
  if (!spawns) return null;
  return { sites, levels, bonusSites, bonusLevels: bonusSites.map(() => 2), spawns, zoneSpots: null };
}

function tryBuild(
  rng: () => number,
  index: number,
  land: Uint8Array,
  layout: Layout,
  relaxed: boolean,
  quakes?: QuakeKind[],
  inventoryOverride?: QuakeKind[],
): Candidate | null {
  const { sites, levels, spawns, bonusSites, bonusLevels } = layout;
  const allSites = [...sites, ...bonusSites];
  // A map may fix the solution's quake types; otherwise roll them.
  const kinds = quakes && quakes.length >= 2 && quakes.length <= MAX_PLACED ? [...quakes] : solutionKinds(index, sites.length, rng);
  const groups = planGroups(sites.length, kinds.length);
  const inventory = inventoryOverride ?? (index >= 3 ? unmergeOne(kinds, rng) : kinds);
  // Responses for everything the player could field, merges included.
  const fieldable = obtainableKinds(inventory);
  for (const k of kinds) fieldable.add(k);

  // Reverse simulations: one per city and quake type.
  const responses = allSites.map((s) => {
    const byKind = new Map<QuakeKind, Response>();
    for (const kind of fieldable) {
      const sim = new WaveSim(land, { trackPeak: true, trackPeakTime: true });
      const mx = s.mouth % GRID_W;
      sim.addSource({ x: mx, y: (s.mouth - mx) / GRID_W, waveform: buildWaveform(kind, NO_MODS), startStep: 0 });
      sim.run(RECIP_STEPS);
      byKind.set(kind, { peak: sim.peak!, step: sim.peakStep! });
    }
    return byKind;
  });
  const spawnCells = cellsInSpawns(land, spawns, allSites);
  const reach = reachableCells(land, spawns, allSites);
  if (spawnCells.length === 0) return null;

  // Witness: for each quake the spawn cell that serves its cities best
  // (normalised per city, so a shared quake balances both), then delays that
  // line the crests up per group.
  const serves = kinds.map((_, q) => groups.map((g, c) => (g.includes(q) ? c : -1)).filter((c) => c >= 0));
  const maxPeak = sites.map((_, c) => {
    const m = new Map<QuakeKind, number>();
    for (const [kind, r] of responses[c]) m.set(kind, Math.max(1e-6, ...spawnCells.map((cell) => r.peak[cell])));
    return m;
  });
  const cells: number[] = [];
  for (let q = 0; q < kinds.length; q++) {
    let bestCell = -1;
    let bestScore = -Infinity;
    for (const cell of spawnCells) {
      const x = cell % GRID_W;
      const y = (cell - x) / GRID_W;
      if (cells.some((o) => Math.hypot((o % GRID_W) - x, Math.floor(o / GRID_W) - y) < QUAKE_MIN_SEPARATION + 1)) continue;
      let score = Infinity;
      for (const c of serves[q]) score = Math.min(score, responses[c].get(kinds[q])!.peak[cell] / maxPeak[c].get(kinds[q])!);
      // Spread quakes over different epicenters when it costs little.
      score *= 1 - 0.15 * cells.filter((o) => sameSpawn(spawns, o, cell)).length;
      if (score > bestScore) {
        bestScore = score;
        bestCell = cell;
      }
    }
    if (bestCell < 0) return null;
    cells.push(bestCell);
  }
  const arrival = cells.map((cell, q) => sites.map((_, c) => responses[c].get(kinds[q])!.step[cell] * DT));
  const delays = alignDelays(arrival, groups, BASE_MAX_FUSE, BASE_FUSE_STEP);
  const witness: QuakePlacement[] = cells.map((cell, q) => {
    const x = cell % GRID_W;
    return { kind: kinds[q], x, y: (cell - x) / GRID_W, delay: delays[q], angle: 0 };
  });

  const timed = forwardSeries(land, allSites, witness, true);
  const flat = forwardSeries(land, allSites, witness, false);
  const samples = samplePlans(rng, land, allSites, spawns, witness, groups);
  // With several cities every one must fall, so each needs a higher share.
  const share = Math.pow(winShare(index), 1 / sites.length);

  const walls: number[] = [];
  const hps: number[] = [];
  const witnessDamage: number[] = [];
  const flatDamages: number[] = [];
  for (let c = 0; c < sites.length; c++) {
    const crest = Math.max(...timed.series[c]);
    // Best a single quake of any available type can do from any spawn cell.
    let single = 0;
    // Quakes outside epicenters are allowed but weaker, so weigh every legal cell by its power.
    for (const r of responses[c].values()) reach.cells.forEach((cell, i) => (single = Math.max(single, r.peak[cell] * reach.power[i])));
    // Crest that the target share of imperfect plans reaches.
    const sampleCrests = samples.map((sm) => Math.max(...sm[c])).sort((a, b) => a - b);
    const typical = quantile(sampleCrests, 1 - share);
    let wall = Math.min(Math.max(G().minWall, single * G().wallOverSingle), typical * 0.85, crest * 0.9);
    if (wall < crest * 0.35) {
      if (!relaxed) return null;
    }
    wall = Math.max(0.5, wall);
    const damage = replayDamage(timed.series[c], wall);
    if (damage < (relaxed ? 0.3 : MIN_WITNESS_DAMAGE)) return null;
    const sampleDamage = samples.map((sm) => replayDamage(sm[c], wall)).sort((a, b) => a - b);
    const target = quantile(sampleDamage, 1 - share) * 0.95;
    let hp = Math.max(0.8, Math.min(damage * G().hpFraction, target));
    const flatDamage = replayDamage(flat.series[c], wall);
    // From the third sea on, firing everything at once should not be enough,
    // as long as that keeps most of the intended share of fair plans winning.
    if (index >= 2) {
      const fairCap = quantile(sampleDamage, 1 - share * 0.6) * 0.95;
      hp = Math.max(hp, Math.min(flatDamage * 1.1, damage * G().hpFraction, fairCap));
    }
    walls.push(wall);
    hps.push(hp);
    witnessDamage.push(damage);
    flatDamages.push(flatDamage);
  }

  // Cities that share a quake can't both get perfect timing, so check the
  // share of sample plans that ruin *every* city and soften the city that
  // fails most until the target share is met.
  // A margin on top: sampling is noisy and two-city outcomes are fragile.
  const target = Math.min(0.95, winShare(index) + 0.1);
  for (let iter = 0; iter < 16 && sites.length > 1; iter++) {
    const dmg = samples.map((sm) => sites.map((_, c) => replayDamage(sm[c], walls[c])));
    const wins = dmg.filter((d) => d.every((v, c) => v >= hps[c])).length / samples.length;
    if (wins >= target) break;
    const fails = sites.map((_, c) => dmg.filter((d) => d[c] < hps[c]).length);
    const c = fails.indexOf(Math.max(...fails));
    // Mostly no overflow at all: lower the wall; otherwise lower the hp.
    if (dmg.filter((d) => d[c] <= 0).length > samples.length / 2) walls[c] = Math.max(0.5, walls[c] * 0.9);
    else hps[c] = Math.max(0.5, hps[c] * 0.85);
  }

  const cities: CitySpec[] = [];
  let timingRatio = Infinity;
  for (let c = 0; c < sites.length; c++) {
    const hp = Math.round(Math.min(hps[c], replayDamage(timed.series[c], walls[c]) * G().hpFraction) * 10) / 10;
    timingRatio = Math.min(timingRatio, replayDamage(flat.series[c], walls[c]) / Math.max(hp, 0.1));
    cities.push({
      name: `${pick(rng, CITY_A)} ${pick(rng, CITY_B)}`,
      x: sites[c].x,
      y: sites[c].y,
      level: levels[c],
      protection: Math.round(walls[c] * 10) / 10,
      hp: Math.max(0.5, hp),
      shore: sites[c].shore,
    });
  }
  // Bonus cities: walls above what any single quake reaches (by a wider
  // margin than core cities) and hp above what the verified solution or any
  // sample plan deals, so they take upgrades or a dedicated plan.
  bonusSites.forEach((site, b) => {
    const c = sites.length + b;
    let single = 0;
    for (const r of responses[c].values()) reach.cells.forEach((cell, i) => (single = Math.max(single, r.peak[cell] * reach.power[i])));
    const wall = Math.max(G().minWall, single * G().bonusWallOverSingle);
    const fromWitness = replayDamage(timed.series[c], wall) * G().bonusHpOverWitness;
    const fromSamples = Math.max(0, ...samples.map((sm) => replayDamage(sm[c], wall))) * 1.1;
    const hp = Math.max(2 + bonusLevels[b], fromWitness, fromSamples);
    cities.push({
      name: `${pick(rng, CITY_A)} ${pick(rng, CITY_B)}`,
      x: site.x,
      y: site.y,
      level: bonusLevels[b],
      protection: Math.round(wall * 10) / 10,
      hp: Math.round(hp * 10) / 10,
      shore: site.shore,
      bonus: true,
    });
  });
  void witnessDamage;
  void flatDamages;
  return { cities, spawns, witness, inventory, timingRatio, peakField: timed.peak, groups };
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
  groups: readonly number[][],
): Float32Array[][] {
  const out: Float32Array[][] = [];
  const precision = CONFIG.rules.arrivalPrecision;
  for (let n = 0; n < G().samplePlans; n++) {
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
    const arrival = plan.map((q) => {
      const dist = waterDistanceField(land, q.x, q.y);
      return sites.map((site) => crestArrival(q.kind, NO_MODS, dist[site.mouth]) + (rng() * 2 - 1) * precision);
    });
    const delays = alignDelays(arrival, groups, BASE_MAX_FUSE, BASE_FUSE_STEP);
    plan.forEach((q, i) => (q.delay = delays[i]));
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

function pickCitySites(rng: () => number, land: Uint8Array, count: number, avoid: readonly Site[]): Site[] | null {
  const margin = SPONGE + 3;
  const sites: Site[] = [];
  for (let tries = 0; tries < 3000 && sites.length < count; tries++) {
    const x = margin + Math.floor(rng() * (GRID_W - 2 * margin));
    const y = margin + Math.floor(rng() * (GRID_H - 2 * margin));
    if (!land[y * GRID_W + x]) continue;
    if ([...avoid, ...sites].some((s) => Math.hypot(s.x - x, s.y - y) < CITY_SEPARATION)) continue;
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
    mult: CONFIG.chaos.zoneMult,
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
