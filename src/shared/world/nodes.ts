// 結節点（モック仕様 4.5）と、結節点どうしを結ぶ辺（4.6）。

import {
  BRANCH_RATIO,
  EDGE_CELL_REACH,
  MAX_SEA_CROSSING,
  NODE_CELL,
  ROUTE_GRID,
} from "./constants.ts";
import { hash, hashUnit } from "./hash.ts";
import { placeName } from "./names.ts";
import { smoothstep } from "./noise.ts";
import type { Terrain } from "./terrain.ts";
import type { NodeKind, RoadClass, WorldNode } from "./types.ts";

const SALT_NODE = 11;
const SALT_IMPORTANCE = 12;
const SALT_BRANCH = 13;

export function nodeId(cx: number, cz: number): string {
  return `n_${cx}_${cz}`;
}

/** 格子 (cx, cz) の結節点。候補がすべて海なら null */
export function makeNode(seed: number, terrain: Terrain, cx: number, cz: number): WorldNode | null {
  let best: { x: number; z: number; y: number; score: number; slope: number } | null = null;
  for (let k = 0; k < 8; k++) {
    // 格子の縁を避ける（隣の格子の点と近づきすぎないように）
    const ux = 0.08 + 0.84 * hashUnit(seed, cx, cz, SALT_NODE * 64 + k * 2);
    const uz = 0.08 + 0.84 * hashUnit(seed, cx, cz, SALT_NODE * 64 + k * 2 + 1);
    const x = Math.floor((cx + ux) * NODE_CELL / ROUTE_GRID) * ROUTE_GRID;
    const z = Math.floor((cz + uz) * NODE_CELL / ROUTE_GRID) * ROUTE_GRID;
    const y = terrain.routeHeight(x, z);
    if (y < 0.02) continue;
    const slope = terrain.slope(x, z, 150);
    // 低い所（谷・海沿い）を好む。山地では尾根の上ではなく谷に置き、道が峠を越えるようにする。
    // 海から 600m 以内を強く好み、海沿いの町と海岸を通る道ができるようにする（GENERATOR_VERSION 2）
    const coastal = y < 40 ? 0.35 + 1.6 * terrain.seaNearness(x, z) : 0;
    const score = -slope * 12 - y / 250 + coastal;
    if (!best || score > best.score) best = { x, z, y, score, slope };
  }
  if (!best) return null;
  const flat = 1 - smoothstep(0.02, 0.18, best.slope);
  const low = 1 - smoothstep(50, 700, best.y);
  const importance = 0.55 * hashUnit(seed, cx, cz, SALT_IMPORTANCE) + 0.25 * flat + 0.2 * low;
  const kind: NodeKind = importance >= 0.68 ? "town" : importance >= 0.42 ? "village" : "junction";
  const nm = placeName(seed, cx, cz);
  return {
    id: nodeId(cx, cz),
    cx,
    cz,
    x: best.x,
    y: best.y,
    z: best.z,
    importance,
    kind,
    name: nm.name,
    reading: nm.reading,
  };
}

export interface EdgeInfo {
  id: string;
  a: WorldNode;
  b: WorldNode;
  kind: "main" | "branch";
  cls: RoadClass;
}

/** 結節点の順序（識別子の比較を数値で行う） */
export function nodeLess(a: WorldNode, b: WorldNode): boolean {
  return a.cx < b.cx || (a.cx === b.cx && a.cz < b.cz);
}

export function edgeId(a: WorldNode, b: WorldNode): string {
  return nodeLess(a, b) ? `${a.id}~${b.id}` : `${b.id}~${a.id}`;
}

function d2(a: WorldNode, b: WorldNode): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** 直線 ab が海を連続して渡る最長の長さ */
export function longestSeaRun(terrain: Terrain, a: WorldNode, b: WorldNode): number {
  const len = Math.sqrt(d2(a, b));
  const n = Math.max(2, Math.ceil(len / 25));
  let run = 0;
  let best = 0;
  const step = len / n;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = terrain.routeHeight(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (h < 0) {
      run += step;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

export interface NodeSource {
  node(cx: number, cz: number): WorldNode | null;
}

/** 周囲 5×5 格子の結節点（自分を含む） */
function neighborhood(src: NodeSource, n: WorldNode): WorldNode[] {
  const out: WorldNode[] = [];
  for (let dz = -EDGE_CELL_REACH; dz <= EDGE_CELL_REACH; dz++)
    for (let dx = -EDGE_CELL_REACH; dx <= EDGE_CELL_REACH; dx++) {
      const m = src.node(n.cx + dx, n.cz + dz);
      if (m) out.push(m);
    }
  return out;
}

/**
 * 結節点 a から出る辺。どこから計算しても同じになるよう、
 * 判定に使う第三の点は a と b それぞれの周囲 5×5 格子の和集合にする。
 */
export function edgesOf(seed: number, terrain: Terrain, src: NodeSource, a: WorldNode): EdgeInfo[] {
  const out: EdgeInfo[] = [];
  const nearA = neighborhood(src, a);
  for (const b of nearA) {
    if (b === a) continue;
    const nearB = neighborhood(src, b);
    const ab = d2(a, b);
    let rng = true;
    let gabriel = true;
    const check = (c: WorldNode) => {
      if (c === a || c === b) return;
      const ac = d2(a, c);
      const bc = d2(b, c);
      if (ac < ab && bc < ab) rng = false;
      if (ac + bc < ab) gabriel = false;
    };
    for (const c of nearA) check(c);
    for (const c of nearB) {
      if (Math.abs(c.cx - a.cx) <= EDGE_CELL_REACH && Math.abs(c.cz - a.cz) <= EDGE_CELL_REACH) continue;
      check(c);
    }
    if (!gabriel) continue;
    const id = edgeId(a, b);
    let kind: "main" | "branch";
    if (rng) kind = "main";
    else {
      const lo = nodeLess(a, b) ? a : b;
      const hi = lo === a ? b : a;
      if (hashUnit(seed, lo.cx * 1009 + hi.cx, lo.cz * 1009 + hi.cz, SALT_BRANCH) >= BRANCH_RATIO) continue;
      kind = "branch";
    }
    if (longestSeaRun(terrain, a, b) > MAX_SEA_CROSSING) continue;
    out.push({ id, a: nodeLess(a, b) ? a : b, b: nodeLess(a, b) ? b : a, kind, cls: edgeClass(terrain, a, b, kind) });
  }
  return out;
}

/** 等級。両端の重要度と沿線の起伏から決める */
function edgeClass(terrain: Terrain, a: WorldNode, b: WorldNode, kind: "main" | "branch"): RoadClass {
  const len = Math.sqrt(d2(a, b));
  const n = Math.max(2, Math.ceil(len / 200));
  let top = -1e9;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = terrain.routeHeight(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (h > top) top = h;
  }
  const climb = top - Math.max(a.y, b.y);
  const impMin = Math.min(a.importance, b.importance);
  if (kind === "main") {
    if (impMin >= 0.5 && climb < 120 && top < 350) return 0;
    if (climb > 350 || top > 750) return 2;
    return 1;
  }
  if (climb > 250 || top > 650 || impMin < 0.3) return 3;
  if (climb > 120) return 2;
  return 1;
}

export function edgeHash(seed: number, e: EdgeInfo, salt: number): number {
  return hash(seed, e.a.cx * 1009 + e.b.cx, e.a.cz * 1009 + e.b.cz, salt);
}
