// 自転車の傷みと整備、自転車店・燃料店の置き場所（配達の草案 29 章）
import { describe, expect, it } from "vitest";
import { CARE_SERVICES, careBlock, careEffects, careFromJSON, FRESH_CARE, serviceCare, wear, worstPart } from "../src/shared/bike-care.ts";
import { parseSave } from "../src/shared/save.ts";
import { BIKE_SIGN, CAR_SIGN, CHAIN_SIGN, isFood, placeRest, REST_LABELS } from "../src/shared/rest-stops.ts";
import { DEFAULT_BIKE, equilibriumSpeed } from "../src/sim/bicycle.ts";
import { SHOP_SIGNS } from "../src/shared/work-places.ts";
import type { Road } from "../src/shared/world/types.ts";

describe("自転車の傷み（配達の草案 29 章）", () => {
  it("1 時間（25km）走ると、空気 63%・チェーン 80%・ブレーキ 88%。0 より下にはならない", () => {
    const c = wear(FRESH_CARE, 25000);
    expect(c.tire).toBeCloseTo(0.625, 6);
    expect(c.chain).toBeCloseTo(0.8, 6);
    expect(c.brake).toBeCloseTo(0.875, 6);
    expect(wear(FRESH_CARE, 1e7)).toEqual({ tire: 0, chain: 0, brake: 0 });
    expect(wear(c, -100)).toEqual(c);
    expect(worstPart(c)).toEqual({ part: "tire", share: 0.625 });
  });

  it("傷むと転がりが重く、推進が減り、ブレーキが効きにくい。平らな道の速さが落ちる", () => {
    expect(careEffects(FRESH_CARE)).toEqual({ crr: 1, drive: 1, brake: 1 });
    const worn = careEffects({ tire: 0.5, chain: 0.5, brake: 0.5 });
    expect(worn.crr).toBeCloseTo(2.5, 6);
    expect(worn.drive).toBeCloseTo(0.9, 6);
    expect(worn.brake).toBeCloseTo(0.775, 6);
    const v0 = equilibriumSpeed(170, 0, DEFAULT_BIKE);
    const v1 = equilibriumSpeed(170 * worn.drive, 0, { ...DEFAULT_BIKE, crr: DEFAULT_BIKE.crr * worn.crr });
    // ふつうの出力で 1 割ほど遅くなる
    expect(v1 / v0).toBeLessThan(0.93);
    expect(v1 / v0).toBeGreaterThan(0.8);
  });

  it("整備: 空気は無料、まとめて点検は全部を直す。直す所が無い・所持金が足りない時は頼めない", () => {
    const c = { tire: 0.4, chain: 0.7, brake: 0.9 };
    const air = CARE_SERVICES.find((s) => s.id === "air")!;
    const all = CARE_SERVICES.find((s) => s.id === "all")!;
    expect(air.price).toBe(0);
    expect(careBlock(air, c, 0)).toBeNull();
    expect(serviceCare(air, c)).toEqual({ tire: 1, chain: 0.7, brake: 0.9 });
    expect(careBlock(all, c, all.price - 1)).toBe("所持金が足りない");
    expect(serviceCare(all, c)).toEqual(FRESH_CARE);
    expect(careBlock(air, FRESH_CARE, 1e6)).toBe("直す所が無い");
    // まとめて頼むと別々より安い
    const sum = CARE_SERVICES.filter((s) => s.id !== "all").reduce((a, s) => a + s.price, 0);
    expect(all.price).toBeLessThan(sum);
  });

  it("保存: 前の保存（傷みの無い物）は整備したてとして読む。壊れた値も直す", () => {
    expect(careFromJSON(undefined)).toEqual(FRESH_CARE);
    expect(careFromJSON({ tire: 0.3, chain: "x", brake: 7 })).toEqual({ tire: 0.3, chain: 1, brake: 1 });
    const base = { version: 1, generator: 1, savedAt: "", pos: null, odometer: 0, climb: 0, time: 0, ridden: {}, stamps: [], settings: {}, outfit: {}, watching: false, adventure: null };
    const old = parseSave(JSON.stringify({ ...base, work: { money: 10, gear: "bag" } }));
    expect(old?.work?.bike).toEqual(FRESH_CARE);
    const now = parseSave(JSON.stringify({ ...base, work: { money: 10, gear: "bag", bike: { tire: 0.5, chain: 0.6, brake: 0.7 } } }));
    expect(now?.work?.bike).toEqual({ tire: 0.5, chain: 0.6, brake: 0.7 });
  });
});

describe("自転車店と燃料店（配達の草案 29 章）", () => {
  it("看板の字が「自転車店」「燃料店」の店を使う（建物の看板と合う）", () => {
    expect(SHOP_SIGNS[BIKE_SIGN]).toBe("自転車店");
    expect(SHOP_SIGNS[CAR_SIGN]).toBe("燃料店");
    expect(SHOP_SIGNS[CHAIN_SIGN]).toBe("食堂");
    expect(isFood("bike")).toBe(false);
    expect(isFood("gyudon")).toBe(true);
  });

  it("置き場所は食べ物の所と同じ決め方", () => {
    const pts = new Float32Array(101 * 3);
    for (let i = 0; i < 101; i++) pts[i * 3] = i * 2;
    const road = { id: "r", cls: 1, width: 8, surface: "paved", origin: [0, 0], points: pts, length: 200, spans: [], name: "", kind: "branch", start: "a", end: "b" } as unknown as Road;
    const st = placeRest("bike", 5, 50, 15, new Map([["r", road]]))!;
    expect(st.name).toBe(REST_LABELS.bike);
    expect(st.z).toBeCloseTo(4.9, 6);
    expect(st.roadZ).toBe(0);
  });
});
