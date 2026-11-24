import { describe, expect, it } from "vitest";
import { SIGN_TEXT } from "../src/render/building/atlas-layout.ts";
import { Delivery, errandOrder, HANDOVER_S, KIND_DROP_RANGE, makeOrder, orderReward, parcelOrder, type Place, REGULAR_BONUS, SHOPPING_RANGE, SPOT_REACH, stoppedAt } from "../src/shared/delivery.ts";
import { AddressBook, type AddressPoint } from "../src/shared/world/address.ts";
import { BUILDING_REC, BUILDING_STYLES, type HokkaidoBuildings } from "../src/shared/world/hokkaido.ts";
import type { Road } from "../src/shared/world/types.ts";
import { chomeSpot, ERRAND_WINDOW, errandsNear, FLAG_WINDOW, houseFlag, housesNear, MEAL_SIGNS, roadSpot, SHOP_SIGNS, shopsNear, signOf } from "../src/shared/work-places.ts";
import { walkersNear } from "../src/sim/pedestrians.ts";

/** 東西の道を 120m おきに南北へ並べた格子（各 2,000m、2m ごとの点、幅 8m） */
function streets(): Road[] {
  const out: Road[] = [];
  const n = 1001;
  for (let k = -8; k <= 8; k++) {
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pts[i * 3] = i * 2 - 1000;
    out.push({ id: `r${k}`, cls: 2, width: 8, surface: "paved", origin: [0, k * 120], points: pts, length: 2000, spans: [], name: "", kind: "branch", start: `a${k}`, end: `b${k}` });
  }
  return out;
}

/** 丁目の点（120m 四方の格子の中心） */
function chome(): AddressPoint[] {
  const out: AddressPoint[] = [];
  for (let e = -8; e < 8; e++) for (let n = -8; n < 8; n++) out.push({ name: `c${e}_${n}`, x: e * 120 + 60, z: n * 120 + 60 });
  return out;
}

/** 建物の記録の入れ物の代わり（区画 250m） */
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

/** 看板が sign になる種（(種 >>> 6) % 32） */
const seedFor = (sign: number, k: number) => (k * 32 + sign) << 6;

describe("町の仕事の出どころ（配達の草案 16 章）", () => {
  const roads = streets();

  it("店の業種の並びは看板の文字と同じ", () => {
    expect([...SHOP_SIGNS]).toEqual([...SIGN_TEXT]);
    expect(MEAL_SIGNS.map((i) => SHOP_SIGNS[i])).toEqual(["食堂", "そば処", "寿司", "焼肉", "ラーメン"]);
  });

  it("店と家を建物の記録から拾う", () => {
    const b = fakeBuildings([
      { x: 10, z: 20, style: "shop", seed: seedFor(6, 1) },
      { x: 30, z: 20, style: "shop", seed: seedFor(10, 2) },
      { x: 50, z: 20, style: "house", seed: 777 },
      { x: 400, z: 20, style: "shop", seed: seedFor(19, 3) },
    ]);
    const meals = shopsNear(b, 0, 0, 200, MEAL_SIGNS);
    expect(meals.map((s) => SHOP_SIGNS[s.sign])).toEqual(["そば処"]);
    expect(signOf(seedFor(19, 3))).toBe(19);
    expect(shopsNear(b, 0, 0, 500, MEAL_SIGNS)).toHaveLength(2);
    expect(housesNear(b, 0, 0, 200).map((h) => h.seed)).toEqual([777]);
  });

  it("止まる所はいちばん近い走る道の上の点", () => {
    const s = roadSpot(roads, 33, 45, 50)!;
    expect(s.road).toBe("r0");
    expect(s.x).toBe(32);
    expect(s.z).toBe(0);
    expect(s.d).toBeCloseTo(Math.hypot(1, 45));
    expect(roadSpot(roads, 33, 60.5, 70)!.road).toBe("r1");
    expect(roadSpot(roads, 5000, 0, 40)).toBeNull();
  });

  it("丁目に届ける時は、道の脇がその丁目になる所で止まる（点に近い道の脇が隣の丁目なら、別の道）", () => {
    // A は大きな敷地の中（z = 0 の道から 50m）、B は z = 0 の道のすぐそば。z = 0 の道の脇は B になる
    const pts = [
      { name: "A", x: 0, z: 50 },
      { name: "B", x: 0, z: 10 },
    ];
    const book = new AddressBook(pts);
    const s = chomeSpot(roads, (x, z) => book.at(x, z, 400), pts[0])!;
    expect(s.z).toBe(120);
    expect(Math.abs(s.x)).toBeLessThanOrEqual(2);
    expect(roadSpot(roads, 0, 50, 200)!.z).toBe(0);
    expect(chomeSpot(roads, (x, z) => book.at(x, z, 400), pts[1])!.z).toBe(0);
  });

  it("頼み事の人は道と時刻で決まり、窓が変わると入れ替わる", () => {
    const t = 1_800_000_000;
    const a = errandsNear(roads, 0, 0, 1000, t);
    expect(a.length).toBeGreaterThan(2);
    expect(errandsNear(roads, 0, 0, 1000, t)).toEqual(a);
    for (const e of a) {
      expect(Math.hypot(e.roadX, e.roadZ)).toBeLessThanOrEqual(1000);
      // 道の脇（道の端から 1.3m 外）に立つ
      expect(Math.abs(e.z - e.roadZ)).toBeCloseTo(4 + 1.3, 3);
      expect(e.until).toBeGreaterThan(t);
      expect(e.until - t).toBeLessThanOrEqual(ERRAND_WINDOW);
    }
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    const later = errandsNear(roads, 0, 0, 1000, t + ERRAND_WINDOW * 3);
    expect(later.map((e) => e.id)).not.toEqual(a.map((e) => e.id));
    expect(errandsNear(roads, 0, 0, 1000, t, (x) => x > 0).every((e) => e.roadX > 0)).toBe(true);
  });

  it("旗の立つ家は 1 回の窓で 2% ほど", () => {
    let n = 0;
    for (let seed = 1; seed <= 20000; seed++) if (houseFlag(seed * 7919, 1_800_000_000) !== null) n++;
    expect(n / 20000).toBeGreaterThan(0.014);
    expect(n / 20000).toBeLessThan(0.026);
    // 同じ窓の間は同じ
    const s = 12345;
    const w = houseFlag(s, 1_800_000_000);
    expect(houseFlag(s, 1_800_000_000)).toBe(w);
    expect(FLAG_WINDOW).toBe(1800);
  });

  it("歩く人は道の脇を行き来し、同じ時刻なら同じ所", () => {
    const t = 1_800_000_000;
    const w = walkersNear(roads, 0, 0, 170, t, 0.45, 56);
    expect(w.length).toBeGreaterThan(5);
    expect(w.length).toBeLessThanOrEqual(56);
    expect(walkersNear(roads, 0, 0, 170, t, 0.45, 56)).toEqual(w);
    for (const p of w) {
      const off = Math.abs(p.z - Math.round(p.z / 120) * 120);
      expect(off).toBeGreaterThanOrEqual(4.8 - 1e-4);
      expect(off).toBeLessThanOrEqual(5.5 + 1e-4);
    }
    // 1 秒後に少しだけ動く（立っている人は動かない）
    const w1 = walkersNear(roads, 0, 0, 170, t + 1, 0.45, 200);
    const w0 = walkersNear(roads, 0, 0, 170, t, 0.45, 200);
    const bySeed = new Map(w0.map((p) => [p.seed, p]));
    for (const p of w1) {
      const q = bySeed.get(p.seed);
      if (!q) continue;
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      expect(d).toBeLessThanOrEqual(1.6);
      if (q.still) expect(d).toBe(0);
    }
    expect(walkersNear(roads, 0, 0, 170, t, 0, 56)).toHaveLength(0);
  });
});

describe("頼み事・家からの発送・常連の注文（配達の草案 16 章）", () => {
  const pts = chome();
  const book = new AddressBook(pts);
  const from: Place = { name: "頼んだ人", x: 0, z: 0, kind: "person", id: "e1" };
  const shops: Place[] = [
    { name: "青果店（c1）", x: 300, z: 0, kind: "shop", id: "s1" },
    { name: "酒店（c2）", x: 2000, z: 0, kind: "shop", id: "s2" },
  ];

  it("忘れ物・書類はその場で受け取り、決めた範囲の丁目へ届ける", () => {
    for (const kind of ["forgot", "papers"] as const)
      for (let no = 1; no <= 20; no++) {
        const o = errandOrder(kind, from, pts, shops, no, 5)!;
        expect(o.pickedAtStart).toBe(true);
        expect(o.source).toBe("street");
        expect(o.pickup).toBe(from);
        expect(o.approach).toBe(0);
        expect(o.distance).toBeGreaterThanOrEqual(KIND_DROP_RANGE[kind][0]);
        expect(o.distance).toBeLessThanOrEqual(KIND_DROP_RANGE[kind][1]);
      }
    // 書類は期限が短く報酬が高い
    expect(orderReward(1000, "papers")).toBeGreaterThan(orderReward(1000, "forgot"));
  });

  it("買い物は近くの店で受け取って頼んだ人へ届ける。近くに店が無ければ作らない", () => {
    const o = errandOrder("shopping", from, pts, shops, 1, 5)!;
    expect(o.pickup.id).toBe("s1");
    expect(o.dropoff).toBe(from);
    expect(o.pickedAtStart).toBe(false);
    expect(o.approach).toBeGreaterThanOrEqual(SHOPPING_RANGE[0]);
    expect(errandOrder("shopping", from, pts, [shops[1]], 1, 5)).toBeNull();
  });

  it("家からの発送はその場で受け取り、遠めの丁目へ。届けると結果が出る", () => {
    const house: Place = { name: "家", x: 0, z: 0, kind: "house", id: "h1" };
    const o = parcelOrder(house, pts, 4, 9)!;
    expect(o.kind).toBe("parcel");
    expect(o.distance).toBeGreaterThanOrEqual(KIND_DROP_RANGE.parcel[0]);
    const d = new Delivery(o, 10, 0);
    expect(d.phase).toBe("dropoff");
    expect(d.handover).toBe(HANDOVER_S);
    // 届け先の丁目の中の道で止まる（左右の 3m・9m を見るので、点のすぐ北の東西の道）
    const t = o.dropoff;
    const r = d.update(book, { x: t.x, z: t.z - 5, dx: 1, dz: 0 }, 0, 100, 1500);
    expect(r && r !== "picked" ? r.elapsed : null).toBe(90 + 2 * HANDOVER_S);
  });

  it("店・家・人の前は、止まる所の近くで止まると着いた", () => {
    const p: Place = { name: "店", x: 100, z: 0, kind: "shop", id: "s" };
    expect(stoppedAt(book, p, { x: 100 + SPOT_REACH - 1, z: 0, dx: 1, dz: 0 }, 0)).toBe(true);
    expect(stoppedAt(book, p, { x: 100 + SPOT_REACH + 1, z: 0, dx: 1, dz: 0 }, 0)).toBe(false);
    expect(stoppedAt(book, p, { x: 100, z: 0, dx: 1, dz: 0 }, 2)).toBe(false);
  });

  it("常連の店の注文は報酬が多い。受け取りは渡した店から選ぶ", () => {
    const meal: Place[] = [{ name: "そば処", x: 400, z: 0, kind: "shop", id: "m1" }];
    const app = makeOrder(pts, 0, 0, 2, 7, { pickups: meal })!;
    const reg = makeOrder(pts, 0, 0, 2, 7, { pickups: meal, source: "regular" })!;
    expect(app.pickup.id).toBe("m1");
    expect(reg.source).toBe("regular");
    expect(reg.dropoff).toEqual(app.dropoff);
    expect(Math.abs(reg.reward - app.reward * REGULAR_BONUS)).toBeLessThanOrEqual(10);
  });
});
