// 接続点の形（モック仕様 5.3・6.2）。描画と走行の両方が使う。描画に依存しない。
// - 腕ごとの「口」: 接続点の中心から腕の道路を t だけ進んだ所。道路の路面は口で止め、口の内側は接続点の舗装面で埋める
// - 隣り合う腕の路肩どうしを曲線（隅切り）でつなぐ
// - 腕から腕へ曲がる時の走る線（左側の車線から左側の車線へ）

import type { Junction, JunctionArm, Road } from "../shared/world/types.ts";
import { roadSpacing } from "./road-network.ts";

/** 隅切りの半径 (m)【初期値】。等級が高いほど大きい */
const CORNER_RADIUS = [9, 7, 5, 5, 4];
/** 口までの距離の上限 (m) */
const MAX_MOUTH = 30;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ArmShape {
  arm: JunctionArm;
  road: Road;
  /** 接続点の中心から腕の先へ向かう水平の単位ベクトル（中心付近の道の向き） */
  ux: number;
  uz: number;
  angle: number;
  hw: number;
  /** 口の道のり（道路の点の位置にそろえる） */
  mouthS: number;
  /** 中心から口までの道のり */
  t: number;
  /** 口の中心と、外向きに見て右（+r）・左（−r）の路肩の点 */
  mouth: Vec3;
  plus: Vec3;
  minus: Vec3;
  /** 口での外向きの単位ベクトル */
  ox: number;
  oz: number;
}

export interface JunctionShape {
  junction: Junction;
  center: Vec3;
  /** 角度の順（atan2(z, x) の増える向き） */
  arms: ArmShape[];
  /** 腕 i の +r の点から腕 i+1 の −r の点までの路肩の曲線（腕が2本以上の時） */
  edges: Vec3[][];
  /** 隣り合う腕の間の角度（ラジアン）。edges[i] の側 */
  gaps: number[];
  /** 形を決めた腕の並び（変わったら作り直す） */
  key: string;
}

interface RoadSource {
  roads: Map<string, Road>;
  junctionsOn(roadId: string): { junction: Junction; s: number }[];
}

/** 道路の点 i の位置（世界座標）と、点の前後から求めた道のりが増える向きの単位ベクトル。描画の断面と同じ求め方 */
export function roadFrame(r: Road, i: number): { x: number; y: number; z: number; tx: number; tz: number } {
  const P = r.points;
  const n = P.length / 3;
  const a = Math.max(0, i - 1);
  const b = Math.min(n - 1, i + 1);
  let tx = P[b * 3] - P[a * 3];
  let tz = P[b * 3 + 2] - P[a * 3 + 2];
  const l = Math.sqrt(tx * tx + tz * tz) || 1;
  tx /= l;
  tz /= l;
  return { x: P[i * 3] + r.origin[0], y: P[i * 3 + 1], z: P[i * 3 + 2] + r.origin[1], tx, tz };
}

function pointAtS(r: Road, s: number): Vec3 {
  const P = r.points;
  const n = P.length / 3;
  const ds = roadSpacing(r);
  let f = s / ds;
  if (f < 0) f = 0;
  if (f > n - 1) f = n - 1;
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  return {
    x: r.origin[0] + P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t,
    y: P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t,
    z: r.origin[1] + P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t,
  };
}

const cache = new Map<string, JunctionShape>();

/** 接続点の形。読み込まれていない道路の腕は除く。腕が1本なら口を作らない（t = 0） */
export function junctionShape(net: RoadSource, j: Junction): JunctionShape {
  const live = j.arms.filter((a) => net.roads.has(a.road));
  const key = live.map((a) => `${a.road}:${a.s.toFixed(2)}:${a.dir}`).join("|");
  const old = cache.get(j.id);
  if (old && old.key === key && old.junction === j) return old;
  const shape = build(net, j, live, key);
  cache.set(j.id, shape);
  if (cache.size > 4000) {
    // 古いものから捨てる
    const drop = cache.size - 3000;
    let k = 0;
    for (const id of cache.keys()) {
      if (k++ >= drop) break;
      cache.delete(id);
    }
  }
  return shape;
}

function build(net: RoadSource, j: Junction, live: JunctionArm[], key: string): JunctionShape {
  const center = { x: j.x, y: j.y, z: j.z };
  // 腕の向きと、口に使える長さ
  const raw = live.map((arm) => {
    const road = net.roads.get(arm.road)!;
    const room = roomOf(net, road, arm);
    const p = pointAtS(road, arm.s + arm.dir * Math.min(8, Math.max(1, room)));
    let ux = p.x - center.x;
    let uz = p.z - center.z;
    const l = Math.sqrt(ux * ux + uz * uz) || 1;
    ux /= l;
    uz /= l;
    return { arm, road, ux, uz, angle: Math.atan2(uz, ux), hw: road.width / 2, room };
  });
  raw.sort((a, b) => a.angle - b.angle);
  const n = raw.length;
  const need = raw.map((r) => (n >= 2 ? r.hw + 1 : 0));
  const gaps: number[] = [];
  if (n >= 2) {
    for (let i = 0; i < n; i++) {
      const a = raw[i];
      const b = raw[(i + 1) % n];
      let g = b.angle - a.angle;
      if (i === n - 1) g += Math.PI * 2;
      if (g <= 0) g += Math.PI * 2;
      gaps.push(g);
      if (g >= (170 * Math.PI) / 180) continue;
      // a の +r の路肩と b の −r の路肩が交わる位置（それぞれの腕に沿った距離）＋ 隅切りの接線の長さ
      const sin = Math.sin(g);
      const cos = Math.cos(g);
      const da = (b.hw + a.hw * cos) / sin;
      const db = (a.hw + b.hw * cos) / sin;
      const R = Math.max(CORNER_RADIUS[a.road.cls], CORNER_RADIUS[b.road.cls]);
      const tan = R / Math.tan(g / 2);
      need[i] = Math.max(need[i], da + tan);
      need[(i + 1) % n] = Math.max(need[(i + 1) % n], db + tan);
    }
  }
  const arms: ArmShape[] = raw.map((r, i) => {
    const ds = roadSpacing(r.road);
    const want = Math.min(MAX_MOUTH, need[i], Math.max(0, r.room));
    // 口は道路の点の位置にそろえる（描画の断面と路肩の点を一致させるため）
    let idx = r.arm.dir > 0 ? Math.ceil((r.arm.s + want) / ds - 1e-6) : Math.floor((r.arm.s - want) / ds + 1e-6);
    const last = r.road.points.length / 3 - 1;
    idx = Math.max(0, Math.min(last, idx));
    const mouthS = idx * ds;
    const f = roadFrame(r.road, idx);
    // 外向き
    const ox = f.tx * r.arm.dir;
    const oz = f.tz * r.arm.dir;
    // 外向きに見た右 (+r) = (−oz, ox)
    const rx = -oz;
    const rz = ox;
    return {
      arm: r.arm,
      road: r.road,
      ux: r.ux,
      uz: r.uz,
      angle: r.angle,
      hw: r.hw,
      mouthS,
      t: Math.abs(mouthS - r.arm.s),
      mouth: { x: f.x, y: f.y, z: f.z },
      plus: { x: f.x + rx * r.hw, y: f.y, z: f.z + rz * r.hw },
      minus: { x: f.x - rx * r.hw, y: f.y, z: f.z - rz * r.hw },
      ox,
      oz,
    };
  });
  const edges: Vec3[][] = [];
  if (n >= 2)
    for (let i = 0; i < n; i++) {
      const a = arms[i];
      const b = arms[(i + 1) % n];
      edges.push(cornerCurve(a.plus, -a.ox, -a.oz, b.minus, b.ox, b.oz, 12));
    }
  return { junction: j, center, arms, edges, gaps, key };
}

/** 腕の向きに、次の接続点（の半分）か道路の端まで使える長さ */
function roomOf(net: RoadSource, road: Road, arm: JunctionArm): number {
  let room = arm.dir > 0 ? road.length - arm.s : arm.s;
  for (const o of net.junctionsOn(road.id)) {
    const d = (o.s - arm.s) * arm.dir;
    if (d > 0.5) room = Math.min(room, d / 2);
  }
  return Math.max(0, room - 0.5);
}

/**
 * p0 を向き d0 で出て、p1 に向き d1 で着く曲線（点の列、両端を含む）。
 * 2本の向きの直線が前方で交われば、その交点を制御点にした2次曲線（円弧に近い）。交わらなければ3次曲線。
 */
export function cornerCurve(p0: Vec3, d0x: number, d0z: number, p1: Vec3, d1x: number, d1z: number, segments: number): Vec3[] {
  const cx = p1.x - p0.x;
  const cz = p1.z - p0.z;
  const chord = Math.sqrt(cx * cx + cz * cz);
  // p0 + d0·α = p1 − d1·β
  const den = d0x * d1z - d0z * d1x;
  let c1: [number, number];
  let c2: [number, number];
  let ok = false;
  if (Math.abs(den) > 1e-3) {
    const alpha = (cx * d1z - cz * d1x) / den;
    const beta = (cx * d0z - cz * d0x) / den;
    if (alpha > 0 && beta > 0 && alpha < chord * 3 && beta < chord * 3) {
      const kx = p0.x + d0x * alpha;
      const kz = p0.z + d0z * alpha;
      c1 = [p0.x + ((kx - p0.x) * 2) / 3, p0.z + ((kz - p0.z) * 2) / 3];
      c2 = [p1.x + ((kx - p1.x) * 2) / 3, p1.z + ((kz - p1.z) * 2) / 3];
      ok = true;
    }
  }
  if (!ok) {
    const k = chord / 3;
    c1 = [p0.x + d0x * k, p0.z + d0z * k];
    c2 = [p1.x - d1x * k, p1.z - d1z * k];
  }
  const out: Vec3[] = [];
  for (let q = 0; q <= segments; q++) {
    const t = q / segments;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    // 高さは両端の間をなめらかに
    const h = t * t * (3 - 2 * t);
    out.push({
      x: w0 * p0.x + w1 * c1![0] + w2 * c2![0] + w3 * p1.x,
      y: p0.y + (p1.y - p0.y) * h,
      z: w0 * p0.z + w1 * c1![1] + w2 * c2![1] + w3 * p1.z,
    });
  }
  return out;
}

/** 接続点 j の腕 from（入ってくる腕: 中心から見て来た方向）から腕 to へ曲がる時の、口から口までの走る線 */
export function turnPath(shape: JunctionShape, fromArm: ArmShape, toArm: ArmShape, offIn: number, offOut: number): Vec3[] {
  // 入る腕の口: 進む向きは中心へ（−外向き）。右向き = (−dz, dx) で、左右位置 off（右が正）
  const dinx = -fromArm.ox;
  const dinz = -fromArm.oz;
  const p0 = { x: fromArm.mouth.x - dinz * offIn, y: fromArm.mouth.y, z: fromArm.mouth.z + dinx * offIn };
  const doutx = toArm.ox;
  const doutz = toArm.oz;
  const p1 = { x: toArm.mouth.x - doutz * offOut, y: toArm.mouth.y, z: toArm.mouth.z + doutx * offOut };
  void shape;
  const len = Math.sqrt((p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2);
  return cornerCurve(p0, dinx, dinz, p1, doutx, doutz, Math.max(4, Math.ceil(len / 1.5)));
}
