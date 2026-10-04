import { BASE_FUSE_STEP, BASE_MAX_FUSE, COMBO_MAX, COMBO_STEP, COMBO_WINDOW } from '../sim/constants.ts';
import { DEFAULT_COAST_ABSORB, DEFAULT_OPEN_DAMP } from '../sim/WaveSim.ts';
import type { DamageRules } from '../sim/cities.ts';
import type { QuakeKind, QuakeMods } from '../sim/quakes.ts';
import type { IconId } from '../ui/icons.ts';
import { CONFIG } from '../config.ts';

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
  perfectStorm: number;
  /** Whether the timeline shows crest-arrival marks at all (Seismograph). */
  marks: boolean;
  /**
   * +/- seconds of uncertainty in those marks. Without marks it models how
   * far off a player's own guess is (used by the simulated player).
   */
  precision: number;
}

export interface SkillDef {
  id: string;
  name: string;
  branch: Branch;
  icon: IconId;
  requires: string[];
  /** Grid position: column 0-9 (two per branch), row 0-7. */
  col: number;
  row: number;
  /** Cost and effect size come from config.json. */
  readonly cost: number;
  readonly value: number;
  desc: string;
  apply: (l: Loadout) => void;
}

const pctOf = (v: number) => `${Math.round(v * 100)}%`;

function S(
  branch: Branch,
  col: number,
  row: number,
  id: string,
  name: string,
  icon: IconId,
  requires: string[],
  describe: (v: number) => string,
  apply: (l: Loadout, v: number) => void,
): SkillDef {
  const entry = () => CONFIG.skills[id] ?? { cost: 999, value: 0 };
  return {
    id,
    name,
    branch,
    icon,
    requires,
    col,
    row,
    get cost() {
      return entry().cost;
    },
    get value() {
      return entry().value;
    },
    get desc() {
      return describe(entry().value);
    },
    apply: (l) => apply(l, entry().value),
  };
}

const plural = (v: number, one: string) => `+${v} ${one}${v === 1 ? '' : 's'}`;

// Most upgrades add control, information or new tools rather than raw
// power, so the timing puzzle never dissolves. Numbers live in config.json.
export const SKILLS: readonly SkillDef[] = [
  // Arsenal: more and new quakes (only three can be placed; the rest merge).
  S('arsenal', 0.5, 0, 'tremor1', 'Spare Tremor', 'tremor', [], (v) => `${plural(v, 'Tremor')} every sea.`, (l, v) => addQuakes(l, 'small', v)),
  S('arsenal', 0, 1, 'tremor2', 'Tremor Cache', 'tremor', ['tremor1'], (v) => `${plural(v, 'Tremor')} every sea.`, (l, v) => addQuakes(l, 'small', v)),
  S('arsenal', 1, 1, 'fault1', 'Fault Line', 'quake', ['tremor1'], (v) => `${plural(v, 'Quake')} every sea.`, (l, v) => addQuakes(l, 'medium', v)),
  S('arsenal', 0, 2, 'pulse1', 'Pulsar', 'pulse', ['tremor2'], (v) => `Unlock the Pulsar: a long train of small waves, made for combos. ${plural(v, 'Pulsar')} per sea.`, (l, v) => addQuakes(l, 'pulse', v)),
  S('arsenal', 1, 2, 'fault2', 'Deep Fault', 'quake', ['fault1'], (v) => `${plural(v, 'Quake')} every sea.`, (l, v) => addQuakes(l, 'medium', v)),
  S('arsenal', 0, 3, 'pulse2', 'Pulsar Array', 'pulse', ['pulse1'], (v) => `${plural(v, 'Pulsar')} every sea.`, (l, v) => addQuakes(l, 'pulse', v)),
  S('arsenal', 1, 3, 'rift1', 'Rift', 'rift', ['fault2'], (v) => `Unlock the Rift: a fault line that fires its waves sideways. Rotate it to aim. ${plural(v, 'Rift')} per sea.`, (l, v) => addQuakes(l, 'rift', v)),
  S('arsenal', 0, 4, 'rift2', 'Rift Swarm', 'rift', ['rift1'], (v) => `${plural(v, 'Rift')} every sea.`, (l, v) => addQuakes(l, 'rift', v)),
  S('arsenal', 1, 4, 'mega1', 'Megathrust', 'mega', ['rift1'], (v) => `${plural(v, 'Megaquake')} every sea.`, (l, v) => addQuakes(l, 'large', v)),
  S('arsenal', 0.5, 5, 'mega2', 'Supercontinent', 'mega', ['mega1'], (v) => `${plural(v, 'Megaquake')} every sea.`, (l, v) => addQuakes(l, 'large', v)),

  // Power: shape the waves.
  S('power', 2.5, 0, 'res1', 'Resonance', 'wave', [], (v) => `All waves ${pctOf(v)} taller.`, (l, v) => (l.mods.ampMul *= 1 + v)),
  S('power', 2, 1, 'res2', 'Resonance II', 'wave', ['res1'], (v) => `All waves another ${pctOf(v)} taller.`, (l, v) => (l.mods.ampMul *= 1 + v)),
  S('power', 3, 1, 'long1', 'Long Period', 'longwave', ['res1'], (v) => `Waves ${pctOf(v)} longer: crests line up more forgivingly (combo window grows too).`, (l, v) => stretchPeriod(l, v)),
  S('power', 2, 2, 'deep1', 'Deep Water', 'deep', ['res2'], (v) => `Open water drains ${pctOf(v)} less energy.`, (l, v) => (l.openDamp *= 1 - v)),
  S('power', 3, 2, 'long2', 'Long Period II', 'longwave', ['long1'], (v) => `Waves another ${pctOf(v)} longer.`, (l, v) => stretchPeriod(l, v)),
  S('power', 2, 3, 'res3', 'Resonance III', 'wave', ['deep1'], (v) => `All waves another ${pctOf(v)} taller.`, (l, v) => (l.mods.ampMul *= 1 + v)),
  S('power', 3, 3, 'train1', 'Wave Train', 'train', ['long2'], (v) => `Every quake sends ${v} more wave${v === 1 ? '' : 's'}.`, (l, v) => (l.mods.extraCycles += v)),
  S('power', 2, 4, 'after1', 'Aftershock', 'aftershock', ['res3'], () => `Each quake fires again ${AFTERSHOCK_DELAY} s later at ${pctOf(AFTERSHOCK_STRENGTH)} strength.`, (l, v) => (l.aftershocks = Math.max(l.aftershocks, v))),
  S('power', 3, 4, 'train2', 'Endless Train', 'train', ['train1'], (v) => `Every quake sends ${v} more wave${v === 1 ? '' : 's'}.`, (l, v) => (l.mods.extraCycles += v)),
  S('power', 2.5, 5, 'after2', 'Double Aftershock', 'aftershock', ['after1'], (v) => `Up to ${v} aftershocks, ${AFTERSHOCK_DELAY} s apart.`, (l, v) => (l.aftershocks = Math.max(l.aftershocks, v))),
  S('power', 2.5, 6, 'harmonic', 'Harmonic Lock', 'harmonic', ['after2', 'train2'], (v) => `All waves ${pctOf(v)} taller.`, (l, v) => (l.mods.ampMul *= 1 + v)),

  // Timing: see and control when crests land.
  S('timing', 4.5, 0, 'seis1', 'Seismograph', 'fine', [], (v) => `Shows when each quake's crest reaches each city, roughly (±${v.toFixed(2)} s).`, (l, v) => seismograph(l, v)),
  S('timing', 4, 1, 'iso', 'Isochrones', 'rings', ['seis1'], () => 'While placing, see 1-second arrival rings spread from your cursor.', (l) => (l.isochrones = true)),
  S('timing', 5, 1, 'seis2', 'Seismograph II', 'fine', ['seis1'], (v) => `Crest marks accurate to ±${v.toFixed(2)} s.`, (l, v) => seismograph(l, v)),
  S('timing', 4, 2, 'fuse1', 'Long Fuse', 'fuse', ['iso'], (v) => `Delays can go ${v} s longer.`, (l, v) => (l.maxFuse += v)),
  S('timing', 5, 2, 'fine', 'Fine Fuse', 'fine', ['seis2'], (v) => `Set delays in ${v} s steps.`, (l, v) => (l.fuseStep = Math.min(l.fuseStep, v))),
  S('timing', 4, 3, 'oracle1', 'Oracle', 'eye', ['fuse1'], (v) => `${v} preview${v === 1 ? '' : 's'} per attempt of how much damage your plan would deal.`, (l, v) => (l.oracles += v)),
  S('timing', 5, 3, 'seis3', 'Seismograph III', 'fine', ['fine'], (v) => `Crest marks accurate to ±${v.toFixed(2)} s.`, (l, v) => seismograph(l, v)),
  S('timing', 4, 4, 'oracle2', 'Clairvoyance', 'eye', ['oracle1'], (v) => `${v} more Oracle preview${v === 1 ? '' : 's'} per attempt.`, (l, v) => (l.oracles += v)),
  S('timing', 5, 4, 'fuse2', 'Fuse Mastery', 'fuse', ['seis3'], (v) => `Delays can go another ${v} s longer.`, (l, v) => (l.maxFuse += v)),
  S('timing', 4, 5, 'slow', 'Bullet Time', 'slow', ['oracle2'], () => 'Adds a 0.5× replay speed.', (l) => (l.slowMotion = true)),
  S('timing', 5, 5, 'rhythm', 'Rhythm', 'combo', ['fuse2'], (v) => `Crests chain into combos over a ${v} s longer window.`, (l, v) => (l.rules.comboWindow += v)),
  S('timing', 4.5, 6, 'crescendo', 'Crescendo', 'combo', ['rhythm'], (v) => `Each combo step adds ${pctOf(v)} more damage.`, (l, v) => (l.rules.comboStep += v)),
  S('timing', 4.5, 7, 'fortissimo', 'Fortissimo', 'combo', ['crescendo'], (v) => `Combo multiplier can climb ${v}× higher.`, (l, v) => (l.rules.comboMax += v)),

  // Destruction: hit cities harder.
  S('destruction', 6.5, 0, 'ram1', 'Battering Ram', 'ram', [], (v) => `Crests deal ${pctOf(v)} more damage.`, (l, v) => (l.rules.damageMul *= 1 + v)),
  S('destruction', 6, 1, 'under1', 'Undertow', 'wall', ['ram1'], (v) => `City walls ${pctOf(v)} lower.`, (l, v) => (l.rules.protectionMul *= 1 - v)),
  S('destruction', 7, 1, 'mirror1', 'Mirror Coast', 'mirror', ['ram1'], (v) => `Coasts absorb ${pctOf(v)} less: reflections hit harder.`, (l, v) => (l.coastAbsorb *= 1 - v)),
  S('destruction', 6, 2, 'under2', 'Undertow II', 'wall', ['under1'], (v) => `City walls another ${pctOf(v)} lower.`, (l, v) => (l.rules.protectionMul *= 1 - v)),
  S('destruction', 7, 2, 'mirror2', 'Hall of Mirrors', 'mirror', ['mirror1'], (v) => `Coasts absorb another ${pctOf(v)} less.`, (l, v) => (l.coastAbsorb *= 1 - v)),
  S('destruction', 6, 3, 'ram2', 'Battering Ram II', 'ram', ['under2'], (v) => `Crests deal another ${pctOf(v)} more damage.`, (l, v) => (l.rules.damageMul *= 1 + v)),
  S('destruction', 7, 3, 'domino', 'Domino', 'domino', ['mirror2'], () => 'A ruined city collapses into the sea and sets off a Quake.', (l) => (l.domino = true)),
  S('destruction', 6.5, 4, 'under3', 'Erosion', 'wall', ['ram2'], (v) => `City walls another ${pctOf(v)} lower.`, (l, v) => (l.rules.protectionMul *= 1 - v)),
  S('destruction', 6.5, 5, 'ram3', 'Wrecking Tide', 'ram', ['under3', 'domino'], (v) => `Crests deal ${pctOf(v)} more damage.`, (l, v) => (l.rules.damageMul *= 1 + v)),

  // Fortune: attempts, chaos and epicenters.
  S('fortune', 8.5, 0, 'break1', 'Breakwater', 'shield', [], (v) => `${plural(v, 'attempt')} per sea.`, (l, v) => (l.attempts += v)),
  S('fortune', 8, 1, 'chaos1', 'Chaos Theory', 'chaos', ['break1'], (v) => `+${pctOf(v)} chaos earned.`, (l, v) => (l.chaosMul += v)),
  S('fortune', 9, 1, 'spawnR', 'Wide Epicenters', 'spawn', ['break1'], (v) => `Epicenters ${pctOf(v)} wider.`, (l, v) => (l.spawnRadiusMul *= 1 + v)),
  S('fortune', 8, 2, 'salvage', 'Salvage', 'salvage', ['chaos1'], (v) => `Unused quakes pay ${v} chaos each instead of ${CONFIG.chaos.salvage}.`, (l, v) => (l.salvage = Math.max(l.salvage, v))),
  S('fortune', 9, 2, 'spawnX', 'Extra Epicenter', 'spawn', ['spawnR'], (v) => `${plural(v, 'epicenter')} every sea.`, (l, v) => (l.extraSpawns += v)),
  S('fortune', 8, 3, 'amp1', 'Amplifier', 'amp', ['salvage'], (v) => `Chaos rings multiply by an extra ${v}×.`, (l, v) => (l.zoneBonus += v)),
  S('fortune', 9, 3, 'break2', 'Second Wind', 'shield', ['spawnX'], (v) => `${plural(v, 'attempt')} per sea.`, (l, v) => (l.attempts += v)),
  S('fortune', 8.5, 4, 'chaos2', 'Butterfly Effect', 'chaos', ['amp1'], (v) => `+${pctOf(v)} chaos earned.`, (l, v) => (l.chaosMul += v)),
  S('fortune', 8.5, 5, 'perfect', 'Perfect Storm', 'storm', ['chaos2', 'break2'], (v) => `Clearing a sea on the first attempt pays ${v}× chaos.`, (l, v) => (l.perfectStorm = v)),
];

/** Longer waves space crests further apart, so the combo window stretches with them. */
function stretchPeriod(l: Loadout, v: number): void {
  l.mods.periodMul *= 1 + v;
  l.rules.comboWindow *= 1 + v;
}

function seismograph(l: Loadout, v: number): void {
  l.marks = true;
  l.precision = Math.min(l.precision, v);
}

function addQuakes(l: Loadout, kind: QuakeKind, n: number): void {
  for (let i = 0; i < n; i++) l.bonusQuakes.push(kind);
}

export const SKILL_BY_ID: Record<string, SkillDef> = Object.fromEntries(SKILLS.map((s) => [s.id, s]));

export const AFTERSHOCK_DELAY = 3;
export const AFTERSHOCK_STRENGTH = 0.45;

export function loadout(owned: ReadonlySet<string>): Loadout {
  const l: Loadout = {
    mods: { ampMul: 1, periodMul: 1, extraCycles: 0 },
    bonusQuakes: [],
    attempts: CONFIG.rules.baseAttempts,
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
    salvage: CONFIG.chaos.salvage,
    perfectStorm: 1,
    marks: false,
    precision: CONFIG.rules.arrivalPrecision,
  };
  for (const s of SKILLS) if (owned.has(s.id)) s.apply(l);
  return l;
}

export function canBuy(id: string, owned: ReadonlySet<string>, chaos: number): boolean {
  const def = SKILL_BY_ID[id];
  return !!def && !owned.has(id) && chaos >= def.cost && def.requires.every((r) => owned.has(r));
}

/** Golden ring multiplier before skills. */
export function zoneBaseMult(): number {
  return CONFIG.chaos.zoneMult;
}

const onOff = (v: boolean) => (v ? 'On' : 'Off');
const count = (l: Loadout, k: QuakeKind) => `${l.bonusQuakes.filter((q) => q === k).length}`;

/** Every stat a skill can change, formatted for the tooltip. */
const STATS: { label: string; get: (l: Loadout) => string }[] = [
  { label: 'Extra Tremors', get: (l) => count(l, 'small') },
  { label: 'Extra Quakes', get: (l) => count(l, 'medium') },
  { label: 'Extra Megaquakes', get: (l) => count(l, 'large') },
  { label: 'Rifts', get: (l) => count(l, 'rift') },
  { label: 'Pulsars', get: (l) => count(l, 'pulse') },
  { label: 'Wave height', get: (l) => pctOf(l.mods.ampMul) },
  { label: 'Wave length', get: (l) => pctOf(l.mods.periodMul) },
  { label: 'Extra waves per quake', get: (l) => `${l.mods.extraCycles}` },
  { label: 'Open-water energy loss', get: (l) => pctOf(l.openDamp / DEFAULT_OPEN_DAMP) },
  { label: 'Aftershocks', get: (l) => `${l.aftershocks}` },
  { label: 'Crest marks', get: (l) => (l.marks ? `±${l.precision.toFixed(2)} s` : 'None') },
  { label: 'Isochrones', get: (l) => onOff(l.isochrones) },
  { label: 'Max delay', get: (l) => `${l.maxFuse} s` },
  { label: 'Delay step', get: (l) => `${l.fuseStep} s` },
  { label: 'Oracle previews', get: (l) => `${l.oracles}` },
  { label: 'Bullet Time', get: (l) => onOff(l.slowMotion) },
  { label: 'Combo window', get: (l) => `${l.rules.comboWindow.toFixed(1)} s` },
  { label: 'Combo bonus per step', get: (l) => `+${Math.round(l.rules.comboStep * 100)}%` },
  { label: 'Combo cap', get: (l) => `×${l.rules.comboMax}` },
  { label: 'Crest damage', get: (l) => pctOf(l.rules.damageMul) },
  { label: 'City wall height', get: (l) => pctOf(l.rules.protectionMul) },
  { label: 'Coast absorption', get: (l) => pctOf(l.coastAbsorb / DEFAULT_COAST_ABSORB) },
  { label: 'Domino', get: (l) => onOff(l.domino) },
  { label: 'Attempts per sea', get: (l) => `${l.attempts}` },
  { label: 'Chaos earned', get: (l) => pctOf(l.chaosMul) },
  { label: 'Epicenter size', get: (l) => pctOf(l.spawnRadiusMul) },
  { label: 'Extra epicenters', get: (l) => `${l.extraSpawns}` },
  { label: 'Chaos per unused quake', get: (l) => `${l.salvage}` },
  { label: 'Golden ring multiplier', get: (l) => `×${(zoneBaseMult() + l.zoneBonus).toFixed(1)}` },
  { label: 'First-attempt chaos', get: (l) => `×${l.perfectStorm}` },
];

/** What buying a skill changes: current value and value afterwards. */
export function skillDiff(id: string, owned: ReadonlySet<string>): { label: string; from: string; to: string }[] {
  const without = new Set(owned);
  without.delete(id);
  const before = loadout(without);
  const after = loadout(new Set([...without, id]));
  return STATS.map((s) => ({ label: s.label, from: s.get(before), to: s.get(after) })).filter((d) => d.from !== d.to);
}
