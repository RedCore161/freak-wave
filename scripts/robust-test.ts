// How forgiving is each campaign level? Plays many imperfect attempts: quake
// positions anywhere inside the witness's epicenters, delays set by lining up
// the timeline's crest estimates (what a player sees). Reports the win rate.
// Run with: node scripts/robust-test.ts [trials]
import { DT, GRID_W, SIM_STEPS } from '../src/sim/constants.ts';
import { waterDistanceField } from '../src/sim/arrival.ts';
import { CityMeter } from '../src/sim/cities.ts';
import { buildWaveform, crestArrival, NO_MODS } from '../src/sim/quakes.ts';
import { makeRng } from '../src/sim/rng.ts';
import { WaveSim } from '../src/sim/WaveSim.ts';
import type { LevelData } from '../src/level/types.ts';
import { loadCampaign } from './lib.ts';

const TRIALS = Number(process.argv[2] ?? 12);
const JITTER = 4; // cells, fallback when no epicenter matches

function mouthOf(c: LevelData['cities'][number]): number {
  const d = (k: number) => Math.hypot((k % GRID_W) - c.x, Math.floor(k / GRID_W) - c.y);
  return c.shore.reduce((best, cell) => (d(cell) < d(best) ? cell : best));
}

function trial(level: LevelData, rng: () => number): boolean {
  const mouths = level.cities.map(mouthOf);
  const quakes = level.witness.map((w) => {
    // Anywhere inside the epicenter the witness used (a player knows the area, not the spot).
    const s = level.spawns.find((sp) => Math.hypot(sp.x - w.x, sp.y - w.y) <= sp.r + 0.5) ?? { x: w.x, y: w.y, r: JITTER };
    let x = w.x;
    let y = w.y;
    for (let k = 0; k < 40; k++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * s.r;
      const nx = s.x + Math.cos(a) * rr;
      const ny = s.y + Math.sin(a) * rr;
      if (!level.land[Math.round(ny) * GRID_W + Math.round(nx)]) {
        x = nx;
        y = ny;
        break;
      }
    }
    return { ...w, x, y, dist: waterDistanceField(level.land, x, y) };
  });
  // Delays: line up estimated arrivals within each city's group, as on the timeline.
  let k = 0;
  for (let c = 0; c < level.cities.length; c++) {
    const group = quakes.slice(k, (k += level.cities[c].level + 1));
    const arr = group.map((q) => crestArrival(q.kind, NO_MODS, q.dist[mouths[c]]));
    const latest = Math.max(...arr);
    group.forEach((q, i) => (q.delay = Math.round((latest - arr[i]) / 0.1) * 0.1));
  }
  const sim = new WaveSim(level.land);
  for (const q of quakes) sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, NO_MODS), startStep: Math.round(q.delay / DT) });
  const meters = level.cities.map((c) => new CityMeter(c));
  for (let s = 0; s < SIM_STEPS && !meters.every((m) => m.ruined); s++) {
    sim.step();
    for (const m of meters) m.update(sim.u, sim.stepIndex);
  }
  return meters.every((m) => m.ruined);
}

const rng = makeRng(99);
for (const level of loadCampaign()) {
  let wins = 0;
  for (let t = 0; t < TRIALS; t++) if (trial(level, rng)) wins++;
  const cities = level.cities.map((c) => `wall ${c.protection} hp ${c.hp}`).join(' | ');
  console.log(`${level.name.padEnd(16)} ${String(Math.round((wins / TRIALS) * 100)).padStart(3)}% wins   ${cities}`);
}
