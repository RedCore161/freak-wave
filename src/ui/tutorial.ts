// Tutorial slides with small animated SVG illustrations. Colours match the
// game: green epicenters, quake gems, cyan-to-red wave heights.

export interface Slide {
  title: string;
  body: string;
  svg: string;
}

const SEA = '<rect width="240" height="140" rx="14" fill="#0b2a4a"/>';
const ISLAND = (x: number, y: number, rx: number, ry: number) =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#7fb069" stroke="#e8d6a5" stroke-width="3"/>`;
const CITY = (x: number, y: number) =>
  `<g transform="translate(${x} ${y})"><rect x="-9" y="-12" width="6" height="12" fill="#f2efe6"/><rect x="-2" y="-18" width="6" height="18" fill="#e06d4f"/><rect x="5" y="-9" width="6" height="9" fill="#f2efe6"/></g>`;
const GEM = (x: number, y: number, color: string, cls = '') =>
  `<rect class="${cls}" x="${x - 6}" y="${y - 6}" width="12" height="12" rx="2" fill="${color}" transform="rotate(45 ${x} ${y})"/>`;
const RINGS = (x: number, y: number, color: string, delay = 0) =>
  [0, 0.6, 1.2]
    .map(
      (d) =>
        `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${color}" stroke-width="2.5" class="tut-ring" style="animation-delay:${d + delay}s"/>`,
    )
    .join('');

export const TUTORIAL_SLIDES: Slide[] = [
  {
    title: 'Use the green epicenters',
    body: 'Pick a quake in the tray and tap the sea. Inside a green circle a quake has full power; the further outside, the weaker it gets. Never too close to a city.',
    svg: `${SEA}
      <circle cx="80" cy="72" r="38" fill="#5dff9a" fill-opacity=".12" stroke="#5dff9a" stroke-width="3"/>
      ${GEM(80, 72, '#7fd4ff', 'tut-pop')}
      <circle cx="80" cy="72" r="14" fill="none" stroke="#fff" stroke-width="2" class="tut-tap"/>
      <path d="M150 100 l18 -10 l-4 18 z" fill="#fff" opacity=".9" class="tut-finger"/>
      ${ISLAND(196, 50, 26, 18)}${CITY(186, 42)}`,
  },
  {
    title: 'Three quakes per sea',
    body: 'You can place at most three quakes. Spare quakes are not wasted: merge three of a kind into one of the next size, Tremors into a Quake, Quakes into a Megaquake.',
    svg: `${SEA}
      ${GEM(44, 50, '#7fd4ff')}${GEM(70, 50, '#7fd4ff')}${GEM(96, 50, '#7fd4ff')}
      <path d="M120 50 h26 m-8 -7 l8 7 l-8 7" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>
      <rect x="166" y="36" width="28" height="28" rx="4" fill="#ffd166" transform="rotate(45 180 50)" class="tut-pop"/>
      <g transform="translate(66 104)">
        <circle cx="0" cy="0" r="7" fill="#5ee6d2"/><circle cx="24" cy="0" r="7" fill="#5ee6d2"/><circle cx="48" cy="0" r="7" fill="none" stroke="#8aa6bf" stroke-width="2"/>
      </g>
      <text x="136" y="109" fill="#8aa6bf" font-size="12">2 of 3 placed</text>`,
  },
  {
    title: 'Waves travel and fade',
    body: 'Every quake sends out a short train of waves. They bounce off coasts, bend around islands, and get weaker with distance.',
    svg: `${SEA}
      ${GEM(48, 70, '#ffd166')}${RINGS(48, 70, '#19c3c9')}
      ${ISLAND(196, 70, 24, 34)}${CITY(178, 66)}`,
  },
  {
    title: 'Time the crests',
    body: 'Drag each quake along the timeline to delay it. The marks under each city show when the crests arrive. Line them up so the waves stack.',
    svg: `${SEA}
      <text x="16" y="36" fill="#8aa6bf" font-size="11">Fire</text>
      <rect x="54" y="24" width="170" height="18" rx="5" fill="#ffffff10"/>
      ${GEM(66, 33, '#7fd4ff')}${GEM(150, 33, '#ffd166', 'tut-slide')}
      <text x="16" y="82" fill="#8aa6bf" font-size="11">City</text>
      <rect x="54" y="70" width="170" height="16" rx="5" fill="#ffffff08"/>
      <rect x="170" y="72" width="4" height="12" rx="2" fill="#7fd4ff"/>
      <rect x="150" y="72" width="4" height="12" rx="2" fill="#ffd166" class="tut-tick"/>
      <text x="138" y="116" fill="#ffe14d" font-size="13" font-weight="700" class="tut-together">together!</text>`,
  },
  {
    title: 'Top the sea wall',
    body: 'A crest that rises above a city’s wall deals damage equal to the overflow. Crests that hit back to back build a combo.',
    svg: `${SEA}
      <rect x="150" y="54" width="10" height="60" fill="#9a9a8e"/>
      ${CITY(186, 114)}<rect x="160" y="114" width="70" height="12" fill="#7fb069"/>
      <line x1="20" y1="54" x2="160" y2="54" stroke="#fff" stroke-dasharray="4 4" stroke-width="1.5"/>
      <text x="22" y="48" fill="#fff" font-size="10">wall</text>
      <path d="M10 112 C40 112 60 112 80 100 S120 30 140 40 S150 100 150 112 Z" fill="#ff8a2a" class="tut-wave"/>
      <path d="M118 54 C124 38 134 34 140 40 C146 46 148 52 150 54 Z" fill="#ff2d3a"/>
      <text x="60" y="30" fill="#ffe14d" font-size="12" font-weight="700">overflow = damage</text>`,
  },
  {
    title: 'Ruin the coast, earn chaos',
    body: 'Ruin every city within 3 attempts. Your quakes stay put between attempts. Spend chaos in the skill tree to unlock new quakes and tools.',
    svg: `${SEA}
      ${ISLAND(70, 80, 34, 24)}
      <g class="tut-ruin">${CITY(64, 74)}</g>
      <g transform="translate(140 40)">
        <rect width="16" height="16" rx="3" fill="#5ee6d2" transform="rotate(45 8 8)"/>
        <rect x="26" width="16" height="16" rx="3" fill="#5ee6d2" transform="rotate(45 34 8)"/>
        <rect x="52" width="16" height="16" rx="3" fill="none" stroke="#8aa6bf" stroke-width="2" transform="rotate(45 60 8)"/>
      </g>
      <text x="140" y="100" fill="#ffe14d" font-size="16" font-weight="700">+42 chaos</text>`,
  },
];
