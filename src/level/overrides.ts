import { CONFIG, type LevelOverride } from '../config.ts';
import type { LevelData } from './types.ts';

/**
 * A generated level with config.json's per-sea tuning applied: multipliers
 * for city hp and walls (core and bonus separately), then exact per-city
 * values. Generation stays untouched, so tuning needs no regeneration.
 */
export function applyOverrides(level: LevelData, o: LevelOverride | undefined = CONFIG.levels[String(level.index)]): LevelData {
  if (!o) return level;
  const cities = level.cities.map((c, i) => {
    const hpMul = (o.hpMul ?? 1) * (c.bonus ? (o.bonusHpMul ?? 1) : 1);
    const wallMul = (o.wallMul ?? 1) * (c.bonus ? (o.bonusWallMul ?? 1) : 1);
    const exact = o.cities?.[String(i)];
    return {
      ...c,
      hp: round1(exact?.hp ?? c.hp * hpMul),
      protection: round1(exact?.wall ?? c.protection * wallMul),
    };
  });
  return { ...level, cities };
}

const round1 = (v: number) => Math.max(0.1, Math.round(v * 10) / 10);
