import { QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { BRANCHES, canBuy, skillDiff, SKILLS, SKILL_BY_ID } from '../game/skills.ts';
import type { Settings } from '../game/settings.ts';
import { iconEl, iconSvg, type IconId } from './icons.ts';
import { TUTORIAL_SLIDES } from './tutorial.ts';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | ((e: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const svgNs = 'http://www.w3.org/2000/svg';

const QUAKE_ICON: Record<QuakeKind, IconId> = { small: 'tremor', medium: 'quake', large: 'mega', rift: 'rift', pulse: 'pulse' };

export interface TrayData {
  kinds: { kind: QuakeKind; left: number; total: number }[];
  selected: QuakeKind | null;
  canStart: boolean;
  canClear: boolean;
  oracles: number;
}

export interface CityLabel {
  x: number;
  y: number;
  name: string;
  level: number;
  wall: number;
  hp: number;
  damage: number;
  ruined: boolean;
  /** Shoreline height / wall, for the live gauge. */
  water: number;
  prediction: number | null;
  /** Hovered, pinned or just hit: shown in full; otherwise a faded compact card. */
  active: boolean;
}

export interface ZoneLabel {
  x: number;
  y: number;
  threshold: number;
  mult: number;
  hit: boolean;
}

export interface HudData {
  level: number;
  name: string;
  attempt: number;
  attempts: number;
  chaos: number;
  speed: number;
  running: boolean;
  muted: boolean;
}

export interface TimelineData {
  duration: number;
  maxFuse: number;
  step: number;
  quakes: { id: number; kind: QuakeKind; delay: number; selected: boolean }[];
  cities: { name: string; ruined: boolean; arrivals: { id: number; kind: QuakeKind; t: number }[] }[];
}

export interface ResultCity {
  name: string;
  level: number;
  ruined: boolean;
  damage: number;
  hp: number;
}

interface Line {
  label: string;
  value: string;
}

export class Ui {
  onSpeed: () => void = () => {};
  onMute: () => void = () => {};
  onSelectKind: (kind: QuakeKind) => void = () => {};
  onStart: () => void = () => {};
  onClear: () => void = () => {};
  onOracle: () => void = () => {};
  onDelay: (steps: number) => void = () => {};
  onSetDelay: (id: number, delay: number) => void = () => {};
  onSelectQuake: (id: number) => void = () => {};
  onRotate: () => void = () => {};
  onRemove: () => void = () => {};
  onSettings: () => void = () => {};
  onSkip: () => void = () => {};
  /** Any button press, for the click sound. */
  onTap: () => void = () => {};

  private hud = h('header', { class: 'hud' });
  private hudLevel = h('div', { class: 'hud-level' });
  private hudAttempts = h('div', { class: 'hud-attempts', title: 'Attempts left' });
  private hudChaos = h('div', { class: 'hud-chaos', title: 'Chaos' });
  private speedBtn = h('button', { class: 'btn small ghost', onclick: () => this.onSpeed() });
  private muteBtn = h('button', { class: 'btn small ghost icon-btn', onclick: () => this.onMute(), title: 'Sound' });
  private skipBtn = h('button', { class: 'btn small ghost', onclick: () => this.onSkip(), title: 'End this attempt now' }, 'Skip');
  private settingsBtn = h('button', { class: 'btn small ghost icon-btn', onclick: () => this.onSettings(), title: 'Settings' });
  private progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  private hint = h('div', { class: 'hint' });
  private dock = h('div', { class: 'dock' });
  private timeline = h('div', { class: 'timeline' });
  private tray = h('footer', { class: 'tray' });
  private labels = h('div', { class: 'labels' });
  private cityEls: HTMLElement[] = [];
  private zoneEls: HTMLElement[] = [];
  private banners = h('div', { class: 'banners' });
  private quakePanel = h('div', { class: 'quake-panel', hidden: '' });
  private overlay = h('div', { class: 'overlay', hidden: '' });
  private trayKey = '';
  private tlKey = '';
  private tlData: TimelineData | null = null;
  private tlDrag: { id: number; pointerId: number } | null = null;
  private skillFocus: string | null = null;
  private skillScroll = { left: 0, top: 0 };
  private hideTimer = 0;

  constructor(root: HTMLElement) {
    this.hud.append(
      this.hudLevel,
      h('div', { class: 'hud-right' }, this.hudAttempts, this.hudChaos, this.skipBtn, this.speedBtn, this.muteBtn, this.settingsBtn),
      this.progress,
    );
    this.dock.append(this.hint, this.timeline, this.tray);
    this.buildQuakePanel();
    this.settingsBtn.innerHTML = GEAR;
    root.append(this.labels, this.banners, this.hud, this.dock, this.quakePanel, this.overlay);
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) this.onTap();
    });
    this.timeline.addEventListener('pointermove', (e) => this.tlMove(e));
    this.timeline.addEventListener('pointerup', (e) => this.tlUp(e));
    this.timeline.addEventListener('pointercancel', (e) => this.tlUp(e));
    this.setPlayVisible(false);
  }

  setPlayVisible(visible: boolean): void {
    document.body.classList.toggle('playing', visible);
    if (!visible) this.quakePanel.hidden = true;
  }

  // ---------------------------------------------------------------- HUD

  setHud(d: HudData): void {
    this.hudLevel.replaceChildren(h('span', { class: 'hud-num' }, `Sea ${d.level}`), h('span', { class: 'hud-name' }, d.name));
    const left = d.attempts - d.attempt + 1;
    this.hudAttempts.replaceChildren(...Array.from({ length: d.attempts }, (_, k) => h('span', { class: k < left ? 'life' : 'life lost' })));
    this.hudChaos.textContent = `${d.chaos} chaos`;
    this.speedBtn.textContent = `${d.speed}×`;
    this.speedBtn.hidden = !d.running;
    this.skipBtn.hidden = !d.running;
    this.progress.hidden = !d.running;
    this.muteBtn.innerHTML = d.muted
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>';
  }

  setProgress(f: number): void {
    (this.progress.firstElementChild as HTMLElement).style.width = `${Math.min(100, f * 100)}%`;
  }

  setHint(text: string, warn = false): void {
    this.hint.textContent = text;
    this.hint.classList.toggle('warn', warn);
    this.hint.classList.toggle('empty', !text);
    if (warn) {
      this.hint.classList.remove('shake');
      void this.hint.offsetWidth;
      this.hint.classList.add('shake');
    }
  }

  /** Big transient text in the middle of the screen. */
  banner(text: string, tone: 'hot' | 'cool' | 'warm' = 'warm', sub?: string): void {
    const el = h('div', { class: `banner ${tone}` }, h('b', {}, text), sub ? h('span', {}, sub) : null);
    this.banners.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  /** Small floating number above a point on screen. */
  popup(x: number, y: number, text: string, tone: 'hit' | 'combo' = 'hit'): void {
    const el = h('div', { class: `popup ${tone}`, style: `left: ${x}px; top: ${y}px` }, text);
    this.labels.append(el);
    setTimeout(() => el.remove(), 1100);
  }

  // ---------------------------------------------------------------- tray

  setTray(d: TrayData | null): void {
    const key = JSON.stringify(d);
    if (key === this.trayKey) return;
    this.trayKey = key;
    this.tray.classList.toggle('empty', !d);
    if (!d) {
      this.tray.replaceChildren();
      return;
    }
    const cards = d.kinds.map((k) => {
      const type = QUAKE_TYPES[k.kind];
      return h(
        'button',
        {
          class: `quake-card${d.selected === k.kind ? ' selected' : ''}${k.left === 0 ? ' spent' : ''}`,
          style: `--qc: ${type.color}`,
          title: type.blurb,
          onclick: () => this.onSelectKind(k.kind),
        },
        iconEl(QUAKE_ICON[k.kind], 18),
        h('span', { class: 'quake-name' }, type.name),
        h('span', { class: 'quake-count' }, `${k.left}/${k.total}`),
      );
    });
    const actions: HTMLElement[] = [];
    if (d.oracles > 0) {
      actions.push(h('button', { class: 'btn ghost oracle', onclick: () => this.onOracle(), title: 'Oracle: preview damage' }, iconEl('eye', 16), `${d.oracles}`));
    }
    const clear = h('button', { class: 'btn ghost', onclick: () => this.onClear() }, 'Clear');
    if (!d.canClear) clear.setAttribute('disabled', '');
    const start = h('button', { class: 'btn primary', onclick: () => this.onStart() }, 'Unleash');
    if (!d.canStart) start.setAttribute('disabled', '');
    actions.push(clear, start);
    this.tray.replaceChildren(h('div', { class: 'cards' }, ...cards), h('div', { class: 'actions' }, ...actions));
  }

  // ---------------------------------------------------------------- timeline

  /** Fire times (draggable) and estimated crest arrivals per city. */
  setTimeline(d: TimelineData | null, playhead: number | null = null): void {
    this.tlData = d;
    this.timeline.classList.toggle('empty', !d);
    if (!d) {
      if (this.tlKey) this.timeline.replaceChildren();
      this.tlKey = '';
      return;
    }
    const key = JSON.stringify(d);
    if (key !== this.tlKey) {
      this.tlKey = key;
      this.renderTimeline(d);
    }
    const head = this.timeline.querySelector<HTMLElement>('.tl-playhead');
    if (head) {
      head.hidden = playhead === null;
      if (playhead !== null) head.style.left = `${Math.min(100, (playhead / d.duration) * 100)}%`;
    }
  }

  private renderTimeline(d: TimelineData): void {
    const pct = (t: number) => `${Math.max(0, Math.min(100, (t / d.duration) * 100))}%`;
    const ticks: HTMLElement[] = [];
    for (let s = 0; s <= d.duration; s++) {
      ticks.push(h('span', { class: `tl-tick${s % 2 ? ' minor' : ''}`, style: `left: ${pct(s)}` }, s % 2 ? '' : `${s}s`));
    }
    const fireTrack = h(
      'div',
      { class: 'tl-track fire' },
      h('div', { class: 'tl-fuse', style: `width: ${pct(d.maxFuse)}` }),
      ...d.quakes.map((q) => {
        const gem = h('button', {
          class: `tl-gem${q.selected ? ' selected' : ''}`,
          style: `left: ${pct(q.delay)}; --qc: ${QUAKE_TYPES[q.kind].color}`,
          title: `${QUAKE_TYPES[q.kind].name} fires at ${q.delay.toFixed(2)} s`,
        });
        gem.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.tlDrag = { id: q.id, pointerId: e.pointerId };
          this.timeline.setPointerCapture(e.pointerId);
          this.onSelectQuake(q.id);
        });
        return gem;
      }),
    );
    const cityRows = d.cities.map((c) =>
      h(
        'div',
        { class: `tl-row${c.ruined ? ' ruined' : ''}` },
        h('span', { class: 'tl-label' }, iconEl('city', 13), h('span', {}, c.name)),
        h(
          'div',
          { class: 'tl-track thin' },
          ...c.arrivals.map((a) =>
            h('span', {
              class: `tl-arrival${d.quakes.find((q) => q.id === a.id)?.selected ? ' selected' : ''}`,
              style: `left: ${pct(a.t)}; --qc: ${QUAKE_TYPES[a.kind].color}`,
            }),
          ),
        ),
      ),
    );
    this.timeline.replaceChildren(
      h('div', { class: 'tl-row' }, h('span', { class: 'tl-label' }, iconEl('fuse', 13), h('span', {}, 'Fire')), fireTrack),
      ...cityRows,
      h(
        'div',
        { class: 'tl-row axis' },
        h('span', { class: 'tl-label' }),
        h('div', { class: 'tl-axis' }, ...ticks, h('div', { class: 'tl-playhead', hidden: '' })),
      ),
    );
  }

  private tlMove(e: PointerEvent): void {
    const d = this.tlData;
    if (!this.tlDrag || this.tlDrag.pointerId !== e.pointerId || !d) return;
    const track = this.timeline.querySelector<HTMLElement>('.tl-track.fire');
    if (!track) return;
    const r = track.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * d.duration;
    const snapped = Math.round(Math.max(0, Math.min(d.maxFuse, t)) / d.step) * d.step;
    this.onSetDelay(this.tlDrag.id, snapped);
  }

  private tlUp(e: PointerEvent): void {
    if (this.tlDrag?.pointerId === e.pointerId) this.tlDrag = null;
  }

  // ---------------------------------------------------------------- labels

  setCityLabels(list: CityLabel[]): void {
    while (this.cityEls.length < list.length) {
      const el = h('div', { class: 'city-label' });
      this.labels.append(el);
      this.cityEls.push(el);
    }
    while (this.cityEls.length > list.length) this.cityEls.pop()!.remove();
    list.forEach((c, k) => {
      const el = this.cityEls[k];
      el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      const water = Math.max(0, Math.min(1.3, c.water));
      el.classList.toggle('active', c.active || c.prediction !== null);
      const key = `${c.name}|${c.wall}|${c.damage.toFixed(2)}|${c.ruined}|${water.toFixed(2)}|${c.prediction}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.classList.toggle('ruined', c.ruined);
      const frac = Math.min(1, c.damage / c.hp);
      const pred =
        c.prediction !== null
          ? h('div', { class: `prediction${c.prediction >= c.hp ? ' ok' : ''}` }, iconEl('eye', 12), ` ${c.prediction.toFixed(1)} / ${c.hp.toFixed(1)}`)
          : null;
      el.replaceChildren(
        h(
          'div',
          { class: 'city-card' },
          h('div', { class: 'city-top' }, h('span', { class: 'city-lvl' }, `L${c.level}`), h('span', { class: 'city-name' }, c.ruined ? 'RUINED' : c.name)),
          h(
            'div',
            { class: 'city-stats' },
            h('span', { class: 'wall' }, iconEl('wall', 12), ` ${c.wall.toFixed(1)} m`),
            h('span', { class: 'gauge', title: 'Water vs wall' }, h('i', { style: `height: ${(water / 1.3) * 100}%`, class: water >= 1 ? 'over' : '' }), h('b', {})),
          ),
          h('div', { class: 'hpbar' }, h('i', { style: `width: ${(1 - frac) * 100}%` })),
          pred,
        ),
      );
    });
  }

  setZoneLabels(list: ZoneLabel[]): void {
    while (this.zoneEls.length < list.length) {
      const el = h('div', { class: 'zone-label' });
      this.labels.append(el);
      this.zoneEls.push(el);
    }
    while (this.zoneEls.length > list.length) this.zoneEls.pop()!.remove();
    list.forEach((z, k) => {
      const el = this.zoneEls[k];
      el.style.transform = `translate(${z.x}px, ${z.y}px)`;
      const key = `${z.threshold}|${z.mult}|${z.hit}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.classList.toggle('hit', z.hit);
      el.replaceChildren(h('div', {}, iconEl('amp', 12), ` ×${z.mult.toFixed(1)} · ${z.threshold.toFixed(1)} m`));
    });
  }

  private panelDelay = h('span', { class: 'delay' });
  private panelPower = h('span', { class: 'power', title: 'Quake power' });
  private panelRotate = h('button', { class: 'btn small ghost icon-btn', title: 'Rotate', onclick: () => this.onRotate() });

  private buildQuakePanel(): void {
    this.panelRotate.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>';
    this.quakePanel.append(
      this.panelPower,
      h('button', { class: 'btn small ghost', onclick: () => this.onDelay(-1) }, '−'),
      this.panelDelay,
      h('button', { class: 'btn small ghost', onclick: () => this.onDelay(1) }, '+'),
      this.panelRotate,
      h('button', { class: 'btn small danger', onclick: () => this.onRemove() }, 'Remove'),
    );
    this.quakePanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setQuakePanel(d: { x: number; y: number; delay: number; rotatable: boolean; power: number } | null): void {
    this.quakePanel.hidden = !d;
    if (!d) return;
    // Keep the panel on screen; it is centred on x via CSS translate.
    const half = this.quakePanel.offsetWidth / 2 + 8;
    const x = Math.max(half, Math.min(window.innerWidth - half, d.x));
    // Flip above the quake when the panel would run into the dock.
    const below = d.y + 24;
    const dockTop = this.dock.getBoundingClientRect().top;
    const y = below + this.quakePanel.offsetHeight > dockTop - 8 ? d.y - 34 - this.quakePanel.offsetHeight : below;
    this.quakePanel.style.transform = `translate(${x}px, ${y}px)`;
    this.panelRotate.hidden = !d.rotatable;
    this.panelDelay.textContent = `fires ${d.delay.toFixed(2)}s`;
    this.panelPower.textContent = `${Math.round(d.power * 100)}%`;
    this.panelPower.classList.toggle('weak', d.power < 1);
  }

  // ---------------------------------------------------------------- overlays

  hideOverlay(): void {
    if (this.overlay.hidden) return;
    this.overlay.classList.add('leaving');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.overlay.hidden = true;
      this.overlay.classList.remove('leaving');
      this.overlay.replaceChildren();
    }, 220);
  }

  private showPanel(cls: string, ...children: Child[]): HTMLElement {
    clearTimeout(this.hideTimer);
    this.overlay.classList.remove('leaving');
    this.overlay.hidden = false;
    const panel = h('div', { class: `panel ${cls}` }, ...children);
    this.overlay.replaceChildren(panel);
    return panel;
  }

  showMenu(
    chaos: number,
    bestLevel: number,
    skills: number,
    a: { start: () => void; skills: () => void; tutorial: () => void; settings: () => void },
  ): void {
    const gear = h('button', { class: 'btn small ghost icon-btn corner', onclick: a.settings, title: 'Settings' });
    gear.innerHTML = GEAR;
    this.showPanel(
      'title-panel',
      gear,
      h('h1', { class: 'logo' }, 'Freak', h('span', {}, 'Wave')),
      h('p', { class: 'tagline' }, 'Time your earthquakes. Stack the waves. Drown the coast.'),
      h(
        'div',
        { class: 'stats' },
        h('div', {}, h('b', {}, String(chaos)), h('span', {}, 'chaos')),
        h('div', {}, h('b', {}, String(bestLevel)), h('span', {}, 'best run')),
        h('div', {}, h('b', {}, `${skills}/${SKILLS.length}`), h('span', {}, 'skills')),
      ),
      h(
        'div',
        { class: 'panel-actions' },
        h('button', { class: 'btn ghost', onclick: a.tutorial }, 'How to play'),
        h('button', { class: 'btn ghost', onclick: a.skills }, 'Skill tree'),
        h('button', { class: 'btn primary', onclick: a.start }, 'Play'),
      ),
      h(
        'ul',
        { class: 'howto' },
        h('li', {}, 'Quakes are strongest inside the green epicenters and fade outside them.'),
        h('li', {}, 'Drag quakes along the timeline to delay them, so their crests reach a city together.'),
        h('li', {}, 'Every crest that tops a sea wall damages the city. Back-to-back crests combo.'),
        h('li', {}, 'Ruin every city within 3 attempts. Golden rings multiply your chaos.'),
      ),
    );
  }

  showSettings(
    settings: Settings,
    a: { change: (s: Settings) => void; reset: () => void; tutorial: () => void; close: () => void },
  ): void {
    const s = { ...settings };
    const slider = (label: string, key: 'master' | 'ambience' | 'effects') => {
      const input = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(s[key] * 100)) });
      const value = h('span', { class: 'slider-value' }, `${Math.round(s[key] * 100)}`);
      input.addEventListener('input', () => {
        s[key] = Number(input.value) / 100;
        value.textContent = input.value;
        a.change({ ...s });
      });
      return h('label', { class: 'setting' }, h('span', {}, label), input, value);
    };
    const mute = h('input', { type: 'checkbox' });
    mute.checked = s.muted;
    mute.addEventListener('change', () => {
      s.muted = mute.checked;
      a.change({ ...s });
    });
    let armed = false;
    const reset = h('button', { class: 'btn danger' }, 'Reset progress');
    reset.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        reset.textContent = 'Tap again to erase all chaos and skills';
        setTimeout(() => {
          armed = false;
          if (reset.isConnected) reset.textContent = 'Reset progress';
        }, 3500);
        return;
      }
      a.reset();
    });
    this.showPanel(
      'settings-panel',
      h('h2', {}, 'Settings'),
      h('h3', {}, 'Audio'),
      slider('Master', 'master'),
      slider('Ambience', 'ambience'),
      slider('Effects', 'effects'),
      h('label', { class: 'setting toggle' }, h('span', {}, 'Mute everything'), mute),
      h('h3', {}, 'Game'),
      h('div', { class: 'setting-actions' }, h('button', { class: 'btn ghost', onclick: a.tutorial }, 'Replay tutorial'), reset),
      h('div', { class: 'panel-actions' }, h('button', { class: 'btn primary', onclick: a.close }, 'Done')),
    );
  }

  showTutorial(done: () => void, start = 0): void {
    const slide = TUTORIAL_SLIDES[start];
    const last = start === TUTORIAL_SLIDES.length - 1;
    const art = h('div', { class: 'tut-art' });
    art.innerHTML = `<svg viewBox="0 0 240 140" role="img" aria-label="${slide.title}">${slide.svg}</svg>`;
    this.showPanel(
      `tutorial-panel${start > 0 ? ' instant' : ''}`,
      h('div', { class: 'tut-step' }, `${start + 1} / ${TUTORIAL_SLIDES.length}`),
      art,
      h('h2', {}, slide.title),
      h('p', { class: 'tut-body' }, slide.body),
      h('div', { class: 'tut-dots' }, ...TUTORIAL_SLIDES.map((_, i) => h('span', { class: i === start ? 'on' : '' }))),
      h(
        'div',
        { class: 'panel-actions' },
        !last && h('button', { class: 'btn ghost', onclick: done }, 'Skip'),
        start > 0 && h('button', { class: 'btn ghost', onclick: () => this.showTutorial(done, start - 1) }, 'Back'),
        h('button', { class: 'btn primary', onclick: () => (last ? done() : this.showTutorial(done, start + 1)) }, last ? 'Let\u2019s go' : 'Next'),
      ),
    );
  }

  showLevelSelect(
    seas: { index: number; name: string; unlocked: boolean; cleared: boolean }[],
    a: { pick: (index: number) => void; back: () => void },
  ): void {
    const furthest = Math.max(0, ...seas.filter((s) => s.unlocked).map((s) => s.index));
    this.showPanel(
      'levels-panel',
      h('div', { class: 'skills-head' }, h('h2', {}, 'Choose a sea'), h('button', { class: 'btn ghost', onclick: a.back }, 'Back')),
      h('p', { class: 'muted' }, 'A run starts at the sea you pick and carries on from there. Replay cleared seas to farm chaos.'),
      h(
        'div',
        { class: 'level-grid' },
        ...seas.map((s, i) => {
          const card = h(
            'button',
            {
              class: `level-card${s.cleared ? ' cleared' : ''}${s.index === furthest ? ' next' : ''}`,
              style: `animation-delay: ${Math.min(i, 16) * 0.03}s`,
              onclick: () => a.pick(s.index),
            },
            h('span', { class: 'level-num' }, String(s.index + 1)),
            h('span', { class: 'level-name' }, s.unlocked ? s.name : 'Locked'),
            h('span', { class: 'level-state' }, s.cleared ? 'Cleared' : s.unlocked ? 'New' : ''),
          );
          if (!s.unlocked) card.setAttribute('disabled', '');
          return card;
        }),
      ),
    );
  }

  showLoading(text: string): void {
    this.showPanel('loading-panel', h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text));
  }

  showError(message: string, back: () => void): void {
    this.showPanel(
      '',
      h('h2', {}, 'Something broke'),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'panel-actions' }, h('button', { class: 'btn primary', onclick: back }, 'Back')),
    );
  }

  private chaosLines(lines: Line[], total: number, gained: number): HTMLElement {
    const totalEl = h('b', {}, String(total - gained));
    const box = h(
      'div',
      { class: 'chaos-lines' },
      ...lines.map((l, i) =>
        h('div', { class: 'chaos-line', style: `animation-delay: ${0.15 + i * 0.12}s` }, h('span', {}, l.label), h('b', {}, l.value)),
      ),
      h('div', { class: 'chaos-line total', style: `animation-delay: ${0.15 + lines.length * 0.12}s` }, h('span', {}, 'Chaos banked'), totalEl),
    );
    // Count the total up once the lines have appeared.
    const start = performance.now() + 250 + lines.length * 120;
    const from = total - gained;
    const tick = (now: number) => {
      const k = Math.max(0, Math.min(1, (now - start) / 700));
      totalEl.textContent = String(Math.round(from + gained * (1 - (1 - k) ** 3)));
      if (k < 1 && totalEl.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return box;
  }

  private cityRows(cities: ResultCity[]): HTMLElement {
    return h(
      'div',
      { class: 'result-targets' },
      ...cities.map((c, i) =>
        h(
          'div',
          { class: `result-target${c.ruined ? ' hit' : ''}`, style: `animation-delay: ${i * 0.08}s` },
          h('span', {}, `L${c.level} ${c.name}`),
          h('span', {}, c.ruined ? 'Ruined' : `${Math.round(Math.min(1, c.damage / c.hp) * 100)}%`),
        ),
      ),
    );
  }

  showResult(
    d: { success: boolean; cities: ResultCity[]; lines: Line[]; chaos: number; total: number; attemptsLeft: number },
    a: { next: (() => void) | null; retry: (() => void) | null; skills: () => void; menu: () => void },
  ): void {
    this.showPanel(
      d.success ? 'result win' : 'result',
      h('h2', { class: d.success ? 'win' : 'lose' }, d.success ? 'Coast drowned!' : 'The walls held'),
      h(
        'p',
        { class: 'muted' },
        d.success
          ? 'Every city is in ruins.'
          : `${d.attemptsLeft} ${d.attemptsLeft === 1 ? 'attempt' : 'attempts'} left. Your quakes stay where you put them.`,
      ),
      this.cityRows(d.cities),
      this.chaosLines(d.lines, d.total, d.chaos),
      h(
        'div',
        { class: 'panel-actions' },
        h('button', { class: 'btn ghost', onclick: a.menu }, 'Give up'),
        h('button', { class: 'btn ghost', onclick: a.skills }, 'Skill tree'),
        a.retry && h('button', { class: 'btn primary', onclick: a.retry }, 'Try again'),
        a.next && h('button', { class: 'btn primary', onclick: a.next }, 'Next sea'),
      ),
    );
  }

  showGameOver(
    d: { cleared: number; chaos: number; cities: ResultCity[]; lines: Line[]; total: number; gained: number },
    a: { skills: () => void; again: () => void; menu: () => void },
  ): void {
    this.showPanel(
      'result',
      h('h2', { class: 'lose' }, 'Run over'),
      h('p', { class: 'muted' }, `You drowned ${d.cleared} ${d.cleared === 1 ? 'coast' : 'coasts'} and earned ${d.chaos} chaos this run.`),
      this.cityRows(d.cities),
      this.chaosLines(d.lines, d.total, d.gained),
      h(
        'div',
        { class: 'panel-actions' },
        h('button', { class: 'btn ghost', onclick: a.menu }, 'Menu'),
        h('button', { class: 'btn ghost', onclick: a.skills }, 'Skill tree'),
        h('button', { class: 'btn primary', onclick: a.again }, 'New run'),
      ),
    );
  }

  showSkills(owned: ReadonlySet<string>, chaos: number, a: { buy: (id: string) => void; close: () => void }, justBought?: string): void {
    const COL_W = 84;
    const ROW_H = 92;
    const pad = 46;
    const width = COL_W * 9 + pad * 2;
    const height = ROW_H * 6 + pad * 2;
    const pos = (s: { col: number; row: number }) => ({ x: s.col * COL_W + pad, y: s.row * ROW_H + pad });

    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'skill-links');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    for (const s of SKILLS) {
      for (const r of s.requires) {
        const from = pos(SKILL_BY_ID[r]);
        const to = pos(s);
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('class', owned.has(r) ? (owned.has(s.id) ? 'on' : 'ready') : '');
        svg.append(line);
      }
    }
    const nodes = SKILLS.map((s) => {
      const p = pos(s);
      const isOwned = owned.has(s.id);
      const unlocked = s.requires.every((r) => owned.has(r));
      const state = isOwned ? 'owned' : canBuy(s.id, owned, chaos) ? 'buyable' : unlocked ? 'expensive' : 'locked';
      const color = BRANCHES.find((b) => b.id === s.branch)!.color;
      const node = h(
        'button',
        {
          class: `skill ${state}${this.skillFocus === s.id ? ' focus' : ''}${justBought === s.id ? ' bought' : ''}`,
          style: `left: ${p.x}px; top: ${p.y}px; --bc: ${color}`,
          onclick: () => {
            this.skillFocus = s.id;
            this.showSkills(owned, chaos, a);
          },
        },
        h('span', { class: 'skill-icon' }),
        h('span', { class: 'skill-name' }, s.name),
      );
      (node.firstElementChild as HTMLElement).innerHTML = iconSvg(s.icon, 22);
      node.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') this.showSkillTip(tree, s.id, owned, chaos, p);
      });
      node.addEventListener('pointerleave', () => this.skillTip.remove());
      return node;
    });

    this.skillTip.remove();
    const tree: HTMLElement = h('div', { class: 'skill-tree', style: `width: ${width}px; height: ${height}px` }, svg, ...nodes);
    const labels = h(
      'div',
      { class: 'branch-labels', style: `width: ${width}px` },
      ...BRANCHES.map((b, i) => h('span', { style: `color: ${b.color}; left: ${(i * 2 + 0.5) * COL_W + pad}px` }, b.name)),
    );
    const scroller = h('div', { class: 'skill-scroll' }, labels, tree);
    scroller.addEventListener('scroll', () => (this.skillScroll = { left: scroller.scrollLeft, top: scroller.scrollTop }));
    enableDragScroll(scroller);

    const wasOpen = !!this.overlay.querySelector('.skills-panel');
    this.showPanel(
      `skills-panel${wasOpen ? ' instant' : ''}`,
      h(
        'div',
        { class: 'skills-head' },
        h('h2', {}, 'Skill tree'),
        h('div', { class: 'hud-chaos big' }, `${chaos} chaos`),
        h('button', { class: 'btn ghost', onclick: a.close }, 'Done'),
      ),
      scroller,
      this.skillDetail(owned, chaos, a.buy),
    );
    scroller.scrollLeft = this.skillScroll.left;
    scroller.scrollTop = this.skillScroll.top;
  }

  private skillTip = h('div', { class: 'skill-tip' });

  private showSkillTip(tree: HTMLElement, id: string, owned: ReadonlySet<string>, chaos: number, p: { x: number; y: number }): void {
    const s = SKILL_BY_ID[id];
    const status = owned.has(id) ? 'Owned' : `${s.cost} chaos${chaos < s.cost ? ` (need ${s.cost - chaos} more)` : ''}`;
    this.skillTip.replaceChildren(
      h('b', {}, s.name),
      h('p', {}, s.desc),
      this.diffList(id, owned),
      h('span', { class: `tip-cost${owned.has(id) ? ' owned' : ''}` }, status),
    );
    // Show below nodes near the top, above otherwise; stay inside the tree.
    const below = p.y < 200;
    this.skillTip.className = `skill-tip${below ? ' below' : ''}`;
    this.skillTip.style.left = `${Math.max(120, Math.min(tree.offsetWidth - 120, p.x))}px`;
    this.skillTip.style.top = `${below ? p.y + 52 : p.y - 34}px`;
    tree.append(this.skillTip);
  }

  /** "Current => after" lines for a skill. */
  private diffList(id: string, owned: ReadonlySet<string>): HTMLElement {
    return h(
      'div',
      { class: 'skill-diff' },
      ...skillDiff(id, owned).map((d) => h('div', {}, h('span', {}, d.label), h('b', {}, d.from, h('i', {}, ' \u21d2 '), d.to))),
    );
  }

  private skillDetail(owned: ReadonlySet<string>, chaos: number, buy: (id: string) => void): HTMLElement {
    const s = this.skillFocus ? SKILL_BY_ID[this.skillFocus] : undefined;
    if (!s) return h('div', { class: 'skill-detail muted' }, `${owned.size} of ${SKILLS.length} skills owned. Tap a skill to see what it does.`);
    const missing = s.requires.filter((r) => !owned.has(r)).map((r) => SKILL_BY_ID[r].name);
    const status = owned.has(s.id)
      ? 'Owned'
      : missing.length
        ? `Requires ${missing.join(' and ')}`
        : chaos < s.cost
          ? `Need ${s.cost - chaos} more chaos`
          : '';
    const btn = h('button', { class: 'btn primary', onclick: () => buy(s.id) }, `Buy for ${s.cost}`);
    if (!canBuy(s.id, owned, chaos)) btn.setAttribute('disabled', '');
    const icon = h('span', { class: 'skill-icon big', style: `--bc: ${BRANCHES.find((b) => b.id === s.branch)!.color}` });
    icon.innerHTML = iconSvg(s.icon, 26);
    return h(
      'div',
      { class: 'skill-detail' },
      icon,
      h('div', { class: 'skill-text' }, h('b', {}, s.name), h('p', {}, s.desc), this.diffList(s.id, owned), status && h('span', { class: 'muted' }, status)),
      !owned.has(s.id) && btn,
    );
  }
}

const GEAR =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

/** Mouse drag-to-pan for the skill tree (touch scrolls natively). */
function enableDragScroll(el: HTMLElement): void {
  let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    drag = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    el.scrollLeft = drag.left - dx;
    el.scrollTop = drag.top - dy;
  });
  const end = () => {
    if (drag?.moved) {
      // Swallow the click that ends a drag so it doesn't select a skill.
      el.addEventListener('click', (e) => e.stopPropagation(), { capture: true, once: true });
    }
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointerleave', () => (drag = null));
}
