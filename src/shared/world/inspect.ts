// 世界の検査（モック仕様 4.10）。Node のスクリプト、テスト、ブラウザでの端末間比較で共通に使う。

import { ROAD_CLASSES } from "./constants.ts";
import { circumradius } from "./shape.ts";
import type { Road } from "./types.ts";
import { buildJunctions, type Rect, type World } from "./world.ts";

/** 道路の点列のハッシュ（FNV-1a を Float32 のビット列に掛ける） */
export function roadHash(road: Road): number {
  const u = new Uint32Array(road.points.buffer, road.points.byteOffset, road.points.length);
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h ^= v;
    h = Math.imul(h, 0x01000193);
  };
  for (let i = 0; i < u.length; i++) mix(u[i]);
  const f = new Float64Array([road.origin[0], road.origin[1], road.length]);
  const u2 = new Uint32Array(f.buffer);
  for (let i = 0; i < u2.length; i++) mix(u2[i]);
  for (let i = 0; i < road.id.length; i++) mix(road.id.charCodeAt(i));
  return h >>> 0;
}

/** 道路の集まりのハッシュ（識別子の順に並べて） */
export function roadsHash(roads: Road[]): string {
  const sorted = [...roads].sort((a, b) => (a.id < b.id ? -1 : 1));
  let h = 0x811c9dc5;
  for (const r of sorted) {
    h ^= roadHash(r);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

export interface GradeCheck {
  /** 2m 区間で等級の最大勾配を超えた点の数 */
  over: number;
  maxRatio: number;
  worst: { road: string; s: number; grade: number; limit: number } | null;
}

export function checkGrades(roads: Road[]): GradeCheck {
  let over = 0;
  let maxRatio = 0;
  let worst: GradeCheck["worst"] = null;
  for (const r of roads) {
    const lim = ROAD_CLASSES[r.cls].maxGrade;
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 1; i < n; i++) {
      const g = Math.abs(r.points[i * 3 + 1] - r.points[i * 3 - 2]) / ds;
      // Float32 の丸め（高さ 1000m で約 0.06mm）を許す
      if (g > lim + 1e-4) over++;
      if (g / lim > maxRatio) {
        maxRatio = g / lim;
        worst = { road: r.id, s: i * ds, grade: g, limit: lim };
      }
    }
  }
  return { over, maxRatio, worst };
}

export interface RadiusCheck {
  /** 最小曲線半径を下回った点の数 */
  under: number;
  points: number;
  byClass: { cls: number; under: number; points: number; minRadius: number }[];
  worst: { road: string; s: number; radius: number; limit: number } | null;
}

/** 曲線半径を前後 span m の3点で測る */
export function checkRadius(roads: Road[], span = 6, tolerance = 0.95): RadiusCheck {
  let under = 0;
  let points = 0;
  let worst: RadiusCheck["worst"] = null;
  const byClass = ROAD_CLASSES.map((c, cls) => ({ cls, under: 0, points: 0, minRadius: c.minRadius }));
  for (const r of roads) {
    const lim = ROAD_CLASSES[r.cls].minRadius;
    const P = r.points;
    const n = P.length / 3;
    const ds = r.length / (n - 1);
    const k = Math.max(1, Math.round(span / ds));
    for (let i = k; i < n - k; i++) {
      const R = circumradius(P[(i - k) * 3], P[(i - k) * 3 + 2], P[i * 3], P[i * 3 + 2], P[(i + k) * 3], P[(i + k) * 3 + 2]);
      points++;
      byClass[r.cls].points++;
      if (R < lim * tolerance) {
        under++;
        byClass[r.cls].under++;
        if (!worst || R / lim < worst.radius / worst.limit) worst = { road: r.id, s: i * ds, radius: R, limit: lim };
      }
    }
  }
  return { under, points, byClass, worst };
}

export interface ParallelCheck {
  /** 別の道路と 40m 以内で 200m 以上並ぶ区間の総延長 (m) */
  length: number;
  totalLength: number;
  runs: { road: string; other: string; from: number; to: number }[];
}

/**
 * 並走。各道路を 10m ごとに見て、40m 以内に別の道路があり、その状態が 200m 以上続く区間を数える。
 * 同じ接続点を共有する道路は、接続点から 100m 以内を数えない（分かれ際は近いのが当然なので）。
 */
export function checkParallel(roads: Road[], dist = 40, minRun = 200): ParallelCheck {
  const CELL = 50;
  const grid = new Map<string, { r: number; x: number; z: number }[]>();
  const step = 10;
  const samples: { x: number; z: number; s: number }[][] = roads.map((road) => {
    const out: { x: number; z: number; s: number }[] = [];
    const n = road.points.length / 3;
    const ds = road.length / (n - 1);
    const k = Math.max(1, Math.round(step / ds));
    for (let i = 0; i < n; i += k)
      out.push({ x: road.points[i * 3] + road.origin[0], z: road.points[i * 3 + 2] + road.origin[1], s: i * ds });
    return out;
  });
  samples.forEach((ss, r) => {
    for (const p of ss) {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
      const l = grid.get(key);
      if (l) l.push({ r, x: p.x, z: p.z });
      else grid.set(key, [{ r, x: p.x, z: p.z }]);
    }
  });
  const ends = roads.map((r) => new Set([r.start, r.end]));
  let length = 0;
  let totalLength = 0;
  const runs: ParallelCheck["runs"] = [];
  const d2max = dist * dist;
  roads.forEach((road, ri) => {
    totalLength += road.length;
    let runStart = -1;
    let runOther = -1;
    const ss = samples[ri];
    const flush = (endS: number) => {
      if (runStart >= 0 && endS - runStart >= minRun) {
        length += endS - runStart;
        runs.push({ road: road.id, other: roads[runOther].id, from: runStart, to: endS });
      }
      runStart = -1;
    };
    for (const p of ss) {
      let near = -1;
      const gx = Math.floor(p.x / CELL);
      const gz = Math.floor(p.z / CELL);
      for (let dz = -1; dz <= 1 && near < 0; dz++)
        for (let dx = -1; dx <= 1 && near < 0; dx++) {
          const l = grid.get(`${gx + dx},${gz + dz}`);
          if (!l) continue;
          for (const q of l) {
            if (q.r === ri) continue;
            const ddx = q.x - p.x;
            const ddz = q.z - p.z;
            if (ddx * ddx + ddz * ddz > d2max) continue;
            // 共有する端の近くは数えない
            const other = roads[q.r];
            const shared = [...ends[ri]].some((e) => ends[q.r].has(e)) || other.start === road.id || other.end === road.id;
            if (shared && (p.s < 100 || p.s > road.length - 100)) continue;
            near = q.r;
            break;
          }
        }
      if (near >= 0) {
        if (runStart < 0) {
          runStart = p.s;
          runOther = near;
        }
      } else flush(p.s);
    }
    flush(road.length);
  });
  return { length, totalLength, runs };
}

export interface EarthworkCheck {
  /** 路面 − 地面（橋を除く）の分位点 */
  p01: number;
  p05: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  /** 30m を超える点の数と、その点の延長 */
  extreme: number;
  extremeLength: number;
  samples: number;
  histogram: { from: number; to: number; count: number }[];
}

export function checkEarthwork(world: World, roads: Road[], stride = 5): EarthworkCheck {
  const vals: number[] = [];
  let extremeLength = 0;
  for (const r of roads) {
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 0; i < n; i += stride) {
      const s = i * ds;
      if (r.spans.some((sp) => s >= sp.from && s <= sp.to)) continue;
      const x = r.points[i * 3] + r.origin[0];
      const z = r.points[i * 3 + 2] + r.origin[1];
      const g = world.terrain.height(x, z);
      const d = r.points[i * 3 + 1] - g;
      vals.push(d);
      if (Math.abs(d) > 30) extremeLength += ds * stride;
    }
  }
  vals.sort((a, b) => a - b);
  const edges = [-Infinity, -30, -20, -10, -5, -2, 2, 5, 10, 20, 30, Infinity];
  const histogram = edges.slice(0, -1).map((from, i) => ({ from, to: edges[i + 1], count: 0 }));
  for (const v of vals) for (const b of histogram) if (v >= b.from && v < b.to) {
    b.count++;
    break;
  }
  return {
    p01: percentile(vals, 0.01),
    p05: percentile(vals, 0.05),
    p50: percentile(vals, 0.5),
    p95: percentile(vals, 0.95),
    p99: percentile(vals, 0.99),
    min: vals[0],
    max: vals[vals.length - 1],
    extreme: vals.filter((v) => Math.abs(v) > 30).length,
    extremeLength,
    samples: vals.length,
    histogram,
  };
}

export interface ConnectivityCheck {
  nodes: number;
  /** 最大の連結成分に入る結節点の数 */
  largest: number;
  /** 道路が1本も来ない結節点 */
  isolated: string[];
  /** 道路はあるが最大成分とつながらない結節点 */
  detached: string[];
  components: number;
}

/** rect 内の結節点が道路でつながっているか（道路は rect の外へ出たものも含めて使う） */
export function checkConnectivity(world: World, rect: Rect, roads: Road[]): ConnectivityCheck {
  const { junctions } = buildJunctions(world, roads);
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let p = parent.get(a) ?? a;
    if (p !== a) {
      p = find(p);
      parent.set(a, p);
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  // 道路の識別子を頂点にし、接続点の腕でつなぐ
  for (const j of junctions) {
    const first = `r:${j.arms[0]?.road}`;
    for (const a of j.arms) union(first, `r:${a.road}`);
    if (j.node) union(first, `n:${j.node}`);
  }
  const nodes = world.nodesInRect(rect);
  const reached = new Set(junctions.filter((j) => j.node).map((j) => j.node!));
  const isolated = nodes.filter((n) => !reached.has(n.id)).map((n) => n.id);
  const counts = new Map<string, number>();
  for (const n of nodes) if (reached.has(n.id)) {
    const r = find(`n:${n.id}`);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  let bestRoot = "";
  let best = 0;
  for (const [r, c] of counts) if (c > best) {
    best = c;
    bestRoot = r;
  }
  const detached = nodes.filter((n) => reached.has(n.id) && find(`n:${n.id}`) !== bestRoot).map((n) => n.id);
  return { nodes: nodes.length, largest: best, isolated, detached, components: counts.size };
}
