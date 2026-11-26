// 町の立ち寄る所（配達の草案 28・29 章）: 体力を戻す所（自販機と、チェーンの牛丼屋・定食屋）と、自転車店・車の整備（燃料店）。名前は架空（CLAUDE.md）。
// どれも建物の記録と走る道から決まる（同じ所を見れば同じ物が出る。後でサーバーでも同じ計算をする）。
// 値段・戻る量・かかる時間もここに置く（お金の計算は src/shared の純粋な関数。配達の草案 7.1）。
// DOM・Three.js に依存しない。分岐に関わる計算は加減乗除と sqrt・floor だけ（モック 4.2）。

import { hash, hashUnit } from "./world/hash.ts";
import { BUILDING_REC, BUILDING_STYLES, type HokkaidoBuildings } from "./world/hokkaido.ts";
import type { Road } from "./world/types.ts";
import { roadSpot, signOf } from "./work-places.ts";

/** 体力を戻す所 */
export type FoodKind = "vending" | "gyudon" | "teishoku";
/** 整備の店（自転車店・車の整備） */
export type ServiceKind = "bike" | "car";
export type RestKind = FoodKind | ServiceKind;
export type ChainKind = Exclude<FoodKind, "vending">;
export const isFood = (k: RestKind): k is FoodKind => k === "vending" || k === "gyudon" || k === "teishoku";

/** チェーンの名前（架空） */
export const CHAIN_NAMES: Record<ChainKind, string> = { gyudon: "牛丼 たつ屋", teishoku: "定食 まんぷく亭" };
export const REST_LABELS: Record<RestKind, string> = { vending: "自販機", gyudon: CHAIN_NAMES.gyudon, teishoku: CHAIN_NAMES.teishoku, bike: "自転車店", car: "燃料店・車の整備" };

export interface RestItem {
  id: string;
  name: string;
  /** 値段 (円) */
  price: number;
  /** 戻る体力（体力の量に対する割合） */
  energy: number;
  /** 食べる・飲むのにかかる時間 (s)。持っている注文の経った時間に足す */
  seconds: number;
  /** 座って食べるので脚も全部戻る */
  legs: boolean;
}

/**
 * 品書き【初期値】。アルバイトで 1 時間に約 5,000〜6,000 円、体力は「ふつう」で約 2 時間もつ（配達の草案 14.2・24.1）。
 * 自販機は 100 円でそこそこ戻り・待たない（脚は戻らない）。牛丼は早くて安い。定食は高くて多く戻るが時間がかかる。店は脚も全部戻る
 */
export const REST_MENU: Record<FoodKind, RestItem[]> = {
  vending: [
    // どれも 100 円（ユーザーの指定 2026-11-26。前は 110〜160 円で +3〜6%）
    { id: "water", name: "水", price: 100, energy: 0.1, seconds: 20, legs: false },
    { id: "sports", name: "スポーツドリンク", price: 100, energy: 0.15, seconds: 30, legs: false },
    { id: "coffee", name: "缶コーヒー", price: 100, energy: 0.12, seconds: 30, legs: false },
  ],
  gyudon: [
    { id: "nami", name: "牛丼 並", price: 480, energy: 0.3, seconds: 240, legs: true },
    { id: "omori", name: "牛丼 大盛", price: 620, energy: 0.42, seconds: 300, legs: true },
    { id: "set", name: "牛丼 並と味噌汁", price: 560, energy: 0.36, seconds: 270, legs: true },
  ],
  teishoku: [
    { id: "daily", name: "日替わり定食", price: 850, energy: 0.55, seconds: 600, legs: true },
    { id: "karaage", name: "から揚げ定食", price: 920, energy: 0.6, seconds: 600, legs: true },
    { id: "saba", name: "さば味噌定食", price: 880, energy: 0.55, seconds: 600, legs: true },
  ],
};

/** 自販機を置く建物の割合（1 棟あたり）【初期値】。札幌の中心で 100m に 1 台ほど */
export const VENDING_SHARE = 0.035;
/** 店・自販機から走る道までの距離の上限 (m) */
export const REST_REACH = 30;
/** 止まって買える距離 (m): 道の上の止まる所から。自販機・店【初期値】 */
export const REST_STOP_RANGE: Record<RestKind, number> = { vending: 9, gyudon: 14, teishoku: 14, bike: 14, car: 16 };
/** 歩道に置く時の、道の端からの間 (m) */
const SIDEWALK = 0.9;

/** 1 階に店の看板がある建物の型（店・古い店・雑居ビル・貸店舗。src/render/building/styles.ts で看板の帯を描く物） */
const SIGNED_STYLES = new Set(["shop", "oldshop", "tenant", "strip"].map((n) => BUILDING_STYLES.indexOf(n as (typeof BUILDING_STYLES)[number])));
/** チェーンの店にする看板（食堂。建物の 1 階の看板の字と合う）。src/shared/work-places.ts の SHOP_SIGNS の 5 */
export const CHAIN_SIGN = 5;
/** 自転車店・車の整備にする看板（自転車店・燃料店）。SHOP_SIGNS の 27・29 */
export const BIKE_SIGN = 27;
export const CAR_SIGN = 29;

/** 店の建物がチェーンの店なら、その種類。看板が食堂の店を、種で牛丼屋と定食屋に分ける */
export function chainOf(seed: number, sign: number = signOf(seed)): ChainKind | null {
  if (sign !== CHAIN_SIGN) return null;
  return hash(0x4e57, seed) % 5 < 3 ? "gyudon" : "teishoku";
}

/** 建物に自販機があるか */
export function hasVending(seed: number): boolean {
  return hashUnit(0x7e4d, seed) < VENDING_SHARE;
}

export interface RestStop {
  /** 建物の種と種類から作る識別子 */
  id: string;
  kind: RestKind;
  name: string;
  /** 物の置き場所（自販機・店の置き看板）。歩道の上 */
  x: number;
  y: number;
  z: number;
  /** 道から建物への向き（水平の単位ベクトル。自販機の背中・看板の裏の向き） */
  fx: number;
  fz: number;
  /** 止まる所（道の上） */
  road: string;
  s: number;
  roadX: number;
  roadZ: number;
  /** 建物の中心 */
  bx: number;
  bz: number;
}

/** 建物 1 棟分の、体力を戻す所の候補（店はチェーン、ほかの建物は自販機）。無ければ null */
function candidate(style: number, seed: number): RestKind | null {
  if (SIGNED_STYLES.has(style)) {
    const c = chainOf(seed);
    if (c) return c;
    const sign = signOf(seed);
    if (sign === BIKE_SIGN) return "bike";
    if (sign === CAR_SIGN) return "car";
  }
  return hasVending(seed) ? "vending" : null;
}

/** 建物と道から、置き場所と止まる所を決める。道が近くに無ければ null */
export function placeRest(kind: RestKind, seed: number, bx: number, bz: number, roads: ReadonlyMap<string, Road>): RestStop | null {
  const spot = roadSpot(roads.values(), bx, bz, REST_REACH);
  if (!spot) return null;
  const road = roads.get(spot.road);
  if (!road) return null;
  let fx = bx - spot.x;
  let fz = bz - spot.z;
  const l = Math.sqrt(fx * fx + fz * fz);
  if (l < 0.5) return null;
  fx /= l;
  fz /= l;
  // 道の端の外の歩道に置く（建物に食い込まないよう、建物の中心までの半分より奥にはしない）
  const off = Math.min(road.width / 2 + SIDEWALK, l * 0.5);
  return {
    id: `${kind}:${seed}`,
    kind,
    name: REST_LABELS[kind],
    x: spot.x + fx * off,
    y: spot.y,
    z: spot.z + fz * off,
    fx,
    fz,
    road: spot.road,
    s: spot.s,
    roadX: spot.x,
    roadZ: spot.z,
    bx,
    bz,
  };
}

/**
 * (x, z) から r 以内の、体力を戻す所。inside で置いてよい範囲（配達の範囲）を絞る。
 * cache は建物の種 → 決めた所（道が読み込まれていない時の null は覚えない）
 */
export function restStopsNear(
  b: HokkaidoBuildings,
  roads: ReadonlyMap<string, Road>,
  x: number,
  z: number,
  r: number,
  inside?: (x: number, z: number) => boolean,
  cache?: Map<number, RestStop | null>,
): RestStop[] {
  const out: RestStop[] = [];
  const cell = b.index.cell;
  const D = b.data;
  const r2 = r * r;
  for (let gz = Math.floor((z - r) / cell); gz <= Math.floor((z + r) / cell); gz++)
    for (let gx = Math.floor((x - r) / cell); gx <= Math.floor((x + r) / cell); gx++) {
      const c = b.cell(gx, gz);
      if (!c) continue;
      for (let k = c[0]; k < c[0] + c[1]; k++) {
        const o = k * BUILDING_REC;
        const bx = D[o];
        const bz = D[o + 1];
        if ((bx - x) * (bx - x) + (bz - z) * (bz - z) > r2) continue;
        const seed = D[o + 15] >>> 0;
        const kind = candidate(D[o + 12], seed);
        if (!kind) continue;
        if (inside && !inside(bx, bz)) continue;
        let st = cache?.get(seed);
        if (st === undefined) {
          st = placeRest(kind, seed, bx, bz, roads);
          // 置けた所と、近くの道が読み込まれているのに置けない（道から遠い）建物を覚える
          if (cache && (st || roadSpot(roads.values(), bx, bz, REST_REACH * 3))) cache.set(seed, st);
        }
        if (st) out.push(st);
      }
    }
  out.sort((a, b2) => (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  return out;
}

/** 押して向かう円（配達の草案 30 章）: 物の前（道の側へ 1.3m）、半径 1.1m */
export const RING_R = 1.1;
export function restRing(st: RestStop): { x: number; z: number } {
  return { x: st.x - st.fx * 1.3, z: st.z - st.fz * 1.3 };
}

/** 円を押した時に自動で頼む品（店はいちばん安い物、自販機はスポーツドリンク）。買える物が無ければ null */
export function autoItem(kind: FoodKind, money: number, energyShare: number, legsShare: number): RestItem | null {
  const order: Record<FoodKind, string[]> = { vending: ["sports", "coffee", "water"], gyudon: ["nami", "set", "omori"], teishoku: ["daily", "saba", "karaage"] };
  for (const id of order[kind]) {
    const it = REST_MENU[kind].find((x) => x.id === id);
    if (it && !restBlock(it, money, energyShare, legsShare)) return it;
  }
  return null;
}

/** 止まった所 (x, z) で買える所（いちばん近い物）。無ければ null */
export function restStopAt(stops: readonly RestStop[], x: number, z: number): RestStop | null {
  let best: RestStop | null = null;
  let bd = Infinity;
  for (const st of stops) {
    const d = Math.sqrt((st.roadX - x) * (st.roadX - x) + (st.roadZ - z) * (st.roadZ - z));
    if (d > REST_STOP_RANGE[st.kind] || d >= bd) continue;
    bd = d;
    best = st;
  }
  return best;
}

/** 買えるか。買えなければ理由 */
export function restBlock(item: RestItem, money: number, energyShare: number, legsShare: number): string | null {
  if (money < item.price) return "所持金が足りない";
  if (energyShare >= 0.999 && (!item.legs || legsShare >= 0.999)) return "体力は 100%";
  return null;
}
