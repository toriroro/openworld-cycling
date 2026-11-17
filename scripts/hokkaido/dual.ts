// 上り・下りが別の線の道路（中央分離帯のある道路）を 1 本にまとめる（北海道の草案 4.2、6 章 #2）。
//
// 1. 一方通行の幹線・一般道の各点について、40m 以内にある「同じ名前・逆向き」の一方通行の線を相手とする。
// 2. 相手どうしを辺にしたグラフを 2 色に塗る（相手は必ず反対の側）。つながりごとに、番号の小さい道の色の側を残し、反対の側を消す。
// 3. 残す側の点を、相手との中点（中央分離帯の中心）へ動かす。
// 4. 消す側の点のうち、ほかの道（交わる道など）が使う点は、残す側の線の上へ移して差し込む（線の端に近ければその端の点に読み替える）。
// 5. 残す側は両方向の道にし、幅を 2 本分にする。

import type { RoadSpec } from "./roads.ts";
import type { OsmWay } from "./osm.ts";

export interface WayEntry {
  w: OsmWay;
  spec: RoadSpec;
}

type Pos = Map<number, { x: number; z: number }>;

const CELL = 40;
const MAX_D = 40;
const MIN_D = 3;

export function mergeDualCarriageways(ways: WayEntry[], pos: Pos) {
  const P = (id: number) => pos.get(id)!;
  const cand = ways.map((e, i) => ({ e, i })).filter(({ e }) => e.spec.cls <= 1 && e.w.tags.oneway === "yes");
  // 線分の索引
  const grid = new Map<string, [number, number][]>();
  for (const { e, i } of cand)
    for (let s = 0; s + 1 < e.w.nodes.length; s++) {
      const a = P(e.w.nodes[s]);
      const b = P(e.w.nodes[s + 1]);
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++)
        for (let cz = Math.floor(Math.min(a.z, b.z) / CELL); cz <= Math.floor(Math.max(a.z, b.z) / CELL); cz++) {
          const k = `${cx},${cz}`;
          (grid.get(k) ?? grid.set(k, []).get(k)!).push([i, s]);
        }
    }

  // 1. 点ごとの相手
  const partner = new Map<number, { way: number; x: number; z: number }>();
  const weight = new Map<string, number>();
  const pairedCount = new Map<number, number>();
  for (const { e, i } of cand) {
    const nodes = e.w.nodes;
    for (let k = 0; k < nodes.length; k++) {
      const p = P(nodes[k]);
      const a = P(nodes[Math.max(0, k - 1)]);
      const b = P(nodes[Math.min(nodes.length - 1, k + 1)]);
      const hl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const hx = (b.x - a.x) / hl;
      const hz = (b.z - a.z) / hl;
      let best: { way: number; x: number; z: number; d: number } | null = null;
      const seen = new Set<string>();
      for (let cx = Math.floor((p.x - MAX_D) / CELL); cx <= Math.floor((p.x + MAX_D) / CELL); cx++)
        for (let cz = Math.floor((p.z - MAX_D) / CELL); cz <= Math.floor((p.z + MAX_D) / CELL); cz++)
          for (const [j, s] of grid.get(`${cx},${cz}`) ?? []) {
            if (j === i || seen.has(`${j},${s}`)) continue;
            seen.add(`${j},${s}`);
            const o = ways[j];
            if ((o.w.tags.name ?? "") !== (e.w.tags.name ?? "")) continue;
            const c = P(o.w.nodes[s]);
            const d = P(o.w.nodes[s + 1]);
            const dx = d.x - c.x;
            const dz = d.z - c.z;
            const l = Math.hypot(dx, dz) || 1;
            if ((dx / l) * hx + (dz / l) * hz > -0.85) continue;
            const t = Math.max(0, Math.min(1, ((p.x - c.x) * dx + (p.z - c.z) * dz) / (l * l)));
            const qx = c.x + dx * t;
            const qz = c.z + dz * t;
            const dist = Math.hypot(qx - p.x, qz - p.z);
            if (dist < MIN_D || dist > MAX_D || (best && dist >= best.d)) continue;
            best = { way: j, x: qx, z: qz, d: dist };
          }
      if (!best) continue;
      if (!partner.has(nodes[k])) partner.set(nodes[k], { way: best.way, x: best.x, z: best.z });
      pairedCount.set(i, (pairedCount.get(i) ?? 0) + 1);
      const key = i < best.way ? `${i}|${best.way}` : `${best.way}|${i}`;
      weight.set(key, (weight.get(key) ?? 0) + 1);
    }
  }

  // 2. 2 色に塗る
  const paired = new Set(cand.filter(({ e, i }) => (pairedCount.get(i) ?? 0) >= Math.max(2, 0.5 * e.w.nodes.length)).map(({ i }) => i));
  const adj = new Map<number, number[]>();
  for (const [key, wgt] of weight) {
    if (wgt < 2) continue;
    const [a, b] = key.split("|").map(Number);
    if (!paired.has(a) && !paired.has(b)) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const color = new Map<number, number>();
  const comp = new Map<number, number>();
  let conflicts = 0;
  for (const start of [...adj.keys()].sort((a, b) => ways[a].w.id - ways[b].w.id || a - b)) {
    if (color.has(start)) continue;
    color.set(start, 0);
    comp.set(start, start);
    const queue = [start];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of adj.get(u) ?? []) {
        if (!color.has(v)) {
          color.set(v, 1 - color.get(u)!);
          comp.set(v, start);
          queue.push(v);
        } else if (color.get(v) === color.get(u)) conflicts++;
      }
    }
  }
  const dropped = new Set([...color].filter(([, c]) => c === 1).map(([i]) => i));
  const kept = new Set([...color].filter(([, c]) => c === 0).map(([i]) => i));

  // 3. 残す側の点を中点へ
  const moved = new Set<number>();
  for (const i of kept)
    for (const id of ways[i].w.nodes) {
      const pt = partner.get(id);
      if (!pt || moved.has(id) || !dropped.has(pt.way)) continue;
      const p = P(id);
      pos.set(id, { x: (p.x + pt.x) / 2, z: (p.z + pt.z) / 2 });
      moved.add(id);
    }

  // 4. 消す側の点で、ほかの道が使う点を残す側へ移す
  const usedByOthers = new Map<number, number>();
  ways.forEach((e, i) => {
    if (dropped.has(i)) return;
    for (const id of e.w.nodes) usedByOthers.set(id, (usedByOthers.get(id) ?? 0) + 1);
  });
  const alias = new Map<number, number>();
  const inserts = new Map<number, { seg: number; t: number; id: number }[]>();
  let reattached = 0;
  let lost = 0;
  for (const i of dropped) {
    const c = comp.get(i);
    for (const id of ways[i].w.nodes) {
      if (!usedByOthers.has(id) || alias.has(id)) continue;
      const p = P(id);
      let best: { way: number; seg: number; t: number; x: number; z: number; d: number } | null = null;
      for (const k of kept) {
        if (comp.get(k) !== c) continue;
        const nodes = ways[k].w.nodes;
        for (let s = 0; s + 1 < nodes.length; s++) {
          const a = P(nodes[s]);
          const b = P(nodes[s + 1]);
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
          const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
          if (d <= MAX_D && (!best || d < best.d)) best = { way: k, seg: s, t, x: a.x + dx * t, z: a.z + dz * t, d };
        }
      }
      if (!best) {
        lost++;
        continue;
      }
      const nodes = ways[best.way].w.nodes;
      const segLen = Math.hypot(P(nodes[best.seg + 1]).x - P(nodes[best.seg]).x, P(nodes[best.seg + 1]).z - P(nodes[best.seg]).z);
      if (best.t * segLen < 3) alias.set(id, nodes[best.seg]);
      else if ((1 - best.t) * segLen < 3) alias.set(id, nodes[best.seg + 1]);
      else {
        pos.set(id, { x: best.x, z: best.z });
        (inserts.get(best.way) ?? inserts.set(best.way, []).get(best.way)!).push({ seg: best.seg, t: best.t, id });
      }
      reattached++;
    }
  }

  // 5. 組み立て直す
  const out: WayEntry[] = [];
  ways.forEach((e, i) => {
    if (dropped.has(i)) return;
    let nodes = e.w.nodes;
    const ins = inserts.get(i);
    if (ins) {
      ins.sort((a, b) => a.seg - b.seg || a.t - b.t);
      const next: number[] = [];
      let q = 0;
      for (let s = 0; s < nodes.length; s++) {
        next.push(nodes[s]);
        while (q < ins.length && ins[q].seg === s) next.push(ins[q++].id);
      }
      nodes = next;
    }
    nodes = nodes.map((id) => alias.get(id) ?? id).filter((id, k, arr) => k === 0 || id !== arr[k - 1]);
    if (nodes.length < 2) return;
    if (kept.has(i)) {
      out.push({ w: { id: e.w.id, nodes, tags: { ...e.w.tags, oneway: "no", "dual:merged": "yes" } }, spec: { ...e.spec, width: Math.min(20, e.spec.width * 2) } });
    } else out.push({ w: { ...e.w, nodes }, spec: e.spec });
  });
  const km = (set: Set<number>) => {
    let l = 0;
    for (const i of set) {
      const n = ways[i].w.nodes;
      for (let k = 1; k < n.length; k++) l += Math.hypot(P(n[k]).x - P(n[k - 1]).x, P(n[k]).z - P(n[k - 1]).z);
    }
    return +(l / 1000).toFixed(1);
  };
  return { ways: out, stats: { keptWays: kept.size, droppedWays: dropped.size, keptKm: km(kept), droppedKm: km(dropped), reattachedNodes: reattached, lostNodes: lost, colorConflicts: conflicts } };
}
