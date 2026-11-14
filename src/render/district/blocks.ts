// 街路の計画（DistrictPlan）から、街区（街路に囲まれた面）と敷地を作る。Three.js に依存しない。
// 1. 街路の折れ線を交点で切って、平面の網（点と辺）にする
// 2. 行き止まりの辺を落とし、辺を左回りにたどって面（街区）を取り出す
// 3. 街区を街路の幅だけ内側へ寄せる（縁石の線、敷地の線）
// 4. 敷地の線の多角形を、通りに面した列と間口で切って敷地にする
// 入力の街路は何でもよい（格子でなくてよい）ので、実在の地図の道路でも同じ手順が使える。

import { hash } from "../../shared/world/hash.ts";
import { boundsAlong, cleanPoly, clipHalfPlane, type Inset, insetPoly, type P2, pointInPoly, segDist, segIntersect, signedArea } from "./geom.ts";
import type { DistrictPlan, PlanStreet } from "./plan.ts";

export interface GraphEdge {
  a: number;
  b: number;
  street: number;
}

export interface StreetGraph {
  nodes: P2[];
  edges: GraphEdge[];
  /** 点ごとの、つながる辺の数 */
  degree: number[];
}

export interface Block {
  /** 街路の中心線でできた面（反時計回り）と、辺ごとの街路の番号 */
  poly: P2[];
  streets: number[];
  /** 車道の端（縁石の線）。細すぎる街区は null */
  curb: Inset | null;
  /** 敷地の線（歩道の内側） */
  lotLine: Inset | null;
}

export interface Lot {
  block: number;
  poly: P2[];
  /** 辺ごとの街路の番号（敷地どうしの境は −1） */
  tags: number[];
  /** 間口の辺の番号（通りに面していなければ −1） */
  front: number;
  area: number;
  /** 幹線に面した列か */
  mainStreet: boolean;
  /** 奥行きの深い街区の、通りに面した列に挟まれた内側の列か */
  inner: boolean;
}

const PRIORITY: Record<PlanStreet["kind"], number> = { arterial: 3, local: 2, alley: 1, edge: 0 };

const unit = (seed: number, a: number, b = 0, c = 0) => hash(seed, a, b, c) / 4294967296;

/** 街路の半幅（車道の端まで） */
export function halfWidth(s: PlanStreet): number {
  return s.kind === "edge" ? 0 : s.width / 2 + (s.kind === "arterial" ? 0.1 : 0);
}

export function buildGraph(plan: DistrictPlan): StreetGraph {
  interface Seg {
    a: P2;
    b: P2;
    street: number;
    cuts: number[];
  }
  const segs: Seg[] = [];
  plan.streets.forEach((s, si) => {
    for (let i = 0; i < s.pts.length - 1; i++) segs.push({ a: s.pts[i], b: s.pts[i + 1], street: si, cuts: [0, 1] });
  });
  // 交点（別の街路どうし。升目で候補を絞る）
  const C = 40;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / C), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / C);
    const z0 = Math.floor(Math.min(s.a[1], s.b[1]) / C), z1 = Math.floor(Math.max(s.a[1], s.b[1]) / C);
    for (let gz = z0; gz <= z1; gz++)
      for (let gx = x0; gx <= x1; gx++) {
        const k = `${gx},${gz}`;
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
  });
  const done = new Set<number>();
  for (const l of grid.values())
    for (let p = 0; p < l.length; p++)
      for (let q = p + 1; q < l.length; q++) {
        const i = l[p], j = l[q];
        const s = segs[i], t = segs[j];
        if (s.street === t.street) continue;
        const key = i * 100003 + j;
        if (done.has(key)) continue;
        done.add(key);
        const hit = segIntersect(s.a, s.b, t.a, t.b);
        if (!hit) continue;
        s.cuts.push(hit.t);
        t.cuts.push(hit.u);
      }

  // 点（0.3m 以内は同じ点）
  const nodes: P2[] = [];
  const nodeGrid = new Map<string, number[]>();
  const nodeAt = (x: number, z: number): number => {
    const gx = Math.floor(x / 2), gz = Math.floor(z / 2);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const i of nodeGrid.get(`${gx + dx},${gz + dz}`) ?? []) if (Math.hypot(nodes[i][0] - x, nodes[i][1] - z) < 0.3) return i;
    nodes.push([x, z]);
    const k = `${gx},${gz}`;
    const l = nodeGrid.get(k);
    if (l) l.push(nodes.length - 1);
    else nodeGrid.set(k, [nodes.length - 1]);
    return nodes.length - 1;
  };
  const edgeMap = new Map<string, GraphEdge>();
  for (const s of segs) {
    const cuts = [...new Set(s.cuts)].sort((a, b) => a - b);
    let prev = -1;
    for (const t of cuts) {
      const n = nodeAt(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t);
      if (prev >= 0 && prev !== n) {
        const key = prev < n ? `${prev}:${n}` : `${n}:${prev}`;
        const old = edgeMap.get(key);
        if (!old || PRIORITY[plan.streets[s.street].kind] > PRIORITY[plan.streets[old.street].kind]) edgeMap.set(key, { a: prev, b: n, street: s.street });
      }
      prev = n;
    }
  }
  let edges = [...edgeMap.values()];

  // 外周の外の辺を落とす
  edges = edges.filter((e) => {
    if (plan.streets[e.street].kind === "edge") return true;
    const mx = (nodes[e.a][0] + nodes[e.b][0]) / 2, mz = (nodes[e.a][1] + nodes[e.b][1]) / 2;
    return pointInPoly(plan.boundary, mx, mz);
  });

  // 幹線のすぐ脇を並んで走る通りを落とす（同じ向きの道が 2 本並ばないように）
  const arterials = segs.filter((s) => plan.streets[s.street].kind === "arterial");
  edges = edges.filter((e) => {
    const st = plan.streets[e.street];
    if (st.kind !== "local" && st.kind !== "alley") return true;
    const a = nodes[e.a], b = nodes[e.b];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / l, dz = (b[1] - a[1]) / l;
    for (const t of [0.2, 0.5, 0.8]) {
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      for (const s of arterials) {
        const sl = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
        const c = Math.abs((dx * (s.b[0] - s.a[0]) + dz * (s.b[1] - s.a[1])) / sl);
        if (c < 0.8) continue;
        if (segDist(x, z, s.a[0], s.a[1], s.b[0], s.b[1]).d < plan.streets[s.street].width / 2 + st.width / 2 + 16) return false;
      }
    }
    return true;
  });

  // 行き止まりを繰り返し落とす
  for (;;) {
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) {
      deg[e.a]++;
      deg[e.b]++;
    }
    const kept = edges.filter((e) => deg[e.a] > 1 && deg[e.b] > 1);
    if (kept.length === edges.length) break;
    edges = kept;
  }

  // 外周とつながっている部分だけ残す（街区の中に浮いた輪を作らない）
  const adj = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const n of [e.a, e.b]) {
      const l = adj.get(n);
      if (l) l.push(i);
      else adj.set(n, [i]);
    }
  });
  const seen = new Set<number>();
  const start = edges.findIndex((e) => plan.streets[e.street].kind === "edge");
  if (start >= 0) {
    const stack = [edges[start].a];
    const nodeSeen = new Set<number>(stack);
    while (stack.length) {
      const n = stack.pop()!;
      for (const ei of adj.get(n) ?? []) {
        seen.add(ei);
        const o = edges[ei].a === n ? edges[ei].b : edges[ei].a;
        if (!nodeSeen.has(o)) {
          nodeSeen.add(o);
          stack.push(o);
        }
      }
    }
    edges = edges.filter((_, i) => seen.has(i));
  }
  const degree = new Array(nodes.length).fill(0);
  for (const e of edges) {
    degree[e.a]++;
    degree[e.b]++;
  }
  return { nodes, edges, degree };
}

/** 網の面を取り出して街区にする */
export function buildBlocks(plan: DistrictPlan, g: StreetGraph): Block[] {
  // 点ごとに、出ていく辺を角度の順に並べる
  const out = new Map<number, { to: number; edge: number; ang: number }[]>();
  g.edges.forEach((e, i) => {
    for (const [from, to] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      const ang = Math.atan2(g.nodes[to][1] - g.nodes[from][1], g.nodes[to][0] - g.nodes[from][0]);
      const l = out.get(from);
      if (l) l.push({ to, edge: i, ang });
      else out.set(from, [{ to, edge: i, ang }]);
    }
  });
  for (const l of out.values()) l.sort((p, q) => p.ang - q.ang);
  const visited = new Set<string>();
  const blocks: Block[] = [];
  for (const e of g.edges)
    for (const [s0, s1] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      if (visited.has(`${s0}>${s1}`)) continue;
      const poly: P2[] = [];
      const streets: number[] = [];
      let from = s0, to = s1;
      let ok = true;
      for (let guard = 0; guard < 4000; guard++) {
        visited.add(`${from}>${to}`);
        poly.push(g.nodes[from]);
        const l = out.get(to)!;
        const back = l.findIndex((o) => o.to === from);
        // 戻る辺のひとつ時計回り隣へ進むと、面を左に見て一周する
        const next = l[(back + l.length - 1) % l.length];
        const cur = out.get(from)!.find((o) => o.to === to)!;
        streets.push(g.edges[cur.edge].street);
        from = to;
        to = next.to;
        if (from === s0 && to === s1) break;
        if (guard === 3999) ok = false;
      }
      if (!ok || poly.length < 3) continue;
      // 反時計回り（面積が正）の面が街区。外側の面は時計回りになる
      if (signedArea(poly) <= 20) continue;
      blocks.push(makeBlock(plan, poly, streets));
    }
  return blocks;
}

function makeBlock(plan: DistrictPlan, poly0: P2[], streets0: number[]): Block {
  const { poly, tags: streets } = cleanPoly(poly0, streets0, 1.0);
  if (poly.length < 3) return { poly, streets, curb: null, lotLine: null };
  const dCurb = streets.map((s) => halfWidth(plan.streets[s]));
  const dLot = streets.map((s, i) => dCurb[i] + plan.streets[s].sidewalk);
  const curb = insetPoly(poly, dCurb);
  const lotLine = curb ? insetPoly(poly, dLot) : null;
  return { poly, streets, curb, lotLine };
}

/** 敷地の間口の幅【初期値】: 幹線沿い（店）と、それ以外（住宅） */
const FRONT_MAIN: [number, number] = [6.5, 10];
const FRONT_HOUSE: [number, number] = [10.5, 14.5];
/** 幹線沿いの敷地の奥行き */
const MAIN_DEPTH = 17;

interface Piece {
  poly: P2[];
  tags: number[];
}

/** 街区を敷地に切る */
export function buildLots(plan: DistrictPlan, blocks: Block[]): Lot[] {
  const lots: Lot[] = [];
  const kindOf = (t: number) => (t < 0 ? null : plan.streets[t].kind);
  const addLot = (bi: number, c: Piece, inner = false) => {
    if (c.poly.length < 3) return;
    const a = signedArea(c.poly);
    if (a < 50) return;
    // 間口: 通りに面した辺のうち、長さ × 通りの格 が最大のもの
    let front = -1, score = 0;
    let onMain = false;
    for (let i = 0; i < c.poly.length; i++) {
      const k = kindOf(c.tags[i]);
      if (!k || k === "edge") continue;
      const p = c.poly[i], q = c.poly[(i + 1) % c.poly.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const sc = l * (k === "arterial" ? 4 : k === "local" ? 1 : 0.8);
      if (l > 3 && sc > score) {
        score = sc;
        front = i;
        onMain = k === "arterial";
      }
    }
    lots.push({ block: bi, poly: c.poly, tags: c.tags, front, area: a, mainStreet: onMain, inner });
  };
  /** 軸 (lx, lz) に沿って a0〜a1 を間口で切る */
  const slice = (bi: number, piece: Piece, lx: number, lz: number, a0: number, a1: number, range: [number, number], salt: number, inner = false) => {
    const [f0, f1] = range;
    const cuts: number[] = [a0];
    for (let k = 0; ; k++) {
      const w = f0 + (f1 - f0) * unit(plan.seed, bi * 64 + salt, k, 13);
      const next = cuts[cuts.length - 1] + w;
      if (a1 - next < f0 * 0.7) break;
      cuts.push(next);
    }
    cuts.push(a1);
    for (let k = 0; k < cuts.length - 1; k++) {
      let c = clipHalfPlane(piece.poly, piece.tags, -lx, -lz, -cuts[k], -1);
      c = clipHalfPlane(c.poly, c.tags, lx, lz, cuts[k + 1], -1);
      addLot(bi, c, inner);
    }
  };

  blocks.forEach((b, bi) => {
    if (!b.lotLine) return;
    let rest: Piece = { poly: b.lotLine.poly, tags: b.lotLine.edges.map((e) => b.streets[e]) };
    {
      const area = signedArea(rest.poly);
      let per = 0;
      for (let i = 0; i < rest.poly.length; i++) per += Math.hypot(rest.poly[(i + 1) % rest.poly.length][0] - rest.poly[i][0], rest.poly[(i + 1) % rest.poly.length][1] - rest.poly[i][1]);
      // 細すぎる・小さすぎる街区は敷地にしない
      if (area < 140 || (2 * area) / per < 5) return;
    }

    // 幹線に面した帯を先に切り出す（幹線に間口を向けた、奥行き MAIN_DEPTH の敷地の列）
    for (let pass = 0; pass < 3; pass++) {
      const P = rest.poly, T = rest.tags;
      const n = P.length;
      // 幹線の辺の連なり（同じ世界の道路）で、いちばん長いもの
      let bestStart = -1, bestCount = 0, bestLen = 0;
      for (let i = 0; i < n; i++) {
        if (kindOf(T[i]) !== "arterial" || (kindOf(T[(i + n - 1) % n]) === "arterial" && plan.streets[T[(i + n - 1) % n]].road === plan.streets[T[i]].road)) continue;
        let cnt = 0, len = 0;
        while (cnt < n && kindOf(T[(i + cnt) % n]) === "arterial" && plan.streets[T[(i + cnt) % n]].road === plan.streets[T[i]].road) {
          const p = P[(i + cnt) % n], q = P[(i + cnt + 1) % n];
          len += Math.hypot(q[0] - p[0], q[1] - p[1]);
          cnt++;
        }
        if (len > bestLen) {
          bestLen = len;
          bestStart = i;
          bestCount = cnt;
        }
      }
      if (bestLen < 12) break;
      const p0 = P[bestStart], p1 = P[(bestStart + bestCount) % n];
      let dx = p1[0] - p0[0], dz = p1[1] - p0[1];
      const dl = Math.hypot(dx, dz);
      if (dl < 6) break;
      dx /= dl;
      dz /= dl;
      const nx = -dz, nz = dx; // 街区の内側
      let base = 0;
      for (let k = 0; k <= bestCount; k++) base += P[(bestStart + k) % n][0] * nx + P[(bestStart + k) % n][1] * nz;
      base /= bestCount + 1;
      const depth = MAIN_DEPTH + 3 * unit(plan.seed, bi, pass, 14);
      const strip = clipHalfPlane(P, T, nx, nz, base + depth, -1);
      const remain = clipHalfPlane(P, T, -nx, -nz, -(base + depth), -1);
      const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
      const central = Math.hypot(mx - plan.cx, mz - plan.cz) < plan.radius * 0.7;
      const bbS = boundsAlong(strip.poly, dx, dz);
      slice(bi, strip, dx, dz, bbS.a0, bbS.a1, central ? FRONT_MAIN : FRONT_HOUSE, 8 + pass);
      // 帯に使った幹線の辺は、残りの側では敷地の境になっている（切り口の印 −1）
      rest = remain;
      if (rest.poly.length < 3 || signedArea(rest.poly) < 60) return;
    }

    const P = rest.poly;
    // 箱の向き: 街の主軸と、いちばん長い辺の向きのうち、外接の箱が小さい方
    let best = { ax: plan.ax, az: plan.az, area: Infinity };
    const cands: [number, number][] = [[plan.ax, plan.az]];
    let longest = 0;
    for (let i = 0; i < P.length; i++) {
      const dx = P[(i + 1) % P.length][0] - P[i][0], dz = P[(i + 1) % P.length][1] - P[i][1];
      const l = Math.hypot(dx, dz);
      if (l > longest) {
        longest = l;
        cands[1] = [dx / l, dz / l];
      }
    }
    for (const [cx, cz] of cands) {
      const bb = boundsAlong(P, cx, cz);
      const a = (bb.a1 - bb.a0) * (bb.b1 - bb.b0);
      if (a < best.area) best = { ax: cx, az: cz, area: a };
    }
    let lx = best.ax, lz = best.az;
    let bb = boundsAlong(P, lx, lz);
    if (bb.b1 - bb.b0 > bb.a1 - bb.a0) {
      // 長い方を L 軸にする
      [lx, lz] = [-lz, lx];
      bb = boundsAlong(P, lx, lz);
    }
    const sx = -lz, sz = lx;
    const depth = bb.b1 - bb.b0;

    // 列（奥行きの向き）
    const rows: [number, number][] = [];
    if (depth < 30) rows.push([bb.b0, bb.b1]);
    else if (depth <= 58) {
      const mid = (bb.b0 + bb.b1) / 2 + (unit(plan.seed, bi, 11) - 0.5) * depth * 0.08;
      rows.push([bb.b0, mid], [mid, bb.b1]);
    } else {
      const d = 20 + 4 * unit(plan.seed, bi, 12);
      rows.push([bb.b0, bb.b0 + d], [bb.b0 + d, bb.b1 - d], [bb.b1 - d, bb.b1]);
    }
    rows.forEach(([r0, r1], ri) => {
      const inner = rows.length === 3 && ri === 1;
      let row = clipHalfPlane(rest.poly, rest.tags, -sx, -sz, -r0, -1);
      row = clipHalfPlane(row.poly, row.tags, sx, sz, r1, -1);
      if (row.poly.length < 3) return;
      slice(bi, row, lx, lz, bb.a0, bb.a1, inner ? [16, 24] : FRONT_HOUSE, ri, inner);
    });
  });
  return lots;
}
