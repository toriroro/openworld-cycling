// 走らない道（住宅街の道・敷地の道・歩道）を、見た目だけの路面にする（北海道の草案 17 章）。
// 走る道の路面の上（半幅 + 0.5m 以内）は切り取る（4m 間隔で調べる）。残りは折れ線を間引いて (x, z) だけ持つ。
// 高さは描く側が地形から取る。区画（cell m 四方）の境で切って、区画ごとに並べる（描画と地形のすり合わせが区画ごとに引くため）。

import { HOKKAIDO_STREET_KINDS, type HokkaidoStreetIndex } from "../../src/shared/world/hokkaido.ts";
import { type Grid, gridAt } from "./dem.ts";
import type { OsmData, Tags } from "./osm.ts";
import type { Seg } from "./buildings.ts";

/** 道の種類と幅 (m)。kind は HOKKAIDO_STREET_KINDS の番号（0 = 車の通る道、1 = 歩道・小道） */
function streetSpec(t: Tags): { kind: number; width: number } | null {
  if (t.area === "yes" || t.indoor === "yes" || t.level || (t.layer && Number(t.layer) < 0)) return null;
  if (t.tunnel && t.tunnel !== "no") return null;
  const hw = t.highway;
  switch (hw) {
    case "residential":
      return { kind: 0, width: 5 };
    case "living_street":
      return { kind: 0, width: 4 };
    case "unclassified":
      return { kind: 0, width: 5.5 };
    case "service":
      return { kind: 0, width: t.service === "parking_aisle" ? 3 : 3.5 };
    case "track":
      return { kind: 0, width: 3 };
    case "pedestrian":
      return { kind: 1, width: 4 };
    case "footway":
    case "path":
    case "cycleway":
      // 歩道橋は描かない（走る道の上に重なる）
      if (t.bridge && t.bridge !== "no") return null;
      return { kind: 1, width: t.footway === "sidewalk" ? 2 : 1.6 };
    default:
      return null;
  }
}

/** 折れ線の間引き（ダグラス・ポイカー。tol m 以内の点を落とす）。残す点の番号 */
function simplify(run: number[], a: number, b: number, tol: number): number[] {
  const keep = new Uint8Array(b - a + 1);
  keep[0] = keep[b - a] = 1;
  const stack: [number, number][] = [[a, b]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const ax = run[i0 * 3], az = run[i0 * 3 + 2], bx = run[i1 * 3], bz = run[i1 * 3 + 2];
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    let best = -1;
    let bd = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((run[i * 3] - ax) * dz - (run[i * 3 + 2] - az) * dx) / l;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best - a] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out: number[] = [];
  for (let i = a; i <= b; i++) if (keep[i - a]) out.push(i);
  return out;
}

/**
 * coverage を渡すと、込み具合 0.06 以上の所では走る道から 5m 以内の歩道・小道を描かない
 * （走る道の両側に縁石付きの歩道を作るので、OSM の歩道と二重になるのを避ける。sidewalks.ts）
 */
export function buildStreets(d: OsmData, dem: Grid, rideSegs: Seg[], rideWayIds: Set<number>, cell: number, coverage?: (x: number, z: number) => number) {
  // 走る道の線分の索引（切り取り用）
  const C = 40;
  const grid = new Map<string, Seg[]>();
  for (const s of rideSegs) {
    for (let cx = Math.floor((Math.min(s.ax, s.bx) - s.hw) / C); cx <= Math.floor((Math.max(s.ax, s.bx) + s.hw) / C); cx++)
      for (let cz = Math.floor((Math.min(s.az, s.bz) - s.hw) / C); cz <= Math.floor((Math.max(s.az, s.bz) + s.hw) / C); cz++) {
        const k = `${cx},${cz}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(s);
      }
  }
  const onRide = (x: number, z: number, extra: number) => {
    for (const s of grid.get(`${Math.floor(x / C)},${Math.floor(z / C)}`) ?? []) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      if (Math.hypot(s.ax + dx * t - x, s.az + dz * t - z) < s.hw + extra) return true;
    }
    return false;
  };
  const gx1 = dem.x0 + (dem.nx - 1) * dem.step;
  const gz1 = dem.z0 + (dem.nz - 1) * dem.step;
  const pts: number[] = [];
  const index: HokkaidoStreetIndex = { cell, kinds: [...HOKKAIDO_STREET_KINDS], pieces: {} };
  const stats = { ways: 0, km: [0, 0], pieces: 0, clippedPoints: 0 };
  const emit = (run: number[], width: number, kind: number) => {
    // run: [x, y, z, ...]。区画の境で切る
    let start = 0;
    const cellOf = (i: number) => `${Math.floor(run[i * 3] / cell)},${Math.floor(run[i * 3 + 2] / cell)}`;
    const n = run.length / 3;
    const flush = (a: number, b: number) => {
      if (b - a < 1) return;
      const key = cellOf(Math.min(n - 1, a + ((b - a) >> 1)));
      const keep = simplify(run, a, b, 0.15);
      const off = pts.length / 2;
      for (const i of keep) pts.push(Math.round(run[i * 3] * 100) / 100, Math.round(run[i * 3 + 2] * 100) / 100);
      (index.pieces[key] ??= []).push([off, keep.length, Math.round(width * 10), kind]);
      stats.pieces++;
    };
    let cur = cellOf(0);
    for (let i = 1; i < n; i++) {
      const c = cellOf(i);
      if (c !== cur) {
        flush(start, i);
        start = i;
        cur = c;
      }
    }
    flush(start, n - 1);
  };
  for (const w of d.ways.values()) {
    if (rideWayIds.has(w.id)) continue;
    const spec = streetSpec(w.tags);
    if (!spec) continue;
    const ns = w.nodes.map((id) => d.nodes.get(id));
    if (ns.some((p) => !p)) continue;
    stats.ways++;
    // 4m 間隔に取り直す
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i + 1 < ns.length; i++) {
      const a = ns[i]!;
      const b = ns[i + 1]!;
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      const k = Math.max(1, Math.ceil(l / 4));
      for (let q = i === 0 ? 0 : 1; q <= k; q++) {
        xs.push(a.x + ((b.x - a.x) * q) / k);
        zs.push(a.z + ((b.z - a.z) * q) / k);
      }
    }
    // 高さ: 標高を 3 点でならす
    const ys = xs.map((x, i) => gridAt(dem, x, zs[i]));
    const sm = ys.map((_, i) => (ys[Math.max(0, i - 1)] + 2 * ys[i] + ys[Math.min(ys.length - 1, i + 1)]) / 4);
    // 走る道の上・範囲の外を切り取って、続く所ごとに出す。
    // 走る道で切れる所は、点の間（4m）で境目を求めて端の点を足す（車の通る道は走る道の縁の 0.2m 内側まで伸ばし、路面の下に入れる。
    // 4m ごとの点で切るだけだと、走る道の手前で最大 4m の隙間ができた）
    const extraOf = (x: number, z: number) => (spec.kind === 1 && coverage && coverage(x, z) >= 0.06 ? 5 : 0.5 + (spec.kind === 0 ? 0 : spec.width / 2));
    const edgeOf = (x: number, z: number) => (spec.kind === 0 ? -0.2 : extraOf(x, z));
    const inRange = (x: number, z: number) => x >= dem.x0 && x <= gx1 && z >= dem.z0 && z <= gz1;
    const kept = xs.map((x, i) => inRange(x, zs[i]) && !onRide(x, zs[i], extraOf(x, zs[i])));
    /** a（残す点）から b（切る点）へ、走る道の縁（edgeOf）の手前の一番遠い点 */
    const edgePoint = (a: number, b: number): [number, number, number] | null => {
      if (!inRange(xs[b], zs[b])) return null;
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 10; it++) {
        const t = (lo + hi) / 2;
        const x = xs[a] + (xs[b] - xs[a]) * t;
        const z = zs[a] + (zs[b] - zs[a]) * t;
        if (onRide(x, z, edgeOf(x, z))) hi = t;
        else lo = t;
      }
      if (lo < 0.02) return null;
      return [xs[a] + (xs[b] - xs[a]) * lo, sm[a] + (sm[b] - sm[a]) * lo, zs[a] + (zs[b] - zs[a]) * lo];
    };
    let run: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      if (kept[i]) {
        if (!run.length && i > 0) {
          const e = edgePoint(i, i - 1);
          if (e) run.push(...e);
        }
        run.push(xs[i], sm[i], zs[i]);
        continue;
      }
      stats.clippedPoints++;
      if (run.length && i > 0 && kept[i - 1]) {
        const e = edgePoint(i - 1, i);
        if (e) run.push(...e);
      }
      if (run.length >= 6) emit(run, spec.width, spec.kind);
      run = [];
    }
    if (run.length >= 6) emit(run, spec.width, spec.kind);
    let km = 0;
    for (let i = 1; i < xs.length; i++) km += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    stats.km[spec.kind] += km / 1000;
  }
  stats.km = stats.km.map((v) => Math.round(v * 10) / 10);
  return { pts: Float32Array.from(pts), index, stats };
}
