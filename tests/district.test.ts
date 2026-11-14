// 街区（src/render/district）: 同じ入力なら同じ街並み、建物が車道にかからない、敷地が正しい多角形。
import { describe, expect, it } from "vitest";
import type { Kit, Out } from "../src/render/building/kit.ts";
import { Mesher } from "../src/render/building/mesher.ts";
import { buildBuilding } from "../src/render/building/styles.ts";
import { halfWidth } from "../src/render/district/blocks.ts";
import { segDist, signedArea } from "../src/render/district/geom.ts";
import { layoutDistrict } from "../src/render/district/layout.ts";
import { planTown } from "../src/render/district/plan.ts";
import { buildSurface, sampleSurface } from "../src/render/district/surface.ts";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";

function build() {
  const w = new World(WORLD_SEED);
  const reg = w.region({ x0: ORIGIN.x - 1200, z0: ORIGIN.z - 1200, x1: ORIGIN.x + 1200, z1: ORIGIN.z + 1200 });
  const node = reg.nodes.find((n) => n.id === ORIGIN.node)!;
  const plan = planTown(WORLD_SEED, node, reg.roads);
  const surface = buildSurface(plan.boundary, reg.roads, (x, z) => w.terrain.height(x, z));
  return { w, reg, node, plan, surface, layout: layoutDistrict(plan, surface, []) };
}

describe("街区", () => {
  const a = build();

  it("同じ入力から同じ街並みになる", () => {
    const b = build();
    const key = (L: typeof a.layout) => JSON.stringify([L.buildings.map((q) => [q.x, q.z, q.w, q.d, q.h, q.tone]), L.poles.map((p) => [p.x, p.z]), L.lots.map((l) => l.use)]);
    expect(key(b.layout)).toBe(key(a.layout));
  });

  it("街区と敷地ができ、敷地は反時計回りの多角形", () => {
    const L = a.layout;
    expect(L.blocks.length).toBeGreaterThan(30);
    expect(L.buildings.length).toBeGreaterThan(200);
    for (const l of L.lots) {
      expect(l.lot.poly.length).toBeGreaterThanOrEqual(3);
      expect(signedArea(l.lot.poly)).toBeGreaterThan(0);
    }
  });

  it("建物の四隅が、どの街路の車道にもかからない", () => {
    const L = a.layout;
    let worst = Infinity;
    for (const b of L.buildings) {
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const x = b.x + c * u * b.w - s * v * b.d, z = b.z + s * u * b.w + c * v * b.d;
        for (const e of L.graph.edges) {
          const st = L.plan.streets[e.street];
          if (st.kind === "edge") continue;
          const p = L.graph.nodes[e.a], q = L.graph.nodes[e.b];
          worst = Math.min(worst, segDist(x, z, p[0], p[1], q[0], q[1]).d - halfWidth(st));
        }
      }
    }
    expect(worst).toBeGreaterThan(0);
  });

  it("造成した面は、幹線の上で路面の高さに一致する", () => {
    const t = { h: 0, m: 0 };
    let worst = 0;
    for (const r of a.reg.roads) {
      if (r.kind === "cycleway") continue;
      for (let i = 0; i < r.points.length / 3; i += 5) {
        const x = r.points[i * 3] + r.origin[0], z = r.points[i * 3 + 2] + r.origin[1];
        if (Math.hypot(x - a.node.x, z - a.node.z) > a.plan.radius * 0.7) continue;
        if (!sampleSurface(a.surface, x, z, t)) continue;
        worst = Math.max(worst, Math.abs(t.h - r.points[i * 3 + 1]));
      }
    }
    // 面は 8m の格子。歩道と縁石は路面の高さそのものを使う（layoutDistrict の road）ので、ここは地形タイルが路面を突き抜けない程度でよい
    expect(worst).toBeLessThan(0.25);
  });
});

describe("街区の建物の型", () => {
  const L = build().layout;
  const blank: [number, number, number, number] = [0, 0, 1, 1];
  const kinds = ["siding", "plaster", "cedar", "metal", "tile", "seam", "mortar", "tilewall", "lap", "trim", "atlas"] as const;

  it("すべての建物に型があり、家・集合住宅・商店・テナントがそろう", () => {
    const count = new Map<string, number>();
    for (const b of L.buildings) {
      expect(b.style).toBeDefined();
      count.set(b.style!, (count.get(b.style!) ?? 0) + 1);
      // 店の型は幹線沿いの店の敷地だけ
      expect(["shop", "oldshop", "tenant", "strip"].includes(b.style!)).toBe(b.shop === true);
    }
    for (const s of ["house", "oldhouse", "apartment", "mansion", "shop", "oldshop", "tenant"]) expect(count.get(s) ?? 0).toBeGreaterThan(0);
    expect(count.get("house")!).toBeGreaterThan(count.get("mansion")!);
  });

  it("どの建物も形が組み上がり、三角形の数が予算に収まる", () => {
    const out = Object.fromEntries(kinds.map((k) => [k, new Mesher()])) as Out;
    const tex = Object.fromEntries(kinds.map((k) => [k, 1.5])) as Kit["tex"];
    const cell = new Proxy({}, { get: () => blank }) as Kit["atlas"]["cell"];
    const kit = { out, tex, atlas: { texture: null, cell, sign: Array(32).fill(blank), vsign: Array(16).fill(blank), signBg: Array(32).fill([1, 1, 1]) } } as unknown as Kit;
    let worst = 0;
    for (const b of L.buildings) {
      const before = kinds.reduce((n, k) => n + out[k].triangles, 0);
      buildBuilding(kit, b, { x: b.x - L.plan.cx, y: 0, z: b.z - L.plan.cz });
      worst = Math.max(worst, kinds.reduce((n, k) => n + out[k].triangles, 0) - before);
    }
    let total = 0;
    for (const k of kinds) {
      total += out[k].triangles;
      for (const v of out[k].pos) if (!Number.isFinite(v)) throw new Error(`${k}: 位置が数でない`);
      for (const v of out[k].uv) if (!Number.isFinite(v)) throw new Error(`${k}: uv が数でない`);
    }
    // 1 棟あたり平均 250、最大 1200（町 1 つで 11 万以下）
    expect(total / L.buildings.length).toBeLessThan(250);
    expect(worst).toBeLessThan(1200);
  });
});
