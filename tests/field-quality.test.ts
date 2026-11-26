// 町の見た目の点検で直した所（2026-11-26）: 標識の柱をまとめる、小道の切れ端、歩く人の多さと足元、歩道の上面の高さ。
import { describe, expect, it } from "vitest";
import { pathStubs } from "../src/render/city-build.ts";
import { stackRegulation } from "../src/render/real-signs.ts";
import { SIGN_REC, SIGN_TYPES, type HokkaidoSidewalks, type StreetPiece } from "../src/shared/world/hokkaido.ts";
import type { Road } from "../src/shared/world/types.ts";
import { crowdFactor, walkersNear } from "../src/sim/pedestrians.ts";
import { heightOnRun, sidewalkHeightAt } from "../src/sim/walk-surface.ts";

function signs(list: [number, number, number][]): Float32Array {
  const D = new Float32Array(list.length * SIGN_REC);
  list.forEach(([x, z, type], i) => {
    const o = i * SIGN_REC;
    D[o] = x;
    D[o + 2] = z;
    D[o + 3] = 1;
    D[o + 5] = type;
  });
  return D;
}

describe("標識の柱をまとめる", () => {
  it("同じ所の横断歩道と進入禁止は 1 本の柱に上下に並べ、離れた標識はそのまま", () => {
    const D = signs([
      [0, 0, SIGN_TYPES.crosswalk],
      [0.05, 0, SIGN_TYPES.noEntry],
      [10, 0, SIGN_TYPES.stop],
      [10.3, 0.2, SIGN_TYPES.oneway],
      [30, 0, SIGN_TYPES.speed],
    ]);
    const st = stackRegulation(D, [0, 1, 2, 3, 4]);
    // 進入禁止が上、横断歩道が下。柱は 1 本
    expect(st.get(1)).toMatchObject({ post: true });
    expect(st.get(0)).toMatchObject({ post: false, at: 1 });
    const up = st.get(1)!.y, down = st.get(0)!.y;
    expect(up - down).toBeGreaterThanOrEqual(0.6 + 0.05 - 1e-6);
    // 止まれ（0.8m）の下に一方通行（0.9m）
    expect(st.get(2)!.post).toBe(true);
    expect(st.get(2)!.y - st.get(3)!.y).toBeCloseTo(0.4 + 0.05 + 0.45, 6);
    expect(st.get(3)!.y - 0.45).toBeGreaterThan(0.8);
    expect(st.has(4)).toBe(false);
  });
});

describe("小道の切れ端", () => {
  it("短くて端が何にもつながらない小道だけ描かない", () => {
    // 小道: 0 短い切れ端（6m）、2 走る道に出る短い小道（もう一方の端は宙）、4 と 6 区画の境で 2 つに切れた 10m の小道（両端は宙）、
    // 8 長い小道（40m）。10 は車の道
    const P2 = new Float32Array([0, 0, 6, 0, 100, 0, 106, 0, 200, 0, 205, 0, 205, 0, 210, 0, 300, 0, 340, 0, 400, 0, 403, 0]);
    const pieces: StreetPiece[] = [
      [0, 2, 20, 1],
      [2, 2, 20, 1, 1],
      [4, 2, 20, 1],
      [6, 2, 20, 1],
      [8, 2, 20, 1],
      [10, 2, 50, 0],
    ];
    const out = pathStubs(P2, pieces);
    expect(out.has(0)).toBe(true);
    expect(out.has(2)).toBe(true);
    // 切れた 2 つは、つながる端のほかに宙の端があるので消える（合わせても 10m の切れ端）
    expect(out.has(4)).toBe(true);
    expect(out.has(6)).toBe(true);
    expect(out.has(8)).toBe(false);
    expect(out.has(10)).toBe(false);
  });

  it("両端がほかの道につながる短い小道は残す", () => {
    // 車の道 2 本（x=0 と x=10 の南北）の間をつなぐ 10m の小道
    const P = new Float32Array([0, -50, 0, 50, 10, -50, 10, 50, 0, 0, 10, 0]);
    const pieces: StreetPiece[] = [
      [0, 2, 50, 0],
      [2, 2, 50, 0],
      [4, 2, 20, 1],
    ];
    expect(pathStubs(P, pieces).size).toBe(0);
  });
});

/** x 方向に 100m、幅 4m の歩道の帯 1 本（内側 z=5、外側 z=9。高さは x=0 で 10、x=100 で 12） */
function sidewalk(): HokkaidoSidewalks {
  const pts: number[] = [];
  for (let i = 0; i <= 10; i++) pts.push(i * 10, 5, i * 10, 9, 10 + i * 0.2);
  return { index: { cell: 250, rec: 5, sidewalks: { "0,0": [[0, 11]] }, trees: {}, poles: {}, signs: {} }, pts: new Float32Array(pts) } as unknown as HokkaidoSidewalks;
}

describe("歩道の上面の高さ", () => {
  it("帯の中なら点の間で移した高さ、外なら null", () => {
    const sw = sidewalk();
    expect(sidewalkHeightAt(sw, 55, 7)).toBeCloseTo(11.1, 6);
    expect(sidewalkHeightAt(sw, 55, 4)).toBeNull();
    expect(sidewalkHeightAt(sw, 120, 7)).toBeNull();
    expect(heightOnRun(sw.pts, [0, 11], 0, 5)).toBeCloseTo(10, 6);
  });
});

describe("歩く人の多さと足元", () => {
  it("込み具合の倍率は都心で多く、住宅街で少なく、上下を抑える", () => {
    expect(crowdFactor(0.52, 0.52)).toBeGreaterThan(1.3);
    expect(crowdFactor(0.1, 0.3)).toBeGreaterThan(0.3);
    expect(crowdFactor(0.1, 0.3)).toBeLessThan(0.5);
    expect(crowdFactor(0, 0)).toBeGreaterThanOrEqual(0.1);
    expect(crowdFactor(1, 1)).toBeLessThanOrEqual(1.45);
  });

  const road = (spans: Road["spans"] = []): Road => {
    const n = 1001;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pts[i * 3] = i * 2 - 1000;
    return { id: "r", cls: 1, width: 8, surface: "paved", origin: [0, 0], points: pts, length: 2000, spans, name: "", kind: "main", start: "a", end: "b" } as Road;
  };

  it("倍率で人数が変わり、足元の高さを渡せ、立つ所が無ければ出さない", () => {
    const t = 1_800_000_000;
    const many = walkersNear([road()], 0, 0, 400, t, 0.5, 1000, { crowd: () => 1.4 });
    const few = walkersNear([road()], 0, 0, 400, t, 0.5, 1000, { crowd: () => 0.2 });
    expect(many.length).toBeGreaterThan(few.length * 4);
    // 倍率で減らす時は、多い時の人の一部（同じ人が同じ所）
    const seeds = new Set(many.map((w) => w.seed));
    for (const w of few) expect(seeds.has(w.seed)).toBe(true);
    const raised = walkersNear([road()], 0, 0, 400, t, 0.5, 1000, { ground: (_x, _z, y) => y + 0.15 });
    for (const w of raised) expect(w.y).toBeCloseTo(0.15, 6);
    expect(walkersNear([road()], 0, 0, 400, t, 0.5, 1000, { ground: () => null })).toHaveLength(0);
  });

  it("橋の区間には出さない", () => {
    const t = 1_800_000_000;
    const w = walkersNear([road([{ from: 900, to: 1100, kind: "bridge" }])], 0, 0, 400, t, 1, 1000);
    expect(w.length).toBeGreaterThan(0);
    for (const p of w) expect(Math.abs(p.x)).toBeGreaterThan(100 - 4 - 16);
  });
});
