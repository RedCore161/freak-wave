import type { QuakeKind } from '../sim/quakes.ts';

export interface TargetSpec {
  x: number;
  y: number;
  /** Required crest height in metres. */
  required: number;
}

export interface QuakePlacement {
  kind: QuakeKind;
  x: number;
  y: number;
}

export interface LevelData {
  index: number;
  name: string;
  seed: number;
  land: Uint8Array;
  targets: TargetSpec[];
  /** Quakes the level grants before skill bonuses. */
  inventory: QuakeKind[];
  /** A known solution the generator verified (kept for debugging/hints). */
  witness: QuakePlacement[];
  /** Best crest any single quake can reach at each target (difficulty check). */
  singleBest: number[];
  /** Requirement vs best one-quake-per-target plan; above 1 means waves must combine. */
  soloRatio: number;
}

export interface LevelRequest {
  index: number;
  seed: number;
  /** Hand-made terrain (from a PNG); procedural islands if omitted. */
  land?: Uint8Array;
  name?: string;
}
