// トレーナーの入力元（トレーナー連携の草案 3.1）。モック 6.1【固定】の PowerSource の 3 つ目の実装。
// 機器から最後に受けた出力を返す。3 秒受けなければ 0（惰性で進む）。ブレーキは画面・キーの入力。

import type { PowerSource } from "../power.ts";

/** 出力の通知が途切れたとみなすまでの時間 (ms)【初期値】 */
export const SIGNAL_TIMEOUT_MS = 3000;
/** 画面に出す出力の平均の幅 (ms)【初期値】 */
export const DISPLAY_AVERAGE_MS = 3000;

export class TrainerPower implements PowerSource {
  brake = 0;
  private last = 0;
  private at = -Infinity;
  private samples: { t: number; w: number }[] = [];

  constructor(private now: () => number) {}

  /** 機器から出力を受けた */
  feed(watts: number, t = this.now()) {
    const w = Math.max(0, Math.min(3000, watts));
    this.last = w;
    this.at = t;
    this.samples.push({ t, w });
    while (this.samples.length && this.samples[0].t < t - DISPLAY_AVERAGE_MS) this.samples.shift();
  }

  /** 出力の通知が来ているか */
  get signal(): boolean {
    return this.now() - this.at < SIGNAL_TIMEOUT_MS;
  }

  /** 最後に受けた出力 (W)。途切れていれば 0 */
  get watts(): number {
    return this.signal ? this.last : 0;
  }

  /** 画面に出す出力: 3 秒の平均 (W) */
  get average(): number {
    if (!this.signal) return 0;
    const t0 = this.now() - DISPLAY_AVERAGE_MS;
    let sum = 0;
    let n = 0;
    for (const s of this.samples)
      if (s.t >= t0) {
        sum += s.w;
        n++;
      }
    return n ? sum / n : 0;
  }

  read(): { watts: number; brake: number } {
    return { watts: this.brake > 0 ? 0 : this.watts, brake: this.brake };
  }

  reset() {
    this.last = 0;
    this.at = -Infinity;
    this.samples = [];
  }
}
