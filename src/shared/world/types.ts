// 世界のデータの形（モック仕様 4.8）。将来サーバーで地域単位に保存する時もこの型を入れ物にする。

/** 幹線・一般道・山道・林道・自転車道（4 は河川敷の自転車道。河川の草案 4.4） */
export type RoadClass = 0 | 1 | 2 | 3 | 4;

export interface Span {
  from: number;
  to: number;
  /** トンネルは北海道の世界の道路だけ（北海道の草案 4.2。描画は H2 で作る） */
  kind: "bridge" | "tunnel";
}

export interface Road {
  /** 両端の結節点の識別子から作る */
  id: string;
  /** 幹線・一般道・山道・林道・自転車道 */
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
  /** 主要道か枝道か、河川敷の自転車道か */
  kind: "main" | "branch" | "cycleway";
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

// ---- 鉄道（鉄道の草案 9 章）。道路の後に引き、道路は変えない ----

export type RailStationKind = "hub" | "passing" | "small" | "terminus";

export interface RailStation {
  id: string;
  /** 線路の道のり */
  s: number;
  name: string;
  /** 町・集落に当たる場合 */
  node?: string;
  kind: RailStationKind;
  /** 駅舎の側（線路の道のりが増える向きに対して -1 = 左、1 = 右） */
  side: 1 | -1;
}

export interface RailCrossing {
  id: string;
  line: string;
  /** 線路の道のり */
  s: number;
  road: string;
  /** 道路の道のり */
  roadS: number;
  /** 踏切 / 線路が上（跨道橋）/ 道路の橋の下 */
  kind: "level" | "over" | "under";
  /** 縦断で高さを合わせられなかった（検査で数える） */
  unresolved?: boolean;
}

export interface RailSpan {
  from: number;
  to: number;
  kind: "bridge" | "tunnel";
}

export interface RailLine {
  /** 両端の拠点・終点の結節点から作る */
  id: string;
  kind: "trunk" | "branch";
  /** 廃線は線路を描かず、路盤と自転車道だけ（鉄道の草案 3.4） */
  status: "open" | "abandoned";
  name: string;
  origin: [number, number];
  /** 基準位置からの x, y, z を RAIL_STEP ごとに */
  points: Float32Array;
  length: number;
  spans: RailSpan[];
  stations: RailStation[];
  crossings: RailCrossing[];
  /** 端の結節点 */
  start: string;
  end: string;
}
