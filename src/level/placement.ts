import { GRID_W, QUAKE_MIN_SEPARATION } from '../sim/constants.ts';
import type { SpawnArea } from './types.ts';

interface Point {
  x: number;
  y: number;
}

/** Why a quake can't go here, or null if it can. */
export function placementProblem(
  land: Uint8Array,
  x: number,
  y: number,
  spawns: readonly SpawnArea[],
  others: readonly Point[],
  radiusMul = 1,
): string | null {
  if (!spawns.some((s) => Math.hypot(s.x - x, s.y - y) <= s.r * radiusMul)) {
    return 'Quakes can only start inside a green epicenter';
  }
  if (land[Math.round(y) * GRID_W + Math.round(x)]) return 'Quakes must be placed on water';
  for (const o of others) {
    if (Math.hypot(o.x - x, o.y - y) < QUAKE_MIN_SEPARATION) return 'Too close to another quake';
  }
  return null;
}
