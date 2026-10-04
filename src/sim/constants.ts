// Simulation grid. Gameplay is defined entirely in grid cells and sim steps,
// so results are identical regardless of screen size or frame rate.
export const GRID_W = 160;
export const GRID_H = 100;
export const DT = 1 / 60;
/** Wave speed in cells per second. */
export const WAVE_SPEED = 18;
/** Hard cap on simulated time per attempt (keeps rounds short). */
export const SIM_DURATION = 24;
export const SIM_STEPS = Math.round(SIM_DURATION / DT);
/** Length of the reverse simulations the level generator fires from cities. */
export const RECIP_STEPS = Math.round(15 / DT);
/** Width of the absorbing border that simulates open ocean. */
export const SPONGE = 10;
/** Quakes may only be placed inside spawn areas of this radius. */
export const SPAWN_RADIUS = 9;
/** Quakes may not be placed this close to the map edge. */
export const EDGE_MARGIN = 3;
/** Minimum distance between two quakes. */
export const QUAKE_MIN_SEPARATION = 5;
/** Water within this radius of a city's centre counts as its shoreline. */
export const CITY_SHORE_RADIUS = 4;
/** Wave height at a chaos zone is the highest crest within this radius. */
export const ZONE_RADIUS = 2;
export const BASE_MAX_FUSE = 6;
export const BASE_FUSE_STEP = 0.1;
/** Crests hitting the same city within this window chain into a combo. */
export const COMBO_WINDOW = 1.3;
export const COMBO_STEP = 0.25;
export const COMBO_MAX = 2;
