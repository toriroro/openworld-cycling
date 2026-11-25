// 配達アプリの注文の一覧（配達の草案 27 章）。注文はしばらくおきに届き、それぞれの期限が来ると消える。プレイヤーは一覧から選んで受ける。
// DOM に依存しない。時刻は走行の時間 (s)。間隔と載っている長さは注文の番号のハッシュで決める（同じ番号なら同じ）。

import type { DeliveryOrder } from "../shared/delivery.ts";
import { hash } from "../shared/world/hash.ts";

/** 一覧に載る数の上限、次の注文までの間隔 (s)、載っている長さ (s)【初期値】 */
export const FEED_MAX = 8;
export const FEED_GAP = [6, 16] as const;
export const FEED_LIFE = [50, 130] as const;

export interface FeedItem {
  order: DeliveryOrder;
  /** 届いた時刻と、消える時刻 (s) */
  at: number;
  until: number;
}

/** [a, b] の範囲の値を、番号 no と種 k のハッシュで 0.1 刻みに選ぶ */
const pick = (range: readonly [number, number], no: number, k: number) => range[0] + (hash(k, no) % Math.round((range[1] - range[0]) * 10 + 1)) / 10;

export class OrderFeed {
  items: FeedItem[] = [];
  /** 次の注文が届く時刻 (s) */
  nextAt = 3;

  /**
   * time まで進める: 期限の過ぎた物を消し、届く頃なら make（注文の番号を渡す）で 1 件足す。
   * 足した物を返す。make が null なら作れなかったとして、次の間隔を置く
   */
  tick(time: number, nextNo: () => number, make: (no: number) => DeliveryOrder | null): FeedItem | null {
    this.items = this.items.filter((x) => x.until > time);
    if (time < this.nextAt) return null;
    const no = nextNo();
    this.nextAt = time + pick(FEED_GAP, no, 0xfe1);
    if (this.items.length >= FEED_MAX) return null;
    const order = make(no);
    if (!order) return null;
    const item = { order, at: time, until: time + pick(FEED_LIFE, no, 0xfe2) };
    // 新しい物を上に
    this.items.unshift(item);
    return item;
  }

  /** 一覧から受ける（一覧から外す）。無ければ null */
  take(no: number): DeliveryOrder | null {
    const i = this.items.findIndex((x) => x.order.no === no);
    if (i < 0) return null;
    return this.items.splice(i, 1)[0].order;
  }

  /** アプリを切った・配達の範囲を出た時: 一覧を空にして、次はすぐ届くようにする */
  clear(time: number) {
    this.items = [];
    this.nextAt = time + FEED_GAP[0] / 2;
  }
}
