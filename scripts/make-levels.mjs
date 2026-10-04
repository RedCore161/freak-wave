// Writes the hand-made campaign maps as RGBA PNGs plus levels.json.
//
// Map legend (any image editor works; keep a 16:10 aspect ratio):
//   transparent        water
//   any opaque colour  land
//   #FF0000 red        city level 1 (paint a dot on the coast)
//   #FF8000 orange     city level 2
//   #FF00FF magenta    city level 3
//   #00FF00 green      epicenter (a filled disc; its size is the radius)
//   #FFFF00 yellow     golden chaos ring (a small dot)
// Keep features ~24 px away from the edges: the border is open ocean.
// Run with: npm run levels
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 320;
const H = 200;

const LAND = [52, 64, 48];
const CITY = { 1: [255, 0, 0], 2: [255, 128, 0], 3: [255, 0, 255] };
const SPAWN = [0, 255, 0];
const ZONE = [255, 255, 0];

// ---------------------------------------------------------------- shapes

const wobble = (x, y, cx, cy, seed) => {
  const a = Math.atan2(y - cy, x - cx);
  return 1 + 0.08 * Math.sin(a * 3 + seed) + 0.04 * Math.sin(a * 7 + seed * 2);
};
const ellipse = (cx, cy, rx, ry, seed = cx) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < wobble(x, y, cx, cy, seed) ** 2;
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const ring = (cx, cy, r0, r1, gapAngle, gapWidth) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  if (d < r0 || d > r1) return false;
  const a = Math.atan2(y - cy, x - cx);
  const diff = Math.abs(Math.atan2(Math.sin(a - gapAngle), Math.cos(a - gapAngle)));
  return diff > gapWidth;
};
const union = (...fs) => (x, y) => fs.some((f) => f(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);

// ---------------------------------------------------------------- campaign

const levels = [
  {
    file: '01-first-ripple.png',
    name: 'First Ripple',
    hint: 'The far epicenter needs a head start: give the near quake a delay so both crests arrive together.',
    quakes: ['small', 'small'],
    land: ellipse(205, 100, 34, 26, 1),
    cities: [[172, 100, 1]],
    spawns: [[70, 58, 18], [62, 160, 16]],
    zones: [],
  },
  {
    file: '02-long-shore.png',
    name: 'The Long Shore',
    hint: 'Big distance differences need big delays. Drag the near quake far along the timeline.',
    quakes: ['small', 'medium'],
    land: union(rect(250, 20, 320, 180), ellipse(252, 100, 12, 40, 4)),
    cities: [[241, 100, 1]],
    spawns: [[56, 44, 18], [150, 160, 16]],
    zones: [[150, 92]],
  },
  {
    file: '03-breakwater.png',
    name: 'The Breakwater',
    hint: 'The wall blocks everything except the gap. Waves spread out again behind it.',
    quakes: ['small', 'medium'],
    land: union(minus(rect(40, 95, 280, 105), rect(150, 90, 172, 110)), rect(100, 165, 220, 200)),
    cities: [[160, 164, 1]],
    spawns: [[118, 40, 16], [214, 54, 16]],
    zones: [[161, 72]],
  },
  {
    file: '04-harbor-echo.png',
    name: 'Harbor Echo',
    hint: 'The harbor walls funnel and reflect waves toward the city at its far end.',
    quakes: ['small', 'medium', 'medium'],
    land: minus(union(rect(215, 20, 320, 180), ellipse(218, 100, 10, 70, 2)), rect(205, 86, 272, 114)),
    cities: [[273, 100, 2]],
    spawns: [[60, 48, 18], [86, 158, 18], [150, 34, 14]],
    zones: [[150, 100]],
  },
  {
    file: '05-twin-towns.png',
    name: 'Twin Towns',
    hint: 'Two cities, two plans. Some quakes can serve both if you time them well.',
    quakes: ['small', 'medium', 'small', 'medium'],
    land: union(ellipse(75, 110, 30, 36, 5), ellipse(245, 90, 28, 40, 6)),
    cities: [[104, 110, 1], [218, 90, 1]],
    spawns: [[150, 32, 16], [176, 168, 16]],
    zones: [],
  },
  {
    file: '06-scattered-isles.png',
    name: 'Scattered Isles',
    hint: 'Small islands cast shadows and scatter waves. Look for clear lanes.',
    quakes: ['small', 'medium', 'medium'],
    land: union(
      ellipse(92, 62, 12, 9, 1),
      ellipse(128, 140, 14, 10, 2),
      ellipse(172, 70, 10, 12, 3),
      ellipse(198, 132, 11, 8, 4),
      ellipse(116, 100, 8, 8, 5),
      ellipse(252, 100, 24, 22, 6),
    ),
    cities: [[228, 100, 2]],
    spawns: [[42, 42, 15], [44, 158, 15], [160, 36, 13]],
    zones: [[160, 104]],
  },
  {
    file: '07-the-strait.png',
    name: 'The Strait',
    hint: 'A narrow channel guides waves between the two coasts.',
    quakes: ['small', 'medium', 'medium', 'small'],
    land: union(rect(100, 20, 220, 80), rect(100, 120, 220, 182)),
    cities: [[160, 79, 1], [205, 121, 1]],
    spawns: [[44, 100, 16], [282, 100, 14], [58, 40, 13]],
    zones: [[160, 100]],
  },
  {
    file: '08-lighthouse.png',
    name: 'Lighthouse',
    hint: 'Symmetric epicenters arrive together. The odd one out needs the delay.',
    quakes: ['medium', 'medium', 'small'],
    land: ellipse(160, 100, 26, 22, 3),
    cities: [[160, 79, 2]],
    spawns: [[52, 46, 14], [268, 46, 14], [56, 156, 14], [264, 156, 14]],
    zones: [[160, 160]],
  },
  {
    file: '09-crescent-lagoon.png',
    name: 'Crescent Lagoon',
    hint: 'The lagoon opens to the east. Waves from the west must find a way around.',
    quakes: ['medium', 'medium', 'small'],
    land: minus(ellipse(170, 100, 72, 62, 0.5), ellipse(197, 100, 60, 48, 0.5)),
    cities: [[136, 100, 2]],
    spawns: [[282, 58, 14], [282, 146, 14], [40, 100, 16]],
    zones: [[270, 100]],
  },
  {
    file: '10-fjord.png',
    name: 'The Fjord',
    hint: 'Only waves that enter the fjord mouth reach the city. Chain crests for combos.',
    quakes: ['medium', 'medium', 'small', 'small'],
    land: minus(union(rect(24, 110, 232, 200), rect(0, 24, 90, 200)), rect(110, 128, 240, 156)),
    cities: [[109, 142, 3]],
    spawns: [[282, 142, 14], [200, 58, 16], [128, 46, 14]],
    zones: [[260, 100]],
  },
  {
    file: '11-three-crowns.png',
    name: 'Three Crowns',
    hint: 'Three cities, three timings. Plan one at a time, then check for overlap.',
    quakes: ['small', 'medium', 'medium', 'medium', 'small', 'small', 'medium'],
    land: union(ellipse(72, 58, 22, 16, 1), ellipse(160, 145, 34, 22, 2), ellipse(248, 58, 22, 16, 3)),
    cities: [[72, 74, 1], [160, 123, 2], [248, 74, 1]],
    spawns: [[160, 38, 16], [40, 150, 14], [284, 150, 14]],
    zones: [[160, 84]],
  },
  {
    file: '12-maelstrom.png',
    name: 'Maelstrom',
    hint: 'The ring opens to the east. Everything that gets inside echoes around.',
    quakes: ['medium', 'medium', 'medium', 'small'],
    land: ring(160, 100, 45, 68, 0, 0.35),
    cities: [[114, 100, 3]],
    spawns: [[42, 40, 14], [42, 160, 14], [284, 100, 14]],
    zones: [[160, 100]],
  },
];

// ---------------------------------------------------------------- PNG

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function render(level) {
  const px = new Uint8Array(W * H * 4);
  const paint = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    px[o] = rgb[0];
    px[o + 1] = rgb[1];
    px[o + 2] = rgb[2];
    px[o + 3] = 255;
  };
  const disc = (cx, cy, r, rgb) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if (Math.hypot(x - cx, y - cy) <= r) paint(x, y, rgb);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (level.land(x + 0.5, y + 0.5)) paint(x, y, LAND);
  for (const [x, y, r] of level.spawns) disc(x, y, r, SPAWN);
  for (const [x, y] of level.zones) disc(x, y, 2, ZONE);
  for (const [x, y, lvl] of level.cities) disc(x, y, 2.5, CITY[lvl]);
  return px;
}

function png(px) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/levels', { recursive: true });
for (const level of levels) writeFileSync(`public/levels/${level.file}`, png(render(level)));
writeFileSync(
  'public/levels/levels.json',
  JSON.stringify(
    levels.map((l) => ({ name: l.name, image: l.file, quakes: l.quakes, hint: l.hint })),
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${levels.length} levels to public/levels`);
