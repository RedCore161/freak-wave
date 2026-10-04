// Wave height (metres) to colour. Stops tuned so calm water reads as deep
// blue, a single wave as cyan, combined waves as yellow and freak waves red.
const STOPS: [number, number, number, number][] = [
  [0, 0x0a, 0x24, 0x44],
  [1.2, 0x0e, 0x4c, 0x7c],
  [3, 0x17, 0xa7, 0xc4],
  [5, 0x5e, 0xe6, 0xd2],
  [7.5, 0xff, 0xe1, 0x4d],
  [10, 0xff, 0x8a, 0x2a],
  [13, 0xff, 0x2d, 0x3a],
  [17, 0xff, 0xd0, 0xd8],
];

export const RAMP_MAX = 17;
const LUT_SIZE = 256;
const LUT = new Float32Array(LUT_SIZE * 3);

for (let k = 0; k < LUT_SIZE; k++) {
  const h = (k / (LUT_SIZE - 1)) * RAMP_MAX;
  let s = 0;
  while (s < STOPS.length - 2 && STOPS[s + 1][0] < h) s++;
  const [h0, r0, g0, b0] = STOPS[s];
  const [h1, r1, g1, b1] = STOPS[s + 1];
  const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  LUT[k * 3] = (r0 + (r1 - r0) * t) / 255;
  LUT[k * 3 + 1] = (g0 + (g1 - g0) * t) / 255;
  LUT[k * 3 + 2] = (b0 + (b1 - b0) * t) / 255;
}

/** Writes the colour for height h into out[o..o+2]. */
export function rampInto(h: number, out: Float32Array, o: number): void {
  let k = Math.round((h / RAMP_MAX) * (LUT_SIZE - 1));
  if (k < 0) k = 0;
  else if (k >= LUT_SIZE) k = LUT_SIZE - 1;
  out[o] = LUT[k * 3];
  out[o + 1] = LUT[k * 3 + 1];
  out[o + 2] = LUT[k * 3 + 2];
}

export function rampCss(h: number): string {
  const tmp = new Float32Array(3);
  rampInto(h, tmp, 0);
  return `rgb(${Math.round(tmp[0] * 255)}, ${Math.round(tmp[1] * 255)}, ${Math.round(tmp[2] * 255)})`;
}
