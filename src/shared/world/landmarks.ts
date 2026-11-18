// 北海道の世界の名所（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）。変換（scripts/hokkaido/landmarks.ts）が書くデータの形と、
// 区域への距離などの小さな計算。DOM・Three.js に依存しない。三角関数を使わない（モック 4.2）。

export type LandmarkKind =
  | "tvtower"
  | "odori"
  | "clocktower"
  | "akarenga"
  | "hokudai"
  | "nakajima"
  | "jingu"
  | "asahiyama"
  | "moiwa"
  | "moere"
  | "okurayama"
  | "hitsujigaoka";

/** 名所の部品。pts は世界座標の [x, z, ...]（点は 1 組、面は閉じた多角形で最後の点を繰り返さない） */
export interface LandmarkFeature {
  t:
    | "building"
    | "row"
    | "wood"
    | "fountain"
    | "water"
    | "garden"
    | "grass"
    | "skijump"
    | "lift"
    | "torii"
    | "path"
    | "tree"
    | "statue"
    | "peak"
    | "viewpoint"
    | "takeoff"
    | "station"
    | "lamp"
    | "gate";
  /** OSM の番号 */
  id: number;
  pts: number[];
  tags: Record<string, string>;
  /** 模型で置き換える建物（OSM の建物は描かない） */
  replace?: boolean;
}

export interface LandmarkData {
  id: string;
  /** 画面に出す名前（公共の物は OSM の名前、会社の施設は一般名。決定 2026-11-18） */
  name: string;
  kind: LandmarkKind;
  /** 区域の OSM の道 */
  osm: number;
  /** 行き先にする点 */
  x: number;
  z: number;
  /** 区域（閉じた多角形の [x, z, ...]） */
  zone: number[];
  /** 模型を出す距離 (m) */
  view: number;
  features: LandmarkFeature[];
}

export interface LandmarkFile {
  version: 1;
  area: string;
  builtAt: string;
  attribution: string;
  landmarks: LandmarkData[];
}

/** 名所のスタンプの識別子（喫茶店の立ち寄り地点の識別子と重ならない） */
export const landmarkStampId = (id: string) => `landmark:${id}`;
export const isLandmarkStamp = (poi: string) => poi.startsWith("landmark:");

/** 多角形 [x, z, ...] の中か */
export function insidePolygon(p: ArrayLike<number>, x: number, z: number): boolean {
  let c = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** 多角形の縁までの距離（中なら 0） */
export function distanceToPolygon(p: ArrayLike<number>, x: number, z: number): number {
  if (insidePolygon(p, x, z)) return 0;
  return distanceToPolyline(p, x, z, true);
}

/** 折れ線 [x, z, ...] までの距離。closed で最後と最初もつなぐ */
export function distanceToPolyline(p: ArrayLike<number>, x: number, z: number, closed = false): number {
  const n = p.length / 2;
  let best = Infinity;
  const segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const i = k, j = (k + 1) % n;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const ex = ax + dx * t - x, ez = az + dz * t - z;
    const d = Math.sqrt(ex * ex + ez * ez);
    if (d < best) best = d;
  }
  return best;
}

/** 多角形の外接矩形 */
export function polygonBounds(p: ArrayLike<number>): { x0: number; z0: number; x1: number; z1: number } {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < z0) z0 = p[i + 1];
    if (p[i + 1] > z1) z1 = p[i + 1];
  }
  return { x0, z0, x1, z1 };
}

/** 多角形の面積（m²、向きによらず正） */
export function polygonArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return Math.abs(a) / 2;
}

/**
 * 名所に着いたか: 止まっている所が区域から arrive m 以内。
 * 区域のそばに走る道が無い名所（山の上など）は、行き先から一番近い走る道までの距離 + 25m まで広げる（呼ぶ側が roadGap を渡す）。
 */
export function arrivedAt(lm: LandmarkData, x: number, z: number, roadGap = 0): boolean {
  const reach = Math.max(LANDMARK_ARRIVE, roadGap + 25);
  if (distanceToPolygon(lm.zone, x, z) <= reach) return true;
  const dx = lm.x - x, dz = lm.z - z;
  return dx * dx + dz * dz <= reach * reach;
}

/** 区域からこの距離 (m) 以内で止まると着いたことにする */
export const LANDMARK_ARRIVE = 45;
