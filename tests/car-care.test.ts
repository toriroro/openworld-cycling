// 自分の車の燃料と傷み（D7b。配達の草案 34 章）
import { describe, expect, it } from "vitest";
import { CAR_SERVICES, carEffects, carFromJSON, carServiceBlock, carServicePrice, driveWear, FUEL_PRICE, freshCar, KM_PER_L, RESCUE, rescueCar, serviceCar, TANK, worstCarPart } from "../src/shared/car-care.ts";

const svc = (id: string) => CAR_SERVICES.find((s) => s.id === id)!;

describe("車の燃料と傷み（D7b）", () => {
  it("1km あたりの燃料は軽自動車で約 9 円。満タンで軽自動車 540km・軽バン 490km", () => {
    expect(FUEL_PRICE / KM_PER_L.kei).toBeCloseTo(9.44, 1);
    expect(TANK.kei * KM_PER_L.kei).toBe(540);
    expect(TANK.van * KM_PER_L.van).toBe(490);
    const c = driveWear(freshCar("kei"), "kei", 90_000);
    expect(c.fuel).toBeCloseTo(25, 6);
    expect(c.tire).toBeCloseTo(0.865, 6);
    expect(driveWear(freshCar("kei"), "kei", 1e9)).toEqual({ fuel: 0, tire: 0, oil: 0, brake: 0 });
    expect(worstCarPart(c).part).toBe("tire");
  });

  it("傷むと加速とブレーキが弱くなる", () => {
    expect(carEffects(freshCar("van"))).toEqual({ accel: 1, brake: 1 });
    const e = carEffects({ fuel: 10, tire: 0, oil: 0, brake: 0 });
    expect(e.accel).toBeCloseTo(0.525, 6);
    expect(e.brake).toBeCloseTo(0.55, 6);
  });

  it("給油は満タンまでの量の値段。まとめて点検は給油も足す。直す所が無い・資金が足りない時は頼めない", () => {
    const c = { fuel: 10, tire: 0.5, oil: 0.9, brake: 1 };
    expect(carServicePrice(svc("fuel"), c, "kei")).toBe(20 * FUEL_PRICE);
    expect(carServicePrice(svc("all"), c, "kei")).toBe(9000 + 20 * FUEL_PRICE);
    expect(carServiceBlock(svc("fuel"), c, "kei", 100)).toBe("資金が足りない");
    expect(serviceCar(svc("fuel"), c, "kei").fuel).toBe(30);
    expect(serviceCar(svc("all"), c, "kei")).toEqual(freshCar("kei"));
    expect(carServiceBlock(svc("air"), freshCar("kei"), "kei", 1e6)).toBe("直す所が無い");
    expect(carServiceBlock(svc("fuel"), freshCar("kei"), "kei", 1e6)).toBe("直す所が無い");
    expect(carServiceBlock(svc("air"), c, "kei", 0)).toBeNull();
  });

  it("燃料が尽きたら呼んで 10L 入れてもらう。保存の壊れた値は満タン", () => {
    expect(rescueCar({ fuel: 0, tire: 1, oil: 1, brake: 1 }, "kei").fuel).toBe(RESCUE.liters);
    expect(carFromJSON(undefined, "van")).toEqual(freshCar("van"));
    expect(carFromJSON({ fuel: 99, tire: -1, oil: "x" }, "kei")).toEqual({ fuel: 30, tire: 0, oil: 1, brake: 1 });
  });
});

describe("車の付け替え（D7c）", () => {
  it("荷室の棚は 1 回だけ。冬タイヤは雪の天候が入るまで付けられない。塗装は今と違う色だけ", async () => {
    const { applyMod, modBlock, modsFromJSON, NO_MODS, SHELF } = await import("../src/shared/car-care.ts");
    expect(modBlock("shelf", NO_MODS, SHELF.price - 1)).toBe("資金が足りない");
    expect(modBlock("shelf", NO_MODS, SHELF.price)).toBeNull();
    const m = applyMod("shelf", NO_MODS);
    expect(m.shelf).toBe(true);
    expect(modBlock("shelf", m, 1e9)).toBe("付いている");
    expect(modBlock("winter", NO_MODS, 1e9)).toBe("雪の天候が入ってから");
    expect(modBlock("paint:", NO_MODS, 1e9)).toBe("この色に塗ってある");
    const red = applyMod("paint:#c8323f", m);
    expect(red).toEqual({ shelf: true, winter: false, paint: "#c8323f" });
    expect(modBlock("paint:#c8323f", red, 1e9)).toBe("この色に塗ってある");
    expect(applyMod("paint:", red).paint).toBeNull();
    expect(modsFromJSON({ shelf: true, paint: "#123456" })).toEqual({ shelf: true, winter: false, paint: null });
  });
});
