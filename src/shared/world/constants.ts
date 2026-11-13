// 世界生成の定数（モック仕様 4.1）。生成結果が変わる変更をしたら GENERATOR_VERSION を上げる。

/** 世界の種（M1 の起点選びで決定、2026-11-13） */
export const WORLD_SEED = 6;
/** 起点の町（葛郷）。世界座標 (m) と結節点の識別子 */
export const ORIGIN = { x: -32500, z: 11250, node: "n_-9_2" } as const;
/** 生成結果が変わる変更のたびに上げる。保存データのキーに含める（起点の決定以降、生成結果を変えたら必ず上げる） */
export const GENERATOR_VERSION = 4;

/** 結節点を1つ置く格子の一辺 (m) */
export const NODE_CELL = 4000;
/** 経路探索の格子 (m)。世界座標の倍数にそろえる */
export const ROUTE_GRID = 50;
/** 道路の点列の間隔 (m) */
export const ROAD_STEP = 2;
/** 近景タイルの一辺 (m) */
export const TILE_NEAR = 256;

/** 結節点の辺を探す範囲（自分の格子から ±2 = 5×5 格子） */
export const EDGE_CELL_REACH = 2;
/** 経路探索の範囲を両端の矩形から広げる量 (m) */
export const ROUTE_MARGIN = 1500;
/** 海を越えてよい長さ (m)。辺の判定と橋の両方 */
export const MAX_SEA_CROSSING = 300;
/** 枝道として採用する割合 */
export const BRANCH_RATIO = 0.4;

export interface RoadClassSpec {
  name: string;
  width: number;
  maxGrade: number;
  minRadius: number;
  surface: "paved" | "gravel";
}

/** 等級（モック仕様 4.6）。添字が Road.cls */
export const ROAD_CLASSES: readonly RoadClassSpec[] = [
  { name: "幹線", width: 7, maxGrade: 0.08, minRadius: 60, surface: "paved" },
  { name: "一般道", width: 6, maxGrade: 0.1, minRadius: 30, surface: "paved" },
  { name: "山道", width: 4.5, maxGrade: 0.12, minRadius: 12, surface: "paved" },
  { name: "林道", width: 3.5, maxGrade: 0.15, minRadius: 10, surface: "gravel" },
];

/** 縦断の平滑化（ガウスの σ, m） */
export const PROFILE_SIGMA = 30;
/** 交差点の前後でゆるくする範囲 (m) と勾配 */
export const JUNCTION_FLAT_LENGTH = 30;
export const JUNCTION_FLAT_GRADE = 0.03;
/** 橋にする条件: 地面より高い量 (m) と続く長さ (m) */
export const BRIDGE_MIN_HEIGHT = 6;
export const BRIDGE_MIN_LENGTH = 40;
/** 水面上の区間を橋にする最短の長さ (m)。これより短いものは盛土で渡す */
export const WATER_BRIDGE_MIN_LENGTH = 16;
/** 路面を海面より上に保つ高さ (m) */
export const ROAD_MIN_ELEVATION = 2;
/** 水の上を渡る橋の路面の高さ (m) */
export const BRIDGE_DECK_OVER_WATER = 8;

/** 喫茶店の密度: 道なりこの距離に1軒程度 (m) */
export const CAFE_SPACING = 15000;
/** 峠: 前後より高い量 (m) */
export const PASS_PROMINENCE = 100;
