// Checks that the timeline's crest estimates are good enough to play by:
// keeps each level's witness positions, but sets delays only by lining up
// the estimated crest arrivals per city (what a player sees), then simulates.
// Run with: node scripts/timing-test.ts
import { DT, GRID_W, SIM_STEPS } from '../src/sim/constants.ts';
import { waterDistanceField } from '../src/sim/arrival.ts';
import { CityMeter } from '../src/sim/cities.ts';
import { buildWaveform, crestArrival, NO_MODS } from '../src/sim/quakes.ts';
import { WaveSim } from '../src/sim/WaveSim.ts';
import { generateLevel } from '../src/level/generator.ts';

let solved = 0;
const N = 12;
for (let index = 0; index < N; index++) {
  const level = generateLevel({ index: index % 9, seed: 4242 + index * 131 });
  const mouths = level.cities.map((c) => c.shore.reduce((best, cell) => {
    const d = (k: number) => Math.hypot((k % GRID_W) - c.x, Math.floor(k / GRID_W) - c.y);
    return d(cell) < d(best) ? cell : best;
  }));
  // Assign each quake to the city it reaches strongest in the witness: the city
  // whose estimated arrival is earliest (closest), as a player would guess.
  const quakes = level.witness.map((w) => {
    const dist = waterDistanceField(level.land, w.x, w.y);
    const arr = mouths.map((m) => crestArrival(w.kind, NO_MODS, dist[m]));
    return { ...w, arr };
  });
  // Group by the witness order: the generator places groups city by city.
  let k = 0;
  const groups = level.cities.map((c) => quakes.slice(k, (k += c.level + 1)));
  groups.forEach((g, c) => {
    const latest = Math.max(...g.map((q) => q.arr[c]));
    for (const q of g) q.delay = Math.round((latest - q.arr[c]) / 0.1) * 0.1;
  });
  const sim = new WaveSim(level.land);
  for (const q of quakes) sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, NO_MODS), startStep: Math.round(q.delay / DT) });
  const meters = level.cities.map((c) => new CityMeter(c));
  for (let s = 0; s < SIM_STEPS; s++) {
    sim.step();
    for (const m of meters) m.update(sim.u, sim.stepIndex);
  }
  const ok = meters.every((m) => m.ruined);
  if (ok) solved++;
  const diff = quakes.map((q, i) => (q.delay - level.witness[i].delay).toFixed(1)).join(',');
  console.log(`#${index} ${ok ? 'SOLVED' : 'failed'}  damage ${meters.map((m) => `${m.damage.toFixed(1)}/${m.spec.hp}`).join(' ')}  delay error vs witness ${diff}`);
}
console.log(`${solved}/${N} solved by lining up the timeline estimates`);
