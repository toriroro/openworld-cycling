// 配達の注文と結果（配達の草案 2 章・13 章・16 章）。DOM・Three.js・端末の機能に依存しない（後でサーバーでも動かす。草案 7.1）。
// 注文は「受け取り」と「届け先」の 2 つの場所を持つ。場所は丁目（住所。その丁目に面した道で止まる）か、
// 店・家・頼んだ人の前の道の上の点（そこで止まる）。乱数はハッシュ（モック 4.2）。
// 注文の出どころ（配達アプリ・道端の頼み事・家からの発送・常連の店）と種類で、期限と報酬の決め方が変わる（草案 14.3）。

import type { AddressBook } from "./world/address.ts";
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
/** 期限に遅れたら報酬に掛ける倍率【初期値】 */
const LATE_FACTOR = 0.7;
/** 止まったとみなす速さ (m/s) と、止まった所から住所を調べる左右の距離 (m) */
const STOP_SPEED = 0.5;
const SIDE_REACH = [3, 9, 18];
/** 店・家・人の前の点で止まったとみなす距離 (m)【初期値】 */
export const SPOT_REACH = 30;
/** 常連の店から直接頼まれた時の報酬の倍率（アプリの取り分が無い）【初期値】 */
export const REGULAR_BONUS = 1.3;

export type PlaceKind = "chome" | "shop" | "house" | "person";

/** 受け取り・届け先の場所。丁目のほかは (x, z) が止まる所（道の上の点） */
export interface Place {
  name: string;
  x: number;
  z: number;
  /** 無ければ丁目 */
  kind?: PlaceKind;
  /** 店・家の識別子（建物の種）、頼み事の識別子 */
  id?: string;
  /** 店・家・人の建物（人なら立っている所）の位置。光の柱を立てる（配達の草案 26 章）。無ければ道の脇から求める */
  bx?: number;
  bz?: number;
}

/** 注文の出どころ（草案 14.3） */
export type OrderSource = "app" | "street" | "house" | "regular";
/** 注文の種類 */
export type OrderKind = "meal" | "forgot" | "shopping" | "papers" | "parcel";

export const ORDER_KIND_LABELS: Record<OrderKind, string> = { meal: "出前", forgot: "忘れ物を届ける", shopping: "買い物", papers: "急ぎの書類", parcel: "小包" };
export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = { app: "配達アプリ", street: "頼み事", house: "家からの発送", regular: "店から（常連）" };

/**
 * 種類ごとの期限と報酬【初期値】: 期限 = 見込みの走る時間 × limit + 余裕、報酬 = base + perKm × 直線 km（受け取りまでの分も数えるなら withApproach）
 */
const KIND_TERMS: Record<OrderKind, { limit: number; base: number; perKm: number; withApproach: boolean }> = {
  meal: { limit: 1, base: 250, perKm: 200, withApproach: false },
  forgot: { limit: 1, base: 200, perKm: 200, withApproach: false },
  shopping: { limit: 1.1, base: 300, perKm: 200, withApproach: true },
  papers: { limit: 0.8, base: 350, perKm: 300, withApproach: false },
  parcel: { limit: 1.6, base: 300, perKm: 150, withApproach: false },
};

/** 道端の頼み事・家からの発送で、届け先までの直線距離の範囲 (m)【初期値】 */
export const KIND_DROP_RANGE: Record<"forgot" | "papers" | "parcel", [number, number]> = {
  forgot: [400, 1500],
  papers: [800, 2000],
  parcel: [1000, 3000],
};
/** 買い物の店までの直線距離の範囲 (m)【初期値】 */
export const SHOPPING_RANGE: [number, number] = [150, 600];

export interface DeliveryOrder {
  /** 注文の通し番号（乱数の種にも使う） */
  no: number;
  source: OrderSource;
  kind: OrderKind;
  pickup: Place;
  dropoff: Place;
  /** 受けた時に荷を受け取っている（頼み事・家からの発送。受け取りの場所はその場） */
  pickedAtStart: boolean;
  /** 受け取りから届け先までの直線距離 (m) */
  distance: number;
  /** 注文を受けた所から受け取りまでの直線距離 (m) */
  approach: number;
  /** 期限 (s、受けてから) */
  limit: number;
  reward: number;
  /** 大きめの小包（家からの発送の一部。リアキャリアが要る。配達の草案 22.6 の 49） */
  big?: boolean;
}

/** 自転車の装備（22.6 の 49）: 背負い鞄（初期）とリアキャリア */
export type Gear = "bag" | "carrier";
export const GEAR_LABELS: Record<Gear, string> = { bag: "背負い鞄", carrier: "リアキャリア" };
/** リアキャリアの値段 (円)、大きめの小包の割合と報酬の倍率【初期値】 */
export const CARRIER_COST = 15_000;
const BIG_SHARE = 0.4;
const BIG_BONUS = 1.25;
/** 同時に持てる注文の数 */
export const carryLimit = (gear: Gear) => (gear === "carrier" ? 2 : 1);
/** その装備で受けられない注文なら理由 */
export const gearBlocks = (o: DeliveryOrder, gear: Gear): string | null => (o.big && gear !== "carrier" ? "大きめの小包はリアキャリアが要る" : null);

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
const within = (p: { x: number; z: number }, from: { x: number; z: number }, r: [number, number]) => {
  const d = d2(p, from);
  return d >= r[0] * r[0] && d <= r[1] * r[1];
};

/** 期限 (s)。10 秒単位に切り上げる */
export function orderLimit(approach: number, distance: number, factor = 1): number {
  return Math.ceil((((approach + distance) * ROUTE_FACTOR) / PLAN_SPEED / 10) * factor) * 10 + LIMIT_SLACK;
}

/** 報酬 (円)。10 円単位 */
export function orderReward(distance: number, kind: OrderKind = "meal", approach = 0, factor = 1): number {
  const t = KIND_TERMS[kind];
  const km = (distance + (t.withApproach ? approach : 0)) / 1000;
  return Math.round(((t.base + t.perKm * km) * factor) / 10) * 10;
}

function finish(no: number, source: OrderSource, kind: OrderKind, pickup: Place, dropoff: Place, here: { x: number; z: number }, pickedAtStart: boolean, bonus = 1): DeliveryOrder {
  const distance = Math.sqrt(d2(pickup, dropoff));
  const approach = pickedAtStart ? 0 : Math.sqrt(d2(pickup, here));
  return {
    no,
    source,
    kind,
    pickup,
    dropoff,
    pickedAtStart,
    distance,
    approach,
    limit: orderLimit(approach, distance, KIND_TERMS[kind].limit),
    reward: orderReward(distance, kind, approach, bonus),
  };
}

/**
 * 配達アプリ・常連の店の注文（出前）を作る。candidates は届け先にしてよい丁目。
 * pickups を渡せば受け取りはその中（店の前）から、無ければ丁目から選ぶ。条件に合う場所が無ければ null
 */
export function makeOrder(candidates: Place[], x: number, z: number, no: number, seed: number, opts: { pickups?: Place[]; source?: "app" | "regular" } = {}): DeliveryOrder | null {
  const here = { x, z };
  const pick = <T>(list: T[], k: number) => (list.length ? list[hash(seed, no, k) % list.length] : null);
  const pickups = (opts.pickups ?? candidates).filter((p) => within(p, here, PICKUP_RANGE));
  const source = opts.source ?? "app";
  // 受け取りを何回か選び直して、届け先の候補がある物にする
  for (let k = 0; k < 8; k++) {
    const pickup = pick(pickups, k * 2);
    if (!pickup) return null;
    const drops = candidates.filter((p) => p !== pickup && within(p, pickup, DROP_RANGE));
    const dropoff = pick(drops, k * 2 + 1);
    if (!dropoff) continue;
    return finish(no, source, "meal", pickup, dropoff, here, false, source === "regular" ? REGULAR_BONUS : 1);
  }
  return null;
}

/**
 * 道端の頼み事の注文。from は頼んだ人（止まる所）。
 * 忘れ物・急ぎの書類はその場で荷を受け、丁目へ届ける。買い物は近くの店で品物を受け、頼んだ人へ届ける
 */
export function errandOrder(kind: "forgot" | "shopping" | "papers", from: Place, candidates: Place[], shops: Place[], no: number, seed: number): DeliveryOrder | null {
  const pick = <T>(list: T[], k: number) => (list.length ? list[hash(seed, no, k) % list.length] : null);
  if (kind === "shopping") {
    const shop = pick(
      shops.filter((s) => within(s, from, SHOPPING_RANGE)),
      1,
    );
    return shop ? finish(no, "street", kind, shop, from, from, false) : null;
  }
  const drop = pick(
    candidates.filter((p) => within(p, from, KIND_DROP_RANGE[kind])),
    1,
  );
  return drop ? finish(no, "street", kind, from, drop, from, true) : null;
}

/** 家からの発送（小包）の注文。家の前で荷を受け、遠めの丁目へ届ける */
export function parcelOrder(house: Place, candidates: Place[], no: number, seed: number): DeliveryOrder | null {
  const drops = candidates.filter((p) => within(p, house, KIND_DROP_RANGE.parcel));
  if (!drops.length) return null;
  const big = hash(seed, no, 2) / 4294967296 < BIG_SHARE;
  const o = finish(no, "house", "parcel", house, drops[hash(seed, no, 1) % drops.length], house, true, big ? BIG_BONUS : 1);
  if (big) o.big = true;
  return o;
}

/** 止まっている所が、その場所か（丁目なら走る道の左右にその丁目がある。店・家・人なら止まる所の近く） */
export function stoppedAt(book: AddressBook, target: Place, pose: { x: number; z: number; dx: number; dz: number }, speed: number): boolean {
  if (speed > STOP_SPEED) return false;
  if (target.kind && target.kind !== "chome") return d2(pose, target) <= SPOT_REACH * SPOT_REACH;
  // 進む向きに対して左（x が東、z が南）
  const lx = pose.dz;
  const lz = -pose.dx;
  for (const r of SIDE_REACH)
    for (const side of [1, -1]) {
      const p = book.at(pose.x + lx * r * side, pose.z + lz * r * side);
      if (p && p.name === target.name) return true;
    }
  return false;
}

/** 受け渡しの円の半径 (m)【初期値】（配達の草案 26 章） */
export const ZONE_R = 5;
/** 円の中心を道の端から内側へ寄せる量 (m) */
const ZONE_CURB = 1.5;

export interface HandoffZone {
  x: number;
  z: number;
  r: number;
}

/**
 * 受け渡しの円（配達の草案 26 章）: 走る道の上の点 spot（道の中心、向き dx・dz、道の幅 width）から、
 * 建物 (bx, bz) の側の道の端の少し内側に置く。この円に入れば、速さによらず受け取り・受け渡しになる
 */
export function handoffZone(spot: { x: number; z: number; dx: number; dz: number; width: number }, building: { x: number; z: number }): HandoffZone {
  const nx = -spot.dz;
  const nz = spot.dx;
  const side = (building.x - spot.x) * nx + (building.z - spot.z) * nz >= 0 ? 1 : -1;
  const off = Math.max(0, spot.width / 2 - ZONE_CURB) * side;
  return { x: spot.x + nx * off, z: spot.z + nz * off, r: ZONE_R };
}

/** (x, z) が受け渡しの円の中か */
export const inZone = (zone: HandoffZone, p: { x: number; z: number }): boolean => d2(p, zone) <= zone.r * zone.r;

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
  ) {
    if (order.pickedAtStart) {
      this.phase = "dropoff";
      this.handover = HANDOVER_S;
    }
  }

  /** 受け渡し以外で経った時間を足す（喫茶店で休んだ時など） */
  addTime(s: number) {
    this.handover += s;
  }

  get target(): Place {
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
    return this.handoff(time, odometer);
  }

  /** 受け取り・受け渡しを 1 つ進める（受け渡しの円に入った時。配達の草案 26 章）。walk は歩いて渡す時間 (s)（車は止めて歩くので長い。33 章） */
  handoff(time: number, odometer: number, walk: number = HANDOVER_S): "picked" | DeliveryResult {
    this.handover += walk;
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

/** 常連になる、同じ店から届けた件数【初期値】 */
export const REGULAR_AFTER = 3;
