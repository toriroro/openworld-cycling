// 体力を戻す所（配達の草案 28 章）: 置き場所・品書き・買えるか
import { describe, expect, it } from "vitest";
import { Stamina } from "../src/shared/stamina.ts";
import { CHAIN_NAMES, CHAIN_SIGN, chainOf, hasVending, placeRest, REST_MENU, REST_STOP_RANGE, restBlock, restStopAt, restStopsNear, type RestStop } from "../src/shared/rest-stops.ts";
import { BUILDING_REC, BUILDING_STYLES, type HokkaidoBuildings } from "../src/shared/world/hokkaido.ts";
import type { Road } from "../src/shared/world/types.ts";
import { signOf } from "../src/shared/work-places.ts";

/** 東西の道を 120m おきに並べる（各 2,000m、2m ごとの点、幅 8m） */
function streets(): Map<string, Road> {
  const out = new Map<string, Road>();
  const n = 1001;
  for (let k = -4; k <= 4; k++) {
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pts[i * 3] = i * 2 - 1000;
    out.set(`r${k}`, { id: `r${k}`, cls: 1, width: 8, surface: "paved", origin: [0, k * 120], points: pts, length: 2000, spans: [], name: "", kind: "branch", start: `a${k}`, end: `b${k}` });
  }
  return out;
}

function fakeBuildings(recs: { x: number; z: number; style: (typeof BUILDING_STYLES)[number]; seed: number }[]): HokkaidoBuildings {
  const cell = 250;
  const data = new Float32Array(recs.length * BUILDING_REC);
  const cells: Record<string, [number, number]> = {};
  const sorted = [...recs].sort((a, b) => Math.floor(a.x / cell) - Math.floor(b.x / cell) || Math.floor(a.z / cell) - Math.floor(b.z / cell));
  sorted.forEach((r, i) => {
    const o = i * BUILDING_REC;
    data[o] = r.x;
    data[o + 1] = r.z;
    data[o + 12] = BUILDING_STYLES.indexOf(r.style);
    data[o + 15] = r.seed;
    const k = `${Math.floor(r.x / cell)},${Math.floor(r.z / cell)}`;
    if (cells[k]) cells[k][1]++;
    else cells[k] = [i, 1];
  });
  return { index: { cell, rec: BUILDING_REC, cells }, data, cell: (cx: number, cz: number) => cells[`${cx},${cz}`] ?? null } as unknown as HokkaidoBuildings;
}

/** 看板が sign になる種 */
const seedFor = (sign: number, k: number) => (k * 32 + sign) << 6;
/** 自販機がある・無い種（看板は食堂でない） */
function vendingSeed(want: boolean, from = 1): number {
  for (let s = from; ; s++) if (signOf(s) !== CHAIN_SIGN && hasVending(s) === want) return s;
}

describe("体力を戻す所（配達の草案 28 章）", () => {
  const roads = streets();

  it("看板が食堂の店だけがチェーンの店になり、牛丼屋と定食屋の両方が出る", () => {
    const kinds = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const c = chainOf(seedFor(CHAIN_SIGN, k));
      expect(c).not.toBeNull();
      kinds.add(c!);
    }
    expect([...kinds].sort()).toEqual(["gyudon", "teishoku"]);
    expect(chainOf(seedFor(6, 3))).toBeNull();
    expect(CHAIN_NAMES.gyudon).toBe("牛丼 たつ屋");
  });

  it("自販機は建物のおよそ 3.5%", () => {
    let n = 0;
    for (let s = 1; s <= 20000; s++) if (hasVending(s)) n++;
    expect(n / 20000).toBeGreaterThan(0.028);
    expect(n / 20000).toBeLessThan(0.042);
  });

  it("置き場所は道の端の外の歩道で、建物の側。止まる所は道の上", () => {
    // 道 r0（z = 0）の北 12m の建物
    const st = placeRest("vending", 99, 40, -12, roads)!;
    expect(st.road).toBe("r0");
    expect(st.roadX).toBe(40);
    expect(st.roadZ).toBe(0);
    expect(st.fz).toBeCloseTo(-1, 6);
    // 道の幅の半分（4m）＋ 0.9m。建物の中心までの半分（6m）より手前
    expect(st.z).toBeCloseTo(-4.9, 6);
    expect(placeRest("gyudon", 99, 40, -45, roads)).toBeNull();
  });

  it("建物の記録から、自販機と店を拾う。範囲の外と道の遠い建物は入れない", () => {
    const chain = seedFor(CHAIN_SIGN, 2);
    const vend = vendingSeed(true);
    const none = vendingSeed(false);
    const b = fakeBuildings([
      { x: 10, z: 12, style: "shop", seed: chain },
      { x: 60, z: 110, style: "house", seed: vend },
      { x: 90, z: 12, style: "house", seed: none },
      { x: 30, z: 60, style: "house", seed: vendingSeed(true, vend + 1) },
      { x: 900, z: 12, style: "shop", seed: seedFor(CHAIN_SIGN, 5) },
    ]);
    const cache = new Map<number, RestStop | null>();
    const list = restStopsNear(b, roads, 0, 0, 300, (x) => x < 500, cache);
    expect(list.map((s) => s.kind).sort()).toEqual([chainOf(chain), "vending"].sort());
    // 道から 60m の建物は覚えて、次から探さない
    expect(cache.size).toBe(3);
    expect(restStopsNear(b, roads, 0, 0, 300, (x) => x < 500, cache)).toEqual(list);
  });

  it("止まって買えるのは止まる所の近くだけ。いちばん近い所", () => {
    const a = placeRest("vending", 1, 40, -12, roads)!;
    const c = placeRest("teishoku", 2, 52, -12, roads)!;
    expect(restStopAt([a, c], 41, 0)?.id).toBe(a.id);
    expect(restStopAt([a, c], 51, 0)?.id).toBe(c.id);
    expect(restStopAt([a], 40 + REST_STOP_RANGE.vending + 1, 0)).toBeNull();
  });

  it("買えるか: 所持金と体力。店で食べると脚も戻る", () => {
    const nami = REST_MENU.gyudon[0];
    const water = REST_MENU.vending[0];
    expect(restBlock(nami, 400, 0.5, 0.5)).toBe("所持金が足りない");
    expect(restBlock(nami, 1000, 0.5, 0.5)).toBeNull();
    expect(restBlock(water, 1000, 1, 0.2)).toBe("体力は 100%");
    expect(restBlock(nami, 1000, 1, 0.2)).toBeNull();
    expect(restBlock(nami, 1000, 1, 1)).toBe("体力は 100%");
    const st = new Stamina();
    st.energy = st.p.energy * 0.2;
    st.legs = 0;
    st.refill(nami.energy, nami.legs);
    expect(st.energyShare).toBeCloseTo(0.5, 6);
    expect(st.legsShare).toBe(1);
    st.refill(10);
    expect(st.energyShare).toBe(1);
  });

  it("品書き: 自販機は安くすぐ、定食は高くて多く戻り時間がかかる", () => {
    for (const it of REST_MENU.vending) expect(it.seconds).toBeLessThanOrEqual(30);
    const best = (k: keyof typeof REST_MENU) => Math.max(...REST_MENU[k].map((i) => i.energy));
    expect(best("teishoku")).toBeGreaterThan(best("gyudon"));
    expect(best("gyudon")).toBeGreaterThan(best("vending"));
    for (const it of [...REST_MENU.gyudon, ...REST_MENU.teishoku]) expect(it.legs).toBe(true);
  });
});
