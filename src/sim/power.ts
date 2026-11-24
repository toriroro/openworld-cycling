// 推進力の入力元（モック仕様 6.1【固定】）。トレーナーは後でこの形に合わせて足す。

import { type Pace, paceWatts } from "../shared/stamina.ts";

export interface PowerSource {
  read(dt: number): { watts: number; brake: number };
}

/**
 * 手動: 押している間は設定した出力。押していない間は選んだペースの出力で漕ぎ続ける（半オート。配達の草案 14.1）。
 * cap は脚と体力から決まる出力の上限（草案 14.2）。ブレーキは別の入力
 */
export class ManualPower implements PowerSource {
  /** 設定した出力 (W)。POWER_MIN〜POWER_MAX */
  setting = 180;
  pedal = false;
  brake = 0;
  pace: Pace = 0;
  /** 臨界出力 (W)。ペースの出力の基準 */
  cp = 200;
  cap = Infinity;
  read(): { watts: number; brake: number } {
    if (this.brake > 0) return { watts: 0, brake: this.brake };
    const w = this.pedal ? this.setting : paceWatts(this.pace, this.cp);
    return { watts: Math.min(w, this.cap), brake: 0 };
  }
}

/** 自動: 設定した出力を出し続ける（眺める乗り方） */
export class AutoPower implements PowerSource {
  constructor(public setting = 150) {}
  read(): { watts: number; brake: number } {
    return { watts: this.setting, brake: 0 };
  }
}

export const POWER_MIN = 50;
/** 出力の上限（2026-11-17 ユーザーの指定で 400 → 700W） */
export const POWER_MAX = 700;
