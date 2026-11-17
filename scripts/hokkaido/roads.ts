// OSM の道路から、自転車で走る道の網を作る（北海道の草案 4.2）。
// 選ぶ → 点の共有で接続点を決める → 短い道でつながる接続点をまとめる → 曲線で 2m 間隔にする → 縦断（橋・トンネル・平滑化・接続点の高さ合わせ）。

import { ROAD_CLASSES, ROAD_STEP } from "../../src/shared/world/constants.ts";
import type { RoadClass, Span } from "../../src/shared/world/types.ts";
import { type Grid, gridAt } from "./dem.ts";
import { mergeDualCarriageways } from "./dual.ts";
import type { OsmData, OsmWay, Tags } from "./osm.ts";

export interface RoadSpec {
  cls: RoadClass;
  kind: "main" | "branch" | "cycleway";
  surface: "paved" | "gravel";
  width: number;
  /** 等級 2・3（unclassified・track）。走る道に入れるかを H0 の数字で決める */
  minor: boolean;
}

const UNPAVED = new Set(["unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "mud", "sand", "pebblestone", "rock", "wood"]);

/** 道路の種類 → 走る道の等級。走らない道は null */
export function classify(t: Tags): RoadSpec | null {
  const hw = t.highway;
  if (!hw || t.area === "yes") return null;
  if (t.bicycle === "no" || t.motorroad === "yes") return null;
  const bikeOk = t.bicycle === "yes" || t.bicycle === "designated";
  if ((t.access === "private" || t.access === "no") && !bikeOk) return null;
  let cls: RoadClass;
  if (hw === "trunk" || hw === "primary") cls = 0;
  else if (hw === "secondary" || hw === "tertiary") cls = 1;
  else if (hw === "unclassified") cls = 2;
  else if (hw === "track") cls = 3;
  else if (hw === "cycleway" || ((hw === "path" || hw === "footway") && t.bicycle === "designated")) cls = 4;
  else return null;
  const spec = ROAD_CLASSES[cls];
  let surface: "paved" | "gravel" = spec.surface;
  if (t.surface) surface = UNPAVED.has(t.surface) ? "gravel" : "paved";
  const lanes = Number(t.lanes);
  const width = cls <= 1 && lanes >= 2 ? Math.min(20, Math.max(spec.width, lanes * 3.25)) : spec.width;
  return { cls, kind: cls <= 1 ? "main" : cls === 4 ? "cycleway" : "branch", surface, width, minor: cls === 2 || cls === 3 };
}

export interface BuiltRoad {
  id: string;
  cls: RoadClass;
  width: number;
  surface: "paved" | "gravel";
  name: string;
  kind: "main" | "branch" | "cycleway";
  start: string;
  end: string;
  spans: Span[];
  origin: [number, number];
  points: Float32Array;
  length: number;
  minor: boolean;
  oneway: boolean;
  /** 元の道（OSM の way の番号） */
  ways: number[];
}

export interface BuiltJunction {
  id: string;
  x: number;
  y: number;
  z: number;
  arms: { road: string; s: number; dir: 1 | -1 }[];
}

/** 道の性質（同じなら 1 本につなぐ） */
interface Piece {
  nodes: number[];
  /** 辺ごと: 1 = 橋、2 = トンネル */
  flags: number[];
  way: number;
  spec: RoadSpec;
  key: string;
  name: string;
  oneway: boolean;
  /** 上り・下りの 2 本をまとめた道（dual.ts） */
  dual: boolean;
}

const edgeFlag = (t: Tags) => (t.tunnel && t.tunnel !== "no" && t.tunnel !== "building_passage" ? 2 : t.bridge && t.bridge !== "no" ? 1 : 0);

export interface RoadBuildOptions {
  /** 等級 2・3 を入れる */
  includeMinor: boolean;
  /** これより短い道でつながる接続点は 1 つにまとめる (m) */
  mergeJunction: number;
  /** 行き止まりのこれより短い道は消す (m) */
  stub: number;
  /** 縦断の平滑化の幅（ガウスの σ、m） */
  sigma: number;
  /** 接続点の前後で高さを合わせる長さ (m) */
  junctionBlend: number;
  /** 上り・下りが別の線の道路を 1 本にまとめる（dual.ts） */
  mergeDual: boolean;
}

export const DEFAULT_ROAD_OPTIONS: RoadBuildOptions = { includeMinor: true, mergeJunction: 12, stub: 25, sigma: 12, junctionBlend: 30, mergeDual: true };

export function buildRoads(d: OsmData, dem: Grid, opt: RoadBuildOptions = DEFAULT_ROAD_OPTIONS) {
  // 1. 選ぶ
  let ways: { w: OsmWay; spec: RoadSpec }[] = [];
  // 標高の格子の外の点で切る（範囲の端は行き止まりになる）
  const gx1 = dem.x0 + (dem.nx - 1) * dem.step;
  const gz1 = dem.z0 + (dem.nz - 1) * dem.step;
  const inside = (id: number) => {
    const p = d.nodes.get(id);
    return !!p && p.x >= dem.x0 && p.x <= gx1 && p.z >= dem.z0 && p.z <= gz1;
  };
  for (const w of d.ways.values()) {
    const spec = classify(w.tags);
    if (!spec || (!opt.includeMinor && spec.minor)) continue;
    let run: number[] = [];
    for (const id of [...w.nodes, -1]) {
      if (id !== -1 && inside(id)) {
        run.push(id);
        continue;
      }
      if (run.length >= 2) ways.push({ w: { id: w.id, nodes: run, tags: w.tags }, spec });
      run = [];
    }
  }
  // 点の位置（中央分離帯のある道路をまとめると動く）
  const nodePos = new Map<number, { x: number; z: number }>();
  for (const { w } of ways) for (const id of w.nodes) if (!nodePos.has(id)) nodePos.set(id, { x: d.nodes.get(id)!.x, z: d.nodes.get(id)!.z });
  let dual: ReturnType<typeof mergeDualCarriageways>["stats"] | null = null;
  if (opt.mergeDual) {
    const m = mergeDualCarriageways(ways, nodePos);
    ways = m.ways;
    dual = m.stats;
  }
  const keyOf = (w: OsmWay, s: RoadSpec) => `${s.cls}|${s.surface}|${s.width}|${w.tags.name ?? ""}|${w.tags.oneway === "yes" ? 1 : 0}|${w.tags["dual:merged"] ?? ""}`;

  // 2. 区切りの点: 3 本以上が集まる点、行き止まり、性質の変わる点
  const uses = new Map<number, number>();
  const endKeys = new Map<number, string[]>();
  for (const { w, spec } of ways) {
    const n = w.nodes.length;
    w.nodes.forEach((id, i) => uses.set(id, (uses.get(id) ?? 0) + (i === 0 || i === n - 1 ? 1 : 2)));
    for (const id of [w.nodes[0], w.nodes[n - 1]]) {
      const l = endKeys.get(id) ?? [];
      l.push(keyOf(w, spec));
      endKeys.set(id, l);
    }
  }
  const isBreak = (id: number) => {
    if (uses.get(id) !== 2) return true;
    const k = endKeys.get(id);
    return !!k && k.length === 2 && k[0] !== k[1];
  };

  // 3. 区切りで切った断片
  const pieces: Piece[] = [];
  for (const { w, spec } of ways) {
    let cur: number[] = [w.nodes[0]];
    const flag = edgeFlag(w.tags);
    for (let i = 1; i < w.nodes.length; i++) {
      cur.push(w.nodes[i]);
      if (i < w.nodes.length - 1 && isBreak(w.nodes[i])) {
        pieces.push({ nodes: cur, flags: cur.slice(1).map(() => flag), way: w.id, spec, key: keyOf(w, spec), name: w.tags.name ?? "", oneway: w.tags.oneway === "yes", dual: w.tags["dual:merged"] === "yes" });
        cur = [w.nodes[i]];
      }
    }
    pieces.push({ nodes: cur, flags: cur.slice(1).map(() => flag), way: w.id, spec, key: keyOf(w, spec), name: w.tags.name ?? "", oneway: w.tags.oneway === "yes", dual: w.tags["dual:merged"] === "yes" });
  }

  // 4. 区切りでない端（性質が同じ 2 本のつなぎ目）で断片をつなぐ
  const atNode = new Map<number, number[]>();
  pieces.forEach((p, i) => {
    for (const id of [p.nodes[0], p.nodes[p.nodes.length - 1]]) {
      if (isBreak(id)) continue;
      const l = atNode.get(id) ?? [];
      l.push(i);
      atNode.set(id, l);
    }
  });
  const used = new Uint8Array(pieces.length);
  interface Seg {
    nodes: number[];
    flags: number[];
    ways: number[];
    spec: RoadSpec;
    name: string;
    oneway: boolean;
    dual: boolean;
  }
  const segs: Seg[] = [];
  const other = (node: number, from: number) => (atNode.get(node) ?? []).find((k) => k !== from && !used[k]);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const p = pieces[i];
    let nodes = p.nodes.slice();
    let flags = p.flags.slice();
    const wset = [p.way];
    // 後ろへ
    for (let k = other(nodes[nodes.length - 1], i); k !== undefined; k = other(nodes[nodes.length - 1], k)) {
      used[k] = 1;
      const q = pieces[k];
      const fwd = q.nodes[0] === nodes[nodes.length - 1];
      nodes = nodes.concat((fwd ? q.nodes : q.nodes.slice().reverse()).slice(1));
      flags = flags.concat(fwd ? q.flags : q.flags.slice().reverse());
      wset.push(q.way);
    }
    // 前へ
    for (let k = other(nodes[0], i); k !== undefined; k = other(nodes[0], k)) {
      used[k] = 1;
      const q = pieces[k];
      const fwd = q.nodes[q.nodes.length - 1] === nodes[0];
      nodes = (fwd ? q.nodes : q.nodes.slice().reverse()).slice(0, -1).concat(nodes);
      flags = (fwd ? q.flags : q.flags.slice().reverse()).concat(flags);
      wset.unshift(q.way);
    }
    segs.push({ nodes, flags, ways: [...new Set(wset)], spec: p.spec, name: p.name, oneway: p.oneway, dual: p.dual });
  }

  // 5. 接続点をまとめる
  const pos = (id: number) => nodePos.get(id)!;
  const segLen = (s: Seg) => {
    let l = 0;
    for (let i = 1; i < s.nodes.length; i++) {
      const a = pos(s.nodes[i - 1]);
      const b = pos(s.nodes[i]);
      l += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return l;
  };
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  let alive = segs.map((s) => ({ s, len: segLen(s) }));
  let merged = 0;
  for (const e of alive) {
    const a = e.s.nodes[0];
    const b = e.s.nodes[e.s.nodes.length - 1];
    if (a !== b && e.len < opt.mergeJunction) {
      union(a, b);
      merged++;
    }
  }
  alive = alive.filter((e) => !(e.len < opt.mergeJunction && e.s.nodes[0] !== e.s.nodes[e.s.nodes.length - 1]));
  // 同じ接続点に戻る短い輪と、短い行き止まりを消す
  let stubs = 0;
  for (let pass = 0; pass < 2; pass++) {
    const deg = new Map<number, number>();
    for (const e of alive) for (const id of [e.s.nodes[0], e.s.nodes[e.s.nodes.length - 1]]) deg.set(find(id), (deg.get(find(id)) ?? 0) + 1);
    alive = alive.filter((e) => {
      const a = find(e.s.nodes[0]);
      const b = find(e.s.nodes[e.s.nodes.length - 1]);
      const drop = (a === b && e.len < 40) || (e.len < opt.stub && ((deg.get(a) ?? 0) === 1 || (deg.get(b) ?? 0) === 1) && (deg.get(a) ?? 0) + (deg.get(b) ?? 0) > 2);
      if (drop) stubs++;
      return !drop;
    });
  }
  // まとめた接続点の位置
  const cluster = new Map<number, { x: number; z: number; n: number; min: number }>();
  for (const e of alive)
    for (const id of [e.s.nodes[0], e.s.nodes[e.s.nodes.length - 1]]) {
      const r = find(id);
      const p = pos(id);
      const c = cluster.get(r) ?? { x: 0, z: 0, n: 0, min: id };
      c.x += p.x;
      c.z += p.z;
      c.n++;
      c.min = Math.min(c.min, id);
      cluster.set(r, c);
    }

  // 6. 形・縦断
  const roads: BuiltRoad[] = [];
  const counter = new Map<number, number>();
  for (const { s } of alive) {
    const ra = find(s.nodes[0]);
    const rb = find(s.nodes[s.nodes.length - 1]);
    const ca = cluster.get(ra)!;
    const cb = cluster.get(rb)!;
    const xz: number[] = [];
    const fl: number[] = [];
    for (let i = 0; i < s.nodes.length; i++) {
      const p = i === 0 ? { x: ca.x / ca.n, z: ca.z / ca.n } : i === s.nodes.length - 1 ? { x: cb.x / cb.n, z: cb.z / cb.n } : pos(s.nodes[i]);
      const lx = xz[xz.length - 2];
      const lz = xz[xz.length - 1];
      if (xz.length && Math.hypot(p.x - lx, p.z - lz) < 0.05) {
        if (i > 0) fl[fl.length - 1] = Math.max(fl[fl.length - 1] ?? 0, s.flags[i - 1]);
        continue;
      }
      if (i > 0) fl.push(s.flags[i - 1]);
      xz.push(p.x, p.z);
    }
    if (xz.length < 4) continue;
    const curve = resample(xz, fl, ROAD_STEP);
    if (curve.n < 2) continue;
    const n0 = counter.get(s.ways[0]) ?? 0;
    counter.set(s.ways[0], n0 + 1);
    const id = `h${s.ways[0]}_${n0}`;
    const ds = curve.length / (curve.n - 1);
    // 高さ: 地面 → 橋・トンネルは両端を直線でつなぐ → 平滑化
    const y = new Float64Array(curve.n);
    for (let i = 0; i < curve.n; i++) y[i] = gridAt(dem, curve.x[i], curve.z[i]);
    if (s.dual) {
      // まとめた道の中心は中央分離帯（川・水路のこともある）なので、両側の車道の位置の高さの平均にする
      const off = s.spec.width / 2;
      for (let i = 0; i < curve.n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(curve.n - 1, i + 1);
        const tx = curve.x[b] - curve.x[a];
        const tz = curve.z[b] - curve.z[a];
        const l = Math.hypot(tx, tz) || 1;
        const nx = -tz / l;
        const nz = tx / l;
        y[i] = (gridAt(dem, curve.x[i] + nx * off, curve.z[i] + nz * off) + gridAt(dem, curve.x[i] - nx * off, curve.z[i] - nz * off)) / 2;
      }
    }
    const spans: Span[] = [];
    for (let i = 0; i < curve.n; ) {
      if (!curve.flag[i]) {
        i++;
        continue;
      }
      const kind = curve.flag[i] === 2 ? "tunnel" : "bridge";
      let j = i;
      while (j + 1 < curve.n && curve.flag[j + 1] === curve.flag[i]) j++;
      const a = Math.max(0, i - 1);
      const b = Math.min(curve.n - 1, j + 1);
      for (let k = a + 1; k < b; k++) y[k] = y[a] + ((y[b] - y[a]) * (k - a)) / (b - a);
      spans.push({ from: a * ds, to: b * ds, kind });
      i = j + 1;
    }
    const sm = gaussian(y, opt.sigma / ds);
    const ox = curve.x[0];
    const oz = curve.z[0];
    const pts = new Float32Array(curve.n * 3);
    for (let i = 0; i < curve.n; i++) {
      pts[i * 3] = curve.x[i] - ox;
      pts[i * 3 + 1] = sm[i];
      pts[i * 3 + 2] = curve.z[i] - oz;
    }
    roads.push({
      id,
      cls: s.spec.cls,
      width: s.spec.width,
      surface: s.spec.surface,
      name: s.name,
      kind: s.spec.kind,
      start: `hj${ca.min}`,
      end: `hj${cb.min}`,
      spans,
      origin: [ox, oz],
      points: pts,
      length: curve.length,
      minor: s.spec.minor,
      oneway: s.oneway,
      ways: s.ways,
    });
  }

  // 7. 接続点: 高さは集まる道の端の平均。各道の端の前後 junctionBlend m で合わせる
  const junctions = new Map<string, BuiltJunction & { sum: number; cnt: number }>();
  for (const r of roads)
    for (const [jid, s, dir] of [
      [r.start, 0, 1],
      [r.end, r.length, -1],
    ] as const) {
      const i = dir === 1 ? 0 : r.points.length / 3 - 1;
      const j = junctions.get(jid) ?? { id: jid, x: r.points[i * 3] + r.origin[0], y: 0, z: r.points[i * 3 + 2] + r.origin[1], arms: [], sum: 0, cnt: 0 };
      j.sum += r.points[i * 3 + 1];
      j.cnt++;
      j.arms.push({ road: r.id, s, dir });
      junctions.set(jid, j);
    }
  for (const j of junctions.values()) j.y = j.sum / j.cnt;
  for (const r of roads) {
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    const d0 = junctions.get(r.start)!.y - r.points[1];
    const d1 = junctions.get(r.end)!.y - r.points[(n - 1) * 3 + 1];
    const L = opt.junctionBlend;
    for (let i = 0; i < n; i++) {
      const s = i * ds;
      let w0: number;
      let w1: number;
      if (r.length < 2 * L) {
        w1 = s / r.length;
        w0 = 1 - w1;
      } else {
        w0 = Math.max(0, 1 - s / L);
        w1 = Math.max(0, 1 - (r.length - s) / L);
      }
      r.points[i * 3 + 1] += d0 * w0 + d1 * w1;
    }
  }
  const outJunctions: BuiltJunction[] = [...junctions.values()].map(({ id, x, y, z, arms }) => ({ id, x, y, z, arms }));
  return { roads, junctions: outJunctions, stats: { dual, selectedWays: ways.length, pieces: pieces.length, segments: segs.length, mergedJunctionLinks: merged, removedStubs: stubs } };
}

/** 中心を通るキャットマル・ロム（向心）で曲線にし、step 以下の等間隔に取り直す。flag は元の辺ごと */
function resample(xz: number[], fl: number[], step: number) {
  const n = xz.length / 2;
  const P = (i: number): [number, number] => {
    if (i < 0) return [2 * xz[0] - xz[2], 2 * xz[1] - xz[3]];
    if (i >= n) return [2 * xz[(n - 1) * 2] - xz[(n - 2) * 2], 2 * xz[(n - 1) * 2 + 1] - xz[(n - 2) * 2 + 1]];
    return [xz[i * 2], xz[i * 2 + 1]];
  };
  const dx: number[] = [];
  const dz: number[] = [];
  const df: number[] = [];
  for (let e = 0; e < n - 1; e++) {
    const p0 = P(e - 1);
    const p1 = P(e);
    const p2 = P(e + 1);
    const p3 = P(e + 2);
    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1e-6);
    const t2 = t1 + Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1e-6);
    const t3 = t2 + Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) || 1e-6);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(4, Math.ceil(len / 0.5));
    for (let q = e === 0 ? 0 : 1; q <= k; q++) {
      const t = t1 + ((t2 - t1) * q) / k;
      const out: number[] = [0, 0];
      for (let c = 0; c < 2; c++) {
        const a1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        out[c] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      }
      dx.push(out[0]);
      dz.push(out[1]);
      df.push(fl[e] ?? 0);
    }
  }
  const cum = new Float64Array(dx.length);
  for (let i = 1; i < dx.length; i++) cum[i] = cum[i - 1] + Math.hypot(dx[i] - dx[i - 1], dz[i] - dz[i - 1]);
  const length = cum[cum.length - 1];
  const m = Math.max(2, Math.ceil(length / step) + 1);
  const x = new Float64Array(m);
  const z = new Float64Array(m);
  const flag = new Uint8Array(m);
  let k = 0;
  for (let i = 0; i < m; i++) {
    const s = (length * i) / (m - 1);
    while (k < cum.length - 2 && cum[k + 1] < s) k++;
    const u = cum[k + 1] > cum[k] ? (s - cum[k]) / (cum[k + 1] - cum[k]) : 0;
    x[i] = dx[k] + (dx[k + 1] - dx[k]) * u;
    z[i] = dz[k] + (dz[k + 1] - dz[k]) * u;
    flag[i] = df[Math.min(df.length - 1, u < 0.5 ? k : k + 1)];
  }
  return { n: m, x, z, flag, length };
}

function gaussian(y: Float64Array, sigma: number): Float64Array {
  const n = y.length;
  if (sigma < 0.5 || n < 3) return y.slice();
  const R = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp((-k * k) / (2 * sigma * sigma)));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let b = 0;
    for (let k = -R; k <= R; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k));
      a += y[j] * w[k + R];
      b += w[k + R];
    }
    out[i] = a / b;
  }
  return out;
}
