// 長距離の便の経路（配達の草案 22 章、D5）: 道路網の全体の上で、時間の短い道をダイクストラ法で探す。
// 道路は両端の接続点の間で切れている（北海道の世界）。接続点を頂点、道路を辺にする。DOM・Three.js に依存しない。

import type { Junction, Road } from "./types.ts";

/** 道の等級ごとの平均の速さ (km/h)。信号・町中を込み。自転車道（4）は通らない【初期値】 */
const CLASS_KMH = [40, 35, 30, 25];
/** 営業所・町の中心から道路までの、直線に掛ける倍率と速さ (km/h) */
const ACCESS_FACTOR = 1.3;
const ACCESS_KMH = 20;
/** 道筋を残す間隔 (m) */
const PATH_STEP = 250;

export interface TruckRoute {
  /** 道のり (m) と、かかる時間 (s。晴れ) */
  m: number;
  s: number;
  /** 道筋（世界座標 x, z の並び。約 250m ごと） */
  path: number[];
}

interface Edge {
  to: string;
  road: Road;
  /** 道路の始めから終わりへ進むか */
  fwd: boolean;
  s: number;
}

export class TruckGraph {
  private adj = new Map<string, Edge[]>();
  private pos = new Map<string, { x: number; z: number }>();

  constructor(roads: Iterable<Road>, junctions: Iterable<Junction>) {
    for (const j of junctions) this.pos.set(j.id, { x: j.x, z: j.z });
    for (const r of roads) {
      if (r.island || r.cls > 3 || r.start === r.end) continue;
      const s = (r.length / 1000 / CLASS_KMH[r.cls]) * 3600;
      const add = (a: string, e: Edge) => {
        let l = this.adj.get(a);
        if (!l) this.adj.set(a, (l = []));
        l.push(e);
      };
      add(r.start, { to: r.end, road: r, fwd: true, s });
      add(r.end, { to: r.start, road: r, fwd: false, s });
    }
  }

  /** (x, z) にいちばん近い、道路のつながった接続点 */
  nearest(x: number, z: number): { id: string; d: number } | null {
    let best: { id: string; d: number } | null = null;
    for (const [id, p] of this.pos) {
      if (!this.adj.has(id)) continue;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (!best || d < best.d) best = { id, d };
    }
    return best && { id: best.id, d: Math.sqrt(best.d) };
  }

  /** (fx, fz) から (tx, tz) までの時間の短い道。つながっていなければ null */
  route(fx: number, fz: number, tx: number, tz: number): TruckRoute | null {
    const a = this.nearest(fx, fz);
    const b = this.nearest(tx, tz);
    if (!a || !b) return null;
    const dist = new Map<string, number>([[a.id, 0]]);
    const prev = new Map<string, { from: string; e: Edge }>();
    const heap: [number, string][] = [[0, a.id]];
    const push = (d: number, v: string) => {
      heap.push([d, v]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, string] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    const done = new Set<string>();
    while (heap.length) {
      const [d, v] = pop();
      if (done.has(v)) continue;
      done.add(v);
      if (v === b.id) break;
      for (const e of this.adj.get(v) ?? []) {
        const nd = d + e.s;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { from: v, e });
          push(nd, e.to);
        }
      }
    }
    if (!dist.has(b.id)) return null;
    const edges: Edge[] = [];
    for (let v = b.id; v !== a.id; ) {
      const p = prev.get(v)!;
      edges.push(p.e);
      v = p.from;
    }
    edges.reverse();
    // 道筋: 出発点、道路の点を 250m ごと、着く点
    const path: number[] = [fx, fz];
    let m = 0;
    let since = 0;
    for (const e of edges) {
      const r = e.road;
      const n = r.points.length / 3;
      for (let k = 1; k < n; k++) {
        const i = e.fwd ? k : n - 1 - k;
        since += r.length / (n - 1);
        if (since >= PATH_STEP || k === n - 1) {
          path.push(r.points[i * 3] + r.origin[0], r.points[i * 3 + 2] + r.origin[1]);
          since = 0;
        }
      }
      m += r.length;
    }
    path.push(tx, tz);
    const access = (a.d + b.d) * ACCESS_FACTOR;
    return { m: m + access, s: (dist.get(b.id) ?? 0) + (access / 1000 / ACCESS_KMH) * 3600, path };
  }
}
