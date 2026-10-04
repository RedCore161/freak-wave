import { DEFAULT_COAST_ABSORB } from '../sim/WaveSim.ts';
import type { QuakeKind, QuakeMods } from '../sim/quakes.ts';

export type SkillId =
  | 'tremor'
  | 'fault'
  | 'megathrust'
  | 'resonance'
  | 'longperiod'
  | 'aftershock'
  | 'seismograph'
  | 'isochrones'
  | 'fuse'
  | 'breakwater'
  | 'chaostheory'
  | 'mirrorcoast'
  | 'harmonic';

export interface SkillDef {
  id: SkillId;
  name: string;
  desc: string;
  cost: number;
  requires: SkillId[];
  /** Position in the tree view. */
  col: number;
  row: number;
  branch: 'arsenal' | 'power' | 'insight' | 'survival';
}

// Upgrades grant control and information rather than raw power, so the
// puzzle never dissolves into "just place the biggest quake".
export const SKILLS: readonly SkillDef[] = [
  { id: 'tremor', name: 'Spare Tremor', desc: '+1 Tremor every level.', cost: 15, requires: [], col: 0, row: 0, branch: 'arsenal' },
  { id: 'fault', name: 'Fault Line', desc: '+1 Quake every level.', cost: 40, requires: ['tremor'], col: 0, row: 1, branch: 'arsenal' },
  { id: 'megathrust', name: 'Megathrust', desc: '+1 Megaquake every level.', cost: 90, requires: ['fault'], col: 0, row: 2, branch: 'arsenal' },

  { id: 'resonance', name: 'Resonance', desc: 'All waves 12% taller.', cost: 20, requires: [], col: 1, row: 0, branch: 'power' },
  { id: 'longperiod', name: 'Long Period', desc: 'Waves 20% longer, so timing is more forgiving.', cost: 35, requires: ['resonance'], col: 1, row: 1, branch: 'power' },
  { id: 'aftershock', name: 'Aftershock', desc: 'Each quake fires again 4 s later at 45% strength.', cost: 80, requires: ['longperiod'], col: 1, row: 2, branch: 'power' },

  { id: 'seismograph', name: 'Seismograph', desc: 'Targets show when each quake’s biggest crest will arrive.', cost: 15, requires: [], col: 2, row: 0, branch: 'insight' },
  { id: 'isochrones', name: 'Isochrones', desc: 'While placing, see arrival-time rings from your cursor.', cost: 35, requires: ['seismograph'], col: 2, row: 1, branch: 'insight' },
  { id: 'fuse', name: 'Delay Fuse', desc: 'Give each quake a 0–4 s delay.', cost: 70, requires: ['isochrones'], col: 2, row: 2, branch: 'insight' },

  { id: 'breakwater', name: 'Breakwater', desc: '+1 life per run.', cost: 20, requires: [], col: 3, row: 0, branch: 'survival' },
  { id: 'chaostheory', name: 'Chaos Theory', desc: '+30% chaos earned.', cost: 40, requires: ['breakwater'], col: 3, row: 1, branch: 'survival' },
  { id: 'mirrorcoast', name: 'Mirror Coast', desc: 'Coasts absorb 60% less, so reflections hit harder.', cost: 60, requires: ['chaostheory'], col: 3, row: 2, branch: 'survival' },

  { id: 'harmonic', name: 'Harmonic Lock', desc: 'All waves another 15% taller.', cost: 140, requires: ['aftershock', 'fuse'], col: 1.5, row: 3, branch: 'power' },
];

export const SKILL_BY_ID = Object.fromEntries(SKILLS.map((s) => [s.id, s])) as Record<SkillId, SkillDef>;

export interface Loadout {
  mods: QuakeMods;
  bonusQuakes: QuakeKind[];
  lives: number;
  chaosMul: number;
  coastAbsorb: number;
  aftershock: boolean;
  seismograph: boolean;
  isochrones: boolean;
  fuse: boolean;
}

export const BASE_LIVES = 3;
export const AFTERSHOCK_DELAY = 4;
export const AFTERSHOCK_STRENGTH = 0.45;
export const MAX_FUSE = 4;

export function loadout(owned: ReadonlySet<SkillId>): Loadout {
  const has = (id: SkillId) => owned.has(id);
  const bonusQuakes: QuakeKind[] = [];
  if (has('tremor')) bonusQuakes.push('small');
  if (has('fault')) bonusQuakes.push('medium');
  if (has('megathrust')) bonusQuakes.push('large');
  return {
    mods: {
      ampMul: (has('resonance') ? 1.12 : 1) * (has('harmonic') ? 1.15 : 1),
      periodMul: has('longperiod') ? 1.2 : 1,
    },
    bonusQuakes,
    lives: BASE_LIVES + (has('breakwater') ? 1 : 0),
    chaosMul: has('chaostheory') ? 1.3 : 1,
    coastAbsorb: DEFAULT_COAST_ABSORB * (has('mirrorcoast') ? 0.4 : 1),
    aftershock: has('aftershock'),
    seismograph: has('seismograph'),
    isochrones: has('isochrones'),
    fuse: has('fuse'),
  };
}

export function canBuy(id: SkillId, owned: ReadonlySet<SkillId>, chaos: number): boolean {
  const def = SKILL_BY_ID[id];
  return !owned.has(id) && chaos >= def.cost && def.requires.every((r) => owned.has(r));
}
