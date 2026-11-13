// 大きな川の網（河川の草案 3〜4 章、段階 R1）の検査。
import { describe, expect, it } from "vitest";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { checkGrades, checkRadius, riversHash, roadHash } from "../src/shared/world/inspect.ts";
import { RIVER_BLOCK_SIZE, RIVER_GRID, RIVER_MIN_ACC, RIVER_SEG_MARGIN, type RiverSeg } from "../src/shared/world/rivers.ts";
import { Terrain } from "../src/shared/world/terrain.ts";
import { type Rect, World } from "../src/shared/world/world.ts";

const R = 40000;
const AREA = { x0: ORIGIN.x - R, z0: ORIGIN.z - R, x1: ORIGIN.x + R, z1: ORIGIN.z + R };

describe("川の網", () => {
  const t = new Terrain(WORLD_SEED);
  const { segs, lakes } = t.rivers.inRect(AREA.x0, AREA.z0, AREA.x1, AREA.z1);
  const byCell = new Map(segs.map((s) => [`${s.i}_${s.j}`, s]));

  it("川の線ができ、海へ出る川と湖がある", () => {
    expect(segs.length).toBeGreaterThan(100);
    expect(segs.some((s) => s.toSea)).toBe(true);
    expect(lakes.length).toBeGreaterThan(0);
  });

  it("川のハッシュ（生成器の変更を検出する固定値）", () => {
    expect(riversHash(segs, lakes)).toMatchInlineSnapshot(`"e5806b90"`);
  });

  it("別の順序・別の起点から計算しても同じ川の線になる", () => {
    const t2 = new Terrain(WORLD_SEED);
    // 遠い所から先に、逆の順序で
    t2.rivers.inRect(AREA.x1 + 50000, AREA.z1 + 50000, AREA.x1 + 60000, AREA.z1 + 60000);
    const quads: Rect[] = [
      { x0: ORIGIN.x, z0: ORIGIN.z, x1: AREA.x1, z1: AREA.z1 },
      { x0: AREA.x0, z0: AREA.z0, x1: ORIGIN.x, z1: ORIGIN.z },
    ];
    for (const q of quads) t2.rivers.inRect(q.x0, q.z0, q.x1, q.z1);
    const r2 = t2.rivers.inRect(AREA.x0, AREA.z0, AREA.x1, AREA.z1);
    expect(riversHash(r2.segs, r2.lakes)).toBe(riversHash(segs, lakes));
  });

  it("川は途切れない: 海・湖で終わるか、下流の格子から川が続く。本流の幅は下流で急に縮まない", () => {
    for (const s of segs) {
      if (s.toSea || s.toLake) continue;
      const next = byCell.get(`${s.di}_${s.dj}`);
      if (!next) {
        // 範囲の外へ出た川だけは確かめられない
        const [x, z] = [s.x[s.n - 1], s.z[s.n - 1]];
        expect(x < AREA.x0 + 12000 || x > AREA.x1 - 12000 || z < AREA.z0 + 12000 || z > AREA.z1 - 12000, `${s.i}_${s.j}`).toBe(true);
        continue;
      }
      expect(next.acc).toBeGreaterThanOrEqual(RIVER_MIN_ACC);
      // 水面の高さは格子点でつながる
      expect(next.w[0]).toBe(s.w[s.n - 1]);
      // 位置もつながる
      expect(next.x[0]).toBe(s.x[s.n - 1]);
      expect(next.z[0]).toBe(s.z[s.n - 1]);
    }
  });

  it("水面の高さは上流から下流へ上がらず、海へ出る川は 0 で終わる", () => {
    for (const s of segs) {
      for (let p = 1; p < s.n; p++) expect(s.w[p]).toBeLessThanOrEqual(s.w[p - 1]);
      if (s.toSea) expect(s.w[s.n - 1]).toBe(0);
    }
  });

  it("川の線と影響の範囲は、元の格子から RIVER_SEG_MARGIN 格子の内に収まる（ブロックの境で高さが変わらない前提）", () => {
    const check = (s: RiverSeg) => {
      expect(s.x0).toBeGreaterThanOrEqual((s.i - RIVER_SEG_MARGIN) * RIVER_GRID);
      expect(s.x1).toBeLessThan((s.i + 1 + RIVER_SEG_MARGIN) * RIVER_GRID);
      expect(s.z0).toBeGreaterThanOrEqual((s.j - RIVER_SEG_MARGIN) * RIVER_GRID);
      expect(s.z1).toBeLessThan((s.j + 1 + RIVER_SEG_MARGIN) * RIVER_GRID);
    };
    for (const s of segs) check(s);
    for (const l of lakes) {
      const [cx, cz] = t.rivers.cellPos(l.i, l.j);
      expect(Math.abs(l.x - cx) + l.r).toBeLessThan(RIVER_SEG_MARGIN * RIVER_GRID);
      expect(Math.abs(l.z - cz) + l.r).toBeLessThan(RIVER_SEG_MARGIN * RIVER_GRID);
    }
  });
});

describe("高さ関数への組み込み", () => {
  const t = new Terrain(WORLD_SEED);
  const { segs } = t.rivers.inRect(AREA.x0, AREA.z0, AREA.x1, AREA.z1);

  it("ブロックの境で高さが連続する", () => {
    const b0 = Math.ceil(AREA.x0 / RIVER_BLOCK_SIZE) * RIVER_BLOCK_SIZE;
    let maxJump = 0;
    for (let bx = b0; bx < AREA.x1; bx += RIVER_BLOCK_SIZE)
      for (let z = AREA.z0; z < AREA.z1; z += 37) {
        const a = t.routeHeight(bx - 0.001, z);
        const b = t.routeHeight(bx, z);
        maxJump = Math.max(maxJump, Math.abs(a - b));
      }
    expect(maxJump).toBeLessThan(0.05);
  });

  it("川の水面の内側の地面は水面より低く、河原の地面は水面との差が小さい", () => {
    let inWater = 0;
    for (const s of segs.slice(0, 120)) {
      for (let p = 1; p < s.n - 1; p += 5) {
        const sm = t.sample(s.x[p], s.z[p], true);
        if (sm.water === 1) continue;
        expect(sm.water).toBe(3);
        expect(sm.height).toBeLessThan(sm.waterLevel);
        inWater++;
      }
    }
    expect(inWater).toBeGreaterThan(200);
  });

  it("削った高さは下地以下（堤防を除く）", () => {
    for (const s of segs.slice(0, 60)) {
      const p = s.n >> 1;
      for (let d = -400; d <= 400; d += 25) {
        const x = s.x[p] + d;
        const z = s.z[p] + d * 0.5;
        const base = t.baseHeight(x, z);
        const rh = t.routeHeight(x, z);
        expect(rh).toBeLessThanOrEqual(base + 6.0001);
      }
    }
  });
});

describe("道路と川（12km 四方）", () => {
  const RECT: Rect = { x0: ORIGIN.x - 6000, z0: ORIGIN.z - 6000, x1: ORIGIN.x + 6000, z1: ORIGIN.z + 6000 };
  const w = new World(WORLD_SEED);
  const roads = w.roadsInRect(RECT);

  it("川の水面の上を通る道路の点はすべて橋の区間にある", () => {
    let crossings = 0;
    for (const r of roads) {
      const n = r.points.length / 3;
      const ds = r.length / (n - 1);
      for (let i = 0; i < n; i++) {
        const x = r.points[i * 3] + r.origin[0];
        const z = r.points[i * 3 + 2] + r.origin[1];
        if (w.terrain.sample(x, z, false).water !== 3) continue;
        const s = i * ds;
        expect(r.spans.some((sp) => s >= sp.from - 1 && s <= sp.to + 1), `${r.id} ${s.toFixed(0)}`).toBe(true);
        crossings++;
      }
    }
    expect(crossings).toBeGreaterThan(0);
  });

  it("結節点は川の河原と湖の中に置かれない", () => {
    for (const n of w.nodesInRect({ x0: AREA.x0, z0: AREA.z0, x1: AREA.x1, z1: AREA.z1 })) {
      const s = w.terrain.sample(n.x, n.z, false);
      expect(s.floodplain, n.id).toBe(false);
      expect(s.water, n.id).toBe(0);
    }
  });
});

describe("河川敷の自転車道（大きな川の下流 16km 四方）", () => {
  const RECT: Rect = { x0: -68000, z0: 42500, x1: -52000, z1: 58500 };
  const w = new World(WORLD_SEED);
  const reg = w.region(RECT);
  const cy = reg.roads.filter((r) => r.kind === "cycleway");

  it("自転車道ができ、等級（幅 3m・5%・R15）を守る", () => {
    expect(cy.length).toBeGreaterThan(3);
    for (const r of cy) {
      expect(r.cls).toBe(4);
      expect(r.width).toBe(3);
    }
    expect(checkGrades(cy).over).toBe(0);
    expect(checkRadius(cy, 6, 0.8).under).toBe(0);
  });

  it("両端は橋のたもとで道路につながる（河口で終わる端だけ行き止まり）", () => {
    const byId = new Map(reg.junctions.map((j) => [j.id, j]));
    const inRegion = new Set(reg.roads.map((r) => r.id));
    let checked = 0;
    for (const r of cy) {
      const att = w.attachments.get(r.id);
      for (const [jid, at] of [
        [r.start, att?.start],
        [r.end, att?.end],
      ] as const) {
        if (jid.startsWith("e_")) {
          expect(jid).toBe(r.end);
          expect(r.id.endsWith("~mouth")).toBe(true);
          continue;
        }
        // 取り付けが無いのは、道路の端（結節点・合流点）につながる場合
        if (!at) continue;
        // 取り付け先の道路が範囲の外なら、この範囲では確かめられない
        if (!inRegion.has(at.road)) continue;
        const j = byId.get(jid)!;
        expect(j.arms.some((a) => a.road === at.road), `${r.id} ${jid}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("別の順序・別の範囲から生成しても同じ自転車道になる", () => {
    const w2 = new World(WORLD_SEED);
    w2.roadsInRect({ x0: RECT.x0 + 8000, z0: RECT.z0 + 8000, x1: RECT.x1 + 4000, z1: RECT.z1 + 4000 });
    w2.roadsInRect({ x0: RECT.x0, z0: RECT.z0, x1: RECT.x0 + 5000, z1: RECT.z0 + 5000 });
    const r2 = new Map(w2.roadsInRect(RECT).map((r) => [r.id, r]));
    expect(r2.size).toBe(reg.roads.length);
    for (const r of reg.roads) expect(roadHash(r2.get(r.id)!), r.id).toBe(roadHash(r));
  });
});
