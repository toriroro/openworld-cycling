// 行き先までの最短経路（モック仕様 6.3「地図で行き先を指定すると、最短経路に沿って分岐を自動で選ぶ」）。
// 読み込み済みの道路網の上で、接続点を頂点・接続点の間の道路を辺にしたダイクストラ法。

import type { JunctionArm } from "../shared/world/types.ts";
import type { RoadNetwork, RoadPosition } from "./road-network.ts";

export interface PlanStep {
  /** この接続点で選ぶ腕 */
  junction: string;
  arm: JunctionArm;
}

export interface RoutePlan {
  steps: PlanStep[];
  length: number;
  /** 行き先の道路上の位置 */
  goal: { road: string; s: number };
}

/**
 * (x, z) に最も近い道路上の点。skipIslands で、道路網の一番大きなつながりに入らない道路（Road.island）を除く
 * （その上に行き先を置くと、つながっていないので経路が無い）
 */
export function nearestOnNetwork(net: RoadNetwork, x: number, z: number, skipIslands = false): { road: string; s: number; d: number } | null {
  let best: { road: string; s: number; d: number } | null = null;
  for (const r of net.roads.values()) {
    if (skipIslands && r.island) continue;
    const n = r.points.length / 3;
    const ds = r.length / (n - 1);
    for (let i = 0; i < n; i += 4) {
      const dx = r.points[i * 3] + r.origin[0] - x;
      const dz = r.points[i * 3 + 2] + r.origin[1] - z;
      const d = dx * dx + dz * dz;
      if (!best || d < best.d) best = { road: r.id, s: i * ds, d };
    }
  }
  return best ? { ...best, d: Math.sqrt(best.d) } : null;
}

/** 行き先と接続点の位置の比べで許す誤差 (m) */
const GOAL_EPS = 0.5;

/** 今の位置から行き先までの経路。行けなければ null */
export function planRoute(net: RoadNetwork, from: RoadPosition, goalX: number, goalZ: number): RoutePlan | null {
  // 今いる道路が切れ端の上でなければ、行き先も切れ端の上に置かない
  const goal = nearestOnNetwork(net, goalX, goalZ, !net.roads.get(from.road)?.island);
  if (!goal) return null;
  // 頂点: 接続点と、そこへ来た道路・向き（来た道をそのまま戻る経路を作らないため）。始点は "@start"、終点は "@goal"
  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; junction: string; arm: JunctionArm } | null>();
  const heap: [number, string][] = [];
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
        const l = 2 * i + 1, r = l + 1;
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
  /** 道路 road の位置 s から向き dir に進んで最初に着く接続点 */
  const nextOn = (road: string, s: number, dir: 1 | -1) => {
    const list = net.junctionsOn(road);
    if (dir > 0) {
      for (const j of list) if (j.s > s + 1e-6) return j;
    } else for (let i = list.length - 1; i >= 0; i--) if (list[i].s < s - 1e-6) return list[i];
    return null;
  };
  // 始点から: 今の向きにだけ進める（走行中に向きは変えない）
  dist.set("@start", 0);
  prev.set("@start", null);
  push(0, "@start");
  const relax = (fromV: string, base: number, road: string, s: number, dir: 1 | -1, junction: string, arm: JunctionArm | null) => {
    // 行き先が同じ道路のこの向きの先にあれば終点へ。
    // 0.5m の誤差を許す（行き止まりの端に行き先があると、端の接続点の s と行き先の s が丸めで 0.001m ずれ、どこからも着けなかった。藻岩山展望台）
    if (road === goal.road && (goal.s - s) * dir >= -GOAL_EPS) {
      const nj = nextOn(road, s, dir);
      if (!nj || (nj.s - goal.s) * dir >= -GOAL_EPS) {
        const d = base + Math.abs(goal.s - s);
        if (d < (dist.get("@goal") ?? Infinity)) {
          dist.set("@goal", d);
          prev.set("@goal", arm ? { from: fromV, junction, arm } : { from: fromV, junction: "", arm: { road, s, dir } });
          push(d, "@goal");
        }
      }
    }
    const nj = nextOn(road, s, dir);
    if (!nj) return;
    const d = base + Math.abs(nj.s - s);
    const v = `${nj.junction.id}|${road}|${dir}|${nj.s}`;
    if (d < (dist.get(v) ?? Infinity)) {
      dist.set(v, d);
      prev.set(v, arm ? { from: fromV, junction, arm } : { from: fromV, junction: "", arm: { road, s, dir } });
      push(d, v);
    }
  };
  const done = new Set<string>();
  while (heap.length) {
    const [d, v] = pop();
    if (done.has(v)) continue;
    done.add(v);
    if (v === "@goal") break;
    if (v === "@start") {
      relax(v, 0, from.road, from.s, from.dir, "", null);
      continue;
    }
    const [jid, inRoad, inDir, inS] = v.split("|");
    const j = net.junctions.get(jid);
    if (!j) continue;
    for (const a of j.arms) {
      if (!net.roads.has(a.road)) continue;
      // 来た道へそのまま戻る腕は使わない
      if (a.road === inRoad && a.dir === -Number(inDir) && Math.abs(a.s - Number(inS)) < 0.5) continue;
      relax(v, d, a.road, a.s, a.dir, jid, a);
    }
  }
  if (!dist.has("@goal")) return null;
  // たどり直して、接続点ごとに選ぶ腕の列にする
  const steps: PlanStep[] = [];
  let v = "@goal";
  while (v !== "@start") {
    const p = prev.get(v);
    if (!p) break;
    if (p.junction) steps.push({ junction: p.junction, arm: p.arm });
    v = p.from;
  }
  steps.reverse();
  return { steps, length: dist.get("@goal")!, goal: { road: goal.road, s: goal.s } };
}
