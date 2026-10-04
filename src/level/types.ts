import type { CitySpec } from '../sim/cities.ts';
import type { QuakeKind } from '../sim/quakes.ts';
import type { MapMarkers } from './mapImage.ts';

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
  hint?: string;
  /** Best city's damage with all delays at zero, over its hp: below 1 means timing is required. */
  timingRatio: number;
}

export interface LevelRequest {
  index: number;
  seed: number;
  /** Hand-made map (from a PNG with markers); procedural if omitted. */
  map?: MapMarkers;
  name?: string;
  /** Exact quake types for a hand-made map, in city order. */
  quakes?: QuakeKind[];
  /** Short tip shown when the sea starts. */
  hint?: string;
}
