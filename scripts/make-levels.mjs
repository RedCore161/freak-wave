// Writes the hand-made opening levels as alpha PNGs (opaque = land).
// Any image editor works too: draw land on a transparent canvas, keep the
// 16:10 aspect ratio and add the file to public/levels/levels.json.
// Run with: npm run levels
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 320;
const H = 200;

const levels = [
  {
    file: 'first-ripple.png',
    name: 'First Ripple',
    land: (x, y) => ellipse(x, y, 205, 95, 22, 16),
  },
  {
    file: 'breakwater.png',
    name: 'The Breakwater',
    land: (x, y) => (Math.abs(y - 100) < 7 && x > 60 && x < 260 && Math.abs(x - 160) > 14) || ellipse(x, y, 60, 100, 9, 9),
  },
  {
    file: 'twin-isles.png',
    name: 'Twin Isles',
    land: (x, y) => ellipse(x, y, 120, 80, 26, 18) || ellipse(x, y, 205, 125, 22, 24) || ellipse(x, y, 250, 55, 8, 6),
  },
];

function ellipse(x, y, cx, cy, rx, ry) {
  // A little wobble keeps coastlines from looking machine-made.
  const a = Math.atan2(y - cy, x - cx);
  const r = 1 + 0.12 * Math.sin(a * 3 + cx) + 0.06 * Math.sin(a * 7 + cy);
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < r * r;
}

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

function png(landFn) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4;
      const isLand = landFn(x, y);
      raw[o + 3] = isLand ? 255 : 0;
    }
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
for (const level of levels) writeFileSync(`public/levels/${level.file}`, png(level.land));
writeFileSync(
  'public/levels/levels.json',
  JSON.stringify(levels.map((l) => ({ name: l.name, image: l.file })), null, 2) + '\n',
);
console.log(`Wrote ${levels.length} levels to public/levels`);
