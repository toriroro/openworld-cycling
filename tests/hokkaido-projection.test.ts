// 北海道の世界の平面座標（北海道の草案 2.3）の検査。
import { describe, expect, it } from "vitest";
import { H0_BOX } from "../scripts/hokkaido/area.ts";
import { PROJ_ORIGIN, project, tileOf, unproject } from "../scripts/hokkaido/projection.ts";

const A = 6378137;
const E2 = 0.00669438002290;
const RAD = Math.PI / 180;
/** 子午線の曲率半径・卯酉線の曲率半径（GRS80） */
const meridianR = (lat: number) => (A * (1 - E2)) / (1 - E2 * Math.sin(lat * RAD) ** 2) ** 1.5;
const primeR = (lat: number) => A / Math.sqrt(1 - E2 * Math.sin(lat * RAD) ** 2);

describe("北海道の平面座標", () => {
  it("原点は (0, 0)", () => {
    const p = project(PROJ_ORIGIN.lat, PROJ_ORIGIN.lon);
    expect(Math.abs(p.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.z)).toBeLessThan(1e-6);
  });

  it("北は -z、東は +x（地図の東が画面の東。手稲山で出した鏡像の誤りを防ぐ）", () => {
    const n = project(PROJ_ORIGIN.lat + 0.01, PROJ_ORIGIN.lon);
    const e = project(PROJ_ORIGIN.lat, PROJ_ORIGIN.lon + 0.01);
    expect(n.z).toBeLessThan(0);
    expect(Math.abs(n.x)).toBeLessThan(1e-6);
    expect(e.x).toBeGreaterThan(0);
  });

  it("中央経線の上は実寸（南北 0.01 度が子午線の弧の長さと 0.01% 以内で合う）", () => {
    for (const lat of [41.5, 43.06, 45.4]) {
      const a = project(lat - 0.005, PROJ_ORIGIN.lon);
      const b = project(lat + 0.005, PROJ_ORIGIN.lon);
      const want = meridianR(lat) * 0.01 * RAD;
      expect(Math.abs(a.z - b.z) / want - 1).toBeLessThan(1e-4);
    }
  });

  it("原点の近くの東西 0.01 度が N cosφ Δλ と 0.01% 以内で合う", () => {
    const lat = PROJ_ORIGIN.lat;
    const a = project(lat, PROJ_ORIGIN.lon - 0.005);
    const b = project(lat, PROJ_ORIGIN.lon + 0.005);
    const want = primeR(lat) * Math.cos(lat * RAD) * 0.01 * RAD;
    expect(Math.abs(b.x - a.x) / want - 1).toBeLessThan(1e-4);
  });

  it("札幌から 250km 東でも縮尺の誤差は 0.1% 未満（根室の辺りで 0.2% 未満）", () => {
    const scaleAt = (lat: number, lon: number) => {
      const a = project(lat, lon - 0.005);
      const b = project(lat, lon + 0.005);
      return Math.hypot(b.x - a.x, b.z - a.z) / (primeR(lat) * Math.cos(lat * RAD) * 0.01 * RAD);
    };
    expect(scaleAt(43.3, 144.4) - 1).toBeLessThan(0.001);
    expect(scaleAt(43.33, 145.58) - 1).toBeLessThan(0.002);
  });

  it("逆変換で元の緯度経度に戻る（1cm 未満）", () => {
    for (const [lat, lon] of [
      [43.06, 141.35],
      [42.97, 141.23],
      [43.15, 141.47],
      [43.33, 145.58],
    ]) {
      const p = project(lat, lon);
      const q = unproject(p.x, p.z);
      const back = project(q.lat, q.lon);
      expect(Math.hypot(back.x - p.x, back.z - p.z)).toBeLessThan(0.01);
    }
  });

  it("H0 の範囲は約 20km 四方", () => {
    const sw = project(H0_BOX.south, H0_BOX.west);
    const ne = project(H0_BOX.north, H0_BOX.east);
    expect(ne.x - sw.x).toBeGreaterThan(19500);
    expect(ne.x - sw.x).toBeLessThan(21500);
    expect(sw.z - ne.z).toBeGreaterThan(19500);
    expect(sw.z - ne.z).toBeLessThan(21500);
  });

  it("タイル番号（地理院タイルと同じ式）: 札幌駅の z15", () => {
    // 札幌駅 43.0687N 141.3508E → z15 の x = floor((141.3508 + 180) / 360 × 32768)
    const t = tileOf(43.0687, 141.3508, 15);
    expect(t.x).toBe(Math.floor(((141.3508 + 180) / 360) * 32768));
    expect(t.x).toBe(29250);
    // y = floor((1 − asinh(tan φ) / π) / 2 × 32768) = floor(12032.7)
    expect(t.y).toBe(12032);
  });
});
