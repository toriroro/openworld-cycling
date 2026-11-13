import { describe, expect, it } from "vitest";
import { roadHash } from "../src/shared/world/inspect.ts";
import { Terrain } from "../src/shared/world/terrain.ts";
import { type Rect, World } from "../src/shared/world/world.ts";
import { RoadNetwork, sampleRoad } from "../src/sim/road-network.ts";
import { RouteFollower } from "../src/sim/route-follower.ts";
import { buildTile, ROAD_CLEAR } from "../src/workers/terrain-tile.ts";

const RECT: Rect = { x0: -36000, z0: 7000, x1: -28000, z1: 15000 };

describe("World.prune", () => {
  it("捨てて作り直しても同じ道路になる", () => {
    const w = new World(6);
    const a = new Map(w.roadsInRect(RECT).map((r) => [r.id, roadHash(r)]));
    w.prune({ x0: 100000, z0: 100000, x1: 100001, z1: 100001 });
    const b = w.roadsInRect(RECT);
    expect(b.length).toBe(a.size);
    for (const r of b) expect(roadHash(r)).toBe(a.get(r.id));
  });
});

describe("道路網に沿って進む", () => {
  const w = new World(6);
  const reg = w.region(RECT);
  const net = new RoadNetwork();
  for (const r of reg.roads) net.addRoad(r);
  for (const j of reg.junctions) net.addJunction(j);

  it("接続点を越えて進み、記録した道を逆にたどると元の位置へ戻る", () => {
    const start = reg.roads.find((r) => r.id.startsWith("n_-9_2") && r.kind === "main")!;
    const f = new RouteFollower(net, { road: start.id, s: 10, dir: 1 });
    f.startRecording();
    const left = f.advance(6000);
    expect(left).toBe(0);
    expect(f.legs.length).toBeGreaterThan(1);
    const end = { ...f.pos };
    f.followPlan(f.legs, true);
    while (!f.planDone) f.advance(500);
    expect(f.pos.road).toBe(start.id);
    expect(f.pos.s).toBeCloseTo(10, 6);
    // もう一度進むと同じ終点
    f.followPlan(f.legs, false);
    while (!f.planDone) f.advance(500);
    expect(f.pos.road).toBe(end.road);
    expect(f.pos.s).toBeCloseTo(end.s, 6);
  });
});

describe("地形タイル", () => {
  it("路面の下の頂点は路面より ROAD_CLEAR 以上低い", () => {
    const w = new World(6);
    const t = new Terrain(6);
    const size = 256;
    const tile = { x0: -32768, z0: 11008 };
    const roads = w.roadsInRect({ x0: tile.x0 - 100, z0: tile.z0 - 100, x1: tile.x0 + size + 100, z1: tile.z0 + size + 100 });
    expect(roads.length).toBeGreaterThan(0);
    const pts: number[] = [];
    const starts: number[] = [];
    for (const r of roads) {
      starts.push(pts.length / 5);
      for (let i = 0; i < r.points.length / 3; i++)
        pts.push(r.points[i * 3] + r.origin[0] - tile.x0, r.points[i * 3 + 2] + r.origin[1] - tile.z0, r.points[i * 3 + 1], r.width / 2, 0);
    }
    starts.push(pts.length / 5);
    const out = buildTile(t, { ...tile, size, cells: 32, skirt: 6, roads: { pts: Float32Array.from(pts), starts: Int32Array.from(starts) }, uvRepeat: 16 });
    // 道路の中心線上の点で、その点を含む格子の4頂点が路面より低いこと
    const step = size / 32;
    let checked = 0;
    for (const r of roads) {
      for (let s = 0; s < r.length; s += 3) {
        const p = sampleRoad(r, s);
        const lx = p.x - tile.x0, lz = p.z - tile.z0;
        if (lx < 0 || lz < 0 || lx >= size || lz >= size) continue;
        const i = Math.floor(lx / step), j = Math.floor(lz / step);
        for (const [a, b] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) {
          const y = out.position[(b * 33 + a) * 3 + 1];
          expect(y).toBeLessThanOrEqual(p.y - ROAD_CLEAR + 0.05);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
