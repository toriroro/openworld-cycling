// バス停（端末で作る見た目。都市と交通の草案 1.1）。幹線・一般道の脇に、場所のハッシュで置く。
// 町・集落の近くに多く、田舎道にもまばらに置く。両側に 1 本ずつ、少しずらして置く。雪の多い土地らしく待合所付きを混ぜる。

import { hashString, hashUnit } from "../../shared/world/hash.ts";
import type { Road, WorldNode } from "../../shared/world/types.ts";
import { sampleRoad } from "../road-network.ts";

export interface BusStop {
  id: string;
  road: string;
  s: number;
  /** 道路のどちら側か（道のりが増える向きに対して -1 = 左、1 = 右）。この向きの左側を走る車が止まる */
  side: 1 | -1;
  /** 標柱の世界座標と路面の高さ */
  x: number;
  y: number;
  z: number;
  /** 道路の向き（道のりが増える向き） */
  dx: number;
  dz: number;
  /** 待合所があるか */
  shelter: boolean;
}

/** 区間の長さ (m)。区間ごとに 0〜1 組 */
const BUCKET = 700;
const SEED = 0xb05;

/**
 * 道路の上のバス停（同じ道路なら誰でも同じ）。nodes は町・集落の判定に使う。
 * ground（地面の高さ）を渡すと、谷側のガードレールが付く所（道路端から 4m で 2m 以上低い）と、切土の急な所には置かない
 */
export function busStopsOn(road: Road, nodes: Iterable<WorldNode>, ground?: (x: number, z: number) => number): BusStop[] {
  if (road.cls > 1 || road.kind === "cycleway" || road.length < 300) return [];
  const towns = [...nodes].filter((n) => n.kind !== "junction");
  const out: BusStop[] = [];
  const key = hashString(road.id);
  const n = Math.floor(road.length / BUCKET);
  for (let k = 0; k < n; k++) {
    const s0 = (k + 0.2 + 0.6 * hashUnit(SEED, key, k, 1)) * BUCKET;
    if (s0 < 80 || s0 > road.length - 110) continue;
    if (road.spans.some((sp) => s0 > sp.from - 40 && s0 < sp.to + 70)) continue;
    const p = sampleRoad(road, s0);
    let near = Infinity;
    let townR = 2000;
    for (const t of towns) {
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      const r = t.kind === "town" ? 2600 : 1500;
      if (d / r < near / townR) {
        near = d;
        townR = r;
      }
    }
    const inTown = near < townR;
    const chance = inTown ? 0.8 : 0.22;
    if (hashUnit(SEED, key, k, 2) > chance) continue;
    // 町の中心の近く（街区）では待合所を置かない（建物と重ならないように）
    const shelterOk = near > 650;
    const flat = (side: 1 | -1, s: number) => {
      if (!ground) return true;
      for (const ds of [-15, 0, 15]) {
        const q = sampleRoad(road, Math.max(0, Math.min(road.length, s + ds)));
        const o = road.width / 2 + 4;
        const g = ground(q.x - q.dz * o * side, q.z + q.dx * o * side);
        if (g < q.y - 2 || g > q.y + 2.5) return false;
      }
      return true;
    };
    if (!flat(-1, s0) || !flat(1, s0 + 28)) continue;
    for (const side of [-1, 1] as const) {
      const s = s0 + (side > 0 ? 28 : 0);
      const q = sampleRoad(road, s);
      const off = road.width / 2 + 0.6;
      out.push({
        id: `${road.id}#${k}${side > 0 ? "r" : "l"}`,
        road: road.id,
        s,
        side,
        // 右が正（sampleRoad の向きを右へ 90 度回すと (-dz, dx)）
        x: q.x - q.dz * off * side,
        y: q.y,
        z: q.z + q.dx * off * side,
        dx: q.dx,
        dz: q.dz,
        shelter: shelterOk && hashUnit(SEED, key, k, side > 0 ? 4 : 3) < 0.4,
      });
    }
  }
  return out;
}
