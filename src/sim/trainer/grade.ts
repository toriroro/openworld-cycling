// トレーナーへ送る勾配（トレーナー連携の草案 4.1・4.2）。
// 道路の縦断は区間ごとの折れ線で細かく揺れるので、前後の道のりの高さの差から平均の勾配を出す。
// 送る間隔は、変化がある時に最短 0.5 秒、無くても 5 秒ごと。

import type { Road } from "../../shared/world/types.ts";
import { sampleRoad } from "../road-network.ts";

/** 平均をとる前後それぞれの道のり (m)【初期値】 */
export const GRADE_WINDOW = 15;
/** 送る勾配の範囲【初期値】 */
export const GRADE_MIN = -0.1;
export const GRADE_MAX = 0.2;
/** 効きの既定（2026-11-21 決定） */
export const DEFAULT_EFFECT = 0.5;

/** 道のり s の前後 half m の平均の勾配（進む向き dir で上りが正）。道路の端では窓を狭める */
export function smoothedGrade(road: Road, s: number, dir: 1 | -1, half = GRADE_WINDOW): number {
  const a = Math.max(0, s - half);
  const b = Math.min(road.length, s + half);
  if (b - a < 4) return sampleRoad(road, s).grade * dir;
  return ((sampleRoad(road, b).y - sampleRoad(road, a).y) / (b - a)) * dir;
}

/** 効きを掛けて範囲に収める */
export function trainerGrade(grade: number, effect: number): number {
  return Math.max(GRADE_MIN, Math.min(GRADE_MAX, grade * Math.max(0, Math.min(1, effect))));
}

/** 送るかどうかを決める（時刻 ms と送りたい勾配から）。応答待ちの間は送らない */
export class GradeSchedule {
  /** 最後に送った勾配（未送信は NaN） */
  sent = NaN;
  private sentAt = -Infinity;
  /** 変化があった時の最短の間隔 (ms)【初期値】 */
  minInterval = 500;
  /** 変化が無くても送り直す間隔 (ms)【初期値】 */
  refresh = 5000;
  /** 変化とみなす差（割合。0.001 = 0.1%）【初期値】 */
  threshold = 0.001;

  shouldSend(now: number, grade: number): boolean {
    if (Number.isNaN(this.sent)) return true;
    const dt = now - this.sentAt;
    if (Math.abs(grade - this.sent) >= this.threshold - 1e-9 && dt >= this.minInterval) return true;
    return dt >= this.refresh;
  }

  markSent(now: number, grade: number) {
    this.sent = grade;
    this.sentAt = now;
  }

  reset() {
    this.sent = NaN;
    this.sentAt = -Infinity;
  }
}
