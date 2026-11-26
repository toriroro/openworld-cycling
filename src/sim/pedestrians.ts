// 歩く人（配達の草案 16 章、D2）。走る道の脇を、道に沿って行き来する。見た目だけで、走行・注文には影響しない（草案 6.5）。
// 位置は道路と時刻から決まる（状態を持たない）。近くの道だけを見て、近い順に上限まで出す。

import { hashString, hashUnit } from "../shared/world/hash.ts";
import type { Road } from "../shared/world/types.ts";

export interface Walker {
  x: number;
  y: number;
  z: number;
  /** 向き（水平の単位ベクトル） */
  dx: number;
  dz: number;
  /** 歩みの位相（0〜1 で 1 歩） */
  gait: number;
  /** 立っている（歩かない） */
  still: boolean;
  /** 見た目の種 */
  seed: number;
  /** 上着の色（業者の運転手。無ければ種で選ぶ） */
  coat?: string;
  /** 荷（箱）を持っている */
  carry?: boolean;
}

/** 人を置く道の区切り (m)、1 人が行き来する長さ (m)、歩幅 (m)、道の両端の置かない長さ（交差点の中に立たないように）(m)【初期値】 */
const STEP = 8;
const SPAN = 16;
const STRIDE = 1.25;
const EDGE = 12;

const bbox = new WeakMap<Road, [number, number, number, number]>();
function bboxOf(r: Road) {
  let b = bbox.get(r);
  if (!b) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const P = r.points;
    for (let i = 0; i < P.length; i += 3) {
      x0 = Math.min(x0, P[i]);
      x1 = Math.max(x1, P[i]);
      z0 = Math.min(z0, P[i + 2]);
      z1 = Math.max(z1, P[i + 2]);
    }
    b = [x0 + r.origin[0], z0 + r.origin[1], x1 + r.origin[0], z1 + r.origin[1]];
    bbox.set(r, b);
  }
  return b;
}

/**
 * 町の込み具合から、人の多さの倍率（1 が今までの量）【初期値】。commercial は店・ビル・集合住宅の込み具合、coverage は建物の込み具合（どちらも 0〜1）。
 * 都心（店 0.5）で 1.4、すすきの 1.25、住宅街（店 0.1・建物 0.3）で 0.4、建物の少ない所で 0.1
 */
export function crowdFactor(commercial: number, coverage: number): number {
  const f = 0.12 + 2.5 * commercial + 0.3 * Math.max(0, coverage - commercial);
  return Math.max(0.1, Math.min(1.45, f));
}

export interface WalkerOptions {
  /** 出してよい範囲 */
  inside?: (x: number, z: number) => boolean;
  /** 場所ごとの人の多さの倍率（crowdFactor）。区切りの始めの点で決める */
  crowd?: (x: number, z: number) => number;
  /**
   * 足元の高さ。roadY は道の中心の高さ、key は区切りごとの識別子（覚えておく時に使う）。
   * null なら立つ所が無い（橋の脇・高い盛土の脇など）ので出さない。無ければ道の中心の高さ
   */
  ground?: (x: number, z: number, roadY: number, key: number) => number | null;
  /**
   * 歩く所の横の位置（道の中心からの距離と、歩ける幅）。(x, z) は道の中心の点、(nx, nz) は歩く側への水平の単位ベクトル、
   * half は道の半幅、key は区切りごとの識別子。歩道があればその真ん中を返す。null なら道の端から 0.8〜1.5m
   */
  lane?: (key: number, x: number, z: number, nx: number, nz: number, half: number) => { center: number; width: number } | null;
}

/**
 * (x, z) から r 以内の歩く人。t は秒（世界の時刻）。density は 1 区切りに人のいる割合（昼 0.5・夜 0.15 など）。
 * opt で出してよい範囲・場所ごとの多さ・足元の高さを渡す。近い順に max 人まで。橋・トンネルの区間には出さない
 */
export function walkersNear(roads: Iterable<Road>, x: number, z: number, r: number, t: number, density: number, max: number, opt: WalkerOptions = {}): Walker[] {
  const { inside, crowd, ground, lane } = opt;
  const cand: { w: Walker; d: number }[] = [];
  const r2 = r * r;
  for (const rd of roads) {
    if (rd.island || rd.length < SPAN + 2 * EDGE) continue;
    const b = bboxOf(rd);
    if (x < b[0] - r || x > b[2] + r || z < b[1] - r || z > b[3] + r) continue;
    const hr = hashString(rd.id);
    const P = rd.points;
    const n = P.length / 3;
    const ds = rd.length / (n - 1);
    const room = rd.length - 2 * EDGE - SPAN;
    const slots = Math.floor(room / STEP) + 1;
    const ds0 = rd.length / (n - 1);
    for (let k = 0; k < slots; k++) {
      const keep = hashUnit(0x9a1, hr, k);
      // 倍率が最大でも出ない区切りは先に除く
      if (keep >= density * (crowd ? 1.45 : 1)) continue;
      const u = hashUnit(0x9a2, hr, k);
      const s0 = EDGE + k * STEP + u * Math.max(0, Math.min(STEP, room - k * STEP));
      if (rd.spans.some((q) => s0 + SPAN > q.from - 4 && s0 < q.to + 4)) continue;
      if (crowd) {
        const f0 = Math.min(n - 1.001, s0 / ds0);
        const i0 = Math.floor(f0);
        if (keep >= density * crowd(P[i0 * 3] + rd.origin[0], P[i0 * 3 + 2] + rd.origin[1])) continue;
      }
      const still = hashUnit(0x9a3, hr, k) < 0.15;
      // 歩く速さ 0.75〜1.2m/s（前は 1.0〜1.5 で急いで見えた。2026-11-26）
      const v = 0.75 + 0.45 * hashUnit(0x9a4, hr, k);
      const walked = still ? 0 : t * v + hashUnit(0x9a5, hr, k) * 2 * SPAN;
      const p = walked % (2 * SPAN);
      const fwd = p < SPAN;
      const s = s0 + (fwd ? p : 2 * SPAN - p);
      const f = Math.min(n - 1.001, s / ds);
      const i = Math.floor(f);
      const a = f - i;
      const px = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * a + rd.origin[0];
      const pz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * a + rd.origin[1];
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d > r2) continue;
      if (inside && !inside(px, pz)) continue;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 2);
      let tx = P[i1 * 3] - P[i0 * 3];
      let tz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
      const l = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= l;
      tz /= l;
      const side = hashUnit(0x9a6, hr, k) < 0.5 ? 1 : -1;
      const seed = (hr ^ (k * 0x9e3779b1)) >>> 0;
      const u7 = hashUnit(0x9a7, hr, k);
      // 歩道があれば歩道の真ん中あたり（幅の 6 割の中でばらす）、無ければ道の端から 0.8〜1.5m
      const ln = lane ? lane(seed, px, pz, tz * side, -tx * side, rd.width / 2) : null;
      const off = ln ? ln.center + (u7 - 0.5) * Math.min(0.6 * ln.width, 1.2) : rd.width / 2 + 0.8 + 0.7 * u7;
      // 左（進む向きに対して）は (tz, −tx)
      const wx = px + tz * off * side;
      const wz = pz - tx * off * side;
      const dir = fwd ? 1 : -1;
      const roadY = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * a;
      const y = ground ? ground(wx, wz, roadY, seed) : roadY;
      if (y === null) continue;
      cand.push({
        w: { x: wx, y, z: wz, dx: tx * dir, dz: tz * dir, gait: (walked / STRIDE) % 1, still, seed },
        d,
      });
    }
  }
  cand.sort((p, q) => p.d - q.d);
  return cand.slice(0, max).map((c) => c.w);
}
