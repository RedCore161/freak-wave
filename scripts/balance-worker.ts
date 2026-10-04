// Worker for scripts/balance.ts: runs win-rate estimates and whole
// progressions in parallel. Each job carries the config to evaluate.
import { parentPort, workerData } from 'node:worker_threads';
import { replaceConfig, type Config } from '../src/config.ts';
import { applyOverrides } from '../src/level/overrides.ts';
import type { LevelData } from '../src/level/types.ts';
import { loadout } from '../src/game/skills.ts';
import { winRate } from '../src/balance/model.ts';
import { runProgression } from '../src/balance/progression.ts';
import { makeRng } from '../src/sim/rng.ts';

const levels = workerData.levels as LevelData[];

type Job =
  | { id: number; type: 'winRate'; config: Config; level: number; owned: string[]; trials: number; seed: number }
  | { id: number; type: 'progression'; config: Config; seed: number; maxAttempts: number };

parentPort!.on('message', (job: Job) => {
  replaceConfig(job.config);
  if (job.type === 'winRate') {
    const level = applyOverrides(levels[job.level]);
    const p = winRate(level, loadout(new Set(job.owned)), job.trials, makeRng(job.seed));
    parentPort!.postMessage({ id: job.id, result: p });
  } else {
    parentPort!.postMessage({ id: job.id, result: runProgression(levels, job.seed, job.maxAttempts) });
  }
});
