import { DT, GRID_W, SIM_STEPS, TARGET_RADIUS } from '../sim/constants.ts';
import { waterDistanceField } from '../sim/arrival.ts';
import { buildWaveform, crestArrival, QUAKE_ORDER, QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { WaveSim } from '../sim/WaveSim.ts';
import { LevelSource } from '../level/levels.ts';
import { placementProblem } from '../level/placement.ts';
import type { LevelData } from '../level/types.ts';
import { SceneView } from '../render/SceneView.ts';
import type { Ui } from '../ui/Ui.ts';
import { loadSave, writeSave } from './save.ts';
import {
  AFTERSHOCK_DELAY,
  AFTERSHOCK_STRENGTH,
  canBuy,
  loadout,
  MAX_FUSE,
  SKILL_BY_ID,
  type Loadout,
  type SkillId,
} from './skills.ts';

type Phase = 'menu' | 'loading' | 'placing' | 'running' | 'result' | 'gameover';

interface PlacedQuake {
  id: number;
  kind: QuakeKind;
  x: number;
  y: number;
  delay: number;
  /** Water distance from this quake to every cell (for arrival estimates). */
  dist: Float32Array;
}

interface RunState {
  seed: number;
  index: number;
  lives: number;
  chaosEarned: number;
  cleared: number;
}

interface TargetState {
  best: number;
  hit: boolean;
}

/** How close (in cells) a tap must be to grab an existing quake. */
const GRAB_RADIUS = 3.5;
/** Keep simulating this long after the last target is hit, for the payoff. */
const AFTERGLOW = 1.5;

export class Game {
  private view: SceneView;
  private ui: Ui;
  private levels = new LevelSource();
  private save = loadSave();
  private owned = new Set<SkillId>(this.save.skills);
  private phase: Phase = 'menu';
  private run: RunState | null = null;
  private level: LevelData | null = null;
  private quakes: PlacedQuake[] = [];
  private nextQuakeId = 1;
  private selectedKind: QuakeKind | null = null;
  private selectedId: number | null = null;
  private drag: { id: number; pointerId: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private isoField: Float32Array | null = null;
  private isoCell = -1;
  private sim: WaveSim | null = null;
  private targetState: TargetState[] = [];
  private fireEvents: { step: number; x: number; y: number; color: string }[] = [];
  private allHitStep = -1;
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
    ui.onSpeed = () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      this.refreshHud();
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
      this.refreshPlacing();
    };
    ui.onDelay = (delta) => this.adjustDelay(delta);
    ui.onRemove = () => this.removeSelected();
    this.showMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  private get lo(): Loadout {
    return loadout(this.owned);
  }

  // ---------------------------------------------------------------- screens

  private showMenu(): void {
    this.phase = 'menu';
    this.run = null;
    this.ui.setPlayVisible(false);
    this.ui.showMenu(this.save.chaos, this.save.bestLevel, {
      start: () => this.startRun(),
      skills: () => this.openSkills(() => this.showMenu()),
    });
  }

  private openSkills(back: () => void): void {
    const render = () =>
      this.ui.showSkills(this.owned, this.save.chaos, {
        buy: (id) => {
          if (!canBuy(id, this.owned, this.save.chaos)) return;
          this.save.chaos -= SKILL_BY_ID[id].cost;
          this.owned.add(id);
          this.save.skills = [...this.owned];
          writeSave(this.save);
          if (id === 'breakwater' && this.run) this.run.lives++;
          render();
        },
        close: back,
      });
    render();
  }

  private startRun(): void {
    if (this.run) this.levels.forgetRun(this.run.seed);
    this.run = {
      seed: (Math.random() * 2 ** 31) >>> 0,
      index: 0,
      lives: this.lo.lives,
      chaosEarned: 0,
      cleared: 0,
    };
    void this.loadLevel();
  }

  private async loadLevel(): Promise<void> {
    const run = this.run!;
    this.phase = 'loading';
    this.ui.setPlayVisible(false);
    this.ui.showLoading(run.index === 0 ? 'Charting the sea…' : 'Charting the next sea…');
    let level: LevelData;
    try {
      level = await this.levels.get(run.seed, run.index);
    } catch (err) {
      this.ui.showError(String(err), () => this.showMenu());
      return;
    }
    if (this.run !== run) return;
    // Generate the next level while this one is played.
    void this.levels.get(run.seed, run.index + 1).catch(() => undefined);
    this.level = level;
    this.quakes = [];
    this.selectedId = null;
    this.selectedKind = this.firstAvailableKind();
    this.view.setLevel(level);
    this.enterPlacing();
  }

  private enterPlacing(): void {
    this.phase = 'placing';
    this.sim = null;
    this.targetState = this.level!.targets.map(() => ({ best: 0, hit: false }));
    this.ui.hideOverlay();
    this.ui.setPlayVisible(true);
    this.view.setExclusionVisible(true);
    this.view.setQuakesVisible(true);
    this.view.updateTargets(this.targetState);
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
    if (this.phase !== 'placing') return;
    const p = this.view.pick(e.clientX, e.clientY);
    this.hover = p;
    if (!p) return;
    const grabbed = this.quakeAt(p.x, p.y);
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
    const problem = placementProblem(this.level!.land, p.x, p.y, this.level!.targets, this.quakes);
    if (problem) {
      this.ui.setHint(problem, true);
      return;
    }
    const q: PlacedQuake = {
      id: this.nextQuakeId++,
      kind,
      x: p.x,
      y: p.y,
      delay: 0,
      dist: waterDistanceField(this.level!.land, p.x, p.y),
    };
    this.quakes.push(q);
    this.selectedId = q.id;
    if (this.remaining(kind) === 0) this.selectedKind = this.firstAvailableKind();
    // Allow dragging straight after placing.
    this.drag = { id: q.id, pointerId: e.pointerId };
    this.view.renderer.domElement.setPointerCapture(e.pointerId);
    this.refreshPlacing();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.phase !== 'placing') return;
    const p = this.view.pick(e.clientX, e.clientY);
    this.hover = p;
    if (!this.drag || this.drag.pointerId !== e.pointerId || !p) return;
    const q = this.quakes.find((k) => k.id === this.drag!.id);
    if (!q) return;
    const others = this.quakes.filter((k) => k !== q);
    if (!placementProblem(this.level!.land, p.x, p.y, this.level!.targets, others)) {
      q.x = p.x;
      q.y = p.y;
      this.view.setQuakes(this.quakes, this.selectedId);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    const q = this.quakes.find((k) => k.id === this.drag!.id);
    this.drag = null;
    if (e.pointerType !== 'mouse') this.hover = null;
    if (q && this.level) q.dist = waterDistanceField(this.level.land, q.x, q.y);
    this.refreshPlacing();
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

  private adjustDelay(delta: number): void {
    const q = this.quakes.find((k) => k.id === this.selectedId);
    if (!q || !this.lo.fuse) return;
    q.delay = Math.min(MAX_FUSE, Math.max(0, Math.round((q.delay + delta) * 2) / 2));
    this.refreshPlacing();
  }

  private removeSelected(): void {
    this.quakes = this.quakes.filter((k) => k.id !== this.selectedId);
    this.selectedId = null;
    this.selectedKind ??= this.firstAvailableKind();
    this.refreshPlacing();
  }

  // ---------------------------------------------------------------- simulation

  private startSim(): void {
    if (this.phase !== 'placing' || this.quakes.length === 0) return;
    const lo = this.lo;
    const level = this.level!;
    const sim = new WaveSim(level.land, { coastAbsorb: lo.coastAbsorb, trackEnvelope: true });
    this.fireEvents = [];
    for (const q of this.quakes) {
      const start = Math.round(q.delay / DT);
      const color = QUAKE_TYPES[q.kind].color;
      sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, lo.mods), startStep: start });
      this.fireEvents.push({ step: start, x: q.x, y: q.y, color });
      if (lo.aftershock) {
        const after = start + Math.round(AFTERSHOCK_DELAY / DT);
        sim.addSource({ x: q.x, y: q.y, waveform: buildWaveform(q.kind, lo.mods, AFTERSHOCK_STRENGTH), startStep: after });
        this.fireEvents.push({ step: after, x: q.x, y: q.y, color });
      }
    }
    this.sim = sim;
    this.targetState = level.targets.map(() => ({ best: 0, hit: false }));
    this.allHitStep = -1;
    this.accum = 0;
    this.phase = 'running';
    this.selectedId = null;
    this.drag = null;
    this.isoField = null;
    this.view.setExclusionVisible(false);
    this.view.setGhost(null);
    this.view.setQuakes(this.quakes, null);
    this.ui.setQuakePanel(null);
    this.ui.setTray(null);
    this.ui.setHint('');
    this.refreshHud();
  }

  private stepSim(steps: number): void {
    const sim = this.sim!;
    const targets = this.level!.targets;
    for (let s = 0; s < steps; s++) {
      for (const ev of this.fireEvents) if (ev.step === sim.stepIndex) this.view.spawnShock(ev.x, ev.y, ev.color);
      sim.step();
      targets.forEach((t, k) => {
        const st = this.targetState[k];
        const v = sim.maxInRadius(sim.u, t.x, t.y, TARGET_RADIUS);
        if (v > st.best) st.best = v;
        if (!st.hit && st.best >= t.required) {
          st.hit = true;
          this.view.spawnBurst(t.x, t.y, t.required);
        }
      });
      if (this.allHitStep < 0 && this.targetState.every((t) => t.hit)) this.allHitStep = sim.stepIndex;
      const done =
        sim.stepIndex >= SIM_STEPS || (this.allHitStep >= 0 && sim.stepIndex - this.allHitStep >= AFTERGLOW / DT);
      if (done) {
        this.finish();
        return;
      }
    }
  }

  private finish(): void {
    const run = this.run!;
    const level = this.level!;
    const success = this.targetState.every((t) => t.hit);
    const lo = this.lo;
    const lines: { label: string; value: string }[] = [];
    let chaos = 0;
    if (success) {
      const base = 10 + 3 * level.index;
      lines.push({ label: 'Sea broken', value: `+${base}` });
      const over =
        this.targetState.reduce((a, t, k) => a + Math.min(1, t.best / level.targets[k].required - 1), 0) /
        level.targets.length;
      const overBonus = Math.round(over * 12);
      if (overBonus > 0) lines.push({ label: `Overshoot ${Math.round(over * 100)}%`, value: `+${overBonus}` });
      const unused = this.inventory().length - this.quakes.length;
      if (unused > 0) lines.push({ label: `Unused quakes ×${unused}`, value: `+${unused * 4}` });
      chaos = base + overBonus + unused * 4;
      run.cleared++;
      run.index++;
      this.save.bestLevel = Math.max(this.save.bestLevel, run.cleared);
    } else {
      const reach =
        this.targetState.reduce((a, t, k) => a + Math.min(1, t.best / level.targets[k].required), 0) /
        level.targets.length;
      chaos = Math.round(reach * 4);
      if (chaos > 0) lines.push({ label: 'Ripples', value: `+${chaos}` });
      run.lives--;
    }
    if (lo.chaosMul !== 1 && chaos > 0) {
      const boosted = Math.round(chaos * lo.chaosMul);
      lines.push({ label: 'Chaos Theory', value: `+${boosted - chaos}` });
      chaos = boosted;
    }
    run.chaosEarned += chaos;
    this.save.chaos += chaos;
    writeSave(this.save);

    this.phase = run.lives <= 0 ? 'gameover' : 'result';
    this.refreshHud();
    const targets = level.targets.map((t, k) => ({ required: t.required, best: this.targetState[k].best, hit: this.targetState[k].hit }));
    if (this.phase === 'gameover') {
      this.ui.showGameOver(
        { cleared: run.cleared, chaos: run.chaosEarned, targets, lines, total: this.save.chaos },
        {
          skills: () => this.openSkills(() => this.showMenu()),
          again: () => this.startRun(),
          menu: () => this.showMenu(),
        },
      );
      return;
    }
    const showResult = () =>
      this.ui.showResult(
        { success, targets, lines, chaos, total: this.save.chaos, lives: run.lives },
        {
          next: success ? () => void this.loadLevel() : null,
          retry: success ? null : () => this.enterPlacing(),
          skills: () => this.openSkills(showResult),
          menu: () => this.showMenu(),
        },
      );
    showResult();
  }

  // ---------------------------------------------------------------- frame loop

  private frame(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.phase === 'running' && this.sim) {
      // Fixed timestep: the simulation advances in whole steps regardless of
      // frame rate, so the outcome never depends on the device.
      this.accum += (dt / DT) * this.speed;
      const steps = Math.min(Math.floor(this.accum), 6 * this.speed);
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
    const sim = this.phase === 'running' || this.phase === 'result' || this.phase === 'gameover' ? this.sim : null;
    this.view.updateWater(sim ? sim.u : null, sim ? sim.env : null, this.phase === 'placing' ? this.isoField : null);
    this.view.updateTargets(this.targetState);
    this.updateLabels();
    if (this.phase === 'running' && this.sim) this.ui.setProgress(this.sim.stepIndex / SIM_STEPS);
  }

  private updatePlacingPreview(): void {
    const level = this.level!;
    const p = this.hover;
    if (!p || this.drag) {
      this.view.setGhost(null);
    } else if (!this.quakeAt(p.x, p.y) && this.selectedKind && this.remaining(this.selectedKind) > 0) {
      const valid = !placementProblem(level.land, p.x, p.y, level.targets, this.quakes);
      this.view.setGhost({ x: p.x, y: p.y, kind: this.selectedKind, valid });
    } else {
      this.view.setGhost(null);
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
    const lo = this.lo;
    const showArrivals = this.phase === 'placing' && lo.seismograph;
    this.ui.setTargetLabels(
      level.targets.map((t, k) => {
        const pos = this.view.project(t.x, t.y, t.required);
        const cell = Math.round(t.y) * GRID_W + Math.round(t.x);
        return {
          x: pos.x,
          y: pos.y,
          required: t.required,
          best: this.targetState[k].best,
          hit: this.targetState[k].hit,
          arrivals: showArrivals
            ? this.quakes
                .filter((q) => q.dist[cell] !== Infinity)
                .map((q) => ({
                  color: QUAKE_TYPES[q.kind].color,
                  t: q.delay + crestArrival(q.kind, lo.mods, q.dist[cell]),
                }))
                .sort((a, b) => a.t - b.t)
            : [],
        };
      }),
    );
    const sel = this.phase === 'placing' && !this.drag ? this.quakes.find((q) => q.id === this.selectedId) : undefined;
    if (sel) {
      const pos = this.view.project(sel.x, sel.y);
      this.ui.setQuakePanel({ x: pos.x, y: pos.y, kind: sel.kind, delay: sel.delay, fuse: lo.fuse });
    } else {
      this.ui.setQuakePanel(null);
    }
  }

  // ---------------------------------------------------------------- HUD

  private refreshPlacing(resetHint = true): void {
    this.view.setQuakes(this.quakes, this.selectedId);
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
    });
    if (resetHint) this.ui.setHint(this.placingHint());
    this.refreshHud();
  }

  private placingHint(): string {
    if (this.selectedId !== null) {
      return this.lo.fuse ? 'Drag to move. Use the fuse to delay this quake.' : 'Drag to move, or remove it.';
    }
    if (this.quakes.length === 0) {
      return this.level!.index === 0
        ? 'Tap the sea to place quakes. Their waves must meet so a crest breaks through the hoop.'
        : 'Tap the sea to place quakes. Red zones are off-limits.';
    }
    return 'Place more quakes, drag them to adjust, or press Unleash.';
  }

  private refreshHud(): void {
    if (!this.run || !this.level) return;
    this.ui.setHud({
      level: this.level.index + 1,
      name: this.level.name,
      lives: this.run.lives,
      maxLives: Math.max(this.lo.lives, this.run.lives),
      chaos: this.save.chaos,
      speed: this.speed,
      running: this.phase === 'running',
    });
  }
}
