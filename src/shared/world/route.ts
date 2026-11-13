// 道路1本の経路探索（モック仕様 4.7 手順1）。ROUTE_GRID の格子上の A*、16 方向、進行方向つきの状態。
// 費用は加減乗除と sqrt だけで計算し、同点は状態番号で決める（端末間で同じ結果になるように）。

import { MAX_SEA_CROSSING, ROUTE_GRID } from "./constants.ts";

const DX = [1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1, 0, 1, 1, 2];
const DZ = [0, 1, 1, 2, 1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1];
const DLEN = DX.map((dx, k) => Math.sqrt(dx * dx + DZ[k] * DZ[k]));
/** 向きの差（0〜8、22.5° 刻みの目安）ごとの曲がりの費用。5 以上は曲がれない */
const TURN_COST = [0, 0.04, 0.18, 0.55, 1.3];
const MAX_TURN = 4;

export interface RouteParams {
  maxGrade: number;
  /** 勾配の費用の係数 */
  gradeWeight: number;
  /** 最大勾配を超えた分の費用の係数 */
  overGradeWeight: number;
  /** 橋の費用（水平距離に掛ける追加分） */
  bridgeCost: number;
  /** 主要道の格子を通る時の割引（費用に掛ける） */
  mainDiscount: number;
  /** ヒューリスティックの重み（1 で最適） */
  heuristicWeight: number;
  /** 川の河原（と縁から 30m）を通る移動の費用（水平距離に掛ける追加分。河川の草案 4.1） */
  riverCost: number;
}

export const DEFAULT_ROUTE_PARAMS: Omit<RouteParams, "maxGrade"> = {
  gradeWeight: 2,
  overGradeWeight: 30,
  bridgeCost: 3,
  mainDiscount: 0.3,
  heuristicWeight: 1.15,
  riverCost: 6,
};

export interface RouteGrid {
  /** 範囲の左上の格子番号 */
  ix0: number;
  iz0: number;
  w: number;
  h: number;
  /** 各格子点の routeHeight */
  heights: Float64Array;
  /** 主要道が通っている格子（枝道の探索だけ） */
  mainMask?: Uint8Array;
  /** 格子点の印: bit0 = 水（海・湖）、bit1 = 川の河原と縁から 30m。無ければ高さ 0 未満を水とする */
  flags?: Uint8Array;
}

export interface RouteResult {
  /** 格子番号の列 [ix, iz, ix, iz, ...]（世界の格子番号） */
  cells: Int32Array;
  /** 各点に橋の移動で入ったか */
  bridge: Uint8Array;
  expanded: number;
}

// 探索用の配列は使い回す
let bufG = new Float64Array(0);
let bufParent = new Int32Array(0);
let bufFlags = new Uint8Array(0);
let heapKey = new Float64Array(1024);
let heapVal = new Int32Array(1024);

function ensure(n: number) {
  if (bufG.length < n) {
    bufG = new Float64Array(n);
    bufParent = new Int32Array(n);
    bufFlags = new Uint8Array(n);
  }
}

/** A* 探索。到達できなければ null */
export function findRoute(
  grid: RouteGrid,
  sx: number,
  sz: number,
  gx: number,
  gz: number,
  params: RouteParams,
): RouteResult | null {
  const { w, h, heights, ix0, iz0 } = grid;
  const mask = grid.mainMask;
  const nStates = w * h * 16;
  ensure(nStates);
  const G = bufG;
  const parent = bufParent;
  const flags = bufFlags; // bit0: 閉じた, bit1: 橋で入った, bit2: 訪問済み
  flags.fill(0, 0, nStates);

  const lsx = sx - ix0;
  const lsz = sz - iz0;
  const lgx = gx - ix0;
  const lgz = gz - iz0;
  const step = ROUTE_GRID;
  const gm = params.maxGrade;
  const hw = params.heuristicWeight * step;
  let heapN = 0;

  const push = (key: number, val: number) => {
    if (heapN >= heapKey.length) {
      const nk = new Float64Array(heapKey.length * 2);
      nk.set(heapKey);
      heapKey = nk;
      const nv = new Int32Array(heapVal.length * 2);
      nv.set(heapVal);
      heapVal = nv;
    }
    let i = heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = heapKey[p];
      if (pk < key || (pk === key && heapVal[p] < val)) break;
      heapKey[i] = pk;
      heapVal[i] = heapVal[p];
      i = p;
    }
    heapKey[i] = key;
    heapVal[i] = val;
  };
  const pop = (): number => {
    const top = heapVal[0];
    const k = heapKey[--heapN];
    const v = heapVal[heapN];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapN) break;
      if (c + 1 < heapN) {
        const k1 = heapKey[c + 1];
        const k0 = heapKey[c];
        if (k1 < k0 || (k1 === k0 && heapVal[c + 1] < heapVal[c])) c++;
      }
      const ck = heapKey[c];
      if (k < ck || (k === ck && v < heapVal[c])) break;
      heapKey[i] = ck;
      heapVal[i] = heapVal[c];
      i = c;
    }
    heapKey[i] = k;
    heapVal[i] = v;
    return top;
  };

  const heur = (cx: number, cz: number) => {
    const dx = cx - lgx;
    const dz = cz - lgz;
    return Math.sqrt(dx * dx + dz * dz) * hw;
  };
  const flagsArr = grid.flags;
  const isWater = flagsArr ? (cell: number) => (flagsArr[cell] & 1) !== 0 : (cell: number) => heights[cell] < 0;
  const riv = (cell: number) => (flagsArr ? (flagsArr[cell] >> 1) & 1 : 0);
  const rc = params.riverCost;

  // 出発点: 向きなし。16 方向すべての状態を 0 で入れ、曲がりの費用を掛けない
  const startCell = lsz * w + lsx;
  for (let d = 0; d < 16; d++) {
    const s = startCell * 16 + d;
    G[s] = 0;
    parent[s] = -1;
    flags[s] = 4 | 8; // 8: 出発点
  }
  push(heur(lsx, lsz), startCell * 16);

  let expanded = 0;
  let goalState = -1;

  while (heapN > 0) {
    const s = pop();
    if (flags[s] & 1) continue;
    flags[s] |= 1;
    expanded++;
    const cell = s >> 4;
    const dir = s & 15;
    const cx = cell % w;
    const cz = (cell - cx) / w;
    if (cx === lgx && cz === lgz) {
      goalState = s;
      break;
    }
    const isStart = (flags[s] & 8) !== 0;
    const g0 = G[s];
    const h0 = heights[cell];
    const onMain0 = mask ? mask[cell] : 0;
    for (let nd = 0; nd < 16; nd++) {
      let diff = nd - dir;
      if (diff < 0) diff = -diff;
      if (diff > 8) diff = 16 - diff;
      if (!isStart && diff > MAX_TURN) continue;
      const turn = isStart ? 0 : TURN_COST[diff];
      const dx = DX[nd];
      const dz = DZ[nd];
      let nx = cx + dx;
      let nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      let ncell = nz * w + nx;
      let dist = DLEN[nd] * step;
      let bridge = false;
      let gradeTerm: number;
      if (isWater(ncell)) {
        // 橋: 同じ向きにまっすぐ進んで 300m 以内で対岸に届くなら渡れる
        let m = 1;
        let found = false;
        while ((m + 1) * DLEN[nd] * step <= MAX_SEA_CROSSING) {
          m++;
          nx = cx + dx * m;
          nz = cz + dz * m;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) break;
          ncell = nz * w + nx;
          if (!isWater(ncell)) {
            found = true;
            break;
          }
        }
        if (!found) continue;
        dist = DLEN[nd] * step * m;
        bridge = true;
        const g = Math.abs(heights[ncell] - h0) / dist;
        gradeTerm = params.bridgeCost + gradeCost(g, gm, params);
      } else {
        // 2 格子進む移動は、途中の 2 格子も陸であることを求め、勾配は中点でも見る
        if (dx === 2 || dx === -2 || dz === 2 || dz === -2) {
          const ax = cx + (dx === 2 ? 1 : dx === -2 ? -1 : 0);
          const az = cz + (dz === 2 ? 1 : dz === -2 ? -1 : 0);
          const bx = cx + (dx === 2 || dx === -2 ? dx >> 1 : dx);
          const bz = cz + (dz === 2 || dz === -2 ? dz >> 1 : dz);
          const ca = az * w + ax;
          const cb = bz * w + bx;
          if (isWater(ca) || isWater(cb)) continue;
          const hm = (heights[ca] + heights[cb]) * 0.5;
          const half = dist * 0.5;
          const g1 = Math.abs(hm - h0) / half;
          const g2 = Math.abs(heights[ncell] - hm) / half;
          gradeTerm = (gradeCost(g1, gm, params) + gradeCost(g2, gm, params)) * 0.5;
          gradeTerm += rc * (riv(cell) + riv(ca) + riv(cb) + riv(ncell)) * 0.25;
        } else if (dx !== 0 && dz !== 0) {
          // 斜めの移動は角の2格子がどちらも水なら通れない
          if (isWater(cz * w + cx + dx) && isWater((cz + dz) * w + cx)) continue;
          const g = Math.abs(heights[ncell] - h0) / dist;
          gradeTerm = gradeCost(g, gm, params) + rc * (riv(cell) + riv(ncell)) * 0.5;
        } else {
          const g = Math.abs(heights[ncell] - h0) / dist;
          gradeTerm = gradeCost(g, gm, params) + rc * (riv(cell) + riv(ncell)) * 0.5;
        }
      }
      let cost = dist * (1 + gradeTerm + turn);
      if (mask && onMain0 && mask[ncell]) cost *= params.mainDiscount;
      const ns = ncell * 16 + nd;
      const fl = flags[ns];
      if (fl & 1) continue;
      const ng = g0 + cost;
      if (fl & 4 && G[ns] <= ng) continue;
      G[ns] = ng;
      parent[ns] = s;
      flags[ns] = (fl & ~2) | 4 | (bridge ? 2 : 0);
      push(ng + heur(nx, nz), ns);
    }
  }
  if (goalState < 0) return null;

  const rev: number[] = [];
  const revBridge: number[] = [];
  for (let s = goalState; s >= 0; s = parent[s]) {
    rev.push(s >> 4);
    revBridge.push(flags[s] & 2 ? 1 : 0);
    if (flags[s] & 8) break;
  }
  const n = rev.length;
  const cells = new Int32Array(n * 2);
  const bridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = rev[n - 1 - i];
    const x = c % w;
    cells[i * 2] = x + ix0;
    cells[i * 2 + 1] = (c - x) / w + iz0;
    bridge[i] = revBridge[n - 1 - i];
  }
  return { cells, bridge, expanded };
}

function gradeCost(g: number, gm: number, p: RouteParams): number {
  const r = g / gm;
  if (r <= 1) return p.gradeWeight * r * r;
  return p.gradeWeight + p.overGradeWeight * (r - 1);
}

