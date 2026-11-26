import { describe, expect, it } from "vitest";
import { DEFAULT_STAMINA, effectivePace, paceWatts, Stamina } from "../src/shared/stamina.ts";
import { segmentCost } from "../src/sim/route-plan.ts";
import type { Road } from "../src/shared/world/types.ts";

const run = (st: Stamina, watts: number, seconds: number) => {
  for (let t = 0; t < seconds; t += 0.5) st.update(watts, 0.5);
};

describe("脚と体力（配達の草案 14.2）", () => {
  const cp = DEFAULT_STAMINA.cp;

  it("ペースの出力: 止まる 0、ふつうは CP より下、急ぐ・全力は上", () => {
    expect(paceWatts(0, cp)).toBe(0);
    expect(paceWatts(2, cp)).toBeLessThan(cp);
    expect(paceWatts(3, cp)).toBeGreaterThan(cp);
    expect(paceWatts(4, cp)).toBeGreaterThan(paceWatts(3, cp));
  });

  it("ふつうでは脚が減らない。全力では 2 分ほどで尽き、上限がゆっくりとふつうの間になる（配達の草案 30 章）", () => {
    const st = new Stamina();
    run(st, paceWatts(2, cp), 600);
    expect(st.legsShare).toBe(1);
    expect(st.cap()).toBe(Infinity);
    run(st, paceWatts(4, cp), 60);
    expect(st.legsShare).toBeGreaterThan(0);
    run(st, paceWatts(4, cp), 90);
    expect(st.legs).toBe(0);
    expect(st.cap()).toBeLessThan(paceWatts(2, cp));
    expect(st.cap()).toBeGreaterThan(paceWatts(1, cp));
    expect(effectivePace(4, cp, st.cap())).toBe(1);
  });

  it("脚が尽きたら、20% に戻るまで上限を外さない（0% 付近で全力のまま走れていた）", () => {
    const st = new Stamina();
    st.legs = 0;
    st.update(paceWatts(4, cp), 1 / 120);
    expect(st.exhausted).toBe(true);
    // 上限の出力で漕ぎ続けても、少し戻っただけでは外れない
    let t = 0;
    while (st.exhausted && t < 600) {
      st.update(Math.min(paceWatts(4, cp), st.cap()), 0.1);
      t += 0.1;
      if (st.legsShare > 0.05 && st.legsShare < 0.19) expect(st.cap()).toBeLessThan(cp);
    }
    expect(st.legsShare).toBeGreaterThanOrEqual(0.2);
    expect(t).toBeGreaterThan(60);
    expect(t).toBeLessThan(150);
    expect(st.cap()).toBe(Infinity);
    expect(effectivePace(4, cp, Infinity)).toBe(4);
  });

  it("ゆっくり走ると脚は数分で戻る", () => {
    const st = new Stamina();
    st.legs = 0;
    run(st, paceWatts(1, cp), 400);
    expect(st.legsShare).toBe(1);
  });

  it("体力は「ふつう」で 2 時間ほどで尽き、尽きると大きく遅くなる。強く漕ぐと早く減る", () => {
    const a = new Stamina();
    run(a, paceWatts(2, cp), 3600);
    expect(a.energyShare).toBeGreaterThan(0.4);
    expect(a.energyShare).toBeLessThan(0.6);
    run(a, paceWatts(2, cp), 3600 * 1.5);
    expect(a.bonk).toBe(true);
    expect(a.cap()).toBeLessThan(paceWatts(1, cp) * 1.0);
    // 同じ仕事でも CP を超えた分は余計に減る
    const easy = new Stamina();
    const hard = new Stamina();
    run(easy, 200, 600);
    run(hard, 300, 400);
    expect(hard.energy).toBeLessThan(easy.energy);
  });

  it("食べる・休むで戻る。保存して読み直すと同じ", () => {
    const st = new Stamina();
    st.legs = 100;
    st.energy = 100_000;
    st.eat(250_000);
    expect(st.energy).toBe(350_000);
    st.rest();
    expect(st.legsShare).toBe(1);
    st.eat(10_000_000);
    expect(st.energyShare).toBe(1);
    st.energy = 123_456;
    expect(Stamina.fromJSON(JSON.parse(JSON.stringify(st.toJSON()))).energy).toBe(123_456);
    expect(Stamina.fromJSON(null).energyShare).toBe(1);
  });
});

describe("経路の引き方（配達の草案 14.1）", () => {
  // 100m で 5m 上る道（2m ごとの点）
  const n = 51;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = i * 2;
    pts[i * 3 + 1] = (i / (n - 1)) * 5;
  }
  const road = (cls: 0 | 1 | 2 | 3 | 4) => ({ id: "r", cls, width: 6, surface: "paved", origin: [0, 0], points: pts, length: 100, spans: [], name: "", kind: "main", start: "a", end: "b" }) as Road;

  it("近い = 道のり。坂が少ない = 上る向きだけ重くなる。大きい道 = 等級で変わる", () => {
    const r = road(2);
    expect(segmentCost(r, 0, 100, "short")).toBeCloseTo(100);
    expect(segmentCost(r, 0, 100, "flat")).toBeCloseTo(100 + 25 * 5, 0);
    expect(segmentCost(r, 100, 0, "flat")).toBeCloseTo(100, 0);
    expect(segmentCost(road(0), 0, 100, "main")).toBeLessThan(segmentCost(road(2), 0, 100, "main"));
  });
});
