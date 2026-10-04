import { QUAKE_TYPES, type QuakeKind } from '../sim/quakes.ts';
import { rampCss } from '../render/palette.ts';
import { canBuy, SKILLS, type SkillDef, type SkillId } from '../game/skills.ts';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
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

export interface TrayData {
  kinds: { kind: QuakeKind; left: number; total: number }[];
  selected: QuakeKind | null;
  canStart: boolean;
  canClear: boolean;
}

export interface TargetLabel {
  x: number;
  y: number;
  required: number;
  best: number;
  hit: boolean;
  arrivals: { color: string; t: number }[];
}

export interface HudData {
  level: number;
  name: string;
  lives: number;
  maxLives: number;
  chaos: number;
  speed: number;
  running: boolean;
}

interface ResultTarget {
  required: number;
  best: number;
  hit: boolean;
}

interface Line {
  label: string;
  value: string;
}

export class Ui {
  onSpeed: () => void = () => {};
  onSelectKind: (kind: QuakeKind) => void = () => {};
  onStart: () => void = () => {};
  onClear: () => void = () => {};
  onDelay: (delta: number) => void = () => {};
  onRemove: () => void = () => {};

  private root: HTMLElement;
  private hud = h('header', { class: 'hud' });
  private hudLevel = h('div', { class: 'hud-level' });
  private hudLives = h('div', { class: 'hud-lives', title: 'Lives' });
  private hudChaos = h('div', { class: 'hud-chaos', title: 'Chaos' });
  private speedBtn = h('button', { class: 'btn small ghost', onclick: () => this.onSpeed() });
  private progress = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  private hint = h('div', { class: 'hint' });
  private tray = h('footer', { class: 'tray' });
  private labels = h('div', { class: 'labels' });
  private labelEls: HTMLElement[] = [];
  private quakePanel = h('div', { class: 'quake-panel', hidden: '' });
  private overlay = h('div', { class: 'overlay', hidden: '' });
  private trayKey = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.hud.append(
      this.hudLevel,
      h('div', { class: 'hud-right' }, this.hudLives, this.hudChaos, this.speedBtn),
      this.progress,
    );
    this.buildQuakePanel();
    root.append(this.labels, this.hud, this.hint, this.tray, this.quakePanel, this.overlay);
    this.setPlayVisible(false);
  }

  setPlayVisible(visible: boolean): void {
    for (const el of [this.hud, this.hint, this.tray, this.labels]) el.hidden = !visible;
    if (!visible) this.quakePanel.hidden = true;
  }

  // ---------------------------------------------------------------- HUD

  setHud(d: HudData): void {
    this.hudLevel.replaceChildren(h('span', { class: 'hud-num' }, `Sea ${d.level}`), h('span', { class: 'hud-name' }, d.name));
    this.hudLives.replaceChildren(
      ...Array.from({ length: d.maxLives }, (_, k) => h('span', { class: k < d.lives ? 'life' : 'life lost' })),
    );
    this.hudChaos.textContent = `${d.chaos} chaos`;
    this.speedBtn.textContent = `${d.speed}×`;
    this.speedBtn.hidden = !d.running;
    this.progress.hidden = !d.running;
  }

  setProgress(f: number): void {
    (this.progress.firstElementChild as HTMLElement).style.width = `${Math.min(100, f * 100)}%`;
  }

  setHint(text: string, warn = false): void {
    this.hint.textContent = text;
    this.hint.classList.toggle('warn', warn);
    this.hint.style.visibility = text ? 'visible' : 'hidden';
  }

  setTray(d: TrayData | null): void {
    const key = JSON.stringify(d);
    if (key === this.trayKey) return;
    this.trayKey = key;
    if (!d) {
      this.tray.replaceChildren();
      this.tray.classList.add('empty');
      return;
    }
    this.tray.classList.remove('empty');
    const cards = d.kinds.map((k) => {
      const type = QUAKE_TYPES[k.kind];
      const card = h(
        'button',
        {
          class: `quake-card${d.selected === k.kind ? ' selected' : ''}${k.left === 0 ? ' spent' : ''}`,
          style: `--qc: ${type.color}`,
          onclick: () => this.onSelectKind(k.kind),
        },
        h('span', { class: 'gem' }),
        h('span', { class: 'quake-name' }, type.name),
        h('span', { class: 'quake-count' }, `${k.left}/${k.total}`),
      );
      return card;
    });
    const clear = h('button', { class: 'btn ghost', onclick: () => this.onClear() }, 'Clear');
    if (!d.canClear) clear.setAttribute('disabled', '');
    const start = h('button', { class: 'btn primary', onclick: () => this.onStart() }, 'Unleash');
    if (!d.canStart) start.setAttribute('disabled', '');
    this.tray.replaceChildren(h('div', { class: 'cards' }, ...cards), h('div', { class: 'actions' }, clear, start));
  }

  setTargetLabels(list: TargetLabel[]): void {
    while (this.labelEls.length < list.length) {
      const el = h('div', { class: 'target-label' });
      this.labels.append(el);
      this.labelEls.push(el);
    }
    while (this.labelEls.length > list.length) this.labelEls.pop()!.remove();
    list.forEach((t, k) => {
      const el = this.labelEls[k];
      el.style.transform = `translate(${t.x}px, ${t.y}px)`;
      const key = `${t.required}|${t.best.toFixed(1)}|${t.hit}|${t.arrivals.map((a) => a.color + a.t.toFixed(1)).join()}`;
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.classList.toggle('hit', t.hit);
      const best = t.best > 0.05 ? h('span', { class: 'best', style: `color: ${rampCss(Math.max(4, t.best))}` }, `${t.best.toFixed(1)}`) : null;
      const arrivals = t.arrivals.length
        ? h(
            'div',
            { class: 'arrivals' },
            ...t.arrivals.map((a) => h('span', { class: 'arrival', style: `--qc: ${a.color}` }, `${a.t.toFixed(1)}s`)),
          )
        : null;
      const need = h('div', { class: 'need' }, t.hit ? 'HIT ' : '', best, best ? ' / ' : '', `${t.required.toFixed(1)} m`);
      if (arrivals) el.replaceChildren(need, arrivals);
      else el.replaceChildren(need);
    });
  }

  private panelDelay = h('span', { class: 'delay' });
  private panelFuse = h('div', { class: 'fuse' });

  private buildQuakePanel(): void {
    this.panelFuse.append(
      h('button', { class: 'btn small ghost', onclick: () => this.onDelay(-0.5) }, '−'),
      this.panelDelay,
      h('button', { class: 'btn small ghost', onclick: () => this.onDelay(0.5) }, '+'),
    );
    this.quakePanel.append(this.panelFuse, h('button', { class: 'btn small danger', onclick: () => this.onRemove() }, 'Remove'));
    this.quakePanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setQuakePanel(d: { x: number; y: number; kind: QuakeKind; delay: number; fuse: boolean } | null): void {
    this.quakePanel.hidden = !d;
    if (!d) return;
    this.quakePanel.style.transform = `translate(${d.x}px, ${d.y + 22}px)`;
    this.panelFuse.hidden = !d.fuse;
    this.panelDelay.textContent = `fuse ${d.delay.toFixed(1)}s`;
  }

  // ---------------------------------------------------------------- overlays

  hideOverlay(): void {
    this.overlay.hidden = true;
    this.overlay.replaceChildren();
  }

  private showPanel(...children: Child[]): void {
    this.overlay.hidden = false;
    this.overlay.replaceChildren(h('div', { class: 'panel' }, ...children));
  }

  showMenu(chaos: number, bestLevel: number, a: { start: () => void; skills: () => void }): void {
    this.overlay.hidden = false;
    this.overlay.replaceChildren(
      h(
        'div',
        { class: 'panel title-panel' },
        h('h1', { class: 'logo' }, 'Freak', h('span', {}, 'Wave')),
        h('p', { class: 'tagline' }, 'Place earthquakes. Bend the sea. Make the waves meet.'),
        h(
          'div',
          { class: 'stats' },
          h('div', {}, h('b', {}, String(chaos)), h('span', {}, 'chaos')),
          h('div', {}, h('b', {}, String(bestLevel)), h('span', {}, 'best run')),
        ),
        h(
          'div',
          { class: 'panel-actions' },
          h('button', { class: 'btn ghost', onclick: a.skills }, 'Skill tree'),
          h('button', { class: 'btn primary', onclick: a.start }, 'Start run'),
        ),
        h(
          'ul',
          { class: 'howto' },
          h('li', {}, 'Each quake sends out a train of waves.'),
          h('li', {}, 'Waves that arrive together stack up. Islands reflect them.'),
          h('li', {}, 'Push a crest through every hoop before the sea calms.'),
        ),
      ),
    );
  }

  showLoading(text: string): void {
    this.showPanel(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text));
  }

  showError(message: string, back: () => void): void {
    this.showPanel(
      h('h2', {}, 'Something broke'),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'panel-actions' }, h('button', { class: 'btn primary', onclick: back }, 'Back')),
    );
  }

  private targetRows(targets: ResultTarget[]): HTMLElement {
    return h(
      'div',
      { class: 'result-targets' },
      ...targets.map((t, k) =>
        h(
          'div',
          { class: `result-target${t.hit ? ' hit' : ''}` },
          h('span', {}, targets.length > 1 ? `Hoop ${String.fromCharCode(65 + k)}` : 'Hoop'),
          h('span', { style: `color: ${rampCss(Math.max(4, t.best))}` }, `${t.best.toFixed(1)} m`),
          h('span', { class: 'muted' }, `of ${t.required.toFixed(1)} m`),
        ),
      ),
    );
  }

  private chaosLines(lines: Line[], total: number): HTMLElement {
    return h(
      'div',
      { class: 'chaos-lines' },
      ...lines.map((l) => h('div', { class: 'chaos-line' }, h('span', {}, l.label), h('b', {}, l.value))),
      h('div', { class: 'chaos-line total' }, h('span', {}, 'Chaos banked'), h('b', {}, String(total))),
    );
  }

  showResult(
    d: { success: boolean; targets: ResultTarget[]; lines: Line[]; chaos: number; total: number; lives: number },
    a: { next: (() => void) | null; retry: (() => void) | null; skills: () => void; menu: () => void },
  ): void {
    this.showPanel(
      h('h2', { class: d.success ? 'win' : 'lose' }, d.success ? 'Freak wave!' : 'The sea held'),
      h('p', { class: 'muted' }, d.success ? 'Every hoop was breached.' : `You lose a life. ${d.lives} left.`),
      this.targetRows(d.targets),
      this.chaosLines(d.lines, d.total),
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
    d: { cleared: number; chaos: number; targets: ResultTarget[]; lines: Line[]; total: number },
    a: { skills: () => void; again: () => void; menu: () => void },
  ): void {
    this.showPanel(
      h('h2', { class: 'lose' }, 'Run over'),
      h('p', { class: 'muted' }, `You broke ${d.cleared} ${d.cleared === 1 ? 'sea' : 'seas'} and earned ${d.chaos} chaos.`),
      this.targetRows(d.targets),
      this.chaosLines(d.lines, d.total),
      h(
        'div',
        { class: 'panel-actions' },
        h('button', { class: 'btn ghost', onclick: a.menu }, 'Menu'),
        h('button', { class: 'btn ghost', onclick: a.skills }, 'Skill tree'),
        h('button', { class: 'btn primary', onclick: a.again }, 'New run'),
      ),
    );
  }

  showSkills(owned: ReadonlySet<SkillId>, chaos: number, a: { buy: (id: SkillId) => void; close: () => void }): void {
    const cols = 4;
    const rows = 4;
    const pos = (s: SkillDef) => ({ x: ((s.col + 0.5) / cols) * 100, y: ((s.row + 0.5) / rows) * 100 });
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'skill-links');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const s of SKILLS) {
      for (const r of s.requires) {
        const from = pos(SKILLS.find((x) => x.id === r)!);
        const to = pos(s);
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', String(from.x));
        line.setAttribute('y1', String(from.y));
        line.setAttribute('x2', String(to.x));
        line.setAttribute('y2', String(to.y));
        line.setAttribute('class', owned.has(r) ? 'on' : '');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(line);
      }
    }
    const nodes = SKILLS.map((s) => {
      const p = pos(s);
      const isOwned = owned.has(s.id);
      const unlocked = s.requires.every((r) => owned.has(r));
      const affordable = canBuy(s.id, owned, chaos);
      const state = isOwned ? 'owned' : affordable ? 'buyable' : unlocked ? 'expensive' : 'locked';
      return h(
        'button',
        {
          class: `skill ${state} branch-${s.branch}${this.skillFocus === s.id ? ' focus' : ''}`,
          style: `left: ${p.x}%; top: ${p.y}%`,
          onclick: () => {
            this.skillFocus = s.id;
            this.showSkills(owned, chaos, a);
          },
        },
        h('span', { class: 'skill-name' }, s.name),
        h('span', { class: 'skill-desc' }, s.desc),
        h('span', { class: 'skill-cost' }, isOwned ? 'Owned' : `${s.cost} chaos`),
      );
    });
    this.overlay.hidden = false;
    this.overlay.replaceChildren(
      h(
        'div',
        { class: 'panel skills-panel' },
        h(
          'div',
          { class: 'skills-head' },
          h('h2', {}, 'Skill tree'),
          h('div', { class: 'hud-chaos big' }, `${chaos} chaos`),
          h('button', { class: 'btn ghost', onclick: a.close }, 'Done'),
        ),
        h(
          'div',
          { class: 'branch-labels' },
          ...['Arsenal', 'Power', 'Insight', 'Survival'].map((b) => h('span', {}, b)),
        ),
        h('div', { class: 'skill-tree' }, svg, ...nodes),
        this.skillDetail(owned, chaos, a.buy),
      ),
    );
  }

  private skillFocus: SkillId | null = null;

  private skillDetail(owned: ReadonlySet<SkillId>, chaos: number, buy: (id: SkillId) => void): HTMLElement {
    const s = SKILLS.find((x) => x.id === this.skillFocus);
    if (!s) return h('div', { class: 'skill-detail muted' }, 'Tap a skill to see what it does.');
    const missing = s.requires.filter((r) => !owned.has(r)).map((r) => SKILLS.find((x) => x.id === r)!.name);
    const status = owned.has(s.id)
      ? 'Owned'
      : missing.length
        ? `Requires ${missing.join(' and ')}`
        : chaos < s.cost
          ? `Need ${s.cost - chaos} more chaos`
          : '';
    const btn = h('button', { class: 'btn primary', onclick: () => buy(s.id) }, `Buy for ${s.cost}`);
    if (!canBuy(s.id, owned, chaos)) btn.setAttribute('disabled', '');
    return h(
      'div',
      { class: 'skill-detail' },
      h('div', {}, h('b', {}, s.name), h('p', {}, s.desc), status && h('span', { class: 'muted' }, status)),
      !owned.has(s.id) && btn,
    );
  }
}
