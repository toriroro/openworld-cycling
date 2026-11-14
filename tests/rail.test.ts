import { describe, expect, it } from "vitest";
import { WORLD_SEED } from "../src/shared/world/constants.ts";
import { railHash, roadsHash } from "../src/shared/world/inspect.ts";
import { RAIL_MAX_GRADE, solveProfile } from "../src/shared/world/rail.ts";
import { circumradius } from "../src/shared/world/shape.ts";
import { World } from "../src/shared/world/world.ts";

// 起点の西の、線路が 1 本通る 16km 四方
const RECT = { x0: -53000, z0: 0, x1: -37000, z1: 16000 };

describe("鉄道の生成（鉄道の草案 L1）", () => {
  const w = new World(WORLD_SEED);
  const lines = w.rail.inRect(RECT);

  it("線路が引かれ、勾配 2.5% と最小曲線半径を守り、駅は 3km 以上離れる", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const P = l.points;
      const n = P.length / 3;
      const ds = l.length / (n - 1);
      for (let i = 1; i < n; i++) expect(Math.abs(P[i * 3 + 1] - P[i * 3 - 2]) / ds).toBeLessThanOrEqual(RAIL_MAX_GRADE + 1e-4);
      const minR = l.kind === "trunk" ? 300 : 200;
      const k = 6;
      for (let i = k; i < n - k; i++) {
        const r = circumradius(P[(i - k) * 3], P[(i - k) * 3 + 2], P[i * 3], P[i * 3 + 2], P[(i + k) * 3], P[(i + k) * 3 + 2]);
        expect(r).toBeGreaterThan(minR * 0.9);
      }
      expect(l.stations[0].s).toBe(0);
      expect(l.stations[l.stations.length - 1].s).toBeCloseTo(l.length, 3);
      for (let k2 = 1; k2 < l.stations.length; k2++) expect(l.stations[k2].s - l.stations[k2 - 1].s).toBeGreaterThanOrEqual(3000 - 1e-6);
      for (const sp of l.spans) {
        expect(sp.from).toBeGreaterThanOrEqual(0);
        expect(sp.to).toBeLessThanOrEqual(l.length + 1e-6);
      }
      for (const c of l.crossings) expect(["level", "over", "under"]).toContain(c.kind);
    }
  }, 120000);

  it("同じ範囲は、問い合わせの順序によらず同じ線路になる。線路を引いても道路は変わらない", () => {
    const w2 = new World(WORLD_SEED);
    // 先に別の所を問い合わせてから
    w2.rail.inRect({ x0: RECT.x0 + 20000, z0: RECT.z0 - 12000, x1: RECT.x1 + 20000, z1: RECT.z1 - 12000 });
    expect(railHash(w2.rail.inRect(RECT))).toBe(railHash(lines));
    const fresh = new World(WORLD_SEED);
    const r = { x0: RECT.x0 + 4000, z0: RECT.z0 + 4000, x1: RECT.x1 - 4000, z1: RECT.z1 - 4000 };
    expect(roadsHash(w.roadsInRect(r))).toBe(roadsHash(fresh.roadsInRect(r)));
  }, 240000);

  it("縦断: 固定点を通り、区間の高さの差は上限以内。両立しない固定点は外す", () => {
    const n = 200;
    const base = new Float64Array(n);
    for (let i = 0; i < n; i++) base[i] = 40 * Math.sin(i / 15);
    const lim = new Float64Array(n).fill(0.5);
    const pins = new Map([
      [0, 0],
      [80, 10],
      [82, 30], // 80 から 2 区間で 20m は届かない → 外す
      [199, 5],
    ]);
    const { y, dropped } = solveProfile(base, lim, pins);
    expect(dropped.has(82)).toBe(true);
    expect(y[0]).toBe(0);
    expect(y[80]).toBe(10);
    expect(y[199]).toBe(5);
    for (let i = 1; i < n; i++) expect(Math.abs(y[i] - y[i - 1])).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});
