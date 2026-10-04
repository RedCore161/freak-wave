// Measures how long attempts last with the early-end rules, per campaign level,
// for three plans: the verified solution, the same with no delays, and a
// single quake. Mirrors Game.settled(). Run with: node scripts/settle-test.ts
import { DT, SIM_STEPS } from '../src/sim/constants.ts';
import { CityMeter } from '../src/sim/cities.ts';
import { buildWaveform, NO_MODS } from '../src/sim/quakes.ts';
import { WaveSim } from '../src/sim/WaveSim.ts';
import type { LevelData, QuakePlacement } from '../src/level/types.ts';
import { loadCampaign } from './lib.ts';

const CALM = 0.05;
const SETTLE_SHARE = 0.9;
const QUIET_STEPS = Math.round(2.5 / DT);
const QUIET_RATIO = 0.75;
const AFTERGLOW = 1.8;

function play(level: LevelData, plan: QuakePlacement[]): { t: number; won: boolean } {
  const sim = new WaveSim(level.land);
  for (const q of plan) sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, NO_MODS), startStep: Math.round(q.delay / DT) });
  const meters = level.cities.map((c) => new CityMeter(c));
  let lastHit = 0;
  let allRuined = -1;
  while (sim.stepIndex < SIM_STEPS) {
    sim.step();
    for (const m of meters) if (m.update(sim.u, sim.stepIndex)) lastHit = sim.stepIndex;
    if (allRuined < 0 && meters.every((m) => m.ruined)) allRuined = sim.stepIndex;
    if (allRuined >= 0 && sim.stepIndex - allRuined >= AFTERGLOW / DT) break;
    if (allRuined < 0 && sim.sourcesDone && sim.stepIndex % 10 === 0) {
      if (sim.activity() < CALM) break;
      const minWall = Math.min(...meters.filter((m) => !m.ruined).map((m) => m.wall));
      const tallest = sim.maxHeight();
      if (tallest < (minWall * SETTLE_SHARE) / Math.max(2, plan.length)) break;
      if (sim.stepIndex - lastHit > QUIET_STEPS && tallest < minWall * QUIET_RATIO) break;
    }
  }
  return { t: sim.time, won: meters.every((m) => m.ruined) };
}

const fmt = (r: { t: number; won: boolean }) => `${r.t.toFixed(1).padStart(4)}s ${r.won ? 'won ' : 'lost'}`;
for (const level of loadCampaign()) {
  const solved = play(level, level.witness);
  const flat = play(level, level.witness.map((q) => ({ ...q, delay: 0 })));
  const single = play(level, level.witness.slice(0, 1));
  console.log(`${level.name.padEnd(16)} solution ${fmt(solved)}   no delays ${fmt(flat)}   one quake ${fmt(single)}`);
}
