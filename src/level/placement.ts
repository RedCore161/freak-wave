import { EDGE_MARGIN, GRID_H, GRID_W, QUAKE_MIN_SEPARATION, TARGET_EXCLUSION } from '../sim/constants.ts';

interface Point {
  x: number;
  y: number;
}

/** Why a quake can't go here, or null if it can. */
export function placementProblem(
  land: Uint8Array,
  x: number,
  y: number,
  targets: readonly Point[],
  others: readonly Point[],
  minSeparation = QUAKE_MIN_SEPARATION,
): string | null {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (cx < EDGE_MARGIN || cy < EDGE_MARGIN || cx >= GRID_W - EDGE_MARGIN || cy >= GRID_H - EDGE_MARGIN) {
    return 'Too close to the edge of the map';
  }
  if (land[cy * GRID_W + cx]) return 'Quakes must be placed on water';
  for (const t of targets) {
    if (Math.hypot(t.x - x, t.y - y) < TARGET_EXCLUSION) return 'Too close to a target';
  }
  for (const o of others) {
    if (Math.hypot(o.x - x, o.y - y) < minSeparation) return 'Too close to another quake';
  }
  return null;
}
