// 音（モック仕様 7.5、概要仕様 9.5 の 7）。音はすべてこのモジュールを通す（WebAudio だけ。audio/video 要素は使わない）。
// - 風: 速さで大きく、高い音へ（downhill-3D の src/render/audio.ts の WindAudio を移した）
// - 路面: 舗装はタイヤの低いうなり（低域だけ残した雑音）、未舗装は砂利を踏む音（まばらなはじける音の高域を落としたもの）
// - 2026-11-13: 大きく雑音のように聞こえたので、どれも控えめにした（風は 1/8、路面は低域だけ）
// - 出口は 1 つ（主音量・消音）。音の系統ごとにバスを持ち、後から BGM の系統を足せるようにする
// - 最初の操作で再生を始める（ブラウザの自動再生の制限）
// - 2026-11-14: 近くを通る車の音（低めの雑音の大きさと高さを、近さと速さで変える）

export type Surface = "paved" | "gravel";

export interface SoundState {
  /** 速さ (m/s) */
  speed: number;
  surface: Surface;
  /** 走っている（止まっている・立ち寄り中・一時停止中は false） */
  riding: boolean;
  /** 近くを通る車の音の大きさ 0〜1 */
  traffic?: number;
}

/** 雑音の素材（ブラウン雑音に近い、ゆっくり変わる雑音） */
function noiseBuffer(ctx: AudioContext, seconds: number, smooth: number, gain: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    s = smooth * s + (1 - smooth) * (Math.random() * 2 - 1);
    d[i] = s * gain;
  }
  return buf;
}

/** 砂利: まばらな短いはじける音を並べた素材 */
function gravelBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  const sr = ctx.sampleRate;
  let t = 0;
  while (t < d.length) {
    t += Math.floor(sr * (0.004 + Math.random() * 0.02));
    const len = Math.floor(sr * (0.002 + Math.random() * 0.006));
    const amp = 0.3 + Math.random() * 0.7;
    for (let k = 0; k < len && t + k < d.length; k++) d[t + k] += (Math.random() * 2 - 1) * amp * (1 - k / len);
  }
  return buf;
}

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** 系統ごとの出口（今は環境音だけ。BGM はここに足す） */
  private buses = new Map<string, GainNode>();
  private wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private paved: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private gravel: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private cars: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private wave = new Float32Array(512);
  private volume = 0.3;
  private muted = false;
  /** 使えない環境（AudioContext がない・作れない） */
  failed = false;

  constructor() {
    // 最初の操作で始める
    const kick = () => this.start();
    addEventListener("pointerdown", kick, { passive: true });
    addEventListener("keydown", kick);
  }

  /** 再生を始める（2 回目以降は止まっていれば再開するだけ） */
  start() {
    if (this.failed) return;
    try {
      if (!this.ctx) this.build();
      void this.ctx!.resume().catch(() => undefined);
    } catch {
      this.failed = true;
    }
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.master = ctx.createGain();
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.applyVolume();
    const env = ctx.createGain();
    env.connect(this.master);
    this.buses.set("env", env);
    const loop = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q = 0.7) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(env);
      src.start();
      return { gain, filter };
    };
    this.wind = loop(noiseBuffer(ctx, 3, 0.94, 3), "lowpass", 300);
    this.paved = loop(noiseBuffer(ctx, 2, 0.9, 2), "lowpass", 110, 0.5);
    this.gravel = loop(gravelBuffer(ctx, 2), "lowpass", 1400, 0.5);
    // 車: タイヤと風を切る音（低めの雑音）。近く・速いほど大きく高く
    this.cars = loop(noiseBuffer(ctx, 3, 0.8, 2), "lowpass", 500, 0.6);
  }

  setVolume(volume: number, muted: boolean) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume() {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  /** 毎フレーム呼ぶ */
  update(s: SoundState) {
    const ctx = this.ctx;
    if (!ctx || !this.wind || !this.paved || !this.gravel) return;
    const now = ctx.currentTime;
    const v = s.riding ? s.speed : 0;
    const tc = s.riding ? 0.2 : 0.05;
    // 風: 速いほど大きく高く
    this.wind.gain.gain.setTargetAtTime(Math.min(0.035, v * 0.0012), now, tc);
    this.wind.filter.frequency.setTargetAtTime(180 + v * 12, now, 0.3);
    // 路面
    const roll = Math.min(1, v / 12);
    const onPaved = s.surface === "paved";
    this.paved.gain.gain.setTargetAtTime(onPaved ? 0.025 * roll : 0, now, tc);
    this.paved.filter.frequency.setTargetAtTime(80 + v * 4, now, 0.3);
    this.gravel.gain.gain.setTargetAtTime(onPaved ? 0 : 0.03 * Math.min(1, v / 6), now, tc);
    this.gravel.filter.frequency.setTargetAtTime(1000 + v * 30, now, 0.3);
    if (this.cars) {
      const k = Math.max(0, Math.min(1, s.traffic ?? 0));
      this.cars.gain.gain.setTargetAtTime(0.05 * k, now, 0.15);
      this.cars.filter.frequency.setTargetAtTime(300 + 700 * k, now, 0.2);
    }
  }

  /** 確認用: 鳴っている音の大きさ（RMS）と状態 */
  stats() {
    if (!this.analyser || !this.ctx) return { state: this.failed ? "failed" : "uninitialized", rms: 0, volume: this.volume, muted: this.muted };
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (const x of this.wave) sum += x * x;
    return { state: this.ctx.state, rms: Math.sqrt(sum / this.wave.length), volume: this.volume, muted: this.muted };
  }
}
