// 接続点を通る線（cornerCurve）。道幅の変わる所などで、ほぼまっすぐ進む時に線が行き過ぎて戻らない（配達の草案 27 章）

import { describe, expect, it } from "vitest";
import { cornerCurve } from "../src/sim/junction-shape.ts";

/** 線のどの区間も、入る向き・出る向きの両方に前へ進むか */
function forwardOnly(pts: { x: number; z: number }[], d0: [number, number], d1: [number, number]) {
  for (let i = 1; i < pts.length; i++) {
    const mx = pts[i].x - pts[i - 1].x;
    const mz = pts[i].z - pts[i - 1].z;
    if (mx * d0[0] + mz * d0[1] <= 0 || mx * d1[0] + mz * d1[1] <= 0) return false;
  }
  return true;
}

describe("接続点を通る線", () => {
  it("ほぼ同じ向きで横にずれる時（道幅の変わる所）も、線は前へだけ進む", () => {
    // 36m 先で左右に 1.5m ずれ、出る向きが 2° ほど傾く（入る向きとの外積が 1e-3 より大きい）
    for (const [lat, deg] of [
      [1.5, 2],
      [-1.5, 2],
      [1.5, -3],
      [0.8, 5],
    ]) {
      const a = (deg * Math.PI) / 180;
      const d1: [number, number] = [Math.cos(a), Math.sin(a)];
      const pts = cornerCurve({ x: 0, y: 0, z: 0 }, 1, 0, { x: 36, y: 0, z: lat }, d1[0], d1[1], 24);
      expect(forwardOnly(pts, [1, 0], d1), `${lat} ${deg}`).toBe(true);
    }
  });

  it("直角に曲がる線は、角の内側を回って前へ進む", () => {
    const pts = cornerCurve({ x: 0, y: 0, z: 0 }, 1, 0, { x: 10, y: 0, z: 10 }, 0, 1, 16);
    expect(pts[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(pts[16].x).toBeCloseTo(10, 6);
    expect(pts[16].z).toBeCloseTo(10, 6);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].x - pts[i - 1].x).toBeGreaterThanOrEqual(-1e-9);
      expect(pts[i].z - pts[i - 1].z).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});
