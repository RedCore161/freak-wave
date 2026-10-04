// Renders the auto-balance report as a self-contained HTML page.

export interface ReportData {
  generatedAt: string;
  durationSec: number;
  iterations: { iter: number; attempts: number; finished: boolean; costScale: number; effectScale: number; lift: number; purchasesPerSea: number; offTarget: number }[];
  seas: {
    name: string;
    hpMul: number;
    wallMul: number;
    target: number;
    p0: number;
    p2: number;
    attempts: number;
    firstTry: boolean;
    arrivalT: number;
    clearedT: number | null;
    purchases: string[];
    ownedOnArrival: number;
  }[];
  timeline: { t: number; chaos: number; level: number; passed: boolean }[];
  purchases: { t: number; id: string; name: string; cost: number; level: number }[];
  skills: { id: string; name: string; branch: string; before: number; after: number; delta: number | null }[];
  seeds: { seed: number; attempts: number; finished: boolean }[];
}

export function renderReport(d: ReportData): string {
  const data = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Balance Report</title>
<style>
.viz-root {
  color-scheme: light;
  --surface-0: #f4f3f0;
  --surface-1: #fcfcfb;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #8a8984;
  --grid: #e6e5e0;
  --axis: #c9c8c2;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --target: #c9c8c2;
  --good: #1baf7a;
  --bad: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) .viz-root {
    color-scheme: dark;
    --surface-0: #111110;
    --surface-1: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #8f8e86;
    --grid: #2b2b29;
    --axis: #45443f;
    --series-1: #3987e5;
    --series-2: #d95926;
    --target: #55544f;
    --good: #199e70;
    --bad: #e66767;
  }
}
:root[data-theme="dark"] .viz-root {
  color-scheme: dark;
  --surface-0: #111110;
  --surface-1: #1a1a19;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #8f8e86;
  --grid: #2b2b29;
  --axis: #45443f;
  --series-1: #3987e5;
  --series-2: #d95926;
  --target: #55544f;
  --good: #199e70;
  --bad: #e66767;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body.viz-root { background: var(--surface-0); color: var(--text-primary); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 2px; }
.sub { color: var(--text-secondary); margin: 0 0 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile, .card { background: var(--surface-1); border-radius: 12px; padding: 14px 16px; }
.tile b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.tile span { color: var(--text-secondary); font-size: 12px; }
.card { margin-bottom: 16px; }
.card p { color: var(--text-secondary); margin: 0 0 10px; font-size: 13px; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); margin: 4px 0 8px; flex-wrap: wrap; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.legend i.band { border-radius: 2px; width: 14px; height: 6px; }
.tip { position: absolute; pointer-events: none; background: var(--surface-0); border: 1px solid var(--axis); border-radius: 8px; padding: 6px 9px; font-size: 12px; white-space: nowrap; opacity: 0; transition: opacity 0.1s; z-index: 2; }
.tip b { font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
th { color: var(--text-secondary); font-weight: 600; }
td.num, th.num { text-align: right; }
.ok { color: var(--good); }
.off { color: var(--bad); }
.scroll { overflow-x: auto; }
details summary { cursor: pointer; color: var(--text-secondary); margin-top: 8px; }
</style>
</head>
<body class="viz-root">
<main>
  <h1>Balance Report</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>

  <section class="card">
    <h2>Chaos banked over the campaign</h2>
    <p>A fresh simulated player, attempt by attempt. Drops are skill purchases; vertical lines mark seas cleared.</p>
    <div class="chart" id="chaos"></div>
  </section>

  <section class="card">
    <h2>Sea reached over the campaign</h2>
    <p>Flat stretches are seas that took several attempts or runs.</p>
    <div class="chart" id="progress"></div>
  </section>

  <section class="card">
    <h2>Win chance per attempt, by sea</h2>
    <p>On arrival (skills the player owns when first reaching the sea) and after buying the two most helpful skills available next. Gray ticks are the on-arrival target.</p>
    <div class="legend"><span><i style="background:var(--series-1)"></i>On arrival</span><span><i style="background:var(--series-2)"></i>After 2 more upgrades</span><span><i class="band" style="background:var(--target)"></i>Arrival target</span></div>
    <div class="chart" id="winrate"></div>
  </section>

  <section class="card">
    <h2>Attempts needed per sea</h2>
    <div class="chart" id="attempts"></div>
  </section>

  <section class="card scroll">
    <h2>Seas</h2>
    <table id="seaTable"></table>
  </section>

  <section class="card scroll">
    <h2>Skills</h2>
    <p>Δ win chance is measured on a mid-campaign sea with the arrival loadout (prerequisites included). Costs were nudged toward value per chaos.</p>
    <table id="skillTable"></table>
  </section>

  <section class="card scroll">
    <h2>Tuning iterations</h2>
    <table id="iterTable"></table>
  </section>
</main>
<script>
const D = ${data};
const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const fmt = (v, d = 0) => Number(v).toFixed(d);
const pct = (v) => Math.round(v * 100) + '%';

document.getElementById('sub').textContent =
  'Generated ' + D.generatedAt + ' · ' + D.iterations.length + ' tuning iterations · ' + fmt(D.durationSec) + ' s';
const cleared = D.seas.filter((s) => s.clearedT !== null).length;
const first = D.seas.filter((s) => s.firstTry).length;
const tiles = [
  [D.timeline.length, 'attempts to finish'],
  [cleared + ' / ' + D.seas.length, 'seas cleared'],
  [first, 'seas cleared first try'],
  [D.purchases.length, 'skills bought'],
  [Math.max(0, ...D.timeline.map((p) => p.chaos)) | 0, 'peak chaos banked'],
];
document.getElementById('tiles').innerHTML = tiles.map(([v, l]) => '<div class="tile"><b>' + v + '</b><span>' + l + '</span></div>').join('');

/** Frame with a y-axis, recessive grid and x labels; returns scales. */
function frame(host, { w = 960, h = 260, xMax, yMax, yTicks, yFmt, xLabel, xTicks }) {
  const m = { l: 44, r: 16, t: 12, b: 30 };
  const svg = el('svg', { viewBox: '0 0 ' + w + ' ' + h, role: 'img' }, host);
  const x = (v) => m.l + (v / xMax) * (w - m.l - m.r);
  const y = (v) => h - m.b - (v / yMax) * (h - m.t - m.b);
  for (const t of yTicks) {
    el('line', { x1: m.l, x2: w - m.r, y1: y(t), y2: y(t), stroke: css('--grid') }, svg);
    const lab = el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: css('--text-muted') }, svg);
    lab.textContent = yFmt(t);
  }
  el('line', { x1: m.l, x2: w - m.r, y1: y(0), y2: y(0), stroke: css('--axis') }, svg);
  for (const t of xTicks) {
    const lab = el('text', { x: x(t.v), y: h - m.b + 18, 'text-anchor': 'middle', 'font-size': 11, fill: css('--text-muted') }, svg);
    lab.textContent = t.label;
  }
  if (xLabel) {
    const lab = el('text', { x: w - m.r, y: h - 2, 'text-anchor': 'end', 'font-size': 11, fill: css('--text-muted') }, svg);
    lab.textContent = xLabel;
  }
  return { svg, x, y, m, w, h };
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
  return Math.ceil(v / p) * p;
}

function tipFor(host) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  host.appendChild(tip);
  return tip;
}

/** Line chart over attempts with a crosshair tooltip. */
function lineChart(id, values, opts) {
  const host = document.getElementById(id);
  const xMax = Math.max(1, values.length);
  const yMax = opts.yMax ?? niceMax(Math.max(1, ...values.map((p) => p.v)));
  const yTicks = opts.yTicks ?? [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax];
  const step = Math.max(1, Math.round(xMax / 8 / 10) * 10);
  const xTicks = [];
  for (let t = 0; t <= xMax; t += step) xTicks.push({ v: t, label: String(t) });
  const f = frame(host, { xMax, yMax, yTicks, yFmt: opts.yFmt, xLabel: 'attempt', xTicks });
  for (const s of D.seas) {
    if (s.clearedT === null) continue;
    el('line', { x1: f.x(s.clearedT), x2: f.x(s.clearedT), y1: f.m.t, y2: f.y(0), stroke: css('--grid'), 'stroke-dasharray': '3 3' }, f.svg);
  }
  let d = '';
  values.forEach((p, i) => (d += (i ? (opts.step ? 'H' + f.x(p.t) + 'V' : 'L' + f.x(p.t) + ',') : 'M' + f.x(p.t) + ',') + f.y(p.v)));
  el('path', { d, fill: 'none', stroke: css('--series-1'), 'stroke-width': 2, 'stroke-linejoin': 'round' }, f.svg);
  const cross = el('line', { y1: f.m.t, y2: f.y(0), stroke: css('--axis'), opacity: 0 }, f.svg);
  const dot = el('circle', { r: 4.5, fill: css('--series-1'), stroke: css('--surface-1'), 'stroke-width': 2, opacity: 0 }, f.svg);
  const tip = tipFor(host);
  const hit = el('rect', { x: f.m.l, y: f.m.t, width: f.w - f.m.l - f.m.r, height: f.h - f.m.t - f.m.b, fill: 'transparent' }, f.svg);
  hit.addEventListener('pointermove', (e) => {
    const r = f.svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * f.w;
    const t = Math.round(((sx - f.m.l) / (f.w - f.m.l - f.m.r)) * xMax);
    const p = values[Math.max(0, Math.min(values.length - 1, t - 1))];
    if (!p) return;
    cross.setAttribute('x1', f.x(p.t));
    cross.setAttribute('x2', f.x(p.t));
    cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', f.x(p.t));
    dot.setAttribute('cy', f.y(p.v));
    dot.setAttribute('opacity', 1);
    tip.innerHTML = opts.tip(p);
    tip.style.opacity = 1;
    const px = (f.x(p.t) / f.w) * r.width;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 4, px + 12) + 'px';
    tip.style.top = (f.y(p.v) / f.h) * r.height - 40 + 'px';
  });
  hit.addEventListener('pointerleave', () => {
    tip.style.opacity = 0;
    cross.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
  });
}

const boughtAt = new Map();
for (const p of D.purchases) boughtAt.set(p.t, [...(boughtAt.get(p.t) ?? []), p.name]);
const seaName = (i) => (D.seas[i] ? D.seas[i].name : 'Sea ' + (i + 1));

lineChart(
  'chaos',
  D.timeline.map((p) => ({ t: p.t, v: p.chaos, level: p.level, passed: p.passed })),
  {
    yFmt: (v) => fmt(v),
    tip: (p) =>
      'Attempt <b>' + p.t + '</b> · ' + seaName(p.level) + (p.passed ? ' <span class="ok">cleared</span>' : '') +
      '<br>Chaos <b>' + fmt(p.v) + '</b>' + (boughtAt.get(p.t) ? '<br>Bought next: ' + boughtAt.get(p.t).join(', ') : ''),
  },
);

lineChart(
  'progress',
  D.timeline.map((p) => ({ t: p.t, v: p.level + (p.passed ? 1 : 0), level: p.level })),
  {
    step: true,
    yMax: D.seas.length,
    yTicks: Array.from({ length: Math.floor(D.seas.length / 2) + 1 }, (_, i) => i * 2),
    yFmt: (v) => 'Sea ' + (v + (v < D.seas.length ? 1 : 0)),
    tip: (p) => 'Attempt <b>' + p.t + '</b><br>Playing ' + seaName(p.level),
  },
);

// Win chance per sea: two series of dots plus target ticks, one axis (0-100%).
(function () {
  const host = document.getElementById('winrate');
  const n = D.seas.length;
  const f = frame(host, {
    xMax: n,
    yMax: 1,
    yTicks: [0, 0.25, 0.5, 0.75, 1],
    yFmt: pct,
    xTicks: D.seas.map((s, i) => ({ v: i + 0.5, label: String(i + 1) })),
  });
  const tip = tipFor(host);
  D.seas.forEach((s, i) => {
    const cx = f.x(i + 0.5);
    el('rect', { x: cx - 14, y: f.y(s.target) - 1.5, width: 28, height: 3, rx: 1.5, fill: css('--target') }, f.svg);
    el('line', { x1: cx, x2: cx, y1: f.y(s.p0), y2: f.y(s.p2), stroke: css('--axis'), 'stroke-width': 2 }, f.svg);
    for (const [v, c] of [[s.p0, '--series-1'], [s.p2, '--series-2']]) {
      el('circle', { cx, cy: f.y(v), r: 5, fill: css(c), stroke: css('--surface-1'), 'stroke-width': 2 }, f.svg);
    }
    const hit = el('rect', { x: cx - 20, y: f.m.t, width: 40, height: f.h - f.m.t - f.m.b, fill: 'transparent' }, f.svg);
    hit.addEventListener('pointerenter', () => {
      tip.innerHTML = '<b>' + (i + 1) + '. ' + s.name + '</b><br>On arrival <b>' + pct(s.p0) + '</b> (target ' + pct(s.target) + ')<br>After 2 upgrades <b>' + pct(s.p2) + '</b>';
      tip.style.opacity = 1;
      const r = f.svg.getBoundingClientRect();
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, (cx / f.w) * r.width + 14) + 'px';
      tip.style.top = (f.y(Math.max(s.p0, s.p2)) / f.h) * r.height - 30 + 'px';
    });
    hit.addEventListener('pointerleave', () => (tip.style.opacity = 0));
  });
  // Direct labels on the last sea.
  const last = D.seas[n - 1];
  if (last) {
    for (const [v, txt] of [[last.p0, 'arrival'], [last.p2, '+2']]) {
      const t = el('text', { x: f.x(n - 0.5) + 10, y: f.y(v) + 4, 'font-size': 11, fill: css('--text-secondary') }, f.svg);
      t.textContent = txt;
    }
  }
})();

// Attempts per sea: bars.
(function () {
  const host = document.getElementById('attempts');
  const n = D.seas.length;
  const yMax = niceMax(Math.max(3, ...D.seas.map((s) => s.attempts)));
  const f = frame(host, {
    h: 200,
    xMax: n,
    yMax,
    yTicks: [0, yMax / 2, yMax],
    yFmt: (v) => fmt(v),
    xTicks: D.seas.map((s, i) => ({ v: i + 0.5, label: String(i + 1) })),
  });
  const tip = tipFor(host);
  const bw = Math.min(36, (f.w - f.m.l - f.m.r) / n - 6);
  D.seas.forEach((s, i) => {
    const x = f.x(i + 0.5) - bw / 2;
    const top = f.y(s.attempts);
    const hgt = f.y(0) - top;
    el('path', { d: 'M' + x + ',' + f.y(0) + 'V' + (top + 4) + 'q0,-4 4,-4H' + (x + bw - 4) + 'q4,0 4,4V' + f.y(0) + 'Z', fill: css('--series-1') }, f.svg);
    if (hgt > 16) {
      const t = el('text', { x: x + bw / 2, y: top - 4, 'text-anchor': 'middle', 'font-size': 11, fill: css('--text-secondary') }, f.svg);
      t.textContent = s.attempts;
    }
    const hit = el('rect', { x: x - 3, y: f.m.t, width: bw + 6, height: f.h - f.m.t - f.m.b, fill: 'transparent' }, f.svg);
    hit.addEventListener('pointerenter', () => {
      tip.innerHTML = '<b>' + (i + 1) + '. ' + s.name + '</b><br>' + s.attempts + ' attempts' + (s.firstTry ? ' (first try)' : '') + '<br>' + s.ownedOnArrival + ' skills on arrival';
      tip.style.opacity = 1;
      const r = f.svg.getBoundingClientRect();
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, ((x + bw) / f.w) * r.width + 8) + 'px';
      tip.style.top = (top / f.h) * r.height - 10 + 'px';
    });
    hit.addEventListener('pointerleave', () => (tip.style.opacity = 0));
  });
})();

const within = (s) => Math.abs(s.p0 - s.target) <= 0.12;
document.getElementById('seaTable').innerHTML =
  '<tr><th>#</th><th>Sea</th><th class="num">hp ×</th><th class="num">wall ×</th><th class="num">Arrival</th><th class="num">Target</th><th class="num">+2 upgrades</th><th class="num">Attempts</th><th class="num">Skills on arrival</th><th>Bought while here</th></tr>' +
  D.seas.map((s, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + s.name + '</td><td class="num">' + fmt(s.hpMul, 2) + '</td><td class="num">' + fmt(s.wallMul, 2) +
    '</td><td class="num ' + (within(s) ? 'ok' : 'off') + '">' + pct(s.p0) + '</td><td class="num">' + pct(s.target) +
    '</td><td class="num ' + (s.p2 >= 0.55 ? 'ok' : 'off') + '">' + pct(s.p2) + '</td><td class="num">' + s.attempts +
    '</td><td class="num">' + s.ownedOnArrival + '</td><td>' + (s.purchases.join(', ') || '-') + '</td></tr>').join('');

document.getElementById('skillTable').innerHTML =
  '<tr><th>Skill</th><th>Branch</th><th class="num">Cost before</th><th class="num">Cost after</th><th class="num">Δ win chance</th><th class="num">Bought at attempt</th></tr>' +
  D.skills.map((s) => {
    const p = D.purchases.find((q) => q.id === s.id);
    return '<tr><td>' + s.name + '</td><td>' + s.branch + '</td><td class="num">' + s.before + '</td><td class="num">' + s.after +
      '</td><td class="num">' + (s.delta === null ? '-' : (s.delta >= 0 ? '+' : '') + Math.round(s.delta * 100) + ' pts') +
      '</td><td class="num">' + (p ? p.t + ' (sea ' + (p.level + 1) + ')' : '-') + '</td></tr>';
  }).join('');

document.getElementById('iterTable').innerHTML =
  '<tr><th>Iteration</th><th class="num">Attempts</th><th>Finished</th><th class="num">Cost scale</th><th class="num">Effect scale</th><th class="num">Lift from 2 upgrades</th><th class="num">Skills per sea</th><th class="num">Seas off target</th></tr>' +
  D.iterations.map((it) =>
    '<tr><td>' + it.iter + '</td><td class="num">' + it.attempts + '</td><td>' + (it.finished ? 'yes' : 'no') + '</td><td class="num">' + fmt(it.costScale, 2) +
    '</td><td class="num">' + fmt(it.effectScale, 2) + '</td><td class="num">' + Math.round(it.lift * 100) + ' pts</td><td class="num">' + fmt(it.purchasesPerSea, 1) + '</td><td class="num">' + it.offTarget + '</td></tr>').join('') +
  '<tr><td colspan="8" style="color:var(--text-secondary)">Final check over ' + D.seeds.length + ' seeds: ' +
  D.seeds.map((s) => s.attempts + (s.finished ? '' : ' (unfinished)')).join(', ') + ' attempts</td></tr>';
</script>
</body>
</html>
`;
}
