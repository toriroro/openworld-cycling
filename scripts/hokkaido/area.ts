// 北海道の世界の範囲（北海道の草案 7 章）。

export interface LatLonBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * H0: 札幌の中心から約 20km 四方（大通・円山・藻岩山・手稲山の麓・豊平川の河川敷）。
 * 南北 約 20.4km、東西 約 20.5km。
 */
export const H0_BOX: LatLonBox = { south: 42.968, west: 141.225, north: 43.152, east: 141.477 };

/** 元データの置き場（git に入れない。記録の manifest だけ入れる） */
export const SOURCE_DIR = "assets-source/hokkaido";

/** Overpass・Web のタイルの順の書き方（南,西,北,東） */
export function bboxString(b: LatLonBox): string {
  return `${b.south},${b.west},${b.north},${b.east}`;
}

/**
 * H2: 札幌圏 約 60km 四方（石狩の海岸、江別、定山渓、支笏湖の北の端）。北海道の草案 18.1。
 * 標高は DEM10B（z14）。H0 の範囲は 5m 格子をそのまま使う。
 */
export const H2_BOX: LatLonBox = { south: 42.79, west: 140.98, north: 43.33, east: 141.72 };
