import { EDGE_MARGIN, GRID_H, GRID_W, QUAKE_MIN_SEPARATION } from '../sim/constants.ts';
import type { SpawnArea } from './types.ts';

interface Point {
  x: number;
  y: number;
}

/** Quakes may never be placed this close (cells) to a city. */
export const CITY_MIN_DISTANCE = 22;
/** Beyond an epicenter's edge, power fades to the minimum over this distance. */
export const POWER_FALLOFF = 30;
export const MIN_POWER = 0.1;

/**
 * Strength multiplier for a quake at (x, y): full inside any epicenter,
 * fading linearly with distance beyond its edge, never below MIN_POWER.
 */
export function quakePower(spawns: readonly SpawnArea[], x: number, y: number): number {
  let best = MIN_POWER;
  for (const s of spawns) {
    const beyond = Math.hypot(s.x - x, s.y - y) - s.r;
    const p = beyond <= 0 ? 1 : 1 - ((1 - MIN_POWER) * beyond) / POWER_FALLOFF;
    if (p > best) best = p;
  }
  return Math.min(1, best);
}

/** Why a quake can't go here, or null if it can. */
export function placementProblem(
  land: Uint8Array,
  x: number,
  y: number,
  cities: readonly Point[],
  others: readonly Point[],
): string | null {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (cx < EDGE_MARGIN || cy < EDGE_MARGIN || cx >= GRID_W - EDGE_MARGIN || cy >= GRID_H - EDGE_MARGIN) {
    return 'Too close to the edge of the map';
  }
  if (land[cy * GRID_W + cx]) return 'Quakes must be placed on water';
  for (const c of cities) {
    if (Math.hypot(c.x - x, c.y - y) < CITY_MIN_DISTANCE) return 'Too close to a city';
  }
  for (const o of others) {
    if (Math.hypot(o.x - x, o.y - y) < QUAKE_MIN_SEPARATION) return 'Too close to another quake';
  }
  return null;
}
