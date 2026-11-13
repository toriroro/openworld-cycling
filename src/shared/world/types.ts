// 世界のデータの形（モック仕様 4.8）。将来サーバーで地域単位に保存する時もこの型を入れ物にする。

export type RoadClass = 0 | 1 | 2 | 3;

export interface Span {
  from: number;
  to: number;
  kind: "bridge";
}

export interface Road {
  /** 両端の結節点の識別子から作る */
  id: string;
  /** 幹線・一般道・山道・林道 */
  cls: RoadClass;
  width: number;
  surface: "paved" | "gravel";
  /** 点列の基準位置（世界座標 x, z） */
  origin: [number, number];
  /** 基準位置からの x, y, z。点の間隔は length / (点の数 − 1)（ROAD_STEP 以下） */
  points: Float32Array;
  length: number;
  spans: Span[];
  name: string;
  /** 主要道か枝道か */
  kind: "main" | "branch";
  /** 両端の接続点 */
  start: string;
  end: string;
}

export interface JunctionArm {
  road: string;
  s: number;
  dir: 1 | -1;
}

export interface Junction {
  id: string;
  x: number;
  y: number;
  z: number;
  /** この接続点から出られる方向 */
  arms: JunctionArm[];
  /** 結節点に当たる場合 */
  node?: string;
}

export type PoiKind = "cafe" | "viewpoint" | "pass";

export interface Poi {
  id: string;
  kind: PoiKind;
  road: string;
  s: number;
  side: 1 | -1;
  name: string;
}

export type NodeKind = "town" | "village" | "junction";

export interface WorldNode {
  id: string;
  cx: number;
  cz: number;
  x: number;
  y: number;
  z: number;
  importance: number;
  kind: NodeKind;
  name: string;
  reading: string;
}
