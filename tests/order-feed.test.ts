// 配達アプリの注文の一覧（配達の草案 27 章）

import { describe, expect, it } from "vitest";
import type { DeliveryOrder } from "../src/shared/delivery.ts";
import { FEED_GAP, FEED_LIFE, FEED_MAX, OrderFeed } from "../src/sim/order-feed.ts";

const order = (no: number) => ({ no, reward: 400 + no }) as unknown as DeliveryOrder;

describe("注文の一覧", () => {
  it("間隔をおいて届き、新しい物が上。期限が来ると消える", () => {
    const f = new OrderFeed();
    let no = 0;
    const next = () => ++no;
    const got: number[] = [];
    for (let t = 0; t <= 60; t += 0.5) {
      const it = f.tick(t, next, order);
      if (it) got.push(t);
    }
    expect(got.length).toBeGreaterThanOrEqual(Math.floor(60 / FEED_GAP[1]));
    expect(got.length).toBeLessThanOrEqual(Math.ceil(60 / FEED_GAP[0]) + 1);
    for (let i = 1; i < got.length; i++) expect(got[i] - got[i - 1]).toBeGreaterThanOrEqual(FEED_GAP[0] - 0.5);
    // 新しい物が先頭
    for (let i = 1; i < f.items.length; i++) expect(f.items[i - 1].at).toBeGreaterThanOrEqual(f.items[i].at);
    // 載っている長さは範囲の中
    for (const x of f.items) {
      expect(x.until - x.at).toBeGreaterThanOrEqual(FEED_LIFE[0]);
      expect(x.until - x.at).toBeLessThanOrEqual(FEED_LIFE[1]);
    }
    // ずっと先まで進めると、届いた物は消える（新しく届いた物だけ残る）
    const first = f.items[f.items.length - 1].order.no;
    f.tick(60 + FEED_LIFE[1] + 1, next, () => null);
    expect(f.items.some((x) => x.order.no === first)).toBe(false);
  });

  it("上限の数より多くは載らない。受けた物は一覧から外れる", () => {
    const f = new OrderFeed();
    let no = 0;
    for (let t = 0; t < 200; t += 1) f.tick(t, () => ++no, order);
    expect(f.items.length).toBeLessThanOrEqual(FEED_MAX);
    const top = f.items[0].order.no;
    expect(f.take(top)?.no).toBe(top);
    expect(f.items.some((x) => x.order.no === top)).toBe(false);
    expect(f.take(top)).toBeNull();
  });

  it("空にすると、次はすぐ届く", () => {
    const f = new OrderFeed();
    let no = 0;
    for (let t = 0; t < 40; t += 1) f.tick(t, () => ++no, order);
    f.clear(40);
    expect(f.items.length).toBe(0);
    expect(f.nextAt).toBeLessThanOrEqual(40 + FEED_GAP[0]);
  });
});
