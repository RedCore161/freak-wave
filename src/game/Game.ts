import { DT, GRID_W, SIM_DURATION, SIM_STEPS, SPAWN_RADIUS, ZONE_RADIUS } from '../sim/constants.ts';
import { waterDistanceField } from '../sim/arrival.ts';
import { CityMeter, type Hit } from '../sim/cities.ts';
import { buildWaveform, crestArrival, QUAKE_ORDER, QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { makeRng } from '../sim/rng.ts';
import { WaveSim } from '../sim/WaveSim.ts';
import { pickSpawns } from '../level/generator.ts';
import { campaignNames, LevelSource } from '../level/levels.ts';
import { placementProblem, quakePower } from '../level/placement.ts';
import { distanceTo } from '../level/terrain.ts';
import type { LevelData, SpawnArea } from '../level/types.ts';
import { SceneView } from '../render/SceneView.ts';
import { Sonifier } from '../audio/Sonifier.ts';
import type { ResultCity, Ui } from '../ui/Ui.ts';
import { loadSave, writeSave } from './save.ts';
import { loadSettings, writeSettings, type Settings } from './settings.ts';
import { AFTERSHOCK_DELAY, AFTERSHOCK_STRENGTH, canBuy, loadout, SKILL_BY_ID, ZONE_BASE_MULT, type Loadout } from './skills.ts';

type Phase = 'menu' | 'loading' | 'placing' | 'running' | 'result' | 'gameover';

interface PlacedQuake {
  id: number;
  kind: QuakeKind;
  x: number;
  y: number;
  delay: number;
  angle: number;
  /** Water distance from this quake to every cell (for arrival estimates). */
  dist: Float32Array;
}

interface RunState {
  index: number;
  chaosEarned: number;
  cleared: number;
}

/** How close (in cells) a tap must be to grab an existing quake. */
const GRAB_RADIUS = 3.5;
/** Keep simulating this long after the last city falls, for the payoff. */
const AFTERGLOW = 1.8;
/** End early once the sea has calmed below this mean height. */
const CALM = 0.05;
/**
 * After the last quake, end once no wave could top a wall even if the waves of
 * every quake stacked perfectly: tallest < wall * SETTLE_SHARE / quakes.
 */
const SETTLE_SHARE = 0.9;
/** ...or once nothing has hit for this long and waves are well below the walls. */
const QUIET_STEPS = Math.round(2.5 / DT);
const QUIET_RATIO = 0.75;
/** Cursor distance (cells) at which a city's card expands. */
const CITY_HOVER = 7;
const HIT_HIGHLIGHT_MS = 1800;
const ROTATE_STEP = Math.PI / 8;
const DOMINO_STRENGTH = 0.8;

export class Game {
  private view: SceneView;
  private ui: Ui;
  private settings: Settings = loadSettings();
  private audio = new Sonifier(this.settings);
  private paused = false;
  private ghostHint = false;
  private pinned = new Set<number>();
  private lastHitAt: number[] = [];
  private lastHitStep = 0;
  private levels = new LevelSource();
  private save = loadSave();
  private owned = new Set<string>(this.save.skills.filter((s) => SKILL_BY_ID[s]));
  private phase: Phase = 'menu';
  private run: RunState | null = null;
  private level: LevelData | null = null;
  private spawns: SpawnArea[] = [];
  private shoreMouth: number[] = [];
  private attempt = 1;
  private quakes: PlacedQuake[] = [];
  private nextQuakeId = 1;
  private selectedKind: QuakeKind | null = null;
  private selectedId: number | null = null;
  private drag: { id: number; pointerId: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private isoField: Float32Array | null = null;
  private isoCell = -1;
  private sim: WaveSim | null = null;
  private meters: CityMeter[] = [];
  private zoneHit: boolean[] = [];
  private fireEvents: { step: number; x: number; y: number; kind: QuakeKind }[] = [];
  private allRuinedStep = -1;
  private oraclesLeft = 0;
  private prediction: number[] | null = null;
  private speed = 1;
  private accum = 0;
  private lastFrame = performance.now();

  constructor(view: SceneView, ui: Ui) {
    this.view = view;
    this.ui = ui;
    const canvas = view.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag) this.hover = null;
    });
    window.addEventListener('resize', () => view.resize());
    window.addEventListener('pointerdown', () => this.audio.unlock(), { capture: true });

    ui.onTap = () => this.audio.blip(520, 0.04, 0.06);
    ui.onSpeed = () => {
      const speeds = this.lo.slowMotion ? [1, 2, 4, 0.5] : [1, 2, 4];
      this.speed = speeds[(speeds.indexOf(this.speed) + 1) % speeds.length];
      this.refreshHud();
    };
    ui.onMute = () => {
      this.applySettings({ ...this.settings, muted: !this.settings.muted });
      this.refreshHud();
    };
    ui.onSkip = () => {
      if (this.phase === 'running') this.finish();
    };
    ui.onSettings = () => {
      if (this.phase !== 'placing' && this.phase !== 'running') return;
      this.paused = true;
      this.openSettings(() => {
        this.paused = false;
        this.ui.hideOverlay();
      });
    };
    ui.onSelectKind = (kind) => {
      this.selectedKind = kind;
      this.selectedId = null;
      this.refreshPlacing();
    };
    ui.onStart = () => this.startSim();
    ui.onClear = () => {
      this.quakes = [];
      this.selectedId = null;
      this.planChanged();
    };
    ui.onOracle = () => this.consultOracle();
    ui.onDelay = (steps) => {
      const q = this.selected();
      if (q) this.setDelay(q.id, q.delay + steps * this.lo.fuseStep);
    };
    ui.onSetDelay = (id, delay) => this.setDelay(id, delay);
    ui.onSelectQuake = (id) => {
      this.selectedId = id;
      this.refreshPlacing();
    };
    ui.onRotate = () => {
      const q = this.selected();
      if (!q) return;
      q.angle = (q.angle + ROTATE_STEP) % Math.PI;
      this.audio.blip(740, 0.05, 0.08);
      this.planChanged();
    };
    ui.onRemove = () => {
      this.quakes = this.quakes.filter((k) => k.id !== this.selectedId);
      this.selectedId = null;
      this.selectedKind ??= this.firstAvailableKind();
      this.audio.blip(330, 0.08, 0.1);
      this.planChanged();
    };
    this.showMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  private get lo(): Loadout {
    return loadout(this.owned);
  }

  private selected(): PlacedQuake | undefined {
    return this.quakes.find((q) => q.id === this.selectedId);
  }

  // ---------------------------------------------------------------- screens

  private showMenu(): void {
    this.phase = 'menu';
    this.run = null;
    this.ui.setPlayVisible(false);
    this.ui.showMenu(this.save.chaos, this.save.bestLevel, this.owned.size, {
      start: () => (this.settings.tutorialSeen ? void this.openLevelSelect() : this.openTutorial(() => this.startRun(0))),
      tutorial: () => this.openTutorial(() => this.showMenu()),
      settings: () => this.openSettings(() => this.showMenu()),
      skills: () => this.openSkills(() => this.showMenu()),
    });
  }

  private openSkills(back: () => void): void {
    const render = (justBought?: string) =>
      this.ui.showSkills(
        this.owned,
        this.save.chaos,
        {
          buy: (id) => {
            if (!canBuy(id, this.owned, this.save.chaos)) return;
            this.save.chaos -= SKILL_BY_ID[id].cost;
            this.owned.add(id);
            this.save.skills = [...this.owned];
            writeSave(this.save);
            this.audio.buy();
            render(id);
          },
          close: back,
        },
        justBought,
      );
    render();
  }

  private applySettings(next: Settings): void {
    this.settings = next;
    this.audio.configure(next);
    writeSettings(next);
  }

  private openSettings(back: () => void): void {
    this.ui.showSettings(this.settings, {
      change: (s) => this.applySettings({ ...s, tutorialSeen: this.settings.tutorialSeen }),
      reset: () => {
        this.save = { chaos: 0, skills: [], bestLevel: 0, unlocked: 0, cleared: [] };
        this.owned.clear();
        writeSave(this.save);
        this.applySettings({ ...this.settings, tutorialSeen: false });
        this.audio.lose();
        this.paused = false;
        this.showMenu();
      },
      tutorial: () => this.openTutorial(() => this.openSettings(back)),
      close: back,
    });
  }

  private openTutorial(done: () => void): void {
    this.ui.showTutorial(() => {
      this.applySettings({ ...this.settings, tutorialSeen: true });
      done();
    });
  }

  /** Sea picker: every sea up to the furthest one reached; replays farm chaos. */
  private async openLevelSelect(): Promise<void> {
    const names = await campaignNames();
    const count = Math.max(this.save.unlocked + 1, names.length);
    this.ui.showLevelSelect(
      Array.from({ length: count }, (_, i) => ({
        index: i,
        name: names[i] ?? `Open Sea ${i + 1 - names.length}`,
        unlocked: i <= this.save.unlocked,
        cleared: this.save.cleared.includes(i),
      })),
      { pick: (i) => this.startRun(i), back: () => this.showMenu() },
    );
  }

  private startRun(index: number): void {
    this.run = { index, chaosEarned: 0, cleared: 0 };
    void this.loadLevel();
  }

  private async loadLevel(): Promise<void> {
    const run = this.run!;
    this.phase = 'loading';
    this.ui.setPlayVisible(false);
    this.ui.showLoading(run.index === 0 ? 'Charting the coast…' : 'Charting the next coast…');
    let level: LevelData;
    try {
      level = await this.levels.get(run.index);
    } catch (err) {
      this.ui.showError(String(err), () => this.showMenu());
      return;
    }
    if (this.run !== run) return;
    // Generate the next level while this one is played.
    void this.levels.get(run.index + 1).catch(() => undefined);
    this.level = level;
    this.spawns = this.buildSpawns(level);
    this.shoreMouth = level.cities.map((c) => {
      let best = c.shore[0];
      let bestD = Infinity;
      for (const cell of c.shore) {
        const x = cell % GRID_W;
        const d = Math.hypot(x - c.x, (cell - x) / GRID_W - c.y);
        if (d < bestD) {
          bestD = d;
          best = cell;
        }
      }
      return best;
    });
    this.quakes = [];
    this.selectedId = null;
    this.attempt = 1;
    this.selectedKind = this.firstAvailableKind();
    this.pinned.clear();
    this.lastHitAt = level.cities.map(() => 0);
    this.view.setLevel(level, this.spawns);
    this.audio.setCities(level.cities.length);
    this.enterPlacing();
    if (level.hint) this.ui.setHint(level.hint);
    this.ui.banner(level.name, 'cool', `Sea ${level.index + 1} · ${level.cities.length} ${level.cities.length === 1 ? 'city' : 'cities'}`);
  }

  /** The level's epicenters, widened and extended by skills. */
  private buildSpawns(level: LevelData): SpawnArea[] {
    const lo = this.lo;
    const r = SPAWN_RADIUS * lo.spawnRadiusMul;
    const base = level.spawns.map((s) => ({ ...s, r }));
    if (lo.extraSpawns === 0) return base;
    const extra = pickSpawns(makeRng(level.seed ^ 0x5eed), level.land, distanceTo(level.land, 1, 32), level.cities, lo.extraSpawns, base, r);
    return [...base, ...(extra ?? [])];
  }

  private enterPlacing(): void {
    this.phase = 'placing';
    this.sim = null;
    this.meters = this.level!.cities.map((c) => new CityMeter(c, this.lo.rules));
    this.zoneHit = this.level!.zones.map(() => false);
    this.oraclesLeft = this.lo.oracles;
    this.prediction = null;
    this.ui.hideOverlay();
    this.ui.setPlayVisible(true);
    this.view.setSpawnsVisible(true);
    this.view.setQuakesVisible(true);
    this.level!.zones.forEach((_, i) => this.view.setZoneHit(i, false));
    if (!this.selectedKind || this.remaining(this.selectedKind) === 0) this.selectedKind = this.firstAvailableKind();
    this.refreshPlacing();
  }

  // ---------------------------------------------------------------- inventory

  private inventory(): QuakeKind[] {
    return [...this.level!.inventory, ...this.lo.bonusQuakes];
  }

  private remaining(kind: QuakeKind): number {
    const total = this.inventory().filter((k) => k === kind).length;
    return total - this.quakes.filter((q) => q.kind === kind).length;
  }

  private firstAvailableKind(): QuakeKind | null {
    if (!this.level) return null;
    return QUAKE_ORDER.find((k) => this.remaining(k) > 0) ?? null;
  }

  // ---------------------------------------------------------------- input

  private onPointerDown(e: PointerEvent): void {
    const p = this.view.pick(e.clientX, e.clientY);
    this.hover = p;
    if (!p || !this.level) return;
    const grabbed = this.phase === 'placing' ? this.quakeAt(p.x, p.y) : null;
    const city = this.cityAt(p.x, p.y);
    if (!grabbed && city >= 0 && this.level.land[Math.round(p.y) * GRID_W + Math.round(p.x)]) {
      // Tapping a city pins its card open (or closes it again).
      if (this.pinned.has(city)) this.pinned.delete(city);
      else this.pinned.add(city);
      return;
    }
    if (this.phase !== 'placing') return;
    if (grabbed) {
      this.selectedId = grabbed.id;
      this.drag = { id: grabbed.id, pointerId: e.pointerId };
      this.view.renderer.domElement.setPointerCapture(e.pointerId);
      this.refreshPlacing();
      return;
    }
    const kind = this.selectedKind;
    if (!kind || this.remaining(kind) === 0) {
      this.selectedId = null;
      this.ui.setHint('No quakes of that type left. Drag a placed quake to move it.', true);
      this.refreshPlacing(false);
      return;
    }
    const problem = placementProblem(this.level!.land, p.x, p.y, this.level!.cities, this.quakes);
    if (problem) {
      this.selectedId = null;
      this.refreshPlacing(false);
      this.ui.setHint(problem, true);
      this.audio.blip(180, 0.1, 0.1);
      return;
    }
    const q: PlacedQuake = {
      id: this.nextQuakeId++,
      kind,
      x: p.x,
      y: p.y,
      delay: 0,
      angle: 0,
      dist: waterDistanceField(this.level!.land, p.x, p.y),
    };
    this.quakes.push(q);
    this.selectedId = q.id;
    if (this.remaining(kind) === 0) this.selectedKind = this.firstAvailableKind();
    this.drag = { id: q.id, pointerId: e.pointerId };
    this.view.renderer.domElement.setPointerCapture(e.pointerId);
    this.audio.blip(660 * QUAKE_TYPES[kind].size ** -0.5, 0.08, 0.14);
    this.planChanged();
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.view.pick(e.clientX, e.clientY);
    this.hover = p;
    if (this.phase !== 'placing') return;
    if (!this.drag || this.drag.pointerId !== e.pointerId || !p) return;
    const q = this.quakes.find((k) => k.id === this.drag!.id);
    if (!q) return;
    const others = this.quakes.filter((k) => k !== q);
    if (!placementProblem(this.level!.land, p.x, p.y, this.level!.cities, others)) {
      q.x = p.x;
      q.y = p.y;
      this.view.setQuakes(this.withPower(), this.selectedId);
      if (this.selectedId === q.id) this.ui.setHint(this.powerHint(q));
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    const q = this.quakes.find((k) => k.id === this.drag!.id);
    this.drag = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    if (q && this.level) q.dist = waterDistanceField(this.level.land, q.x, q.y);
    this.planChanged();
  }

  private cityAt(x: number, y: number): number {
    if (!this.level) return -1;
    let best = -1;
    let bestD = CITY_HOVER;
    this.level.cities.forEach((c, i) => {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private withPower() {
    return this.quakes.map((q) => ({ ...q, power: quakePower(this.spawns, q.x, q.y) }));
  }

  private powerHint(q: PlacedQuake): string {
    const power = quakePower(this.spawns, q.x, q.y);
    return power < 1 ? `Outside the epicenters: ${Math.round(power * 100)}% power` : 'Full power inside the epicenter.';
  }

  private quakeAt(x: number, y: number): PlacedQuake | null {
    let best: PlacedQuake | null = null;
    let bestD = GRAB_RADIUS;
    for (const q of this.quakes) {
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    return best;
  }

  private setDelay(id: number, delay: number): void {
    const q = this.quakes.find((k) => k.id === id);
    if (!q || this.phase !== 'placing') return;
    const lo = this.lo;
    const next = Math.round(Math.min(lo.maxFuse, Math.max(0, delay)) / lo.fuseStep) * lo.fuseStep;
    if (Math.abs(next - q.delay) < 1e-6) return;
    q.delay = next;
    this.selectedId = id;
    this.audio.blip(500 + next * 60, 0.03, 0.05);
    this.planChanged();
  }

  /** Any edit invalidates the Oracle's prediction. */
  private planChanged(): void {
    this.prediction = null;
    this.refreshPlacing();
  }

  // ---------------------------------------------------------------- simulation

  private buildSim(withEnvelope: boolean): { sim: WaveSim; events: { step: number; x: number; y: number; kind: QuakeKind }[] } {
    const lo = this.lo;
    const level = this.level!;
    const sim = new WaveSim(level.land, { coastAbsorb: lo.coastAbsorb, openDamp: lo.openDamp, trackEnvelope: withEnvelope });
    const events: { step: number; x: number; y: number; kind: QuakeKind }[] = [];
    for (const q of this.quakes) {
      const type = QUAKE_TYPES[q.kind];
      const start = Math.round(q.delay / DT);
      const shape = { length: type.length, angle: q.angle };
      const power = quakePower(this.spawns, q.x, q.y);
      sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, lo.mods, power), startStep: start, ...shape });
      events.push({ step: start, x: q.x, y: q.y, kind: q.kind });
      for (let a = 1; a <= lo.aftershocks; a++) {
        const after = start + Math.round((AFTERSHOCK_DELAY * a) / DT);
        sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, lo.mods, AFTERSHOCK_STRENGTH * power), startStep: after, ...shape });
        events.push({ step: after, x: q.x, y: q.y, kind: q.kind });
      }
    }
    return { sim, events };
  }

  /** Runs the whole attempt headlessly and shows the predicted damage. */
  private consultOracle(): void {
    if (this.phase !== 'placing' || this.oraclesLeft <= 0 || this.quakes.length === 0) return;
    this.oraclesLeft--;
    const { sim } = this.buildSim(false);
    const meters = this.level!.cities.map((c) => new CityMeter(c, this.lo.rules));
    for (let s = 0; s < SIM_STEPS; s++) {
      sim.step();
      for (const m of meters) m.update(sim.u, sim.stepIndex);
      if (meters.every((m) => m.ruined)) break;
    }
    this.prediction = meters.map((m) => m.damage);
    this.audio.arpeggio([880, 660, 990], 0.06, 0.08);
    this.refreshPlacing();
  }

  private startSim(): void {
    if (this.phase !== 'placing' || this.quakes.length === 0) return;
    const { sim, events } = this.buildSim(true);
    this.sim = sim;
    this.fireEvents = events;
    this.meters = this.level!.cities.map((c) => new CityMeter(c, this.lo.rules));
    this.zoneHit = this.level!.zones.map(() => false);
    this.allRuinedStep = -1;
    this.lastHitStep = 0;
    this.accum = 0;
    this.phase = 'running';
    this.selectedId = null;
    this.drag = null;
    this.isoField = null;
    this.view.setSpawnsVisible(false);
    this.view.setGhost(null);
    this.view.setQuakes(this.withPower(), null);
    this.ui.setQuakePanel(null);
    this.ui.setTray(null);
    this.ui.setHint('');
    this.refreshHud();
  }

  private stepSim(steps: number): void {
    const sim = this.sim!;
    const level = this.level!;
    for (let s = 0; s < steps; s++) {
      for (const ev of this.fireEvents) {
        if (ev.step !== sim.stepIndex) continue;
        this.view.spawnShock(ev.x, ev.y, QUAKE_TYPES[ev.kind].color);
        this.audio.quake(QUAKE_TYPES[ev.kind].size);
      }
      sim.step();
      this.meters.forEach((m, i) => {
        const hit = m.update(sim.u, sim.stepIndex);
        if (hit) this.onCityHit(i, hit);
      });
      level.zones.forEach((z, i) => {
        if (this.zoneHit[i]) return;
        if (sim.maxInRadius(sim.u, z.x, z.y, ZONE_RADIUS) >= z.threshold) {
          this.zoneHit[i] = true;
          this.view.setZoneHit(i, true);
          this.audio.arpeggio([784, 1046, 1318], 0.05, 0.1);
          this.ui.banner(`×${(ZONE_BASE_MULT + this.lo.zoneBonus).toFixed(1)} chaos`, 'warm', 'Golden ring breached');
        }
      });
      if (this.allRuinedStep < 0 && this.meters.every((m) => m.ruined)) this.allRuinedStep = sim.stepIndex;
      const done =
        sim.stepIndex >= SIM_STEPS || this.settled(sim) || (this.allRuinedStep >= 0 && sim.stepIndex - this.allRuinedStep >= AFTERGLOW / DT);
      if (done) {
        if (this.allRuinedStep < 0 && sim.stepIndex < SIM_STEPS) this.ui.banner('The sea settles', 'cool');
        this.finish();
        return;
      }
    }
  }

  /**
   * True once nothing more can happen: every quake has fired and no wave left
   * on the map is anywhere near tall enough to top a standing wall.
   */
  private settled(sim: WaveSim): boolean {
    if (!sim.sourcesDone || this.allRuinedStep >= 0 || sim.stepIndex % 10 !== 0) return false;
    if (sim.activity() < CALM) return true;
    const walls = this.meters.filter((m) => !m.ruined).map((m) => m.wall);
    if (walls.length === 0) return false;
    const minWall = Math.min(...walls);
    const tallest = sim.maxHeight();
    if (tallest < (minWall * SETTLE_SHARE) / Math.max(2, this.quakes.length)) return true;
    return sim.stepIndex - this.lastHitStep > QUIET_STEPS && tallest < minWall * QUIET_RATIO;
  }

  private onCityHit(i: number, hit: Hit): void {
    this.lastHitAt[i] = performance.now();
    if (this.sim) this.lastHitStep = this.sim.stepIndex;
    const city = this.level!.cities[i];
    const pos = this.view.projectCity(i);
    this.view.cityHit(i, hit.damage);
    this.audio.hit(hit.damage, hit.combo);
    this.ui.popup(pos.x, pos.y, `-${hit.damage.toFixed(1)}`, 'hit');
    if (hit.combo > 0) this.ui.popup(pos.x + 26, pos.y - 18, `COMBO ×${hit.combo + 1}`, 'combo');
    if (!hit.ruined) return;
    this.view.cityRuin(i);
    this.audio.ruin();
    this.ui.banner(`${city.name} falls`, 'hot');
    if (this.lo.domino && this.sim) {
      // The collapsing city slumps into the sea and sets off a quake.
      const cell = this.shoreMouth[i];
      const x = cell % GRID_W;
      const y = (cell - x) / GRID_W;
      const start = this.sim.stepIndex + 1;
      this.sim.addSource({ x, y, waveform: buildWaveform('medium', this.lo.mods, DOMINO_STRENGTH), startStep: start });
      this.fireEvents.push({ step: start, x, y, kind: 'medium' });
    }
  }

  private finish(): void {
    const run = this.run!;
    const level = this.level!;
    const lo = this.lo;
    const success = this.meters.every((m) => m.ruined);
    const lines: { label: string; value: string }[] = [];
    let chaos = 0;
    const ruinedValue = this.meters.reduce((a, m) => a + (m.ruined ? 6 * m.spec.level : 0), 0);
    if (success) {
      const clear = 5 + 2 * level.index;
      lines.push({ label: 'Cities ruined', value: `+${ruinedValue}` });
      lines.push({ label: 'Coast drowned', value: `+${clear}` });
      chaos = ruinedValue + clear;
      const unused = this.inventory().length - this.quakes.length;
      if (unused > 0) {
        lines.push({ label: `Unused quakes ×${unused}`, value: `+${unused * lo.salvage}` });
        chaos += unused * lo.salvage;
      }
      if (!this.save.cleared.includes(level.index)) {
        const bonus = Math.round(chaos * 0.5);
        lines.push({ label: 'First clear', value: `+${bonus}` });
        chaos += bonus;
      }
    } else {
      // Every attempt pays something, so nobody gets stuck without upgrades.
      const effort = 2;
      const dealt = Math.round(this.meters.reduce((a, m) => a + Math.min(1, m.damage / m.spec.hp) * 5 * m.spec.level, 0));
      lines.push({ label: 'Effort', value: `+${effort}` });
      if (dealt > 0) lines.push({ label: 'Damage dealt', value: `+${dealt}` });
      chaos = effort + dealt;
    }
    const mult = (k: number, label: string) => {
      if (chaos <= 0 || k === 1) return;
      const boosted = Math.round(chaos * k);
      lines.push({ label, value: `+${boosted - chaos}` });
      chaos = boosted;
    };
    const zones = this.zoneHit.filter(Boolean).length;
    for (let z = 0; z < zones; z++) mult(ZONE_BASE_MULT + lo.zoneBonus, 'Golden ring');
    if (success && this.attempt === 1 && lo.perfectStorm) mult(1.5, 'Perfect Storm');
    mult(lo.chaosMul, 'Chaos Theory');

    run.chaosEarned += chaos;
    this.save.chaos += chaos;
    if (success) {
      run.cleared++;
      if (!this.save.cleared.includes(level.index)) this.save.cleared.push(level.index);
      this.save.unlocked = Math.max(this.save.unlocked, level.index + 1);
      this.save.bestLevel = Math.max(this.save.bestLevel, this.save.cleared.length);
      run.index++;
    }
    writeSave(this.save);

    const cities: ResultCity[] = this.meters.map((m) => ({
      name: m.spec.name,
      level: m.spec.level,
      ruined: m.ruined,
      damage: m.damage,
      hp: m.spec.hp,
    }));
    const attemptsLeft = lo.attempts - this.attempt;
    if (success) this.audio.win();
    else this.audio.lose();

    if (!success && attemptsLeft <= 0) {
      this.phase = 'gameover';
      this.refreshHud();
      this.ui.showGameOver(
        { cleared: run.cleared, chaos: run.chaosEarned, cities, lines, total: this.save.chaos, gained: chaos },
        { skills: () => this.openSkills(() => this.showMenu()), again: () => this.startRun(level.index), menu: () => this.showMenu() },
      );
      return;
    }
    this.phase = 'result';
    this.refreshHud();
    const show = () =>
      this.ui.showResult(
        { success, cities, lines, chaos, total: this.save.chaos, attemptsLeft },
        {
          next: success ? () => void this.loadLevel() : null,
          retry: success
            ? null
            : () => {
                this.attempt++;
                this.view.resetCities();
                this.enterPlacing();
                this.ui.banner(`Attempt ${this.attempt} of ${lo.attempts}`, 'cool');
              },
          skills: () => this.openSkills(show),
          menu: () => this.showMenu(),
        },
      );
    // Let the last splash settle before the panel slides in.
    window.setTimeout(show, success ? 500 : 250);
  }

  // ---------------------------------------------------------------- frame loop

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.phase === 'running' && this.sim && !this.paused) {
      // Fixed timestep: the simulation advances in whole steps regardless of
      // frame rate, so the outcome never depends on the device.
      this.accum += (dt / DT) * this.speed;
      const steps = Math.min(Math.floor(this.accum), Math.ceil(6 * this.speed));
      this.accum -= Math.floor(this.accum);
      if (steps > 0) this.stepSim(steps);
    }
    this.updateVisuals();
    this.view.render(dt);
    requestAnimationFrame((t) => this.frame(t));
  }

  private updateVisuals(): void {
    if (!this.level) return;
    if (this.phase === 'placing') this.updatePlacingPreview();
    const showSim = this.phase === 'running' || this.phase === 'result' || this.phase === 'gameover';
    const sim = showSim ? this.sim : null;
    this.view.updateWater(sim ? sim.u : null, sim ? sim.env : null, this.phase === 'placing' ? this.isoField : null);
    this.view.updateCities(this.meters.map((m) => ({ damage: m.damage / m.spec.hp, ruined: m.ruined })));
    this.updateLabels();
    const waterRatio = this.meters.map((m) => (sim ? Math.max(0, m.level) / m.wall : 0));
    this.audio.update(sim ? sim.activity() : 0, waterRatio);
    if (this.phase === 'running' && this.sim) {
      this.ui.setProgress(this.sim.stepIndex / SIM_STEPS);
      this.ui.setTimeline(this.timelineData(), this.sim.time);
    }
  }

  private updatePlacingPreview(): void {
    const level = this.level!;
    const p = this.hover;
    if (!p || this.drag || this.quakeAt(p.x, p.y) || !this.selectedKind || this.remaining(this.selectedKind) === 0) {
      this.view.setGhost(null);
    } else {
      const valid = !placementProblem(level.land, p.x, p.y, level.cities, this.quakes);
      const power = quakePower(this.spawns, p.x, p.y);
      this.view.setGhost({ x: p.x, y: p.y, kind: this.selectedKind, valid, power });
      if (valid && power < 1 && !this.ghostHint) {
        this.ghostHint = true;
        this.ui.setHint(`Outside the epicenters: ${Math.round(power * 100)}% power`, true);
      } else if (this.ghostHint && (power >= 1 || !valid)) {
        this.ghostHint = false;
        this.ui.setHint(this.placingHint());
      }
    }
    if (this.lo.isochrones && p) {
      const cell = Math.round(p.y) * GRID_W + Math.round(p.x);
      if (cell !== this.isoCell) {
        this.isoCell = cell;
        this.isoField = waterDistanceField(level.land, p.x, p.y);
      }
    } else {
      this.isoField = null;
      this.isoCell = -1;
    }
  }

  private updateLabels(): void {
    const level = this.level!;
    const hovered = this.hover ? this.cityAt(this.hover.x, this.hover.y) : -1;
    const now = performance.now();
    this.ui.setCityLabels(
      this.meters.map((m, i) => {
        const pos = this.view.projectCity(i);
        const active = hovered === i || this.pinned.has(i) || now - (this.lastHitAt[i] ?? 0) < HIT_HIGHLIGHT_MS;
        return {
          x: pos.x,
          y: pos.y,
          name: m.spec.name,
          level: m.spec.level,
          wall: m.wall,
          hp: m.spec.hp,
          damage: m.damage,
          ruined: m.ruined,
          water: this.sim && this.phase !== 'placing' ? Math.max(0, m.level) / m.wall : 0,
          prediction: this.phase === 'placing' && this.prediction ? this.prediction[i] : null,
          active,
        };
      }),
    );
    this.ui.setZoneLabels(
      level.zones.map((z, i) => {
        const pos = this.view.project(z.x, z.y, z.threshold);
        return { x: pos.x, y: pos.y, threshold: z.threshold, mult: ZONE_BASE_MULT + this.lo.zoneBonus, hit: this.zoneHit[i] };
      }),
    );
    const sel = this.phase === 'placing' && !this.drag ? this.selected() : undefined;
    if (sel) {
      const pos = this.view.project(sel.x, sel.y);
      this.ui.setQuakePanel({
        x: pos.x,
        y: pos.y,
        delay: sel.delay,
        rotatable: QUAKE_TYPES[sel.kind].length > 0,
        power: quakePower(this.spawns, sel.x, sel.y),
      });
    } else {
      this.ui.setQuakePanel(null);
    }
  }

  // ---------------------------------------------------------------- HUD

  private timelineData() {
    const level = this.level!;
    const lo = this.lo;
    const cities = level.cities.map((c, i) => ({
      name: c.name,
      ruined: this.meters[i]?.ruined ?? false,
      arrivals: this.quakes
        .filter((q) => q.dist[this.shoreMouth[i]] !== Infinity)
        .map((q) => ({ id: q.id, kind: q.kind, t: q.delay + crestArrival(q.kind, lo.mods, q.dist[this.shoreMouth[i]]) })),
    }));
    const latest = Math.max(0, ...cities.flatMap((c) => c.arrivals.map((a) => a.t)));
    return {
      duration: Math.min(SIM_DURATION, Math.max(lo.maxFuse + 2, Math.ceil(latest + 1.5))),
      maxFuse: lo.maxFuse,
      step: lo.fuseStep,
      quakes: this.quakes.map((q) => ({ id: q.id, kind: q.kind, delay: q.delay, selected: q.id === this.selectedId })),
      cities,
    };
  }

  private refreshPlacing(resetHint = true): void {
    this.view.setQuakes(this.withPower(), this.selectedId);
    const inv = this.inventory();
    this.ui.setTray({
      kinds: QUAKE_ORDER.filter((k) => inv.includes(k)).map((k) => ({
        kind: k,
        left: this.remaining(k),
        total: inv.filter((x) => x === k).length,
      })),
      selected: this.selectedKind,
      canStart: this.quakes.length > 0,
      canClear: this.quakes.length > 0,
      oracles: this.quakes.length > 0 ? this.oraclesLeft : 0,
    });
    this.ui.setTimeline(this.quakes.length ? this.timelineData() : null);
    if (resetHint) this.ui.setHint(this.placingHint());
    this.refreshHud();
  }

  private placingHint(): string {
    if (this.quakes.length === 0) {
      return this.level!.index === 0
        ? 'Tap inside a green epicenter to place a quake. Outside them, quakes lose power.'
        : 'Quakes have full power inside the green epicenters.';
    }
    if (this.quakes.length === 1 && this.level!.index === 0) {
      return 'Place another. Then drag them on the timeline so their crests reach the city together.';
    }
    if (this.selectedId !== null) return 'Drag on the map to move, on the timeline to delay.';
    return 'Line up the crest marks under each city, then Unleash.';
  }

  private refreshHud(): void {
    if (!this.run || !this.level) return;
    this.ui.setHud({
      level: this.level.index + 1,
      name: this.level.name,
      attempt: this.attempt,
      attempts: this.lo.attempts,
      chaos: this.save.chaos,
      speed: this.speed,
      running: this.phase === 'running',
      muted: this.audio.muted,
    });
  }

  // ---------------------------------------------------------------- debug

  /** Dev/playtest helper: place the generator's verified solution. */
  debugApplyWitness(): void {
    if (this.phase !== 'placing' || !this.level) return;
    this.quakes = this.level.witness.map((w) => ({
      id: this.nextQuakeId++,
      kind: w.kind,
      x: w.x,
      y: w.y,
      delay: w.delay,
      angle: w.angle,
      dist: waterDistanceField(this.level!.land, w.x, w.y),
    }));
    this.planChanged();
  }
}
