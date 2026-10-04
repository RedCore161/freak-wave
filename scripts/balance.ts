// Auto-balancer. Plays the campaign with a simulated player from a fresh save
// and tunes config.json until the progression feels right:
//   - sea 1 is winnable fresh; most later seas are NOT winnable on arrival,
//   - one or two more upgrades make them winnable,
//   - difficulty rises steadily, and the economy buys ~1-2 skills per sea.
// Then nudges each skill's cost toward its measured value, writes config.json
// and a visual report to balance/report.html.
//
// Run with: npm run balance            (tune, write config.json + report)
//           npm run balance -- --dry   (report only, config.json untouched)
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG, type Config } from '../src/config.ts';
import { SKILLS, SKILL_BY_ID } from '../src/game/skills.ts';
import type { Progression } from '../src/balance/progression.ts';
import { loadCampaignCached } from './lib.ts';
import { renderReport, type ReportData } from './balance-report.ts';

const DRY = process.argv.includes('--dry');
const ITERATIONS = Number(process.env.BALANCE_ITERATIONS ?? 6);
const TRIALS = Number(process.env.BALANCE_TRIALS ?? 32);
const SEEDS = [1, 2, 3, 4];
const MAX_ATTEMPTS = 500;
/** Win chance after the next two upgrades should reach at least this. */
const AFTER_TWO = 0.55;
/** Skills per sea the economy should allow. */
const SKILLS_PER_SEA: [number, number] = [1, 2.5];
/** More attempts than this on one sea counts as a grind. */
const MAX_ATTEMPTS_PER_SEA = 12;
/** Sea whose arrival loadout is used to measure each skill's value. */
const VALUE_SEA = 5;
/** Skills whose effect the simulated player can't feel (pure economy or comfort). */
const NO_VALUE_SKILLS = new Set(['chaos1', 'chaos2', 'salvage', 'amp1', 'perfect', 'slow', 'spawnX', 'fuse1', 'fuse2']);

/** On-arrival win chance target: winnable first on sea 1, then progressively harder. */
function arrivalTarget(index: number, count: number): number {
  if (index === 0) return 0.65;
  if (index === 1) return 0.4;
  const k = (index - 2) / Math.max(1, count - 3);
  return 0.32 - k * 0.17;
}

const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

log('Loading campaign (cached after the first run)...');
const levels = loadCampaignCached();
log(`${levels.length} seas loaded`);

// ---------------------------------------------------------------- worker pool

const size = Math.max(1, Math.min(levels.length * 2, availableParallelism() - 1));
const workers = Array.from({ length: size }, () => new Worker(new URL('./balance-worker.ts', import.meta.url), { workerData: { levels } }));
const idle = [...workers];
const queue: { job: Record<string, unknown>; resolve: (v: unknown) => void }[] = [];
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;
for (const w of workers) {
  w.on('message', (m: { id: number; result: unknown }) => {
    pending.get(m.id)!(m.result);
    pending.delete(m.id);
    idle.push(w);
    pump();
  });
  w.on('error', (e) => {
    console.error(e);
    process.exit(1);
  });
}
function pump(): void {
  while (idle.length && queue.length) {
    const w = idle.pop()!;
    const { job, resolve } = queue.shift()!;
    pending.set(job.id as number, resolve);
    w.postMessage(job);
  }
}
function run<T>(job: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    queue.push({ job: { ...job, id: nextId++ }, resolve: resolve as (v: unknown) => void });
    pump();
  });
}
let roundSeed = 7;
const winRate = (config: Config, level: number, owned: string[], seed = roundSeed) =>
  run<number>({ type: 'winRate', config, level, owned, trials: TRIALS, seed });
const progression = (config: Config, seed: number) => run<Progression>({ type: 'progression', config, seed, maxAttempts: MAX_ATTEMPTS });

// ---------------------------------------------------------------- helpers

const config: Config = structuredClone(CONFIG);
const lv = (i: number) => (config.levels[String(i)] ??= {});
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Skills a player could buy next that change play, cheapest first, using the config being tuned. */
function nextSkills(owned: ReadonlySet<string>, n: number): string[] {
  return SKILLS.filter((s) => !owned.has(s.id) && !NO_VALUE_SKILLS.has(s.id) && s.requires.every((r) => owned.has(r)))
    .sort((a, b) => config.skills[a.id].cost - config.skills[b.id].cost)
    .slice(0, n)
    .map((s) => s.id);
}

function scaleCosts(k: number, ids = Object.keys(config.skills)): void {
  for (const id of ids) config.skills[id].cost = Math.max(5, Math.round((config.skills[id].cost * k) / 5) * 5);
}

/** Owned set when the reference player first reached each sea (or its final set). */
function arrivals(p: Progression): string[][] {
  const last = p.seas.length ? [...p.seas[p.seas.length - 1].arrivalOwned, ...p.seas[p.seas.length - 1].purchases] : [];
  return levels.map((_, i) => p.seas[i]?.arrivalOwned ?? last);
}

async function measure(p: Progression) {
  const arr = arrivals(p);
  const jobs = levels.map(async (_, i) => {
    const owned = arr[i];
    const cands = nextSkills(new Set(owned), 8);
    const gains = await Promise.all(cands.map((id) => winRate(config, i, [...owned, id])));
    const plus = [...owned, ...cands.map((id, k) => ({ id, p: gains[k] })).sort((a, b) => b.p - a.p).slice(0, 2).map((g) => g.id)];
    const [p0, p2] = await Promise.all([winRate(config, i, owned), winRate(config, i, plus)]);
    return { p0, p2 };
  });
  return Promise.all(jobs);
}

function purchasesPerSea(p: Progression): number {
  const reached = Math.max(1, p.seas.length);
  return p.purchases.length / reached;
}

// ---------------------------------------------------------------- skill value

const before = Object.fromEntries(Object.entries(config.skills).map(([id, s]) => [id, s.cost]));
const deltas: Record<string, number | null> = {};

/** Measures each skill on a mid-campaign sea and nudges costs toward value per chaos. */
async function valuePass(ref: Progression, seed: number): Promise<void> {
const base = arrivals(ref)[Math.min(VALUE_SEA, levels.length - 1)];
const seaForValue = Math.min(VALUE_SEA, levels.length - 1);
const withPrereqs = (id: string, owned: Set<string>) => {
  const out = new Set(owned);
  const add = (s: string) => {
    for (const r of SKILL_BY_ID[s].requires) add(r);
    out.add(s);
  };
  for (const r of SKILL_BY_ID[id].requires) add(r);
  return out;
};
await Promise.all(
  SKILLS.map(async (s) => {
    if (NO_VALUE_SKILLS.has(s.id)) return (deltas[s.id] = null);
    const pre = withPrereqs(s.id, new Set(base));
    if (pre.has(s.id)) return (deltas[s.id] = null);
    const [a, b] = await Promise.all([winRate(config, seaForValue, [...pre], seed), winRate(config, seaForValue, [...pre, s.id], seed)]);
    deltas[s.id] = b - a;
  }),
);
const measured = Object.values(deltas).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
const median = measured.length ? measured[Math.floor(measured.length / 2)] : 0;
if (median > 0) {
  for (const s of SKILLS) {
    const d = deltas[s.id];
    if (d === null || d === undefined) continue;
    // Gentle: value per chaos evens out over several runs, not in one jump.
    const k = d <= 0 ? 0.85 : Math.min(1.3, Math.max(0.75, Math.sqrt(d / median)));
    config.skills[s.id].cost = Math.max(5, Math.round((config.skills[s.id].cost * k) / 5) * 5);
  }
}
}

// ---------------------------------------------------------------- tuning

/** The config with one sea's multipliers replaced (for search probes). */
function withSea(i: number, hpMul: number, wallMul: number): Config {
  const c = structuredClone(config);
  c.levels[String(i)] = { ...c.levels[String(i)], hpMul, wallMul };
  return c;
}

const HP_MIN = 0.2;
const HP_MAX = 25;
const SEARCH_STEPS = 6;

/**
 * Bisection on the hp multiplier (log scale) so the on-arrival win chance
 * hits the target, then makes sure two more upgrades open the sea up. Fixed
 * seeds keep probes comparable, so win chance falls monotonically with hp.
 */
async function tuneSea(i: number, owned: string[], candidates: string[]): Promise<{ hp: number; wall: number; p0: number; p2: number; best: string[] }> {
  const target = arrivalTarget(i, levels.length);
  let wall = lv(i).wallMul ?? 1;
  const search = async (set: string[], goal: number, lo: number, hi: number) => {
    let a = Math.log(lo);
    let b = Math.log(hi);
    for (let k = 0; k < SEARCH_STEPS; k++) {
      const mid = (a + b) / 2;
      const p = await winRate(withSea(i, Math.exp(mid), wall), i, set);
      if (p > goal) a = mid;
      else b = mid;
    }
    return Math.exp((a + b) / 2);
  };
  // Cities can be too weak even at max hp (walls too low).
  for (let k = 0; k < 3 && (await winRate(withSea(i, HP_MAX, wall), i, owned)) > target + 0.1; k++) wall = Math.min(4, wall * 1.3);
  let hp = await search(owned, target, HP_MIN, HP_MAX);
  // The two upgrades a thoughtful player would buy next: the most helpful ones here.
  const gains = await Promise.all(candidates.map((id) => winRate(withSea(i, hp, wall), i, [...owned, id])));
  const best = candidates.map((id, k) => ({ id, p: gains[k] })).sort((a, b) => b.p - a.p).slice(0, 2).map((g) => g.id);
  const plus = [...owned, ...best];
  if ((await winRate(withSea(i, HP_MIN, wall), i, plus)) < AFTER_TWO) wall = Math.max(0.4, wall * 0.85);
  let p2 = await winRate(withSea(i, hp, wall), i, plus);
  if (p2 < AFTER_TWO) {
    // Soften until two upgrades open the sea, but never past target + 0.2 on
    // arrival: if upgrades barely help here, the effect scale has to fix it.
    const floor = await search(owned, Math.min(0.95, target + 0.2), HP_MIN, hp);
    hp = Math.max(floor, await search(plus, AFTER_TWO, HP_MIN, hp));
    p2 = await winRate(withSea(i, hp, wall), i, plus);
  }
  const p0 = await winRate(withSea(i, hp, wall), i, owned);
  return { hp: r2(hp), wall: r2(wall), p0, p2, best };
}

/**
 * Effect sizes that scale with one knob. "up": bonus fractions (k times
 * bigger); "frac": reductions, pushed toward 1 smoothly; "down": crest-mark
 * precision in seconds (smaller is better).
 */
const SCALABLE: Record<string, 'up' | 'frac' | 'down'> = {
  res1: 'up', res2: 'up', res3: 'up', harmonic: 'up', ram1: 'up', ram2: 'up', ram3: 'up',
  rhythm: 'up', crescendo: 'up',
  deep1: 'frac', under1: 'frac', under2: 'frac', under3: 'frac', mirror1: 'frac', mirror2: 'frac',
  seis1: 'down', seis2: 'down', seis3: 'down',
};
// Baselines are stored in config.json so repeated runs never compound the scale.
config.balance ??= { effectBase: Object.fromEntries(Object.keys(SCALABLE).map((id) => [id, config.skills[id].value])), effectScale: 1 };
const baseValues = config.balance.effectBase;
let effectScale = config.balance.effectScale;
function applyEffectScale(): void {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (const [id, mode] of Object.entries(SCALABLE)) {
    const v = baseValues[id];
    config.skills[id].value =
      mode === 'up' ? r3(v * effectScale) : mode === 'frac' ? r3(Math.min(0.85, 1 - Math.pow(1 - v, effectScale))) : r3(Math.max(0.02, Math.pow(v, effectScale)));
  }
}
/** The two most helpful next upgrades should lift win chance by at least this much (median sea). */
const UPGRADE_LIFT = 0.25;

const iterations: ReportData['iterations'] = [];
let costScale = 1;
for (let iter = 1; iter <= ITERATIONS; iter++) {
  // New random samples every round, so the search can't overfit one sample set.
  roundSeed = 7 + iter * 101;
  const runs = await Promise.all(SEEDS.map((sd) => progression(config, sd)));
  // The median-length trajectory is the most representative player.
  const ref = [...runs].sort((a, b) => a.attempts - b.attempts)[Math.floor(runs.length / 2)];
  const arr = arrivals(ref);
  const tuned = await Promise.all(levels.map((_, i) => tuneSea(i, arr[i], nextSkills(new Set(arr[i]), 8))));
  let offTarget = 0;
  tuned.forEach((t, i) => {
    // A sea that became a grind for any simulated player gets softer on top.
    const grind = Math.max(...runs.map((r) => r.seas[i]?.attempts ?? 0));
    lv(i).hpMul = r2(grind > MAX_ATTEMPTS_PER_SEA ? t.hp * 0.8 : t.hp);
    lv(i).wallMul = t.wall;
    if (Math.abs(t.p0 - arrivalTarget(i, levels.length)) > 0.12) offTarget++;
  });
  // Upgrades must matter: if two of them barely move the needle, strengthen effects.
  const lifts = tuned.slice(1).map((t) => t.p2 - t.p0);
  const lift = [...lifts].sort((a, b) => a - b)[Math.floor(lifts.length / 2)] ?? 0;
  if (lift < UPGRADE_LIFT) effectScale = Math.min(2.5, effectScale * 1.15);
  else if (lift > UPGRADE_LIFT * 2) effectScale = Math.max(0.6, effectScale / 1.1);
  applyEffectScale();
  config.balance.effectScale = r2(effectScale);
  // Economy: about one or two skills per sea.
  const perSea = purchasesPerSea(ref);
  if (perSea > SKILLS_PER_SEA[1]) {
    scaleCosts(1.15);
    costScale *= 1.15;
  } else if (perSea < SKILLS_PER_SEA[0]) {
    scaleCosts(0.87);
    costScale *= 0.87;
  }
  // Halfway: price skills by value, so the remaining rounds tune with final costs.
  if (iter === Math.ceil(ITERATIONS / 2)) {
    log('Measuring each skill on a mid-campaign sea...');
    await valuePass(ref, roundSeed + 5);
  }
  iterations.push({ iter, attempts: ref.attempts, finished: ref.finished, costScale: r2(costScale), effectScale: r2(effectScale), lift: r2(lift), purchasesPerSea: r2(perSea), offTarget });
  log(
    `iter ${iter}: ${ref.attempts} attempts${ref.finished ? '' : ' (unfinished)'}, ${perSea.toFixed(1)} skills/sea, ` +
      `lift ${(lift * 100).toFixed(0)} pts -> effects x${effectScale.toFixed(2)}, ${offTarget} off target; arrival ${tuned.map((x) => Math.round(x.p0 * 100)).join(' ')} | +2 ${tuned.map((x) => Math.round(x.p2 * 100)).join(' ')}`,
  );
}

// ---------------------------------------------------------------- final check

log('Final progression over all seeds...');
// Independent samples for the reported numbers.
roundSeed = 4242;
const finals = await Promise.all(SEEDS.map((s) => progression(config, s)));
const final = finals[0];
const fm = await measure(final);

const report: ReportData = {
  generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
  durationSec: (performance.now() - t0) / 1000,
  iterations,
  seas: levels.map((l, i) => ({
    name: l.name,
    hpMul: lv(i).hpMul ?? 1,
    wallMul: lv(i).wallMul ?? 1,
    target: arrivalTarget(i, levels.length),
    p0: fm[i].p0,
    p2: fm[i].p2,
    attempts: final.seas[i]?.attempts ?? 0,
    firstTry: final.seas[i]?.firstTry ?? false,
    arrivalT: final.seas[i]?.arrivalT ?? 0,
    clearedT: final.seas[i]?.clearedT ?? null,
    purchases: (final.seas[i]?.purchases ?? []).map((id) => SKILL_BY_ID[id].name),
    ownedOnArrival: final.seas[i]?.arrivalOwned.length ?? 0,
  })),
  timeline: final.timeline,
  purchases: final.purchases.map((p) => ({ ...p, name: SKILL_BY_ID[p.id].name })),
  skills: SKILLS.map((s) => ({ id: s.id, name: s.name, branch: s.branch, before: before[s.id], after: config.skills[s.id].cost, delta: deltas[s.id] ?? null })),
  seeds: finals.map((p, i) => ({ seed: SEEDS[i], attempts: p.attempts, finished: p.finished })),
};

mkdirSync('balance', { recursive: true });
writeFileSync('balance/report.html', renderReport(report));
writeFileSync('balance/report.json', JSON.stringify(report, null, 2));
if (!DRY) writeFileSync('config.json', JSON.stringify(config, null, 2) + '\n');
log(`Done. Report: balance/report.html${DRY ? ' (dry run, config.json unchanged)' : '; config.json updated'}`);
for (const w of workers) await w.terminate();
