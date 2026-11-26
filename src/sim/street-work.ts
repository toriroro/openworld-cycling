// 町を走っていて見つかる仕事（配達の草案 16 章、D2）: 道端の頼み事の人、旗の立つ家、店（受け取りの場所・常連）。
// 世界のデータと時刻から、いま近くにある物を拾い、止まった所にあれば注文を作る。描画・DOM には依存しない。

import { errandOrder, type DeliveryOrder, type Place, parcelOrder, REGULAR_AFTER } from "../shared/delivery.ts";
import { type AddressBook, shortAddress } from "../shared/world/address.ts";
import { hash } from "../shared/world/hash.ts";
import type { HokkaidoBuildings } from "../shared/world/hokkaido.ts";
import type { Road } from "../shared/world/types.ts";
import { CHAIN_NAMES, chainOf } from "../shared/rest-stops.ts";
import { type Errand, errandsNear, GOODS_SIGNS, houseFlag, housesNear, MEAL_SIGNS, roadSpot, type RoadSpot, SHOP_SIGNS, shopsNear, type WorkBuilding } from "../shared/work-places.ts";

/** 頼み事の人・旗の家を拾う範囲 (m)、拾い直す間隔 (s)【初期値】 */
const ERRAND_RANGE = 450;
const FLAG_RANGE = 320;
const REFRESH_S = 1;
/** 止まった所からこの距離 (m) 以内の頼み事・旗の家で頼まれる【初期値】（経路の終わりで止まると 15m ほど前後するので、受け渡しの 30m と揃える） */
export const ASK_REACH = 30;
/** 店・家の前の止まる所を探す距離 (m) */
const SPOT_SEARCH = 40;

export interface FlaggedHouse {
  /** 家と窓から作る識別子 */
  id: string;
  house: WorkBuilding;
  /** 家の前の止まる所 */
  spot: RoadSpot;
  /** 旗を立てる所（道の端から家の側へ寄せた所） */
  x: number;
  y: number;
  z: number;
}

export type StreetAsk = { kind: "errand"; errand: Errand } | { kind: "house"; flag: FlaggedHouse };

export class StreetWork {
  errands: Errand[] = [];
  flags: FlaggedHouse[] = [];
  /** 受けた・断った頼み事と旗（同じ窓の間はもう出さない） */
  readonly used = new Set<string>();
  private refreshT = -Infinity;
  private spots = new Map<string, RoadSpot | null>();

  constructor(
    private net: { roads: Map<string, Road> },
    private buildings: HokkaidoBuildings | null,
    private book: AddressBook,
    private inside: (x: number, z: number) => boolean,
  ) {}

  /** 近くの頼み事の人と旗の家を拾い直す（REFRESH_S ごと）。t は走行の時間 (s)、unix は世界の時刻 */
  refresh(x: number, z: number, t: number, unix: number) {
    if (t - this.refreshT < REFRESH_S && t >= this.refreshT) return;
    this.refreshT = t;
    this.errands = errandsNear(this.roads(), x, z, ERRAND_RANGE, unix, this.inside).filter((e) => !this.used.has(e.id));
    const flags: FlaggedHouse[] = [];
    if (this.buildings)
      for (const h of housesNear(this.buildings, x, z, FLAG_RANGE, this.inside)) {
        const w = houseFlag(h.seed, unix);
        if (w === null) continue;
        const id = `${h.id}@${w}`;
        if (this.used.has(id)) continue;
        const spot = this.spotOf(h);
        if (!spot) continue;
        // 旗は道の端（幅の半分 + 0.8m）から家の側に立てる
        const dx = h.x - spot.x;
        const dz = h.z - spot.z;
        const l = Math.sqrt(dx * dx + dz * dz) || 1;
        const road = this.net.roads.get(spot.road);
        const off = Math.min(l * 0.6, (road?.width ?? 6) / 2 + 0.8);
        flags.push({ id, house: h, spot, x: spot.x + (dx / l) * off, y: spot.y, z: spot.z + (dz / l) * off });
      }
    this.flags = flags;
  }

  /** 古い記録を捨てる（読み直した道路が変わった時など） */
  forget() {
    this.refreshT = -Infinity;
    this.spots.clear();
  }

  private roads(): Iterable<Road> {
    return this.net.roads.values();
  }

  private spotOf(b: WorkBuilding): RoadSpot | null {
    let s = this.spots.get(b.id);
    if (s === undefined) {
      s = roadSpot(this.roads(), b.x, b.z, SPOT_SEARCH);
      this.spots.set(b.id, s);
    }
    return s;
  }

  /** 止まった所の近くの頼み事の人・旗の家（いちばん近い物） */
  askAt(x: number, z: number): StreetAsk | null {
    let best: StreetAsk | null = null;
    let bd = ASK_REACH * ASK_REACH;
    for (const e of this.errands) {
      const d = (e.roadX - x) * (e.roadX - x) + (e.roadZ - z) * (e.roadZ - z);
      if (d < bd) {
        bd = d;
        best = { kind: "errand", errand: e };
      }
    }
    for (const f of this.flags) {
      const d = (f.spot.x - x) * (f.spot.x - x) + (f.spot.z - z) * (f.spot.z - z);
      if (d < bd) {
        bd = d;
        best = { kind: "house", flag: f };
      }
    }
    return best;
  }

  /** (x, z) から 30m 以内の頼み事・旗の家の止まる所（地図で押した所を寄せる） */
  snap(x: number, z: number, reach = 30): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bd = reach * reach;
    for (const p of [...this.errands.map((e) => ({ x: e.roadX, z: e.roadZ })), ...this.flags.map((f) => ({ x: f.spot.x, z: f.spot.z }))]) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  private short(x: number, z: number): string {
    const a = this.book.at(x, z);
    return a ? shortAddress(a) : "";
  }

  /** 店を、注文の受け取りの場所にする（止まる所が見つからない店は除く） */
  shopPlaces(x: number, z: number, r: number, signs: readonly number[]): Place[] {
    if (!this.buildings) return [];
    const out: Place[] = [];
    for (const s of shopsNear(this.buildings, x, z, r, signs, this.inside)) {
      const spot = this.spotOf(s);
      if (!spot) continue;
      // チェーンの牛丼屋・定食屋は、店の名前で出す（配達の草案 28 章）
      const chain = chainOf(s.seed, s.sign);
      out.push({ name: `${chain ? CHAIN_NAMES[chain] : SHOP_SIGNS[s.sign]}（${this.short(s.x, s.z)}）`, x: spot.x, z: spot.z, kind: "shop", id: s.id, bx: s.x, bz: s.z });
    }
    return out;
  }

  /** 出前の店のうち、届けた件数が常連の数に達した物 */
  regularPlaces(x: number, z: number, r: number, counts: Record<string, number>): Place[] {
    return this.shopPlaces(x, z, r, MEAL_SIGNS).filter((p) => (counts[p.id!] ?? 0) >= REGULAR_AFTER);
  }

  /** 頼まれた注文を作る。candidates は届け先にしてよい丁目。作れなければ null */
  orderFor(ask: StreetAsk, candidates: Place[], no: number, seed: number): DeliveryOrder | null {
    if (ask.kind === "errand") {
      const e = ask.errand;
      const from: Place = { name: `頼んだ人（${this.short(e.x, e.z)}）`, x: e.roadX, z: e.roadZ, kind: "person", id: e.id, bx: e.x, bz: e.z };
      const shops = e.kind === "shopping" ? this.shopPlaces(e.roadX, e.roadZ, 650, GOODS_SIGNS) : [];
      return errandOrder(e.kind, from, candidates, shops, no, hash(seed, 0xe77, no));
    }
    const f = ask.flag;
    const house: Place = { name: `家（${this.short(f.house.x, f.house.z)}）`, x: f.spot.x, z: f.spot.z, kind: "house", id: f.house.id, bx: f.house.x, bz: f.house.z };
    return parcelOrder(house, candidates, no, hash(seed, 0x40c, no));
  }
}
