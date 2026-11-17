// 推進力の入力元（モック仕様 6.1【固定】）。トレーナーは後でこの形に合わせて足す。

export interface PowerSource {
  read(dt: number): { watts: number; brake: number };
}

/** 手動: 押している間、設定した出力。ブレーキは別の入力 */
export class ManualPower implements PowerSource {
  /** 設定した出力 (W)。POWER_MIN〜POWER_MAX */
  setting = 180;
  pedal = false;
  brake = 0;
  read(): { watts: number; brake: number } {
    return { watts: this.pedal && this.brake <= 0 ? this.setting : 0, brake: this.brake };
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
