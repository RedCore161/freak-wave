import type { CitySpec } from '../sim/cities.ts';
import type { QuakeKind } from '../sim/quakes.ts';

export interface SpawnArea {
  x: number;
  y: number;
  r: number;
}

/** Optional bonus ring at sea: a crest this high multiplies the chaos reward. */
export interface ChaosZone {
  x: number;
  y: number;
  threshold: number;
  mult: number;
}

export interface QuakePlacement {
  kind: QuakeKind;
  x: number;
  y: number;
  delay: number;
  angle: number;
}

export interface LevelData {
  index: number;
  name: string;
  seed: number;
  land: Uint8Array;
  cities: CitySpec[];
  spawns: SpawnArea[];
  zones: ChaosZone[];
  /** Quakes the level grants before skill bonuses. */
  inventory: QuakeKind[];
  /** A known solution the generator verified (debugging and playtests). */
  witness: QuakePlacement[];
  /** Best city's damage with all delays at zero, over its hp: below 1 means timing is required. */
  timingRatio: number;
}

export interface LevelRequest {
  index: number;
  seed: number;
  /** Hand-made terrain (from a PNG); procedural islands if omitted. */
  land?: Uint8Array;
  name?: string;
}
