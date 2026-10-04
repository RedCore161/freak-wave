import { COMBO_MAX, COMBO_STEP, COMBO_WINDOW, DT } from './constants.ts';

// Shared damage model, used identically by the game and the level generator.
// A city watches the highest crest along its shoreline. Every crest that tops
// the sea wall deals damage equal to the overflow; crests that follow each
// other closely chain into a combo multiplier.

export interface CitySpec {
  name: string;
  x: number;
  y: number;
  /** 1-3: size, building count and reward. */
  level: number;
  /** Sea wall height in metres. */
  protection: number;
  /** Total overflow (metres, after combos) needed to ruin the city. */
  hp: number;
  /** Water cells whose height counts as this city's shoreline. */
  shore: number[];
  /** Optional, harder city: only a share of all cities must fall to pass. */
  bonus?: boolean;
}

export interface DamageRules {
  damageMul: number;
  protectionMul: number;
  comboWindow: number;
  comboStep: number;
  comboMax: number;
}

export const BASE_RULES: DamageRules = {
  damageMul: 1,
  protectionMul: 1,
  comboWindow: COMBO_WINDOW,
  comboStep: COMBO_STEP,
  comboMax: COMBO_MAX,
};

export interface Hit {
  damage: number;
  crest: number;
  combo: number;
  ruined: boolean;
}

export class CityMeter {
  readonly spec: CitySpec;
  readonly wall: number;
  damage = 0;
  ruined = false;
  combo = 0;
  /** Current shoreline height, for display and audio. */
  level = 0;
  best = 0;
  private rules: DamageRules;
  private h1 = 0;
  private h2 = 0;
  private lastHitStep = -1e9;

  constructor(spec: CitySpec, rules: DamageRules = BASE_RULES) {
    this.spec = spec;
    this.rules = rules;
    this.wall = spec.protection * rules.protectionMul;
  }

  /** Feed the current surface; returns a hit when a crest topped the wall. */
  update(u: Float32Array, step: number): Hit | null {
    let h = -Infinity;
    for (const c of this.spec.shore) if (u[c] > h) h = u[c];
    return this.feed(h, step);
  }

  /** Feed the shoreline height directly (used when replaying recorded series). */
  feed(h: number, step: number): Hit | null {
    this.level = h;
    if (h > this.best) this.best = h;
    let hit: Hit | null = null;
    // A crest is a local maximum of the shoreline height, one step late.
    if (!this.ruined && this.h1 > this.h2 && this.h1 >= h && this.h1 > this.wall) {
      const r = this.rules;
      this.combo = step - this.lastHitStep <= r.comboWindow / DT ? this.combo + 1 : 0;
      this.lastHitStep = step;
      const mult = Math.min(r.comboMax, 1 + this.combo * r.comboStep);
      const damage = (this.h1 - this.wall) * mult * r.damageMul;
      this.damage += damage;
      if (this.damage >= this.spec.hp) this.ruined = true;
      hit = { damage, crest: this.h1, combo: this.combo, ruined: this.ruined };
    }
    this.h2 = this.h1;
    this.h1 = h;
    return hit;
  }
}

/** Shoreline height of a city for the current surface. */
export function shoreHeight(u: Float32Array, shore: readonly number[]): number {
  let h = -Infinity;
  for (const c of shore) if (u[c] > h) h = u[c];
  return h;
}

/** Total damage a recorded shoreline series would deal against a wall. */
export function replayDamage(series: Float32Array, wall: number, rules: DamageRules = BASE_RULES): number {
  const meter = new CityMeter({ name: '', x: 0, y: 0, level: 1, protection: wall, hp: Infinity, shore: [] }, rules);
  for (let s = 0; s < series.length; s++) meter.feed(series[s], s);
  return meter.damage;
}
