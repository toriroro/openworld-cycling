// 線路の経路探索（鉄道の草案 4.1）。RAIL_GRID の格子上の A*、16 方向、進行方向つきの状態。
// 道路の探索（route.ts）と同じ作りで、違いは: 格子が粗い、曲がりにくい、勾配の上限が 2.5%、
// まっすぐ進んで地形の高い所を抜ける「トンネル」と低い所を渡る「高架」の移動がある（海・湖の橋は道路と同じ）。
// 費用は加減乗除と sqrt だけで計算し、同点は状態番号で決める（モック仕様 4.2【固定】）。

import { MAX_SEA_CROSSING } from "./constants.ts";

const DX = [1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1, 0, 1, 1, 2];
const DZ = [0, 1, 1, 2, 1, 2, 1, 1, 0, -1, -1, -2, -1, -2, -1, -1];
const DLEN = DX.map((dx, k) => Math.sqrt(dx * dx + DZ[k] * DZ[k]));
/** 1 歩の向きの差（22.5° 刻み）ごとの曲がりの費用。3 以上は曲がれない（100m で 45° まで） */
const TURN_COST = [0, 0.12, 0.8];
const MAX_TURN = 2;
/** まっすぐ跳ぶ移動に使う向き（隣の格子へ進む 8 方向） */
const JUMP_DIR = DX.map((dx, k) => Math.abs(dx) <= 1 && Math.abs(DZ[k]) <= 1);

export interface RailGrid {
  /** 範囲の左上の格子番号 */
  ix0: number;
  iz0: number;
  w: number;
  h: number;
  /** 格子の一辺 (m) */
  cell: number;
  heights: Float64Array;
  /** bit0 = 水（海・湖）、bit1 = 川の河原と縁、bit2 = 道路が通る、bit3 = 道路を調べた帯の中 */
  flags: Uint8Array;
  /** 道路を調べた（bit2・bit3 が意味を持つ） */
  roads?: boolean;
}

export interface RailRouteParams {
  maxGrade: number;
  gradeWeight: number;
  overGradeWeight: number;
  /** トンネル・高架の費用（水平距離に掛ける追加分） */
  tunnelCost: number;
  viaductCost: number;
  /** 海・湖の橋の費用 */
  bridgeCost: number;
  /** 川の河原を通る費用 */
  riverCost: number;
  /** まっすぐ跳ぶ移動の最大の格子数 */
  maxJump: number;
  /** 道路を横切る費用 (m)、道路の格子から道路の格子へ進む費用（水平距離に掛ける追加分）、調べた帯の外へ出る費用（同） */
  roadCross: number;
  roadAlong: number;
  offBand: number;
  /** トンネルにする、地面が線より高い量 (m)。高架にする、線より低い量 (m) */
  tunnelCover: number;
  viaductClear: number;
  heuristicWeight: number;
}

export const RAIL_ROUTE_PARAMS: Omit<RailRouteParams, "maxGrade"> = {
  gradeWeight: 4,
  overGradeWeight: 80,
  tunnelCost: 4,
  viaductCost: 2.2,
  bridgeCost: 3,
  riverCost: 3,
  maxJump: 24,
  roadCross: 250,
  roadAlong: 6,
  offBand: 1.5,
  tunnelCover: 12,
  viaductClear: 8,
  heuristicWeight: 1.2,
};

/** 移動の種類: 0 = 地上、1 = 海・湖の橋、2 = トンネル、3 = 高架 */
export interface RailRouteResult {
  cells: Int32Array;
  kind: Uint8Array;
  expanded: number;
}

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

function gradeCost(g: number, p: RailRouteParams): number {
  const r = g / p.maxGrade;
  if (r <= 1) return p.gradeWeight * r * r;
  return p.gradeWeight + p.overGradeWeight * (r - 1);
}

/** A* 探索（格子の番号は範囲の中の番号）。到達できなければ null */
export function findRailRoute(grid: RailGrid, sx: number, sz: number, gx: number, gz: number, p: RailRouteParams): RailRouteResult | null {
  const { w, h, heights, flags: gf, cell: step } = grid;
  const nStates = w * h * 16;
  ensure(nStates);
  const G = bufG;
  const parent = bufParent;
  // bit0: 閉じた, bit1-2: 移動の種類, bit3: 訪問済み, bit4: 出発点
  const st = bufFlags;
  st.fill(0, 0, nStates);
  const hw = p.heuristicWeight * step;
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
      const q = (i - 1) >> 1;
      const pk = heapKey[q];
      if (pk < key || (pk === key && heapVal[q] < val)) break;
      heapKey[i] = pk;
      heapVal[i] = heapVal[q];
      i = q;
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
    const dx = cx - gx;
    const dz = cz - gz;
    return Math.sqrt(dx * dx + dz * dz) * hw;
  };
  const isWater = (c: number) => (gf[c] & 1) !== 0;
  const useRoads = !!grid.roads;
  /** 道路の印による追加の費用（地上の移動） */
  const roadTerm = (from: number, to: number, dist: number) => {
    if (!useRoads) return 0;
    let c = 0;
    if (gf[to] & 4) c += gf[from] & 4 ? dist * p.roadAlong : p.roadCross;
    if (!(gf[to] & 8)) c += dist * p.offBand;
    return c;
  };
  const riv = (c: number) => (gf[c] >> 1) & 1;

  const startCell = sz * w + sx;
  for (let d = 0; d < 16; d++) {
    const s = startCell * 16 + d;
    G[s] = 0;
    parent[s] = -1;
    st[s] = 8 | 16;
  }
  push(heur(sx, sz), startCell * 16);
  let expanded = 0;
  let goal = -1;

  const relax = (s: number, g0: number, ncell: number, nd: number, cost: number, kind: number, nx: number, nz: number) => {
    const ns = ncell * 16 + nd;
    const fl = st[ns];
    if (fl & 1) return;
    const ng = g0 + cost;
    if (fl & 8 && G[ns] <= ng) return;
    G[ns] = ng;
    parent[ns] = s;
    st[ns] = (fl & ~6 & ~16) | 8 | (kind << 1);
    push(ng + heur(nx, nz), ns);
  };

  while (heapN > 0) {
    const s = pop();
    if (st[s] & 1) continue;
    st[s] |= 1;
    expanded++;
    const cell = s >> 4;
    const dir = s & 15;
    const cx = cell % w;
    const cz = (cell - cx) / w;
    if (cx === gx && cz === gz) {
      goal = s;
      break;
    }
    const isStart = (st[s] & 16) !== 0;
    const g0 = G[s];
    const h0 = heights[cell];
    for (let nd = 0; nd < 16; nd++) {
      let diff = nd - dir;
      if (diff < 0) diff = -diff;
      if (diff > 8) diff = 16 - diff;
      if (!isStart && diff > MAX_TURN) continue;
      const turn = isStart ? 0 : TURN_COST[diff];
      const dx = DX[nd];
      const dz = DZ[nd];
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ncell = nz * w + nx;
      const dist = DLEN[nd] * step;
      if (isWater(ncell)) {
        // 海・湖の橋: まっすぐ 300m 以内で対岸に届けば渡れる
        let m = 1;
        while ((m + 1) * DLEN[nd] * step <= MAX_SEA_CROSSING) {
          m++;
          const bx = cx + dx * m;
          const bz = cz + dz * m;
          if (bx < 0 || bz < 0 || bx >= w || bz >= h) break;
          const bc = bz * w + bx;
          if (!isWater(bc)) {
            const L = dist * m;
            const g = Math.abs(heights[bc] - h0) / L;
            relax(s, g0, bc, nd, L * (1 + p.bridgeCost + gradeCost(g, p) + turn), 1, bx, bz);
            break;
          }
        }
        continue;
      }
      let gradeTerm: number;
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
        gradeTerm = (gradeCost(Math.abs(hm - h0) / half, p) + gradeCost(Math.abs(heights[ncell] - hm) / half, p)) * 0.5;
        gradeTerm += p.riverCost * (riv(cell) + riv(ca) + riv(cb) + riv(ncell)) * 0.25;
      } else {
        if (dx !== 0 && dz !== 0 && isWater(cz * w + cx + dx) && isWater((cz + dz) * w + cx)) continue;
        const g = Math.abs(heights[ncell] - h0) / dist;
        gradeTerm = gradeCost(g, p) + p.riverCost * (riv(cell) + riv(ncell)) * 0.5;
        // トンネル・高架: 1 歩の勾配が上限を超える時だけ、まっすぐ跳ぶ移動を試す
        if (JUMP_DIR[nd] && g > p.maxGrade) {
          let lastKind = 0;
          for (let m = 2; m <= p.maxJump; m++) {
            const bx = cx + dx * m;
            const bz = cz + dz * m;
            if (bx < 0 || bz < 0 || bx >= w || bz >= h) break;
            const bc = bz * w + bx;
            if (isWater(bc)) continue;
            const L = dist * m;
            const hb = heights[bc];
            const ge = Math.abs(hb - h0) / L;
            if (ge > p.maxGrade) continue;
            let above = 0;
            let below = 0;
            let wet = 0;
            for (let k = 1; k < m; k++) {
              const kc = (cz + dz * k) * w + cx + dx * k;
              const line = h0 + ((hb - h0) * k) / m;
              const d = heights[kc] - line;
              if (d > above) above = d;
              if (-d > below) below = -d;
              if (isWater(kc)) wet++;
            }
            if (wet * dist > MAX_SEA_CROSSING) break;
            let kind = 0;
            if (above >= p.tunnelCover) kind = 2;
            else if (below >= p.viaductClear) kind = 3;
            if (!kind) continue;
            // 同じ種類の跳び方は、いちばん短いものだけ（長い跳び方は費用が高くなるだけ）
            if (kind === lastKind) continue;
            lastKind = kind;
            const extra = kind === 2 ? p.tunnelCost : p.viaductCost;
            relax(s, g0, bc, nd, L * (1 + extra + gradeCost(ge, p) + turn), kind, bx, bz);
          }
        }
      }
      relax(s, g0, ncell, nd, dist * (1 + gradeTerm + turn) + roadTerm(cell, ncell, dist), 0, nx, nz);
    }
  }
  if (goal < 0) return null;
  const rev: number[] = [];
  const revKind: number[] = [];
  for (let s = goal; s >= 0; s = parent[s]) {
    rev.push(s >> 4);
    revKind.push((st[s] >> 1) & 3);
    if (st[s] & 16) break;
  }
  const n = rev.length;
  const cells = new Int32Array(n * 2);
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = rev[n - 1 - i];
    const x = c % w;
    cells[i * 2] = x + grid.ix0;
    cells[i * 2 + 1] = (c - x) / w + grid.iz0;
    kind[i] = revKind[n - 1 - i];
  }
  return { cells, kind, expanded };
}
