// 走行物理の理論値との照合（downhill-3D の tests/physics.test.ts の考え方を移し、登りの釣り合いを足した）。

import { describe, expect, it } from "vitest";
import { DEFAULT_BIKE, DT, equilibriumSpeed, G, integrateSpeed } from "../src/sim/bicycle.ts";

describe("走行物理", () => {
  it("抵抗なしの下りは位置エネルギーの速度になる", () => {
    const grade = -0.08;
    const pure = { ...DEFAULT_BIKE, cda: 0, crr: 0 };
    let v = 0;
    let d = 0;
    for (let i = 0; i < 1200; i++) {
      const r = integrateSpeed(v, grade, 0, 0, DT, pure);
      v = r.speed;
      d += r.distance;
    }
    const expected = Math.sqrt(2 * G * d * -Math.sin(Math.atan(grade)));
    expect(Math.abs(v - expected)).toBeLessThan(0.002);
  });

  it("8% 下りの終端速度", () => {
    const grade = -0.08;
    const p = DEFAULT_BIKE;
    let v = 0;
    for (let i = 0; i < 120 * 240; i++) v = integrateSpeed(v, grade, 0, 0).speed;
    const th = Math.atan(grade);
    const terminal = Math.sqrt((2 * p.mass * G * (-Math.sin(th) - p.crr * Math.cos(th))) / (p.rho * p.cda));
    expect(Math.abs(v - terminal)).toBeLessThan(0.01);
  });

  it("平地 50km/h からブレーキだけで止まる距離", () => {
    const pure = { ...DEFAULT_BIKE, cda: 0, crr: 0 };
    let v = 50 / 3.6;
    let d = 0;
    for (let i = 0; i < 10000 && v > 0; i++) {
      const r = integrateSpeed(v, 0, 1, 0, DT, pure);
      d += r.distance;
      v = r.speed;
    }
    expect(Math.abs(d - (50 / 3.6) ** 2 / (2 * DEFAULT_BIKE.brakeDecel))).toBeLessThan(0.001);
  });

  it("8% 下り 50km/h の制動距離（空気抵抗と転がり抵抗を含む解析解）", () => {
    const p = DEFAULT_BIKE;
    const th = Math.atan(-0.08);
    let v = 50 / 3.6;
    const a = p.brakeDecel + p.crr * G * Math.cos(th) + G * Math.sin(th);
    const b = (p.rho * p.cda) / (2 * p.mass);
    const real = Math.log(1 + (b * v * v) / a) / (2 * b);
    let d = 0;
    for (let i = 0; i < 10000 && v > 0; i++) {
      const r = integrateSpeed(v, -0.08, 1, 0);
      d += r.distance;
      v = r.speed;
    }
    expect(Math.abs(d - real)).toBeLessThan(0.04);
  });

  for (const [watts, grade] of [
    [180, 0.0],
    [180, 0.05],
    [180, 0.1],
    [250, 0.15],
    [120, 0.03],
  ] as const) {
    it(`登りの釣り合いの速度: ${watts}W・勾配 ${grade * 100}%`, () => {
      let v = 0;
      for (let i = 0; i < 120 * 300; i++) v = integrateSpeed(v, grade, 0, watts).speed;
      const eq = equilibriumSpeed(watts, grade);
      expect(Math.abs(v - eq)).toBeLessThan(0.005);
      // 目安: 180W の平地は 30km/h 前後、10% の登りは 7〜9km/h
      if (watts === 180 && grade === 0) expect(v * 3.6).toBeGreaterThan(27);
      if (watts === 180 && grade === 0.1) expect(v * 3.6).toBeGreaterThan(6.5);
    });
  }

  it("止まった状態からは後ろへ動かない", () => {
    let v = 0;
    for (let i = 0; i < 1200; i++) v = integrateSpeed(v, 0.12, 0, 0).speed;
    expect(v).toBe(0);
  });
});
