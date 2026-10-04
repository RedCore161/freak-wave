# Freak Wave

A low-poly physics puzzle roguelike for the browser. Set off earthquakes in
green epicenters and **time** them so their waves reach coastal cities
together. Every crest that tops a city's sea wall damages it, and back-to-back
crests combo. Ruin every city on the coast within 3 attempts. Rounds take
under a minute. Clearing a sea earns **chaos**, spent in a persistent
49-skill tree.

## Running

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

Tools:

| Command | What it does |
|---|---|
| `npm run levels` | Regenerates the 12 campaign maps in `public/levels/` from `scripts/make-levels.mjs` |
| `node scripts/campaign-test.ts` | Parses every campaign map and generates its level (walls, hp, timing check) |
| `node scripts/settle-test.ts` | Shows how long attempts last with the early-end rules |
| `node scripts/robust-test.ts` | Win rate per campaign sea for imperfect play (random spots in the right epicenters, timeline-aligned delays) |
| `npm run calibrate` | Prints wave height and crest arrival vs distance per quake type |
| `node scripts/gen-test.ts` | Generates levels headlessly and reports timing, walls and hp |
| `node scripts/timing-test.ts` | Checks levels are solvable by lining up the timeline's crest estimates |
| `node scripts/playtest.mjs` | Plays a run in headless Chromium with the generator's solutions (needs `npm run dev`; `LEVELS=5` for more) |

## How a round works

1. Pick a quake in the tray and tap the sea. Inside a **green epicenter** a quake has
   full power; outside, its power fades with distance (down to 10%). Quakes can
   never be placed within 22 cells of a city (red ring). Drag to move.
   **At most 3 quakes per sea.** Spare quakes are merge material: three of a kind
   merge into one of the next size (Tremor → Quake → Megaquake). Clear undoes merges.
2. Each quake appears on the **timeline**. Drag its diamond to delay it. Under
   each city, coloured marks show when each quake's first big crest will
   arrive. Line the marks up so the crests stack.
3. Press **Unleash**. Each crest that tops a city's wall deals damage equal to
   the overflow. Crests within 1.3 s of each other combo (up to 2× by default).
4. Ruin every city to clear the sea. You get 3 attempts per sea, and your
   placements are kept between attempts. Running out ends the run.
   Every attempt earns chaos (effort plus damage dealt); a first clear pays 50% extra.
   **Play** opens the sea picker: start a run at any sea you have reached, and
   replay cleared seas to farm chaos.
5. Optional **golden rings** at sea multiply the chaos reward if a crest breaks through them.

## Architecture

```
src/sim/      wave simulation (pure TS, no DOM): WaveSim, quake waveforms, city damage model, arrival-time field
src/level/    terrain (procedural + PNG), level generator, Web Worker, placement rules
src/game/     game state machine, 49 skills, save data
src/render/   Three.js scene: water, islands, cities, epicenters, effects, camera intro
src/audio/    Web Audio synthesis driven by the live simulation
src/ui/       DOM HUD, timeline, labels, overlays, skill tree, placeholder icons
```

### Simulation

- Linear 2D wave equation on a fixed 160×100 grid, leapfrog integration with an
  isotropic 9-point Laplacian, and a branch-free fast path for open water.
- Low open-water damping, so waves carry across the map. Coasts reflect waves
  and absorb part of their energy. The map edge is an absorbing sponge.
- Rifts are line sources: about 4× stronger broadside than end-on, and rotatable.
- Runs on the CPU with a fixed 1/60 s timestep, so results are identical on
  every device. A step takes about 0.12 ms.

### Level generation

Built backwards from the cities using **reciprocity**: the crest a quake at P
produces at city C equals what a quake at C produces at P. One reverse
simulation per city and quake type gives every epicenter cell's crest height
and arrival time at that city. The generator then:

1. builds a 2–3 quake solution: one city gets all quakes crest-aligned; with two
   cities the middle quake is shared and each city gets one timed partner. It picks
   strong epicenter cells and **delays** them so the crests land together,
2. verifies this witness solution with a forward simulation,
3. plays 8 imperfect sample plans (random spots in the right epicenters, delays
   lined up from the timeline) and sets walls and hp so a target share of them
   wins: about 85% on sea 1, falling to 30% by sea 12. Single quakes stay below
   the wall where that is fair, and the witness always wins,
4. replays the same placements with all delays at zero and prefers levels
   where that fails, so timing is required.

Generation runs in a Web Worker and prefetches the next sea while you play.

### Campaign maps

The campaign is a fixed sequence: 12 hand-made maps, then procedural seas.
Every level has a fixed seed, so a sea plays the same in every run. Skill, not luck.

Maps are RGBA PNGs (16:10, any resolution; the shipped ones are 320×200),
listed in `public/levels/levels.json` with an optional quake list and hint:

| Pixel colour | Meaning |
|---|---|
| transparent | water |
| any other opaque colour | land |
| `#FF0000` red | city, level 1 (a dot on the coast) |
| `#FF8000` orange | city, level 2 |
| `#FF00FF` magenta | city, level 3 |
| `#00FF00` green | epicenter (a filled disc; its size sets the radius) |
| `#FFFF00` yellow | golden chaos ring (a small dot) |

Keep features about 24 px from the edges, which are open ocean. Walls, hp,
ring heights and (if not listed) quake types are computed by the generator.

### Ending rounds early

An attempt ends as soon as nothing more can happen: every quake has fired, and
either no wave anywhere could top a standing wall even if all quakes' waves
stacked, or nothing has hit for 2.5 s and the waves are well below the walls.
Attempts typically last 3–10 s. The **Skip** button ends one immediately.

### Sound

All audio is synthesised; there are no samples. Surf noise follows the sea's
overall activity. Each city has a tone whose pitch and volume rise as water
climbs its wall. Quakes, crest hits (with rising combo plucks), ruins and UI
actions each have their own synthesised sound. Master, ambience and effects
volumes are adjustable in Settings.

## Skill tree

Five branches, 49 skills, with placeholder SVG icons in `src/ui/icons.ts`:

| Branch | Highlights |
|---|---|
| Arsenal | Extra Tremors, Quakes and Megaquakes; unlock **Pulsar** (long combo trains) and **Rift** (aimable fault line) |
| Power | Resonance, Long Period, Deep Water, Wave Train, Aftershocks, Harmonic Lock |
| Timing | Isochrones, Long/Fine Fuse, **Oracle** (damage preview), Bullet Time, combo upgrades |
| Destruction | Battering Ram, Undertow/Erosion (lower walls), Mirror Coast, **Domino** (ruined cities set off quakes) |
| Fortune | Extra attempts, Chaos Theory, wider and extra epicenters, Salvage, Amplifier, Perfect Storm |
