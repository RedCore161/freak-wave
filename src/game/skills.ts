import { BASE_FUSE_STEP, BASE_MAX_FUSE, COMBO_MAX, COMBO_STEP, COMBO_WINDOW } from '../sim/constants.ts';
import { DEFAULT_COAST_ABSORB, DEFAULT_OPEN_DAMP } from '../sim/WaveSim.ts';
import type { DamageRules } from '../sim/cities.ts';
import type { QuakeKind, QuakeMods } from '../sim/quakes.ts';
import type { IconId } from '../ui/icons.ts';

export type Branch = 'arsenal' | 'power' | 'timing' | 'destruction' | 'fortune';

export const BRANCHES: { id: Branch; name: string; color: string }[] = [
  { id: 'arsenal', name: 'Arsenal', color: '#ffd166' },
  { id: 'power', name: 'Power', color: '#ff8a5c' },
  { id: 'timing', name: 'Timing', color: '#7fd4ff' },
  { id: 'destruction', name: 'Destruction', color: '#ff5d73' },
  { id: 'fortune', name: 'Fortune', color: '#5dff9a' },
];

/** Everything skills can change. Built fresh from the owned set. */
export interface Loadout {
  mods: QuakeMods;
  bonusQuakes: QuakeKind[];
  attempts: number;
  chaosMul: number;
  coastAbsorb: number;
  openDamp: number;
  rules: DamageRules;
  maxFuse: number;
  fuseStep: number;
  spawnRadiusMul: number;
  extraSpawns: number;
  aftershocks: number;
  isochrones: boolean;
  oracles: number;
  slowMotion: boolean;
  domino: boolean;
  zoneBonus: number;
  salvage: number;
  perfectStorm: boolean;
}

export interface SkillDef {
  id: string;
  name: string;
  desc: string;
  cost: number;
  requires: string[];
  branch: Branch;
  icon: IconId;
  /** Grid position: column 0-9 (two per branch), row 0-6. */
  col: number;
  row: number;
  apply: (l: Loadout) => void;
}

const S = (
  branch: Branch,
  col: number,
  row: number,
  id: string,
  name: string,
  icon: IconId,
  cost: number,
  requires: string[],
  desc: string,
  apply: (l: Loadout) => void,
): SkillDef => ({ id, name, desc, cost, requires, branch, icon, col, row, apply });

// Most upgrades add control, information or new tools rather than raw
// power, so the timing puzzle never dissolves.
export const SKILLS: readonly SkillDef[] = [
  // Arsenal: more and new quakes.
  S('arsenal', 0.5, 0, 'tremor1', 'Spare Tremor', 'tremor', 12, [], '+1 Tremor every sea.', (l) => l.bonusQuakes.push('small')),
  S('arsenal', 0, 1, 'tremor2', 'Tremor Cache', 'tremor', 28, ['tremor1'], '+1 Tremor every sea.', (l) => l.bonusQuakes.push('small')),
  S('arsenal', 1, 1, 'fault1', 'Fault Line', 'quake', 35, ['tremor1'], '+1 Quake every sea.', (l) => l.bonusQuakes.push('medium')),
  S('arsenal', 0, 2, 'pulse1', 'Pulsar', 'pulse', 50, ['tremor2'], 'Unlock the Pulsar: a long train of small waves, made for combos. +1 per sea.', (l) => l.bonusQuakes.push('pulse')),
  S('arsenal', 1, 2, 'fault2', 'Deep Fault', 'quake', 60, ['fault1'], '+1 Quake every sea.', (l) => l.bonusQuakes.push('medium')),
  S('arsenal', 0, 3, 'pulse2', 'Pulsar Array', 'pulse', 90, ['pulse1'], '+1 Pulsar every sea.', (l) => l.bonusQuakes.push('pulse')),
  S('arsenal', 1, 3, 'rift1', 'Rift', 'rift', 80, ['fault2'], 'Unlock the Rift: a fault line that fires its waves sideways. Rotate it to aim. +1 per sea.', (l) => l.bonusQuakes.push('rift')),
  S('arsenal', 0, 4, 'rift2', 'Rift Swarm', 'rift', 140, ['rift1'], '+1 Rift every sea.', (l) => l.bonusQuakes.push('rift')),
  S('arsenal', 1, 4, 'mega1', 'Megathrust', 'mega', 120, ['rift1'], '+1 Megaquake every sea.', (l) => l.bonusQuakes.push('large')),
  S('arsenal', 0.5, 5, 'mega2', 'Supercontinent', 'mega', 220, ['mega1'], '+1 Megaquake every sea.', (l) => l.bonusQuakes.push('large')),

  // Power: shape the waves.
  S('power', 2.5, 0, 'res1', 'Resonance', 'wave', 15, [], 'All waves 8% taller.', (l) => (l.mods.ampMul *= 1.08)),
  S('power', 2, 1, 'res2', 'Resonance II', 'wave', 35, ['res1'], 'All waves another 8% taller.', (l) => (l.mods.ampMul *= 1.08)),
  S('power', 3, 1, 'long1', 'Long Period', 'longwave', 30, ['res1'], 'Waves 12% longer: crests line up more forgivingly.', (l) => (l.mods.periodMul *= 1.12)),
  S('power', 2, 2, 'deep1', 'Deep Water', 'deep', 45, ['res2'], 'Open water drains 60% less energy.', (l) => (l.openDamp *= 0.4)),
  S('power', 3, 2, 'long2', 'Long Period II', 'longwave', 60, ['long1'], 'Waves another 12% longer.', (l) => (l.mods.periodMul *= 1.12)),
  S('power', 2, 3, 'res3', 'Resonance III', 'wave', 80, ['deep1'], 'All waves another 8% taller.', (l) => (l.mods.ampMul *= 1.08)),
  S('power', 3, 3, 'train1', 'Wave Train', 'train', 90, ['long2'], 'Every quake sends one more wave.', (l) => (l.mods.extraCycles += 1)),
  S('power', 2, 4, 'after1', 'Aftershock', 'aftershock', 110, ['res3'], 'Each quake fires again 3 s later at 45% strength.', (l) => (l.aftershocks = Math.max(l.aftershocks, 1))),
  S('power', 3, 4, 'train2', 'Endless Train', 'train', 150, ['train1'], 'Every quake sends another extra wave.', (l) => (l.mods.extraCycles += 1)),
  S('power', 2.5, 5, 'after2', 'Double Aftershock', 'aftershock', 200, ['after1'], 'A second aftershock 3 s after the first.', (l) => (l.aftershocks = 2)),
  S('power', 2.5, 6, 'harmonic', 'Harmonic Lock', 'harmonic', 280, ['after2', 'train2'], 'All waves 12% taller.', (l) => (l.mods.ampMul *= 1.12)),

  // Timing: see and control when crests land.
  S('timing', 4.5, 0, 'iso', 'Isochrones', 'rings', 15, [], 'While placing, see 1-second arrival rings spread from your cursor.', (l) => (l.isochrones = true)),
  S('timing', 4, 1, 'fuse1', 'Long Fuse', 'fuse', 25, ['iso'], 'Delays can go 3 s longer.', (l) => (l.maxFuse += 3)),
  S('timing', 5, 1, 'fine', 'Fine Fuse', 'fine', 30, ['iso'], 'Set delays in 0.05 s steps.', (l) => (l.fuseStep = 0.05)),
  S('timing', 4, 2, 'oracle1', 'Oracle', 'eye', 60, ['fuse1'], 'Once per attempt, preview how much damage your plan would deal.', (l) => (l.oracles += 1)),
  S('timing', 5, 2, 'slow', 'Bullet Time', 'slow', 20, ['fine'], 'Adds a 0.5× replay speed.', (l) => (l.slowMotion = true)),
  S('timing', 4, 3, 'oracle2', 'Clairvoyance', 'eye', 100, ['oracle1'], 'One more Oracle preview per attempt.', (l) => (l.oracles += 1)),
  S('timing', 5, 3, 'fuse2', 'Fuse Mastery', 'fuse', 70, ['slow'], 'Delays can go another 3 s longer.', (l) => (l.maxFuse += 3)),
  S('timing', 4.5, 4, 'rhythm', 'Rhythm', 'combo', 90, ['oracle2', 'fuse2'], 'Crests chain into combos over a 0.5 s longer window.', (l) => (l.rules.comboWindow += 0.5)),
  S('timing', 4.5, 5, 'crescendo', 'Crescendo', 'combo', 140, ['rhythm'], 'Each combo step adds 10% more damage.', (l) => (l.rules.comboStep += 0.1)),
  S('timing', 4.5, 6, 'fortissimo', 'Fortissimo', 'combo', 220, ['crescendo'], 'Combo multiplier can climb 1× higher.', (l) => (l.rules.comboMax += 1)),

  // Destruction: hit cities harder.
  S('destruction', 6.5, 0, 'ram1', 'Battering Ram', 'ram', 15, [], 'Crests deal 15% more damage.', (l) => (l.rules.damageMul *= 1.15)),
  S('destruction', 6, 1, 'under1', 'Undertow', 'wall', 30, ['ram1'], 'City walls 8% lower.', (l) => (l.rules.protectionMul *= 0.92)),
  S('destruction', 7, 1, 'mirror1', 'Mirror Coast', 'mirror', 30, ['ram1'], 'Coasts absorb 40% less: reflections hit harder.', (l) => (l.coastAbsorb *= 0.6)),
  S('destruction', 6, 2, 'under2', 'Undertow II', 'wall', 60, ['under1'], 'City walls another 8% lower.', (l) => (l.rules.protectionMul *= 0.92)),
  S('destruction', 7, 2, 'mirror2', 'Hall of Mirrors', 'mirror', 70, ['mirror1'], 'Coasts absorb another 40% less.', (l) => (l.coastAbsorb *= 0.6)),
  S('destruction', 6, 3, 'ram2', 'Battering Ram II', 'ram', 90, ['under2'], 'Crests deal another 15% more damage.', (l) => (l.rules.damageMul *= 1.15)),
  S('destruction', 7, 3, 'domino', 'Domino', 'domino', 120, ['mirror2'], 'A ruined city collapses into the sea and sets off a Quake.', (l) => (l.domino = true)),
  S('destruction', 6.5, 4, 'under3', 'Erosion', 'wall', 160, ['ram2'], 'City walls another 10% lower.', (l) => (l.rules.protectionMul *= 0.9)),
  S('destruction', 6.5, 5, 'ram3', 'Wrecking Tide', 'ram', 240, ['under3', 'domino'], 'Crests deal 20% more damage.', (l) => (l.rules.damageMul *= 1.2)),

  // Fortune: attempts, chaos and epicenters.
  S('fortune', 8.5, 0, 'break1', 'Breakwater', 'shield', 18, [], '+1 attempt per sea.', (l) => (l.attempts += 1)),
  S('fortune', 8, 1, 'chaos1', 'Chaos Theory', 'chaos', 30, ['break1'], '+25% chaos earned.', (l) => (l.chaosMul += 0.25)),
  S('fortune', 9, 1, 'spawnR', 'Wide Epicenters', 'spawn', 35, ['break1'], 'Epicenters 25% wider.', (l) => (l.spawnRadiusMul *= 1.25)),
  S('fortune', 8, 2, 'salvage', 'Salvage', 'salvage', 40, ['chaos1'], 'Unused quakes pay 6 chaos each instead of 3.', (l) => (l.salvage = 6)),
  S('fortune', 9, 2, 'spawnX', 'Extra Epicenter', 'spawn', 70, ['spawnR'], '+1 epicenter every sea.', (l) => (l.extraSpawns += 1)),
  S('fortune', 8, 3, 'amp1', 'Amplifier', 'amp', 60, ['salvage'], 'Chaos rings multiply by an extra 0.5×.', (l) => (l.zoneBonus += 0.5)),
  S('fortune', 9, 3, 'break2', 'Second Wind', 'shield', 90, ['spawnX'], '+1 attempt per sea.', (l) => (l.attempts += 1)),
  S('fortune', 8.5, 4, 'chaos2', 'Butterfly Effect', 'chaos', 130, ['amp1'], '+25% chaos earned.', (l) => (l.chaosMul += 0.25)),
  S('fortune', 8.5, 5, 'perfect', 'Perfect Storm', 'storm', 180, ['chaos2', 'break2'], 'Clearing a sea on the first attempt pays 1.5× chaos.', (l) => (l.perfectStorm = true)),
];

export const SKILL_BY_ID: Record<string, SkillDef> = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

export const BASE_ATTEMPTS = 3;
export const AFTERSHOCK_DELAY = 3;
export const AFTERSHOCK_STRENGTH = 0.45;

export function loadout(owned: ReadonlySet<string>): Loadout {
  const l: Loadout = {
    mods: { ampMul: 1, periodMul: 1, extraCycles: 0 },
    bonusQuakes: [],
    attempts: BASE_ATTEMPTS,
    chaosMul: 1,
    coastAbsorb: DEFAULT_COAST_ABSORB,
    openDamp: DEFAULT_OPEN_DAMP,
    rules: { damageMul: 1, protectionMul: 1, comboWindow: COMBO_WINDOW, comboStep: COMBO_STEP, comboMax: COMBO_MAX },
    maxFuse: BASE_MAX_FUSE,
    fuseStep: BASE_FUSE_STEP,
    spawnRadiusMul: 1,
    extraSpawns: 0,
    aftershocks: 0,
    isochrones: false,
    oracles: 0,
    slowMotion: false,
    domino: false,
    zoneBonus: 0,
    salvage: 3,
    perfectStorm: false,
  };
  for (const s of SKILLS) if (owned.has(s.id)) s.apply(l);
  return l;
}

export function canBuy(id: string, owned: ReadonlySet<string>, chaos: number): boolean {
  const def = SKILL_BY_ID[id];
  return !!def && !owned.has(id) && chaos >= def.cost && def.requires.every((r) => owned.has(r));
}

export const ZONE_BASE_MULT = 1.5;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const onOff = (v: boolean) => (v ? 'On' : 'Off');
const count = (l: Loadout, k: QuakeKind) => `${l.bonusQuakes.filter((q) => q === k).length}`;

/** Every stat a skill can change, formatted for the tooltip. */
const STATS: { label: string; get: (l: Loadout) => string }[] = [
  { label: 'Extra Tremors', get: (l) => count(l, 'small') },
  { label: 'Extra Quakes', get: (l) => count(l, 'medium') },
  { label: 'Extra Megaquakes', get: (l) => count(l, 'large') },
  { label: 'Rifts', get: (l) => count(l, 'rift') },
  { label: 'Pulsars', get: (l) => count(l, 'pulse') },
  { label: 'Wave height', get: (l) => pct(l.mods.ampMul) },
  { label: 'Wave length', get: (l) => pct(l.mods.periodMul) },
  { label: 'Extra waves per quake', get: (l) => `${l.mods.extraCycles}` },
  { label: 'Open-water energy loss', get: (l) => pct(l.openDamp / DEFAULT_OPEN_DAMP) },
  { label: 'Aftershocks', get: (l) => `${l.aftershocks}` },
  { label: 'Isochrones', get: (l) => onOff(l.isochrones) },
  { label: 'Max delay', get: (l) => `${l.maxFuse} s` },
  { label: 'Delay step', get: (l) => `${l.fuseStep} s` },
  { label: 'Oracle previews', get: (l) => `${l.oracles}` },
  { label: 'Bullet Time', get: (l) => onOff(l.slowMotion) },
  { label: 'Combo window', get: (l) => `${l.rules.comboWindow.toFixed(1)} s` },
  { label: 'Combo bonus per step', get: (l) => `+${Math.round(l.rules.comboStep * 100)}%` },
  { label: 'Combo cap', get: (l) => `×${l.rules.comboMax}` },
  { label: 'Crest damage', get: (l) => pct(l.rules.damageMul) },
  { label: 'City wall height', get: (l) => pct(l.rules.protectionMul) },
  { label: 'Coast absorption', get: (l) => pct(l.coastAbsorb / DEFAULT_COAST_ABSORB) },
  { label: 'Domino', get: (l) => onOff(l.domino) },
  { label: 'Attempts per sea', get: (l) => `${l.attempts}` },
  { label: 'Chaos earned', get: (l) => pct(l.chaosMul) },
  { label: 'Epicenter size', get: (l) => pct(l.spawnRadiusMul) },
  { label: 'Extra epicenters', get: (l) => `${l.extraSpawns}` },
  { label: 'Chaos per unused quake', get: (l) => `${l.salvage}` },
  { label: 'Golden ring multiplier', get: (l) => `×${(ZONE_BASE_MULT + l.zoneBonus).toFixed(1)}` },
  { label: 'Perfect Storm', get: (l) => onOff(l.perfectStorm) },
];

/** What buying a skill changes: current value and value afterwards. */
export function skillDiff(id: string, owned: ReadonlySet<string>): { label: string; from: string; to: string }[] {
  const without = new Set(owned);
  without.delete(id);
  const before = loadout(without);
  const after = loadout(new Set([...without, id]));
  return STATS.map((s) => ({ label: s.label, from: s.get(before), to: s.get(after) })).filter((d) => d.from !== d.to);
}
