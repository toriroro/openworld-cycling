// 街区の入力。「道路の中心線・幅・種類」と「街の外周」だけの、地図と同じ形のデータ。
// いまは町の結節点と世界の道路から規則で作る（planTown）。将来、実在の地図から作った同じ形のデータに差し替えられる。
// Three.js に依存しない。

import { hash, hashString } from "../../shared/world/hash.ts";
import type { Road, WorldNode } from "../../shared/world/types.ts";
import type { P2 } from "./geom.ts";

/** arterial = 世界の道路（走れる）、local = 区画道路、alley = 路地、edge = 街の外周（道ではない） */
export type StreetKind = "arterial" | "local" | "alley" | "edge";

export interface PlanStreet {
  id: string;
  kind: StreetKind;
  /** 車道の幅 (m) */
  width: number;
  /** 両側の歩道の幅 (m)。0 なら歩道なし */
  sidewalk: number;
  /** 中心線（世界座標 x, z） */
  pts: P2[];
  /** 世界の道路に当たる時、その識別子 */
  road?: string;
}

export interface DistrictPlan {
  id: string;
  seed: number;
  /** 中心（世界座標） */
  cx: number;
  cz: number;
  /** 街の広がりの目安 (m) */
  radius: number;
  /** 街路の主な向き（単位ベクトル） */
  ax: number;
  az: number;
  /** 街の外周（反時計回り） */
  boundary: P2[];
  streets: PlanStreet[];
}

const unit = (seed: number, a: number, b = 0, c = 0) => hash(seed, a, b, c) / 4294967296;

/** 街区の寸法【初期値】 */
export const ARTERIAL_SIDEWALK = 2.5;
export const LOCAL_WIDTH = 6;
export const ALLEY_WIDTH = 4;
/** 幹線の裏の通りまでの奥行きと、通りの間隔 */
const FIRST_DEPTH = 44;
const ROW_PITCH = 50;
/** 交わる通りの間隔 */
const CROSS_PITCH = 78;

/** 町の広がり (m)。重要度で変える */
export function townRadius(node: WorldNode): number {
  return 190 + 90 * Math.min(1, node.importance);
}

/**
 * 町の結節点の周りの街路の計画。roads は周りの世界の道路。
 * 街路は、結節点を通るいちばん等級の高い道路の向きを主軸にした格子（通りの位置はハッシュでずらす）。
 */
export function planTown(seed: number, node: WorldNode, roads: Road[]): DistrictPlan {
  const R = townRadius(node);
  const nh = hashString(node.id) ^ (seed | 0);
  const streets: PlanStreet[] = [];

  // 世界の道路（幹線）: 町の範囲にかかる部分を 8m ごとの折れ線にする
  const sorted = [...roads].filter((r) => r.surface === "paved" && r.kind !== "cycleway" && r.cls <= 2).sort((a, b) => a.cls - b.cls || (a.id < b.id ? -1 : 1));
  let ax = 1, az = 0;
  let axisSet = false;
  for (const r of sorted) {
    const P = r.points;
    const n = P.length / 3;
    const reach = R + 80;
    let run: P2[] = [];
    let k = 0;
    const flush = () => {
      if (run.length >= 2) streets.push({ id: `${r.id}#${k++}`, kind: "arterial", width: r.width, sidewalk: ARTERIAL_SIDEWALK, pts: run, road: r.id });
      run = [];
    };
    let nearest = -1, nearD = Infinity;
    for (let i = 0; i < n; i++) {
      const x = P[i * 3] + r.origin[0], z = P[i * 3 + 2] + r.origin[1];
      const d = Math.hypot(x - node.x, z - node.z);
      if (d < nearD) {
        nearD = d;
        nearest = i;
      }
      if (d > reach) {
        flush();
        continue;
      }
      // 端の点は必ず入れる（接続点で道路どうしがつながるように）
      if (i % 4 === 0 || i === n - 1) run.push([x, z]);
    }
    flush();
    if (!axisSet && nearD < 30) {
      // 主軸: 結節点から 60m ほど離れた所までの向き
      const a = Math.max(0, nearest - 30), b = Math.min(n - 1, nearest + 30);
      const dx = P[b * 3] - P[a * 3], dz = P[b * 3 + 2] - P[a * 3 + 2];
      const l = Math.hypot(dx, dz);
      if (l > 10) {
        ax = dx / l;
        az = dz / l;
        axisSet = true;
      }
    }
  }
  const bx = -az, bz = ax;
  const world = (u: number, v: number): P2 => [node.x + ax * u + bx * v, node.z + az * u + bz * v];

  // 外周: 12 角形。角ごとに半径を変えて、真円や正方形に見えないようにする
  const boundary: P2[] = [];
  for (let k = 0; k < 12; k++) {
    const th = (k / 12) * Math.PI * 2;
    const rr = R * (0.8 + 0.2 * unit(nh, k, 71));
    boundary.push(world(Math.cos(th) * rr, Math.sin(th) * rr));
  }
  streets.push({ id: "edge", kind: "edge", width: 0, sidewalk: 0, pts: [...boundary, boundary[0]] });

  // 主軸に沿う通り（幹線の裏の通りから外へ）
  const ext = R + 60;
  const rows: number[] = [];
  for (const sign of [-1, 1]) {
    let v = FIRST_DEPTH + 6 * unit(nh, sign, 1);
    for (let k = 0; v < R; k++) {
      rows.push(sign * v);
      streets.push({ id: `row${sign > 0 ? "p" : "m"}${k}`, kind: "local", width: LOCAL_WIDTH, sidewalk: 0, pts: [world(-ext, sign * v), world(ext, sign * v)] });
      v += ROW_PITCH - 5 + 10 * unit(nh, sign * (k + 2), 2);
    }
  }
  rows.sort((a, b) => a - b);
  // 交わる通り: 通りと通りの間（帯）ごとに引く。6 割の帯は位置をそろえ、残りは半分ずらして丁字路にする
  const bands = [-ext, ...rows, ext];
  const pitch = CROSS_PITCH + 14 * unit(nh, 3, 3);
  const base = unit(nh, 4, 4) * pitch;
  for (let b = 0; b < bands.length - 1; b++) {
    const v0 = bands[b], v1 = bands[b + 1];
    const stagger = unit(nh, b, 5) < 0.6 ? 0 : pitch / 2;
    for (let j = Math.ceil((-ext - base - stagger) / pitch); ; j++) {
      const u = base + stagger + j * pitch + (unit(nh, b * 131 + j, 6) - 0.5) * 8;
      if (u > ext) break;
      const alley = unit(nh, b * 131 + j, 7) < 0.4;
      // 両端を少し延ばして、通りの中心線に確実に届かせる
      streets.push({ id: `x${b}_${j}`, kind: alley ? "alley" : "local", width: alley ? ALLEY_WIDTH : LOCAL_WIDTH - 1, sidewalk: 0, pts: [world(u, v0 - 0.05), world(u, v1 + 0.05)] });
    }
  }
  return { id: node.id, seed: nh, cx: node.x, cz: node.z, radius: R, ax, az, boundary, streets };
}
