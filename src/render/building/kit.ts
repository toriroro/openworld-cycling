// 建物の部品: 壁、屋根（切妻・寄棟・片流れ・無落雪）、窓、ベランダ、庇、看板、灯油タンク、煙突、玄関フード、室外機、外階段。
// 建物ごとの座標は Fr（中心 c、間口の向き U、道路の向き F）。面（Face）の上では、左端からの距離 a と高さ y で位置を言う。

import type { AtlasLayout } from "./atlas-layout.ts";
import { add, hex, type Mesher, neg, type Rect, type Rgb, UP, type V3, v3, WHITE } from "./mesher.ts";

export type WallKind = "siding" | "plaster" | "cedar" | "metal" | "mortar" | "tilewall" | "lap";
export type RoofKind = "tile" | "seam" | "metal";
export type SurfaceKind = WallKind | RoofKind;

export type Out = Record<SurfaceKind | "trim" | "atlas", Mesher>;

export interface Kit {
  out: Out;
  /** 素材 1 枚が覆う長さ (m) */
  tex: Record<SurfaceKind, number>;
  atlas: AtlasLayout;
  /** 離れた建物（細部を省く。北海道の草案 24 章）。灯油タンクを 1 つの箱に、室外機を省く */
  mid?: boolean;
}

export const C_SLAB = hex("#b4b2ad");
export const C_BASE = hex("#9c9a94");
export const C_RAIL = hex("#c4c7c8");
export const C_DARK = hex("#3d3936");
export const C_ALUMI = hex("#c9ccce");
export const C_BLOCK = hex("#a7a59f");
export const C_ROOF_EDGE = hex("#3a3836");
export const C_STEEL = hex("#6b6f72");
export const C_TANK = [hex("#d9d6c8"), hex("#b9c3c7"), hex("#c9cbc4")];

export interface Fr {
  c: V3;
  /** 間口の向き（道路から建物を見て右） */
  U: V3;
  /** 道路のある向き */
  F: V3;
  hw: number;
  hd: number;
}
export const at = (f: Fr, a: number, b: number, y: number): V3 => v3(f.c.x + f.U.x * a + f.F.x * b, y, f.c.z + f.U.z * a + f.F.z * b);

export interface Face {
  p0: V3;
  n: V3;
  u: V3;
  len: number;
  /** 壁の模様をつなぐための、外周に沿った位置 */
  u0: number;
}
/** 正面・右・裏・左（道路から建物を見て） */
export function faces(f: Fr): [Face, Face, Face, Face] {
  const { U, F, hw, hd } = f;
  const nU = neg(U), nF = neg(F);
  return [
    { p0: at(f, -hw, hd, 0), n: F, u: U, len: 2 * hw, u0: 0 },
    { p0: at(f, hw, hd, 0), n: U, u: nF, len: 2 * hd, u0: 2 * hw },
    { p0: at(f, hw, -hd, 0), n: nF, u: nU, len: 2 * hw, u0: 2 * hw + 2 * hd },
    { p0: at(f, -hw, -hd, 0), n: nU, u: F, len: 2 * hd, u0: 4 * hw + 2 * hd },
  ];
}
/** 面の上の点（左端から a、外へ off、高さ y） */
export const on = (fc: Face, a: number, off: number, y: number): V3 => v3(fc.p0.x + fc.u.x * a + fc.n.x * off, y, fc.p0.z + fc.u.z * a + fc.n.z * off);

export function walls(m: Mesher, f: Fr, y0: number, y1: number, col: Rgb, tex: number) {
  for (const fc of faces(f)) m.wall(on(fc, 0, 0, y0), fc.n, fc.len, y1 - y0, col, tex, fc.u0, y0);
}
/** 面に重ねる帯（腰壁・基礎・色の違う 1 階など） */
export function band(m: Mesher, fc: Face, a0: number, a1: number, y0: number, y1: number, off: number, col: Rgb, tex: number) {
  m.wall(on(fc, a0, off, y0), fc.n, a1 - a0, y1 - y0, col, tex, fc.u0 + a0, y0);
}
/** 面から外へ出る箱（a0〜a1、y0〜y1、外へ d0〜d1） */
export function fbox(m: Mesher, fc: Face, a0: number, a1: number, y0: number, y1: number, d0: number, d1: number, col: Rgb, bottom = false) {
  const p = on(fc, (a0 + a1) / 2, (d0 + d1) / 2, (y0 + y1) / 2);
  m.box(p, fc.u, fc.n, a1 - a0, y1 - y0, d1 - d0, col, 1, bottom);
}
/** 絵の表の四角を面に貼る（窓・扉・看板） */
export function pic(k: Kit, fc: Face, a: number, y: number, w: number, h: number, r: Rect, flip = false, off = 0.035, tint: Rgb = WHITE) {
  k.out.atlas.panel(on(fc, a, off, y), fc.n, w, h, r, tint, flip);
}

/** 切妻。R は棟の向き、hr・hs は棟の向きと流れの向きの半分の長さ。wall を渡すと妻の三角の壁も作る */
export function gableRoof(k: Kit, c: V3, R: V3, hr: number, hs: number, yWall: number, pitch: number, over: number, gover: number, roof: RoofKind, col: Rgb, wall: { m: Mesher; tex: number; col: Rgb } | null) {
  const S = v3(-R.z, 0, R.x);
  const P = (a: number, b: number, y: number) => v3(c.x + R.x * a + S.x * b, y, c.z + R.z * a + S.z * b);
  const rm = k.out[roof], t = k.tex[roof];
  const ex = hr + gover, ez = hs + over;
  const ye = yWall - over * pitch, yr = yWall + hs * pitch;
  const sl = (ez * Math.sqrt(1 + pitch * pitch)) / t;
  const uvs: [number, number][] = [[0, 0], [(2 * ex) / t, 0], [(2 * ex) / t, sl], [0, sl]];
  rm.quad([P(-ex, ez, ye), P(ex, ez, ye), P(ex, 0, yr), P(-ex, 0, yr)], uvs, col);
  rm.quad([P(ex, -ez, ye), P(-ex, -ez, ye), P(-ex, 0, yr), P(ex, 0, yr)], uvs, col);
  if (wall) {
    const wt = wall.tex;
    wall.m.tri([P(hr, hs, yWall), P(hr, -hs, yWall), P(hr, 0, yr)], [[0, yWall / wt], [(2 * hs) / wt, yWall / wt], [hs / wt, yr / wt]], wall.col);
    wall.m.tri([P(-hr, -hs, yWall), P(-hr, hs, yWall), P(-hr, 0, yr)], [[0, yWall / wt], [(2 * hs) / wt, yWall / wt], [hs / wt, yr / wt]], wall.col);
  }
  // 棟の押さえと、軒先の板
  k.out.trim.box(v3(c.x, yr + 0.05, c.z), R, S, 2 * ex, 0.12, 0.28, C_ROOF_EDGE);
  for (const sg of [1, -1]) {
    const n = sg > 0 ? S : neg(S);
    const p = P(sg > 0 ? -ex : ex, sg * ez, ye - 0.14);
    k.out.trim.wall(p, n, 2 * ex, 0.14, C_ROOF_EDGE, 1);
  }
}

/** 腰折れ屋根（下が急で上がゆるい 2 段の屋根）。妻の壁は五角形 */
export function gambrelRoof(k: Kit, c: V3, R: V3, hr: number, hs: number, yWall: number, over: number, gover: number, roof: RoofKind, col: Rgb, wall: { m: Mesher; tex: number; col: Rgb }) {
  const S = v3(-R.z, 0, R.x);
  const P = (a: number, b: number, y: number) => v3(c.x + R.x * a + S.x * b, y, c.z + R.z * a + S.z * b);
  const rm = k.out[roof], t = k.tex[roof];
  const ex = hr + gover, ez = hs + over;
  const bk = hs * 0.55;
  const y1 = yWall + (hs - bk) * 1.6, y2 = y1 + bk * 0.45, ye = yWall - over * 1.6;
  const l1 = Math.hypot(ez - bk, y1 - ye) / t, l2 = Math.hypot(bk, y2 - y1) / t;
  for (const sg of [1, -1]) {
    const a0 = -sg * ex, a1 = sg * ex;
    rm.quad([P(a0, sg * ez, ye), P(a1, sg * ez, ye), P(a1, sg * bk, y1), P(a0, sg * bk, y1)], [[0, 0], [(2 * ex) / t, 0], [(2 * ex) / t, l1], [0, l1]], col);
    rm.quad([P(a0, sg * bk, y1), P(a1, sg * bk, y1), P(a1, 0, y2), P(a0, 0, y2)], [[0, l1], [(2 * ex) / t, l1], [(2 * ex) / t, l1 + l2], [0, l1 + l2]], col);
    k.out.trim.wall(P(a0, sg * ez, ye - 0.14), sg > 0 ? S : neg(S), 2 * ex, 0.14, C_ROOF_EDGE, 1);
  }
  const wt = wall.tex;
  const uvOf = (b: number, y: number): [number, number] => [(hs - b) / wt, y / wt];
  wall.m.quad([P(hr, hs, yWall), P(hr, -hs, yWall), P(hr, -bk, y1), P(hr, 0, y2), P(hr, bk, y1)], [uvOf(hs, yWall), uvOf(-hs, yWall), uvOf(-bk, y1), uvOf(0, y2), uvOf(bk, y1)], wall.col);
  wall.m.quad([P(-hr, -hs, yWall), P(-hr, hs, yWall), P(-hr, bk, y1), P(-hr, 0, y2), P(-hr, -bk, y1)], [uvOf(-hs, yWall), uvOf(hs, yWall), uvOf(bk, y1), uvOf(0, y2), uvOf(-bk, y1)], wall.col);
  k.out.trim.box(v3(c.x, y2 + 0.05, c.z), R, S, 2 * ex, 0.12, 0.28, C_ROOF_EDGE);
}

/** 物置（庭の小さな鋼板の倉庫） */
export function shed(k: Kit, fc: Face, a: number, y: number, tone: number) {
  const c = [hex("#cfd2cf"), hex("#b9b3a0"), hex("#9aa59a"), hex("#a9b3bb")][tone % 4];
  fbox(k.out.trim, fc, a - 0.95, a + 0.95, y, y + 1.85, 0.2, 1.1, c);
  fbox(k.out.trim, fc, a - 1.02, a + 1.02, y + 1.85, y + 1.93, 0.14, 1.16, C_STEEL, true);
  // 引き戸の合わせ目
  k.out.trim.wall(on(fc, a - 0.02, 1.105, y + 0.1), fc.n, 0.04, 1.65, C_STEEL, 1);
}

/** 寄棟 */
export function hipRoof(k: Kit, c: V3, R: V3, hr: number, hs: number, yWall: number, pitch: number, over: number, roof: RoofKind, col: Rgb) {
  const S = v3(-R.z, 0, R.x);
  const P = (a: number, b: number, y: number) => v3(c.x + R.x * a + S.x * b, y, c.z + R.z * a + S.z * b);
  const rm = k.out[roof], t = k.tex[roof];
  const ex = hr + over, ez = hs + over;
  const ye = yWall - over * pitch, yr = yWall + hs * pitch;
  const rx = Math.max(0, hr - hs);
  const u = (ez * Math.sqrt(1 + pitch * pitch)) / t;
  const q: [number, number][] = [[0, 0], [(2 * ex) / t, 0], [(ex + rx) / t, u], [(ex - rx) / t, u]];
  rm.quad([P(-ex, ez, ye), P(ex, ez, ye), P(rx, 0, yr), P(-rx, 0, yr)], q, col);
  rm.quad([P(ex, -ez, ye), P(-ex, -ez, ye), P(-rx, 0, yr), P(rx, 0, yr)], q, col);
  const tr: [number, number][] = [[0, 0], [(2 * ez) / t, 0], [ez / t, u]];
  rm.tri([P(ex, ez, ye), P(ex, -ez, ye), P(rx, 0, yr)], tr, col);
  rm.tri([P(-ex, -ez, ye), P(-ex, ez, ye), P(-rx, 0, yr)], tr, col);
  if (rx > 0.1) k.out.trim.box(v3(c.x, yr + 0.05, c.z), R, S, 2 * rx, 0.12, 0.28, C_ROOF_EDGE);
}

/** 片流れ。+S 側（S = R × UP）が低い。高い側の壁と、両端の三角の壁も作る */
export function shedRoof(k: Kit, c: V3, R: V3, hr: number, hs: number, yWall: number, rise: number, over: number, roof: RoofKind, col: Rgb, wall: { m: Mesher; tex: number; col: Rgb }) {
  const S = v3(-R.z, 0, R.x);
  const P = (a: number, b: number, y: number) => v3(c.x + R.x * a + S.x * b, y, c.z + R.z * a + S.z * b);
  const rm = k.out[roof], t = k.tex[roof];
  const pitch = rise / (2 * hs);
  const ex = hr + over, yl = yWall - over * pitch, yh = yWall + rise + over * pitch;
  const sl = ((2 * hs + 2 * over) * Math.sqrt(1 + pitch * pitch)) / t;
  rm.quad([P(-ex, hs + over, yl), P(ex, hs + over, yl), P(ex, -hs - over, yh), P(-ex, -hs - over, yh)], [[0, 0], [(2 * ex) / t, 0], [(2 * ex) / t, sl], [0, sl]], col);
  const wt = wall.tex;
  // 高い側の壁
  wall.m.wall(P(hr, -hs, yWall), neg(S), 2 * hr, rise, wall.col, wt, 0, yWall);
  wall.m.tri([P(hr, hs, yWall), P(hr, -hs, yWall), P(hr, -hs, yWall + rise)], [[0, yWall / wt], [(2 * hs) / wt, yWall / wt], [(2 * hs) / wt, (yWall + rise) / wt]], wall.col);
  wall.m.tri([P(-hr, -hs, yWall), P(-hr, hs, yWall), P(-hr, -hs, yWall + rise)], [[0, yWall / wt], [(2 * hs) / wt, yWall / wt], [0, (yWall + rise) / wt]], wall.col);
  k.out.trim.wall(P(-ex, hs + over, yl - 0.14), S, 2 * ex, 0.14, C_ROOF_EDGE, 1);
}

/** 無落雪屋根・陸屋根: 壁を立ち上げて、笠木と屋根の面でふたをする */
export function flatRoof(k: Kit, f: Fr, yWall: number, parapet: number, wm: Mesher, wtex: number, wc: Rgb, cap: Rgb) {
  walls(wm, f, yWall, yWall + parapet, wc, wtex);
  k.out.trim.box(v3(f.c.x, yWall + parapet + 0.04, f.c.z), f.U, f.F, 2 * f.hw + 0.1, 0.08, 2 * f.hd + 0.1, cap);
}

/** 庇・下屋（面から外へ下がる屋根）。両面から見える */
export function pent(k: Kit, fc: Face, a0: number, a1: number, yTop: number, depth: number, drop: number, roof: RoofKind, col: Rgb) {
  const t = k.tex[roof];
  const sl = Math.hypot(depth, drop) / t;
  const q = [on(fc, a0, depth, yTop - drop), on(fc, a1, depth, yTop - drop), on(fc, a1, 0.02, yTop), on(fc, a0, 0.02, yTop)];
  const uvs: [number, number][] = [[0, 0], [(a1 - a0) / t, 0], [(a1 - a0) / t, sl], [0, sl]];
  k.out[roof].quad(q, uvs, col);
  k.out.trim.wall(on(fc, a0, depth, yTop - drop - 0.1), fc.n, a1 - a0, 0.1, C_ROOF_EDGE, 1);
}

/** ベランダ: 床と、腰の高さの壁（solid）か手すり（rail） */
export function balcony(k: Kit, fc: Face, a0: number, a1: number, y: number, depth: number, col: Rgb, kind: "solid" | "rail") {
  const m = k.out.trim;
  fbox(m, fc, a0, a1, y - 0.12, y, 0, depth, C_SLAB, true);
  const y0 = kind === "solid" ? y : y + 0.1, h = 1.05;
  const c = kind === "solid" ? col : C_RAIL;
  fbox(m, fc, a0, a1, y0, y + h, depth - 0.07, depth, c, kind === "rail");
  fbox(m, fc, a0, a0 + 0.07, y0, y + h, 0, depth - 0.07, c, kind === "rail");
  fbox(m, fc, a1 - 0.07, a1, y0, y + h, 0, depth - 0.07, c, kind === "rail");
}

/** 店のテント（布のひさし）と前垂れ */
export function tent(k: Kit, fc: Face, a0: number, a1: number, yTop: number, depth: number, col: Rgb) {
  const m = k.out.trim;
  const low = yTop - 0.35;
  m.quad2([on(fc, a0, depth, low), on(fc, a1, depth, low), on(fc, a1, 0.04, yTop), on(fc, a0, 0.04, yTop)], [[0, 0], [1, 0], [1, 1], [0, 1]], col);
  m.wall(on(fc, a0, depth, low - 0.22), fc.n, a1 - a0, 0.22, col, 1);
}

/** 看板の帯（箱）と、その上の文字。idx は業種の番号 */
export function signBand(k: Kit, fc: Face, a0: number, a1: number, y: number, h: number, depth: number, idx: number, plain?: Rgb) {
  const bg = plain ?? k.atlas.signBg[idx];
  fbox(k.out.trim, fc, a0, a1, y, y + h, 0, depth, bg, true);
  const th = h * 0.92, tw = Math.min(th * 4, (a1 - a0) * 0.9);
  const hh = tw / 4;
  if (plain) {
    // 地の色が違う看板は、文字の板を小さく載せる
    pic(k, fc, (a0 + a1) / 2 - tw * 0.4, y + (h - hh * 0.8) / 2, tw * 0.8, hh * 0.8, k.atlas.sign[idx], false, depth + 0.012);
  } else pic(k, fc, (a0 + a1) / 2 - tw / 2, y + (h - hh) / 2, tw, hh, k.atlas.sign[idx], false, depth + 0.012);
}

/** 袖看板（面から直角に突き出す縦の看板）。両面に文字 */
export function sideSign(k: Kit, fc: Face, a: number, y0: number, y1: number, proj: number, idx: number) {
  const v = idx % k.atlas.vsign.length;
  const d0 = 0.12, th = 0.16;
  fbox(k.out.trim, fc, a - th / 2, a + th / 2, y0, y1, d0, d0 + proj, k.atlas.signBg[v], true);
  // 支えの腕
  fbox(k.out.trim, fc, a - 0.03, a + 0.03, y1 - 0.25, y1 - 0.19, 0, d0, C_STEEL);
  fbox(k.out.trim, fc, a - 0.03, a + 0.03, y0 + 0.19, y0 + 0.25, 0, d0, C_STEEL);
  const r = k.atlas.vsign[v];
  k.out.atlas.panel(on(fc, a + th / 2 + 0.01, d0 + proj, y0), fc.u, proj, y1 - y0, r);
  k.out.atlas.panel(on(fc, a - th / 2 - 0.01, d0, y0), neg(fc.u), proj, y1 - y0, r);
}

/** 灯油タンク（ホームタンク）: 脚つきの箱 */
export function tank(k: Kit, fc: Face, a: number, y: number, tone: number) {
  const m = k.out.trim, c = C_TANK[tone % C_TANK.length];
  if (k.mid) {
    // 脚まで含めた 1 つの箱（三角形 42 → 10。アパートの裏に並ぶタンクが近くの建物の三角形の 3 割を占めたため）
    fbox(m, fc, a - 0.5, a + 0.5, y, y + 1.25, 0.18, 0.62, c);
    return;
  }
  fbox(m, fc, a - 0.5, a + 0.5, y + 0.62, y + 1.25, 0.18, 0.62, c, true);
  fbox(m, fc, a - 0.46, a - 0.42, y, y + 0.62, 0.2, 0.6, C_STEEL);
  fbox(m, fc, a + 0.42, a + 0.46, y, y + 0.62, 0.2, 0.6, C_STEEL);
  fbox(m, fc, a - 0.06, a + 0.06, y + 1.25, y + 1.33, 0.34, 0.46, C_STEEL);
}

/** 集合煙突（壁に沿って屋根の上まで立つ角の煙突） */
export function chimney(k: Kit, fc: Face, a: number, y0: number, y1: number) {
  fbox(k.out.trim, fc, a - 0.24, a + 0.24, y0, y1, 0, 0.46, C_BASE);
  fbox(k.out.trim, fc, a - 0.3, a + 0.3, y1, y1 + 0.1, -0.06, 0.52, C_DARK);
}

/** 玄関フード（風除室）: ガラスの小部屋。段と屋根つき */
export function vestibule(k: Kit, fc: Face, a: number, y: number, floor: number, w = 1.8, d = 1.25) {
  const m = k.out.trim, h = 2.3;
  fbox(m, fc, a - w / 2 - 0.1, a + w / 2 + 0.1, y - 0.3, y + floor, 0, d + 0.35, C_SLAB);
  const yf = y + floor;
  pic(k, fc, a - w / 2, yf, w, h, k.atlas.cell.vest, false, d);
  k.out.atlas.panel(on(fc, a + w / 2, d, yf), fc.u, d, h, k.atlas.cell.glassPanel);
  k.out.atlas.panel(on(fc, a - w / 2, 0, yf), neg(fc.u), d, h, k.atlas.cell.glassPanel);
  fbox(m, fc, a - w / 2 - 0.08, a + w / 2 + 0.08, yf + h, yf + h + 0.1, 0, d + 0.1, C_ALUMI, true);
}

/** 玄関（扉、段、小さな屋根） */
export function porch(k: Kit, fc: Face, a: number, y: number, floor: number, cell: Rect, flip: boolean) {
  const m = k.out.trim;
  fbox(m, fc, a - 0.8, a + 0.8, y - 0.3, y + floor, 0, 0.95, C_SLAB);
  pic(k, fc, a - 0.5, y + floor, 1.0, 2.15, cell, flip);
  fbox(m, fc, a - 0.9, a + 0.9, y + floor + 2.35, y + floor + 2.45, 0, 1.0, C_ROOF_EDGE, true);
}

/** 室外機 */
export function acUnit(k: Kit, fc: Face, a: number, y: number) {
  if (k.mid) return;
  fbox(k.out.trim, fc, a - 0.4, a + 0.4, y, y + 0.58, 0.1, 0.4, hex("#dedcd3"));
  pic(k, fc, a - 0.4, y, 0.8, 0.58, k.atlas.cell.ac, false, 0.41);
}

/** 道路沿いのブロック塀（gate0〜gate1 を開ける）。fc は正面、off は面から塀までの距離 */
export function blockFence(k: Kit, fc: Face, off: number, y0: number, y1: number, gate0: number, gate1: number) {
  for (const [a0, a1] of [[-1.5, gate0], [gate1, fc.len + 1.5]]) {
    if (a1 - a0 < 0.3) continue;
    fbox(k.out.trim, fc, a0, a1, y0, y1, off - 0.075, off + 0.075, C_BLOCK);
  }
}

/** 外階段（面に沿って a0 から a1 へ上る。y0 → y1、幅 w、面から d0 離す）と手すり */
export function stairs(k: Kit, fc: Face, a0: number, a1: number, y0: number, y1: number, d0: number, w: number) {
  const m = k.out.trim;
  const A = (a: number, d: number, y: number) => on(fc, a, d, y);
  const t = 0.18;
  const uv4: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // 踏み面（斜めの板）と裏
  m.quad2([A(a0, d0 + w, y0), A(a1, d0 + w, y1), A(a1, d0, y1), A(a0, d0, y0)], uv4, C_STEEL);
  // 側の桁と手すり（外側と内側）
  for (const d of [d0, d0 + w]) {
    m.quad2([A(a0, d, y0 - t), A(a1, d, y1 - t), A(a1, d, y1 + 0.05), A(a0, d, y0 + 0.05)], uv4, C_STEEL);
    m.quad2([A(a0, d, y0 + 0.85), A(a1, d, y1 + 0.85), A(a1, d, y1 + 0.95), A(a0, d, y0 + 0.95)], uv4, C_RAIL);
  }
  // 手すりの柱
  const n = 4;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    fbox(m, fc, Math.min(a, a + 0.05), Math.max(a, a + 0.05), y, y + 0.9, d0 + w - 0.05, d0 + w, C_RAIL);
  }
}

/** 屋上の物: 塔屋（階段室）と高架水槽 */
export function rooftop(k: Kit, f: Fr, y: number, wm: Mesher, wtex: number, wc: Rgb, pentHouse: boolean, waterTank: boolean, side: number) {
  if (pentHouse) {
    const c = at(f, side * (f.hw - 1.9), -f.hd + 1.9, y + 1.25);
    wm.box(c, f.U, f.F, 3, 2.5, 3, wc, wtex);
    k.out.trim.box(v3(c.x, y + 2.54, c.z), f.U, f.F, 3.2, 0.08, 3.2, C_DARK);
  }
  if (waterTank) {
    const c = at(f, -side * (f.hw - 1.6), -f.hd + 1.8, y + 1.7);
    k.out.trim.box(c, f.U, f.F, 1.6, 1.4, 1.6, hex("#d6d9d8"), 1, true);
    for (const [a, b] of [[-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]]) {
      const p = add(add(c, f.U, a), f.F, b);
      k.out.trim.box(v3(p.x, y + 0.5, p.z), f.U, f.F, 0.08, 1.0, 0.08, C_STEEL);
    }
  }
}

export { UP };
