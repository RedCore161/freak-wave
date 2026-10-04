// All sound is synthesised on the fly with Web Audio; there are no samples.
// The continuous layers are driven by the live simulation: surf noise follows
// overall wave activity, and each city has a voice whose pitch and loudness
// follow how close the water at its shore is to topping the wall.

const PENTATONIC = [196, 233, 262, 311, 349, 392, 466];

interface CityVoice {
  osc: OscillatorNode;
  gain: GainNode;
  base: number;
}

export interface AudioSettings {
  master: number;
  ambience: number;
  effects: number;
  muted: boolean;
}

export class Sonifier {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private ambience!: GainNode;
  /** Effects bus; every one-shot sound connects here. */
  private master!: GainNode;
  private surfGain!: GainNode;
  private surfFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private voices: CityVoice[] = [];
  private settings: AudioSettings;

  constructor(settings: AudioSettings) {
    this.settings = { ...settings };
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  /** Browsers only allow audio after a user gesture; call from one. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.connect(ctx.destination);
    this.out = ctx.createGain();
    this.out.connect(comp);
    this.master = ctx.createGain();
    this.master.connect(this.out);
    this.ambience = ctx.createGain();
    this.ambience.connect(this.out);
    this.applySettings();

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    // Brown-ish noise reads as surf rather than hiss.
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.surfFilter = ctx.createBiquadFilter();
    this.surfFilter.type = 'lowpass';
    this.surfFilter.frequency.value = 300;
    this.surfGain = ctx.createGain();
    this.surfGain.gain.value = 0.05;
    src.connect(this.surfFilter).connect(this.surfGain).connect(this.ambience);
    src.start();
  }

  configure(settings: AudioSettings): void {
    this.settings = { ...settings };
    this.applySettings();
  }

  private applySettings(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.settings;
    const t = ctx.currentTime;
    this.out.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.master.gain.setTargetAtTime(s.effects, t, 0.05);
    this.ambience.gain.setTargetAtTime(s.ambience, t, 0.05);
  }

  /** One voice per city; call when a level loads. */
  setCities(count: number): void {
    const ctx = this.ctx;
    for (const v of this.voices) {
      v.gain.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.1);
      v.osc.stop((ctx?.currentTime ?? 0) + 0.5);
    }
    this.voices = [];
    if (!ctx) return;
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const base = PENTATONIC[(i * 2) % PENTATONIC.length];
      osc.frequency.value = base;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.ambience);
      osc.start();
      this.voices.push({ osc, gain, base });
    }
  }

  /**
   * Per frame. `activity` is the mean wave height across the sea; `cities`
   * gives each city's shoreline height relative to its wall (1 = topping).
   */
  update(activity: number, cities: readonly number[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const a = Math.min(1, activity / 1.2);
    this.surfGain.gain.setTargetAtTime(0.05 + a * 0.5, t, 0.15);
    this.surfFilter.frequency.setTargetAtTime(260 + a * 1800, t, 0.15);
    this.voices.forEach((v, i) => {
      const r = Math.max(0, Math.min(1.5, cities[i] ?? 0));
      v.osc.frequency.setTargetAtTime(v.base * (1 + r * 0.5), t, 0.05);
      v.gain.gain.setTargetAtTime(r > 0.25 ? 0.07 * r * r : 0, t, 0.06);
    });
  }

  quake(size: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(70 / size, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 1.4);
    const g = this.env(t, 0.5 * Math.min(1, size), 0.02, 1.5);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 1.6);
    this.noiseBurst(t, 220, 0.35 * size, 1.1, 'lowpass');
  }

  hit(damage: number, combo: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.noiseBurst(t, 900, Math.min(0.6, 0.15 + damage * 0.08), 0.5, 'bandpass');
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.25);
    thump.connect(this.env(t, 0.45, 0.005, 0.3)).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.35);
    if (combo > 0) {
      // Rising pluck per combo step makes chains audible.
      const pluck = ctx.createOscillator();
      pluck.type = 'triangle';
      pluck.frequency.value = PENTATONIC[Math.min(combo, PENTATONIC.length - 1)] * 2;
      pluck.connect(this.env(t, 0.18, 0.005, 0.4)).connect(this.master);
      pluck.start(t);
      pluck.stop(t + 0.45);
    }
  }

  ruin(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(160, t + 1.8);
    src.connect(f).connect(this.env(t, 0.9, 0.01, 2)).connect(this.master);
    src.start(t);
    src.stop(t + 2.1);
    const boom = ctx.createOscillator();
    boom.frequency.setValueAtTime(60, t);
    boom.frequency.exponentialRampToValueAtTime(30, t + 1.5);
    boom.connect(this.env(t, 0.6, 0.01, 1.6)).connect(this.master);
    boom.start(t);
    boom.stop(t + 1.7);
  }

  blip(freq = 660, length = 0.06, level = 0.12): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(this.env(t, level, 0.003, length)).connect(this.master);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  arpeggio(freqs: readonly number[], step = 0.08, level = 0.14): void {
    const ctx = this.ctx;
    if (!ctx) return;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      osc.connect(this.env(t, level, 0.005, 0.35)).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }

  win(): void {
    this.arpeggio([392, 494, 587, 784, 988]);
  }

  lose(): void {
    this.arpeggio([392, 330, 262, 196], 0.12, 0.12);
  }

  buy(): void {
    this.arpeggio([523, 659, 784, 1046], 0.05);
  }

  private env(t: number, peak: number, attack: number, release: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    return g;
  }

  private noiseBurst(t: number, freq: number, level: number, length: number, type: BiquadFilterType): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    src.connect(f).connect(this.env(t, level, 0.01, length)).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + length + 0.05);
  }
}
