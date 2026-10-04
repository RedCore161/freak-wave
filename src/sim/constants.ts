// Simulation grid. Gameplay is defined entirely in grid cells and sim steps,
// so results are identical regardless of screen size or frame rate.
export const GRID_W = 160;
export const GRID_H = 100;
export const DT = 1 / 60;
/** Wave speed in cells per second. */
export const WAVE_SPEED = 18;
/** Hard cap on simulated time per attempt (keeps rounds short). */
export const SIM_DURATION = 16;
export const SIM_STEPS = Math.round(SIM_DURATION / DT);
/** Width of the absorbing border that simulates open ocean. */
export const SPONGE = 10;
/** Wave height at a target is the highest crest within this radius. */
export const TARGET_RADIUS = 2;
/** Quakes may not be placed this close to a target. */
export const TARGET_EXCLUSION = 18;
/** Minimum distance between two quakes. */
export const QUAKE_MIN_SEPARATION = 14;
/** Quakes may not be placed this close to the map edge. */
export const EDGE_MARGIN = 3;
