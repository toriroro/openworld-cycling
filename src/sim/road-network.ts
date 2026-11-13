// 読み込み済みの道路網（道路・接続点）と、道路上の位置の計算。描画なしで使える（モック仕様 3.3: sim は shared/world だけに依存）。

import type { Junction, JunctionArm, Road } from "../shared/world/types.ts";

export interface RoadSample {
  x: number;
  y: number;
  z: number;
  /** 進行方向（道のりが増える向き）の水平の単位ベクトル */
  dx: number;
  dz: number;
  /** 道のりが増える向きの勾配 */
  grade: number;
}

export function roadSpacing(r: Road): number {
  return r.length / (r.points.length / 3 - 1);
}

/** 道のり s の位置・向き・勾配（世界座標） */
export function sampleRoad(r: Road, s: number): RoadSample {
  const P = r.points;
  const n = P.length / 3;
  const ds = roadSpacing(r);
  let f = s / ds;
  if (f < 0) f = 0;
  if (f > n - 1) f = n - 1;
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
  const bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
  // 向きは前後 2 点の差で少しなめらかにする
  const i0 = Math.max(0, i - 2);
  const i1 = Math.min(n - 1, i + 3);
  let dx = P[i1 * 3] - P[i0 * 3];
  let dz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  dx /= len;
  dz /= len;
  return {
    x: r.origin[0] + ax + (bx - ax) * t,
    y: ay + (by - ay) * t,
    z: r.origin[1] + az + (bz - az) * t,
    dx,
    dz,
    grade: (by - ay) / ds,
  };
}

export interface RoadPosition {
  road: string;
  s: number;
  dir: 1 | -1;
}

/** 道路と接続点の集まり。読み込み・破棄は呼び出し側が行う */
export class RoadNetwork {
  readonly roads = new Map<string, Road>();
  readonly junctions = new Map<string, Junction>();

  addRoad(r: Road) {
    this.roads.set(r.id, r);
  }

  addJunction(j: Junction) {
    const old = this.junctions.get(j.id);
    if (!old) {
      this.junctions.set(j.id, { ...j, arms: [...j.arms] });
      return;
    }
    for (const a of j.arms)
      if (!old.arms.some((b) => b.road === a.road && b.s === a.s && b.dir === a.dir)) old.arms.push(a);
  }

  removeRoad(id: string) {
    this.roads.delete(id);
  }

  /** 腕の道路が1本も残っていない接続点を捨てる */
  pruneJunctions() {
    for (const [id, j] of this.junctions) if (!j.arms.some((a) => this.roads.has(a.road))) this.junctions.delete(id);
  }

  /**
   * 道路の端に着いた時に次に進む腕を選ぶ。prefer が与えられればその関数で、なければいちばん直進に近い腕。
   * 行き止まりなら同じ道路を折り返す。
   */
  nextAtEnd(pos: RoadPosition, prefer?: (arms: JunctionArm[], heading: { dx: number; dz: number }) => JunctionArm | null): RoadPosition {
    const road = this.roads.get(pos.road)!;
    const atEnd = pos.dir === 1;
    const jid = atEnd ? road.end : road.start;
    const j = this.junctions.get(jid);
    const here = sampleRoad(road, atEnd ? road.length : 0);
    const hx = here.dx * pos.dir;
    const hz = here.dz * pos.dir;
    const arms = (j?.arms ?? []).filter((a) => {
      if (!this.roads.has(a.road)) return false;
      // 来た道へそのまま戻る腕は除く
      if (a.road === pos.road && (atEnd ? a.s >= road.length - 0.01 : a.s <= 0.01)) return false;
      return true;
    });
    if (!arms.length) return { road: pos.road, s: atEnd ? road.length : 0, dir: (-pos.dir) as 1 | -1 };
    let pick = prefer?.(arms, { dx: hx, dz: hz }) ?? null;
    if (!pick) {
      let best = -Infinity;
      for (const a of arms) {
        const r = this.roads.get(a.road)!;
        const p = sampleRoad(r, Math.min(r.length, Math.max(0, a.s + a.dir * 15)));
        const q = sampleRoad(r, a.s);
        let ax = p.x - q.x;
        let az = p.z - q.z;
        const l = Math.sqrt(ax * ax + az * az) || 1;
        ax /= l;
        az /= l;
        const dot = ax * hx + az * hz;
        if (dot > best) {
          best = dot;
          pick = a;
        }
      }
    }
    return { road: pick!.road, s: pick!.s, dir: pick!.dir };
  }
}
