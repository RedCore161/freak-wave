import raw from '../config.json' with { type: 'json' };

// Every balance number lives in config.json at the project root. The game,
// the level generator (in its worker) and the balancing scripts all read it
// from here. In balancing mode the object is edited live and saved back.

export interface CityOverride {
  hp?: number;
  wall?: number;
}

export interface LevelOverride {
  /** Multiplies every city's hp on this sea. */
  hpMul?: number;
  /** Multiplies every city's wall on this sea. */
  wallMul?: number;
  /** Extra multipliers for bonus cities only. */
  bonusHpMul?: number;
  bonusWallMul?: number;
  /** Exact values for single cities, by index; win over the multipliers. */
  cities?: Record<string, CityOverride>;
}

export interface Config {
  rules: { baseAttempts: number; maxPlaced: number; passShare: number; arrivalPrecision: number };
  chaos: {
    effort: number;
    damagePerCityLevel: number;
    ruinedPerCityLevel: number;
    bonusPerCityLevel: number;
    clearBase: number;
    clearPerSea: number;
    firstClearBonus: number;
    salvage: number;
    zoneMult: number;
  };
  generator: {
    winShareStart: number;
    winShareStep: number;
    winShareMin: number;
    samplePlans: number;
    hpFraction: number;
    wallOverSingle: number;
    bonusWallOverSingle: number;
    bonusHpOverWitness: number;
    minWall: number;
  };
  skills: Record<string, { cost: number; value: number }>;
  levels: Record<string, LevelOverride>;
  /** Written by the auto-balancer: unscaled effect values and the scale applied. */
  balance?: { effectBase: Record<string, number>; effectScale: number };
}

export const CONFIG: Config = raw as Config;

/** Replaces the live config in place (balancing mode), keeping references valid. */
export function replaceConfig(next: Config): void {
  for (const key of Object.keys(CONFIG) as (keyof Config)[]) delete CONFIG[key];
  Object.assign(CONFIG, structuredClone(next));
}
