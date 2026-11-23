// 配達の注文と結果（配達の草案 2 章・13 章、D0）。DOM・Three.js・端末の機能に依存しない（後でサーバーでも動かす。草案 7.1）。
// 注文は丁目（住所）から丁目へ。受け取りの丁目に止まって荷を受け、届け先の丁目に止まって渡す。乱数はハッシュ（モック 4.2）。

import { type AddressBook, type AddressPoint } from "./world/address.ts";
import { hash } from "./world/hash.ts";

/** 受け取りまでの直線距離の範囲 (m)【初期値】 */
export const PICKUP_RANGE: [number, number] = [200, 800];
/** 受け取りから届け先までの直線距離の範囲 (m)【初期値】。近場の配達（草案 0 章の 4） */
export const DROP_RANGE: [number, number] = [500, 1800];
/** 期限の計算: 直線距離に掛ける道のりの倍率、見込む速さ (m/s)、受け渡しの時間を含む余裕 (s)【初期値】 */
const ROUTE_FACTOR = 1.4;
const PLAN_SPEED = 5;
const LIMIT_SLACK = 120;
/** 受け取り・受け渡しに歩いてかかる時間 (s)【初期値】。最寄りの走る道で止めて歩いて渡したことにする（草案 2.4 の a） */
export const HANDOVER_S = 20;
/** 報酬: 基本 + 受け取りから届け先までの直線 1km あたり (円)。期限に遅れたら掛ける倍率【初期値】 */
const REWARD_BASE = 250;
const REWARD_PER_KM = 200;
const LATE_FACTOR = 0.7;
/** 止まったとみなす速さ (m/s) と、止まった所から住所を調べる左右の距離 (m) */
const STOP_SPEED = 0.5;
const SIDE_REACH = [3, 9];

export interface DeliveryOrder {
  /** 注文の通し番号（乱数の種にも使う） */
  no: number;
  pickup: AddressPoint;
  dropoff: AddressPoint;
  /** 受け取りから届け先までの直線距離 (m) */
  distance: number;
  /** 注文を受けた所から受け取りまでの直線距離 (m) */
  approach: number;
  /** 期限 (s、受けてから) */
  limit: number;
  reward: number;
}

export interface DeliveryResult {
  order: DeliveryOrder;
  /** 受けてから渡すまで (s、受け渡しの時間を含む) */
  elapsed: number;
  late: boolean;
  reward: number;
  /** 受けてから走った道のり (m) */
  ridden: number;
}

const d2 = (a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);

/** 期限 (s)。10 秒単位に切り上げる */
export function orderLimit(approach: number, distance: number): number {
  return Math.ceil(((approach + distance) * ROUTE_FACTOR) / PLAN_SPEED / 10) * 10 + LIMIT_SLACK;
}

/** 報酬 (円)。10 円単位 */
export function orderReward(distance: number): number {
  return Math.round((REWARD_BASE + (REWARD_PER_KM * distance) / 1000) / 10) * 10;
}

/**
 * 注文を作る。candidates は受け取り・届け先にしてよい丁目（走れる道に囲まれた所）。
 * 条件に合う丁目が無ければ null
 */
export function makeOrder(candidates: AddressPoint[], x: number, z: number, no: number, seed: number): DeliveryOrder | null {
  const here = { x, z };
  const within = (p: AddressPoint, from: { x: number; z: number }, r: [number, number]) => {
    const d = d2(p, from);
    return d >= r[0] * r[0] && d <= r[1] * r[1];
  };
  const pick = (list: AddressPoint[], k: number) => (list.length ? list[hash(seed, no, k) % list.length] : null);
  const pickups = candidates.filter((p) => within(p, here, PICKUP_RANGE));
  // 受け取りを何回か選び直して、届け先の候補がある物にする
  for (let k = 0; k < 8; k++) {
    const pickup = pick(pickups, k * 2);
    if (!pickup) return null;
    const drops = candidates.filter((p) => p !== pickup && within(p, pickup, DROP_RANGE));
    const dropoff = pick(drops, k * 2 + 1);
    if (!dropoff) continue;
    const distance = Math.sqrt(d2(pickup, dropoff));
    const approach = Math.sqrt(d2(pickup, here));
    return { no, pickup, dropoff, distance, approach, limit: orderLimit(approach, distance), reward: orderReward(distance) };
  }
  return null;
}

/** 止まっている所の左右（走る道の両側）に、その丁目があるか */
export function stoppedAt(book: AddressBook, target: AddressPoint, pose: { x: number; z: number; dx: number; dz: number }, speed: number): boolean {
  if (speed > STOP_SPEED) return false;
  // 進む向きに対して左（x が東、z が南）
  const lx = pose.dz;
  const lz = -pose.dx;
  for (const r of SIDE_REACH)
    for (const side of [1, -1]) {
      const p = book.at(pose.x + lx * r * side, pose.z + lz * r * side);
      if (p === target) return true;
    }
  return false;
}

export type DeliveryPhase = "pickup" | "dropoff";

/** 受けた注文の進み具合。時刻は走行の時間 (s) */
export class Delivery {
  phase: DeliveryPhase = "pickup";
  /** 受け渡しに歩いた時間の合計 (s) */
  handover = 0;

  constructor(
    readonly order: DeliveryOrder,
    readonly startTime: number,
    readonly startOdometer: number,
  ) {}

  get target(): AddressPoint {
    return this.phase === "pickup" ? this.order.pickup : this.order.dropoff;
  }

  elapsed(time: number): number {
    return time - this.startTime + this.handover;
  }

  /** 期限までの残り (s)。負なら遅れ */
  remaining(time: number): number {
    return this.order.limit - this.elapsed(time);
  }

  /**
   * 止まった所で受け取り・受け渡しを進める。渡し終えたら結果を返す。
   * 受け取った時は "picked" を返す
   */
  update(book: AddressBook, pose: { x: number; z: number; dx: number; dz: number }, speed: number, time: number, odometer: number): "picked" | DeliveryResult | null {
    if (!stoppedAt(book, this.target, pose, speed)) return null;
    this.handover += HANDOVER_S;
    if (this.phase === "pickup") {
      this.phase = "dropoff";
      return "picked";
    }
    const elapsed = this.elapsed(time);
    const late = elapsed > this.order.limit;
    return { order: this.order, elapsed, late, reward: late ? Math.round((this.order.reward * LATE_FACTOR) / 10) * 10 : this.order.reward, ridden: odometer - this.startOdometer };
  }
}

/** 注文の種（世界の時刻から。同じ時に同じ所で受けた注文は同じになる） */
export function orderSeed(unixSeconds: number): number {
  return hash(0x5d0, Math.floor(unixSeconds / 60));
}
