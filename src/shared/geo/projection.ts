// 北海道の世界の平面座標（北海道の草案 2.3）。
// 緯度経度 → 横メルカトル（ガウス・クリューゲル、GRS80、クリューゲルの級数を n³ まで）。
// 中央経線上の縮尺は 1（実寸）。変換と、走行の記録の書き出し（トレーナー連携の草案 6.2）で使う。
// 分岐に関わる計算ではないが、三角関数を通すので src/shared/world には入れない（モック 4.2）。
//
// 座標の向きはこの作品に合わせる: x = 東、z = 南（Three.js の右手系で y が上）。
// 原点を変えると変換済みのデータがすべてずれるので、データを作ってからは変えない。

/** 平面座標の原点（札幌の中心付近）。中央経線もここ */
export const PROJ_ORIGIN = { lat: 43.06, lon: 141.35 } as const;

const A_AXIS = 6378137;
const F = 1 / 298.257222101;
const N = F / (2 - F);
const A_RECT = (A_AXIS / (1 + N)) * (1 + (N * N) / 4 + (N * N * N * N) / 64);
const ALPHA = [N / 2 - (2 * N * N) / 3 + (5 * N * N * N) / 16, (13 * N * N) / 48 - (3 * N * N * N) / 5, (61 * N * N * N) / 240];
const E2 = (2 * Math.sqrt(N)) / (1 + N);
const RAD = Math.PI / 180;

/** 中央経線 lon0 に対する (北向きの距離, 東向きの距離) [m]。北向きは赤道から */
function gaussKruger(lat: number, lon: number, lon0: number): { north: number; east: number } {
  const phi = lat * RAD;
  const dl = (lon - lon0) * RAD;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E2 * Math.atanh(E2 * s));
  const tb = Math.sqrt(1 + t * t);
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / tb);
  let north = xi;
  let east = eta;
  for (let j = 1; j <= 3; j++) {
    north += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    east += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { north: A_RECT * north, east: A_RECT * east };
}

const ORIGIN_NORTH = gaussKruger(PROJ_ORIGIN.lat, PROJ_ORIGIN.lon, PROJ_ORIGIN.lon).north;

/** 緯度経度（度）→ 世界座標 x（東）・z（南）[m] */
export function project(lat: number, lon: number): { x: number; z: number } {
  const p = gaussKruger(lat, lon, PROJ_ORIGIN.lon);
  return { x: p.east, z: -(p.north - ORIGIN_NORTH) };
}

/** 世界座標 → 緯度経度（ニュートン法で project を逆に解く。1mm 未満まで） */
export function unproject(x: number, z: number): { lat: number; lon: number } {
  let lat = PROJ_ORIGIN.lat - z / 111130;
  let lon = PROJ_ORIGIN.lon + x / (111320 * Math.cos(lat * RAD));
  const h = 1e-5;
  for (let k = 0; k < 8; k++) {
    const p = project(lat, lon);
    const ex = p.x - x;
    const ez = p.z - z;
    if (ex * ex + ez * ez < 1e-8) break;
    const pa = project(lat + h, lon);
    const pb = project(lat, lon + h);
    const a = (pa.x - p.x) / h;
    const b = (pb.x - p.x) / h;
    const c = (pa.z - p.z) / h;
    const d = (pb.z - p.z) / h;
    const det = a * d - b * c;
    lat -= (d * ex - b * ez) / det;
    lon -= (-c * ex + a * ez) / det;
  }
  return { lat, lon };
}

/** 地理院タイル・Web メルカトルのタイル番号（z15 など） */
export function tileOf(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * n);
  return { x, y };
}
