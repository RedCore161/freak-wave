// Headless calibration: peak height and crest arrival vs distance per quake type.
// Run with: npm run calibrate
import { GRID_W, GRID_H, SIM_STEPS } from '../src/sim/constants.ts';
import { WaveSim } from '../src/sim/WaveSim.ts';
import { buildWaveform, crestArrival, NO_MODS, QUAKE_ORDER, QUAKE_TYPES } from '../src/sim/quakes.ts';

const land = new Uint8Array(GRID_W * GRID_H);
for (const kind of QUAKE_ORDER) {
  const sim = new WaveSim(land);
  const sx = 30;
  const sy = 50;
  // Rifts lie along y, so they radiate along x (broadside).
  sim.addSource({ x: sx, y: sy, waveform: buildWaveform(kind, NO_MODS), startStep: 0, length: QUAKE_TYPES[kind].length, angle: Math.PI / 2 });
  const probes = [15, 30, 60, 100];
  const best = probes.map(() => ({ v: -1, t: 0 }));
  let side = -1;
  const t0 = performance.now();
  for (let s = 0; s < SIM_STEPS; s++) {
    sim.step();
    probes.forEach((d, k) => {
      const v = sim.u[sy * GRID_W + sx + d];
      if (v > best[k].v) best[k] = { v, t: sim.time };
    });
    side = Math.max(side, sim.u[(sy + 30) * GRID_W + sx]);
  }
  const ms = performance.now() - t0;
  console.log(`${kind} (${ms.toFixed(0)} ms for ${SIM_STEPS} steps)`);
  probes.forEach((d, k) =>
    console.log(`  d=${d}: peak ${best[k].v.toFixed(2)} at ${best[k].t.toFixed(2)}s (predicted ${crestArrival(kind, NO_MODS, d).toFixed(2)}s)`),
  );
  console.log(`  end-on d=30: ${side.toFixed(2)}`);
}
