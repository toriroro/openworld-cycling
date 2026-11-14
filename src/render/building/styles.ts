// 建物の型ごとの組み立て。北海道・東北の町を手本にする:
// - 一軒家: 金属の三角屋根（急な勾配）か無落雪屋根（箱形）、高い基礎、玄関フード、灯油タンク、集合煙突。塀は少ない
// - 古い家: 下見板・モルタル・トタンの壁、金属の屋根
// - アパート: 2 階建て。内階段型（中央に共用の入口と階段室、ベランダなし、裏に灯油タンクの列）か、外階段と外廊下の型
// - マンション: 3〜5 階、タイルか塗りの壁、道路側に連続したベランダ、裏に開放廊下、塔屋と高架水槽
// - 商店: 看板建築（正面だけ高く立ち上げた平らな壁）、木造の古い商店（平入り、庇、木のガラス戸）
// - テナント: 3〜5 階のテナントビル（1 階の店、階ごとの看板、積み重ねた袖看板）、平屋の貸店舗（店が横に並ぶ）
// 形は寸法と種（seed）だけから決まる。

import type { Building, BuildingStyle } from "../town-layout.ts";
import {
  acUnit,
  balcony,
  band,
  blockFence,
  C_ALUMI,
  C_BASE,
  C_DARK,
  C_RAIL,
  C_SLAB,
  C_STEEL,
  chimney,
  type Face,
  faces,
  fbox,
  flatRoof,
  type Fr,
  gableRoof,
  gambrelRoof,
  hipRoof,
  type Kit,
  on,
  pent,
  pic,
  porch,
  type RoofKind,
  rooftop,
  shed,
  shedRoof,
  sideSign,
  signBand,
  stairs,
  tank,
  tent,
  vestibule,
  type WallKind,
  walls,
} from "./kit.ts";
import { hex, neg, type Rect, type Rgb, shade, unit, type V3, v3, WHITE } from "./mesher.ts";

const SIDING = ["#efe6d0", "#dccfb4", "#d9d9d4", "#f1efe8", "#c9d6c0", "#c3d0d8", "#a08568", "#767b80", "#6b7a8e", "#c29a7c", "#e6dcc6", "#b9b4a8"].map(hex);
const MORTAR = ["#e9e4d6", "#d9d5cb", "#cfc6b2", "#e6ddc8", "#c4c8c6", "#d6cdbd"].map(hex);
const OLD_MORTAR = ["#c9c3b3", "#b9b5a8", "#d3cab4", "#a9a79f"].map(hex);
const LAP = ["#e8e2d0", "#8a9aa0", "#7d8f7a", "#6b5546", "#b9c7c9", "#9c6a55", "#d8cfb8", "#56605f"].map(hex);
const TOTAN = ["#6f8794", "#7a8c78", "#8f7a66", "#9a9d9c", "#5d6b78", "#a0705a"].map(hex);
const CEDAR: Rgb[] = [[0.42, 0.37, 0.33], [0.55, 0.47, 0.4]];
const SEAM = ["#7d4039", "#3b5a7a", "#46644f", "#5b4638", "#36383c", "#80868a", "#6a3632", "#3d5269", "#4d5256"].map(hex);
const TILE = ["#ffffff", "#c9ced6", "#b3a49a", "#9da6ad"].map(hex);
const RC = ["#e3e0d8", "#cfcbc0", "#d9cfb8", "#b9bcbd", "#e8dfd0", "#c7bfb0", "#aeb6b3"].map(hex);
const TILEWALL = ["#9a5a43", "#b98a64", "#e6e2d8", "#7a6a5c", "#c9b79a", "#5f6a70", "#a8553f", "#d9d2c2"].map(hex);
const FACADE = ["#7fa08f", "#e3d9bf", "#d9b9a3", "#a9c0cc", "#c9c7c0", "#e8e4d8", "#b08a6a", "#8c9a78", "#c7a7a0", "#6f8f9a"].map(hex);
const TENT = ["#2f5d43", "#7a2e2a", "#28456b", "#c9a227", "#e6e1d3", "#3b3b3b", "#a65a2a", "#4d6b7a"].map(hex);
const C_PANEL = [hex("#eceae4"), hex("#cfd2d2"), hex("#d9d2c0")];

const pick = <T>(a: T[], i: number): T => a[((i % a.length) + a.length) % a.length];

/** 面の a0〜a1 に、窓を等間隔に並べる。skip はところどころ抜く割合 */
function row(k: Kit, fc: Face, a0: number, a1: number, y: number, w: number, h: number, pitch: number, cell: Rect, seed: number, skip = 0) {
  if (a1 - a0 < w + 0.3) return;
  const n = Math.max(1, Math.floor((a1 - a0) / pitch));
  const step = (a1 - a0) / n;
  for (let i = 0; i < n; i++) {
    if (n > 1 && unit(seed, i) < skip) continue;
    pic(k, fc, a0 + step * (i + 0.5) - w / 2, y, w, h, cell, unit(seed, i + 40) < 0.5, 0.035, shade(WHITE, 0.82 + 0.18 * unit(seed, i + 80)));
  }
}

interface Ctx {
  k: Kit;
  b: Building;
  f: Fr;
  fc: [Face, Face, Face, Face];
  r: (i: number) => number;
  /** 敷地の高さ（1 階の床の基準）、壁の上端 */
  y0: number;
  yW: number;
  roofKind: RoofKind;
  roofCol: Rgb;
}

/** 集落の建物（型が決まっていない）に型を当てる */
function legacyStyle(b: Building): BuildingStyle {
  if (b.floors >= 3) return "mansion";
  return unit(b.seed, 90) < 0.4 ? "oldhouse" : "house";
}

export function buildBuilding(k: Kit, b: Building, c: V3) {
  const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
  const Z = v3(-sa, 0, ca);
  const F = b.front > 0 ? Z : neg(Z);
  const U = v3(F.z, 0, -F.x);
  const f: Fr = { c, U, F, hw: b.w / 2, hd: b.d / 2 };
  const style = b.style ?? legacyStyle(b);
  // 屋根: 金属が基本。瓦は少数（型の決まっていない集落の建物は、元の指定の 3 割だけ瓦にする）
  const tile = b.roofMat === "tile" && (b.style !== undefined || unit(b.seed, 91) < 0.3);
  const roofKind: RoofKind = tile ? "tile" : "seam";
  const x: Ctx = { k, b, f, fc: faces(f), r: (i) => unit(b.seed, i), y0: b.top, yW: b.top + b.h, roofKind, roofCol: tile ? pick(TILE, b.tone) : pick(SEAM, b.tone + (b.seed % 5)) };
  switch (style) {
    case "house":
      return house(x, false);
    case "oldhouse":
      return house(x, true);
    case "apartment":
      return apartment(x);
    case "mansion":
      return mansion(x);
    case "shop":
      return shop(x);
    case "oldshop":
      return oldShop(x);
    case "tenant":
      return tenant(x);
    case "strip":
      return strip(x);
  }
}

/** 一軒家（old = 古い木造） */
function house(x: Ctx, old: boolean) {
  const { k, b, f, fc, r, y0, yW } = x;
  const fl = 0.5; // 高い基礎
  let wk: WallKind, wc: Rgb;
  if (old) {
    const t = r(1);
    wk = t < 0.45 ? "lap" : t < 0.78 ? "plaster" : t < 0.9 ? "metal" : "cedar";
    wc = wk === "lap" ? pick(LAP, b.tone) : wk === "plaster" ? pick(OLD_MORTAR, b.tone) : wk === "metal" ? pick(TOTAN, b.tone) : pick(CEDAR, b.tone);
  } else {
    wk = b.wallMat === "plaster" ? "mortar" : "siding";
    wc = wk === "siding" ? pick(SIDING, b.tone + (b.seed % 3)) : pick(MORTAR, b.tone);
  }
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  for (const face of fc) band(k.out.trim, face, 0, face.len, b.base, y0 + fl - 0.05, 0.02, C_BASE, 1);
  if (!old && b.floors === 2 && r(2) < 0.3) for (const face of fc) band(wm, face, 0, face.len, y0 + fl - 0.05, y0 + 3.25, 0.014, shade(wc, 0.7), wt);

  // 屋根
  const wallRef = { m: wm, tex: wt, col: wc };
  const longU = f.hw >= f.hd;
  let top = yW + 1.2;
  const gambrel = old && b.roof === "gable" && b.floors === 1 && r(22) < 0.45;
  if (b.roof === "flat") {
    flatRoof(k, f, yW, 0.35, wm, wt, wc, shade(x.roofCol, 0.8));
    for (const face of fc) band(k.out.trim, face, -0.03, face.len + 0.03, yW + 0.05, yW + 0.35, 0.03, shade(x.roofCol, 0.8), 1);
    top = yW + 1.1;
  } else if (gambrel) {
    // 腰折れ屋根（屋根の中が 2 階）。妻の壁に窓
    const R = longU ? f.U : f.F, hr = longU ? f.hw : f.hd, hs = longU ? f.hd : f.hw;
    gambrelRoof(k, f.c, R, hr, hs, yW, 0.35, 0.3, x.roofKind, x.roofCol, wallRef);
    for (const i of longU ? [1, 3] : [0, 2]) pic(k, fc[i], fc[i].len / 2 - 0.7, yW + 0.55, 1.4, 1.05, k.atlas.cell.wood);
    top = yW + hs * 0.97 + 0.7;
  } else if (b.roof === "shed") {
    const rise = Math.min(2.4, f.hd * 2 * 0.28);
    shedRoof(k, f.c, r(3) < 0.6 ? f.U : neg(f.U), f.hw, f.hd, yW, rise, 0.35, x.roofKind, x.roofCol, wallRef);
    top = yW + rise + 0.6;
  } else if (b.roof === "hip") {
    hipRoof(k, f.c, longU ? f.U : f.F, longU ? f.hw : f.hd, longU ? f.hd : f.hw, yW, 0.42, 0.45, x.roofKind, x.roofCol);
    top = yW + Math.min(f.hw, f.hd) * 0.42 + 0.5;
  } else {
    // 三角屋根。古い家と一部の家は勾配が急
    const pitch = x.roofKind === "tile" ? 0.5 : old ? 0.55 + 0.3 * r(3) : 0.42 + 0.4 * r(3);
    gableRoof(k, f.c, longU ? f.U : f.F, longU ? f.hw : f.hd, longU ? f.hd : f.hw, yW, pitch, 0.4, 0.3, x.roofKind, x.roofCol, wallRef);
    top = yW + Math.min(f.hw, f.hd) * pitch + 0.7;
  }

  const bronze = r(4) < 0.4;
  const wS = old ? k.atlas.cell.wood : bronze ? k.atlas.cell.winB : k.atlas.cell.winA;
  const wT = old ? k.atlas.cell.wood : bronze ? k.atlas.cell.tallB : k.atlas.cell.tallA;
  const front = fc[0], L = front.len;
  const y1 = y0 + fl, y2 = y0 + 3.3;
  // 玄関
  const left = r(5) < 0.5;
  const aD0 = L < 6.5 ? L * 0.28 : 1.45;
  const aD = left ? aD0 : L - aD0;
  const setback = b.gap - 0.5;
  if (setback > 1.75 && r(6) < (old ? 0.4 : 0.62)) vestibule(k, front, aD, y0, fl);
  else if (setback > 1.05) porch(k, front, aD, y0, fl, old ? k.atlas.cell.doorSlide : r(7) < 0.5 ? k.atlas.cell.doorA : k.atlas.cell.doorB, left);
  else {
    fbox(k.out.trim, front, aD - 0.6, aD + 0.6, y0 - 0.2, y1, 0, Math.max(0.25, setback - 0.1), C_SLAB);
    pic(k, front, aD - 0.5, y1, 1.0, 2.15, old ? k.atlas.cell.doorSlide : k.atlas.cell.doorA, left);
  }
  // 正面の窓。玄関と反対の側
  const s0 = left ? aD + 1.35 : 0.5, s1 = left ? L - 0.5 : aD - 1.35;
  const garage = !old && b.roof === "flat" && b.floors === 2 && s1 - s0 > 3.2 && setback > 1.2 && r(8) < 0.35;
  if (garage) {
    const g0 = left ? s1 - 2.9 : s0;
    pic(k, front, g0, y0 + 0.02, 2.9, 2.2, k.atlas.cell.shutter);
    band(k.out.trim, front, g0 - 0.1, g0 + 3.0, y0, y0 + 2.3, 0.025, C_BASE, 1);
    if (s1 - s0 > 5.4) row(k, front, left ? s0 : g0 + 3.1, left ? g0 - 0.2 : s1, y1 + 0.85, 1.6, 1.1, 2.6, wS, b.seed + 1);
  } else if (r(9) < 0.5) row(k, front, s0, s1, y1 + 0.08, 1.7, 1.9, 2.7, wT, b.seed + 1);
  else row(k, front, s0, s1, y1 + 0.85, 1.6, 1.1, 2.5, wS, b.seed + 1);
  if (b.floors >= 2) {
    const bal = !old && r(10) < 0.3 && s1 - s0 > 3;
    if (bal) {
      const b0 = Math.max(0.2, s0 - 0.3), b1 = Math.min(L - 0.2, b0 + 3.4);
      balcony(k, front, b0, b1, y2, 1.0, r(11) < 0.5 ? shade(wc, 0.92) : C_PANEL[0], r(12) < 0.6 ? "solid" : "rail");
      pic(k, front, (b0 + b1) / 2 - 0.85, y2 + 0.05, 1.7, 1.9, wT);
      row(k, front, left ? 0.4 : b1 + 0.3, left ? b0 - 0.3 : L - 0.4, y2 + 0.85, 1.5, 1.1, 2.6, wS, b.seed + 2);
    } else row(k, front, 0.5, L - 0.5, y2 + 0.85, 1.6, 1.1, 2.7, wS, b.seed + 2, 0.15);
  }
  // 横と裏
  for (const i of [1, 3] as const) {
    const s = fc[i];
    row(k, s, 0.7, s.len - 0.7, y1 + 1.0, 1.2, 0.95, 3.6, r(13 + i) < 0.4 ? k.atlas.cell.small : wS, b.seed + 3 + i, 0.35);
    if (b.floors >= 2) row(k, s, 0.7, s.len - 0.7, y2 + 0.9, 1.4, 1.05, 3.4, wS, b.seed + 5 + i, 0.3);
  }
  const back = fc[2];
  row(k, back, 0.5, back.len - 0.5, y1 + 0.08, 1.7, 1.9, 3.4, wT, b.seed + 9, 0.3);
  if (b.floors >= 2) row(k, back, 0.5, back.len - 0.5, y2 + 0.85, 1.6, 1.1, 2.8, wS, b.seed + 10, 0.2);
  // 灯油タンク、煙突、室外機
  const ts = r(17) < 0.5 ? 1 : 3;
  const side = fc[ts], other = fc[ts === 1 ? 3 : 1];
  if (r(18) < (old ? 0.85 : 0.72)) tank(k, side, ts === 1 ? side.len - 1.3 : 1.3, y0, b.seed);
  if (r(19) < (old ? 0.6 : 0.18)) chimney(k, other, other.len * (0.35 + 0.3 * r(20)), b.base, top);
  if (!old && r(21) < 0.25) acUnit(k, back, back.len * 0.25, y0 + 0.05);
  // 物置
  if (r(23) < 0.4 && back.len > 5) shed(k, back, back.len * (0.55 + 0.25 * r(24)), y0, b.seed);
  // 雪の多い土地では塀が少ない。型の決まっていない集落の建物は、元の指定の 3 割だけ塀を立てる
  if (b.fence && (b.style !== undefined || r(25) < 0.3)) blockFence(k, front, b.gap - 0.6, Math.min(b.base, b.roadY - 0.8), b.roadY + 0.55, aD - 0.9, aD + 0.9);
}

/** アパート（2 階建て） */
function apartment(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const wk: WallKind = r(1) < 0.7 ? "siding" : "mortar";
  const wc = wk === "siding" ? pick(SIDING, b.tone + 3) : pick(MORTAR, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  for (const face of fc) band(k.out.trim, face, 0, face.len, b.base, y0 + 0.3, 0.02, C_BASE, 1);
  if (b.roof === "flat") {
    flatRoof(k, f, yW, 0.35, wm, wt, wc, shade(x.roofCol, 0.8));
    for (const face of fc) band(k.out.trim, face, -0.03, face.len + 0.03, yW + 0.05, yW + 0.35, 0.03, shade(x.roofCol, 0.8), 1);
  } else gableRoof(k, f.c, f.U, f.hw, f.hd, yW, 0.28, 0.45, 0.3, "seam", x.roofCol, { m: wm, tex: wt, col: wc });
  const [front, right, back, left] = fc;
  const L = front.len, y1 = y0 + 0.35, y2 = y0 + 3.0;
  const A = k.atlas.cell;
  const inner = r(2) < 0.55;
  if (inner) {
    // 内階段型: 中央に共用の入口と階段室。両側に住戸
    const core = 2.4, a0 = (L - core) / 2;
    fbox(k.out.trim, front, a0 + 0.2, a0 + core - 0.2, y0 - 0.2, y1 - 0.2, 0, 1.0, C_SLAB);
    pic(k, front, a0 + 0.4, y1 - 0.2, 1.6, 2.15, A.doorGlass);
    fbox(k.out.trim, front, a0, a0 + core, y1 + 2.1, y1 + 2.22, 0, 1.1, C_DARK, true);
    pic(k, front, a0 + 0.6, y1 + 2.5, 1.2, Math.min(2.6, yW - y1 - 2.9), A.stair);
    for (const yy of [y1, y2])
      for (const [s0, s1] of [[0.4, a0 - 0.2], [a0 + core + 0.2, L - 0.4]]) row(k, front, s0, s1, yy + 0.9, 1.6, 1.1, 2.9, A.winA, b.seed + Math.round(yy * 7 + s0));
    for (const yy of [y1, y2]) row(k, back, 0.5, L - 0.5, yy + 0.9, 1.6, 1.1, 3.0, A.winA, b.seed + 20 + Math.round(yy));
    // 裏に灯油タンクの列（住戸の数）
    const units = Math.max(2, Math.round((L - core) / 6)) * 2;
    for (let i = 0; i < units; i++) tank(k, back, 1.2 + ((L - 2.4) * (i + 0.5)) / units, y0, b.seed + i);
  } else {
    // 外階段と外廊下の型: 道路側に廊下と扉、裏にベランダ
    const n = Math.max(2, Math.round(L / 6)), uw = L / n;
    const yc = y2;
    fbox(k.out.trim, front, 0, L, yc - 0.14, yc, 0, 1.2, C_SLAB, true);
    fbox(k.out.trim, front, 1.25, L, yc + 0.1, yc + 1.05, 1.14, 1.2, C_RAIL, true);
    fbox(k.out.trim, front, 0, L, yW - 0.1, yW, 0, 1.35, shade(x.roofCol, 0.8), true);
    for (let i = 0; i <= n; i++) {
      const a = Math.min(L - 0.05, Math.max(0.05, i * uw));
      fbox(k.out.trim, front, a - 0.04, a + 0.04, y0, yW - 0.1, 1.12, 1.2, C_STEEL);
    }
    // 階段: 道路側の左の端へ上る
    const run = Math.min(4.6, L - 1.6);
    fbox(k.out.trim, front, 0, 1.25, yc - 0.14, yc, 1.2, 2.15, C_SLAB, true);
    stairs(k, front, 1.25 + run, 1.25, y0, yc, 1.25, 0.9);
    for (const yy of [y1, yc])
      for (let i = 0; i < n; i++) {
        const a = i * uw;
        pic(k, front, a + 0.55, yy === y1 ? y1 - 0.2 : yy, 0.9, 2.05, A.doorApt, i % 2 === 1);
        if (uw > 3.6) pic(k, front, a + 2.1, yy + 1.05, 1.1, 0.9, A.small);
        pic(k, back, L - a - uw / 2 - 0.85, yy + 0.05, 1.7, 1.9, A.tallA);
        if (yy === yc) balcony(k, back, L - a - uw + 0.25, L - a - 0.25, yc, 0.9, C_PANEL[b.tone % 3], "rail");
      }
    tank(k, right, right.len - 1.2, y0, b.seed);
    tank(k, right, right.len - 2.5, y0, b.seed + 1);
  }
  for (const s of [right, left]) for (const yy of [y1, y2]) row(k, s, 0.8, s.len - 0.8, yy + 1.0, 1.2, 0.95, 4, A.small, b.seed + 30 + Math.round(yy), 0.3);
}

/** マンション（3〜5 階） */
function mansion(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const wk: WallKind = r(1) < 0.6 ? "tilewall" : "mortar";
  const wc = wk === "tilewall" ? pick(TILEWALL, b.tone) : pick(RC, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  flatRoof(k, f, yW, 0.6, wm, wt, wc, C_DARK);
  rooftop(k, f, yW + 0.6, wm, wt, wc, true, r(2) < 0.6, r(3) < 0.5 ? 1 : -1);
  const [front, right, back, left] = fc;
  const L = front.len, fh = b.h / b.floors;
  const n = Math.max(2, Math.round(L / 6.5)), uw = L / n;
  const A = k.atlas.cell;
  const panel = r(4) < 0.4 ? shade(wc, 0.9) : C_PANEL[b.tone % 3];
  const entry = Math.floor(r(5) * n);
  for (let fl = 0; fl < b.floors; fl++) {
    const y = y0 + fl * fh + 0.12;
    for (let i = 0; i < n; i++) {
      const a = i * uw;
      if (fl === 0 && i === entry) {
        // 入口: ガラスの扉とひさし
        pic(k, front, a + uw / 2 - 0.9, y0 + 0.05, 1.8, 2.2, A.doorGlass);
        pic(k, front, a + uw / 2 + 0.95, y0 + 0.05, 0.9, 2.2, A.glassPanel);
        fbox(k.out.trim, front, a + uw / 2 - 1.5, a + uw / 2 + 2.1, y0 + 2.4, y0 + 2.55, 0, 1.5, C_DARK, true);
        continue;
      }
      pic(k, front, a + uw / 2 - 0.9, y + 0.03, 1.8, 1.95, i % 2 ? A.tallA : A.tallB, i % 2 === 0);
      if (uw > 6.2) pic(k, front, a + uw / 2 + 1.3, y + 0.85, 1.3, 1.1, A.winA);
      if (fl > 0 && r(20 + fl * 8 + i) < 0.4) acUnit(k, front, a + 0.9, y);
      // 裏: 開放廊下の扉と小窓
      pic(k, back, L - a - uw + 0.6, y, 0.9, 2.05, A.doorApt, i % 2 === 0);
      pic(k, back, L - a - uw + 2.2, y + 1.05, 1.1, 0.9, A.small);
    }
    if (fl > 0) {
      balcony(k, front, 0.12, L - 0.12, y, 1.2, panel, "solid");
      for (let i = 1; i < n; i++) fbox(k.out.trim, front, i * uw - 0.03, i * uw + 0.03, y, y + 1.9, 0, 1.12, C_PANEL[1]);
      fbox(k.out.trim, back, 0, L, y - 0.14, y, 0, 1.2, C_SLAB, true);
      fbox(k.out.trim, back, 0, L, y, y + 1.1, 1.13, 1.2, panel);
    }
  }
  // 横: 階段室のガラスブロックと小窓
  const st = r(6) < 0.5 ? right : left, ot = st === right ? left : right;
  pic(k, st, st.len / 2 - 0.6, y0 + 1.2, 1.2, b.h - 2.2, A.stair);
  for (let fl = 0; fl < b.floors; fl++) row(k, ot, 1, ot.len - 1, y0 + fl * fh + 1.0, 1.3, 1.0, 4.5, A.winA, b.seed + 60 + fl, 0.3);
}

/** 1 階の店の正面（ガラスの面かシャッター）を a0〜a1 に張る */
function shopGlass(k: Kit, fc: Face, a0: number, a1: number, y: number, seed: number, shut: boolean) {
  const A = k.atlas.cell;
  const w = a1 - a0;
  if (shut) {
    const n = Math.max(1, Math.round(w / 3.2));
    for (let i = 0; i < n; i++) pic(k, fc, a0 + (w * i) / n + 0.04, y, w / n - 0.08, 2.55, A.shutter);
    return;
  }
  const n = w > 7 ? 2 : 1;
  for (let i = 0; i < n; i++) pic(k, fc, a0 + (w * i) / n, y, w / n, 2.55, unit(seed, 70 + i) < 0.5 ? A.shopA : A.shopB, unit(seed, 72 + i) < 0.5);
}

const signOf = (b: Building) => (b.sign ?? b.seed) % 32;

/** 看板建築: 正面だけ平らな壁を高く立ち上げた商店 */
function shop(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const t = r(1);
  const wk: WallKind = t < 0.35 ? "metal" : t < 0.7 ? "siding" : "mortar";
  const wc = wk === "metal" ? pick(TOTAN, b.tone) : wk === "siding" ? pick(SIDING, b.tone) : pick(OLD_MORTAR, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  let ridge = yW + 0.35;
  if (b.roof === "flat") flatRoof(k, f, yW, 0.3, wm, wt, wc, shade(x.roofCol, 0.8));
  else {
    gableRoof(k, f.c, f.F, f.hd, f.hw, yW, 0.3, 0.15, 0.1, "seam", x.roofCol, { m: wm, tex: wt, col: wc });
    ridge = yW + f.hw * 0.3 + 0.2;
  }
  const [front, right, back, left] = fc;
  const L = front.len, A = k.atlas.cell;
  // 正面の壁
  const ft = r(2);
  const fk: WallKind = ft < 0.6 ? "mortar" : ft < 0.82 ? "tilewall" : "lap";
  const fcol = fk === "tilewall" ? pick(TILEWALL, b.seed) : pick(FACADE, b.seed);
  const fm = k.out[fk], ftex = k.tex[fk];
  const yTop = Math.min(yW + 2.3, Math.max(yW + 0.9, ridge + 0.25));
  const fp = on(front, L / 2, 0.06, (b.base + yTop) / 2);
  fm.box(fp, front.u, front.n, L + 0.16, yTop - b.base, 0.12, fcol, ftex);
  const capCol = r(3) < 0.5 ? C_DARK : shade(fcol, 0.75);
  fbox(k.out.trim, front, -0.16, L + 0.16, yTop, yTop + 0.12, -0.04, 0.24, capCol, true);
  if (r(4) < 0.3 && L > 5) {
    // 中央を一段高くする
    const cp = on(front, L / 2, 0.06, yTop + 0.37);
    fm.box(cp, front.u, front.n, L * 0.5, 0.5, 0.12, fcol, ftex);
    fbox(k.out.trim, front, L * 0.25 - 0.08, L * 0.75 + 0.08, yTop + 0.62, yTop + 0.72, -0.04, 0.24, capCol, true);
  }
  const off = 0.12 + 0.03;
  const sign = signOf(b);
  if (b.floors >= 2) {
    // 2 階の窓と、階の境の帯
    fbox(k.out.trim, front, -0.06, L + 0.06, y0 + 3.5, y0 + 3.62, 0.12, 0.2, capCol, true);
    const cell = r(5) < 0.35 ? A.wood : r(5) < 0.7 ? A.winA : A.bldg;
    const n = Math.max(2, Math.floor(L / 2.5)), step = L / n;
    for (let i = 0; i < n; i++) pic(k, front, step * (i + 0.5) - 0.65, y0 + 4.15, 1.3, 1.5, cell, i % 2 === 0, off);
    signBand(k, front, 0.3, L - 0.3, y0 + 2.75, 0.68, 0.14 + 0.12, sign);
  } else {
    // 平屋: 立ち上げた壁に大きな看板
    signBand(k, front, 0.3, L - 0.3, y0 + 2.9, Math.min(1.0, yTop - y0 - 3.1), 0.14 + 0.12, sign);
  }
  shopGlass(k, { ...front, p0: on(front, 0, 0.12, 0) }, 0.4, L - 0.4, y0 + 0.08, b.seed, r(6) < 0.16);
  if (r(7) < 0.45) tent(k, front, 0.25, L - 0.25, y0 + 2.74, 1.15, pick(TENT, b.seed >> 3));
  if (sign < 16 && r(8) < 0.4 && b.floors >= 2) sideSign(k, front, r(9) < 0.5 ? 0.3 : L - 0.3, y0 + 3.8, y0 + 6.0, 0.55, sign);
  // 横と裏
  for (const s of [right, left]) if (b.floors >= 2) row(k, s, s.len * 0.35, s.len - 1, y0 + 4.3, 1.2, 1.0, 5, A.winA, b.seed + 12, 0.4);
  pic(k, back, 0.6, y0 + 0.1, 0.9, 2.05, A.doorApt);
  row(k, back, 2, back.len - 0.5, y0 + 1.1, 1.4, 1.05, 3, A.winA, b.seed + 14, 0.2);
  if (b.floors >= 2) row(k, back, 0.5, back.len - 0.5, y0 + 4.3, 1.4, 1.05, 2.8, A.winA, b.seed + 15, 0.2);
  if (r(10) < 0.55) tank(k, back, back.len - 1.1, y0, b.seed);
  if (r(11) < 0.3) chimney(k, r(12) < 0.5 ? right : left, f.hd * 1.3, b.base, yW + f.hw * 0.3 + 0.8);
}

/** 木造の古い商店: 平入りの屋根、庇、木のガラス戸 */
function oldShop(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const t = r(1);
  const wk: WallKind = t < 0.45 ? "lap" : t < 0.75 ? "plaster" : "cedar";
  const wc = wk === "lap" ? pick(LAP, b.tone) : wk === "plaster" ? pick(OLD_MORTAR, b.tone) : pick(CEDAR, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  const pitch = x.roofKind === "tile" ? 0.5 : 0.45;
  gableRoof(k, f.c, f.U, f.hw, f.hd, yW, pitch, 0.5, 0.2, x.roofKind, x.roofCol, { m: wm, tex: wt, col: wc });
  const [front, right, back, left] = fc;
  const L = front.len, A = k.atlas.cell;
  const sign = signOf(b);
  const two = b.floors >= 2;
  // 1 階: 木のガラス戸を並べる
  const n = Math.max(2, Math.floor((L - 0.5) / 1.95)), step = (L - 0.5) / n;
  const shut = r(2) < 0.14;
  for (let i = 0; i < n; i++) pic(k, front, 0.25 + step * i + 0.04, y0 + 0.1, step - 0.08, 2.35, shut ? A.shutter : A.shopWood, i % 2 === 1);
  if (two) {
    pent(k, front, -0.2, L + 0.2, y0 + 3.05, 0.95, 0.28, x.roofKind, x.roofCol);
    signBand(k, front, L / 2 - 1.45, L / 2 + 1.45, y0 + 3.12, 0.6, 0.1, sign);
    row(k, front, 0.4, L - 0.4, y0 + 3.95, 1.5, 1.15, 2.3, A.wood, b.seed + 3);
  } else signBand(k, front, 0.4, L - 0.4, y0 + 2.6, 0.62, 0.12, sign);
  if (r(3) < 0.35) {
    // のれん（無地の布）
    const a = 0.25 + step * Math.floor(n / 2);
    k.out.trim.quad2([on(front, a + 0.1, 0.09, y0 + 1.95), on(front, a + step - 0.1, 0.09, y0 + 1.95), on(front, a + step - 0.1, 0.09, y0 + 2.45), on(front, a + 0.1, 0.09, y0 + 2.45)], [[0, 0], [1, 0], [1, 1], [0, 1]], pick(TENT, b.seed >> 4));
  }
  for (const s of [right, left]) row(k, s, s.len * 0.4, s.len - 0.8, y0 + 1.1, 1.3, 1.05, 4.5, A.wood, b.seed + 5, 0.4);
  pic(k, back, 0.6, y0 + 0.1, 0.9, 2.05, A.doorSlide);
  row(k, back, 2, back.len - 0.5, y0 + 1.0, 1.5, 1.1, 2.8, A.wood, b.seed + 6, 0.2);
  if (two) row(k, back, 0.5, back.len - 0.5, y0 + 3.9, 1.5, 1.1, 2.8, A.wood, b.seed + 7, 0.2);
  if (r(4) < 0.6) tank(k, back, back.len - 1.1, y0, b.seed);
  if (r(5) < 0.6) chimney(k, r(6) < 0.5 ? right : left, f.hd * (0.6 + 0.6 * r(7)), b.base, yW + f.hd * pitch + 0.7);
}

/** テナントビル（3〜5 階）: 1 階の店、階ごとの窓と看板、積み重ねた袖看板 */
function tenant(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const wk: WallKind = r(1) < 0.5 ? "tilewall" : "mortar";
  const wc = wk === "tilewall" ? pick(TILEWALL, b.tone + 1) : pick(RC, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  flatRoof(k, f, yW, 0.6, wm, wt, wc, C_DARK);
  const stairLeft = r(2) < 0.5;
  rooftop(k, f, yW + 0.6, wm, wt, wc, true, r(3) < 0.5, stairLeft ? -1 : 1);
  const [front, right, back, left] = fc;
  const L = front.len, A = k.atlas.cell;
  const h1 = 3.6, fh = (b.h - h1) / Math.max(1, b.floors - 1);
  const sign = signOf(b);
  // 1 階: 上の階への入口と、店
  const e0 = stairLeft ? 0.3 : L - 1.5;
  pic(k, front, e0, y0 + 0.08, 1.2, 2.25, A.doorGlass);
  fbox(k.out.trim, front, e0 - 0.15, e0 + 1.35, y0 + 2.42, y0 + 2.52, 0, 0.7, C_ALUMI, true);
  const s0 = stairLeft ? 1.8 : 0.35, s1 = stairLeft ? L - 0.35 : L - 1.8;
  shopGlass(k, front, s0, s1, y0 + 0.08, b.seed, r(4) < 0.14);
  signBand(k, front, s0 - 0.1, s1 + 0.1, y0 + 2.8, 0.7, 0.16, sign);
  if (r(5) < 0.3) tent(k, front, s0, s1, y0 + 2.78, 1.1, pick(TENT, b.seed >> 3));
  // 上の階
  const wkind = r(6);
  for (let fl = 1; fl < b.floors; fl++) {
    const y = y0 + h1 + (fl - 1) * fh;
    if (wkind < 0.4) row(k, front, 0.35, L - 0.35, y + 0.95, 2.6, 1.45, 2.9, A.ribbon, b.seed + fl);
    else row(k, front, 0.4, L - 0.4, y + 0.95, 1.5, 1.4, 2.2, r(30 + fl) < 0.35 ? A.winFilm : A.bldg, b.seed + fl);
    if (r(40 + fl) < 0.45) signBand(k, front, L * 0.18, L * 0.82, y + 0.16, 0.56, 0.1, (sign + fl * 7) % 32);
    // 袖看板（入口と反対の角）
    sideSign(k, front, stairLeft ? L - 0.25 : 0.25, y + 0.45, y + 0.45 + Math.min(2.4, fh - 0.5), 0.6, (sign + fl * 3) % 16);
  }
  // 横: 階段室の小窓の列。裏: 窓と室外機
  const st = stairLeft ? left : right;
  for (let fl = 1; fl < b.floors; fl++) {
    const y = y0 + h1 + (fl - 1) * fh;
    pic(k, st, stairLeft ? st.len - 2.2 : 1.0, y + 1.2, 1.1, 0.9, A.small);
    row(k, back, 0.5, L - 0.5, y + 0.95, 1.5, 1.4, 2.6, A.bldg, b.seed + 50 + fl, 0.15);
    if (r(60 + fl) < 0.6) acUnit(k, back, 1 + (L - 2) * r(70 + fl), y0 + 0.05);
  }
  pic(k, back, L - 1.5, y0 + 0.1, 0.9, 2.05, A.doorApt);
}

/** 平屋の貸店舗: 店が横に並び、1 軒ごとに看板 */
function strip(x: Ctx) {
  const { k, b, f, fc, r, y0, yW } = x;
  const wk: WallKind = r(1) < 0.5 ? "siding" : "mortar";
  const wc = wk === "siding" ? pick(SIDING, b.tone) : pick(RC, b.tone);
  const wm = k.out[wk], wt = k.tex[wk];
  walls(wm, f, b.base, yW, wc, wt);
  flatRoof(k, f, yW, 0.3, wm, wt, wc, C_DARK);
  const [front, , back] = fc;
  const L = front.len, A = k.atlas.cell;
  const n = Math.max(2, Math.round(L / 6)), uw = L / n;
  const sign = signOf(b);
  for (let i = 0; i < n; i++) {
    const a = i * uw;
    shopGlass(k, front, a + 0.35, a + uw - 0.35, y0 + 0.08, b.seed + i * 11, r(10 + i) < 0.15);
    signBand(k, front, a + 0.12, a + uw - 0.12, y0 + 2.85, Math.min(0.95, yW - y0 - 2.95), 0.2, (sign + i * 9) % 32);
    pic(k, back, L - a - uw + 0.8, y0 + 0.1, 0.9, 2.05, A.doorApt);
    if (r(20 + i) < 0.7) acUnit(k, back, L - a - uw + 2.6, y0 + 0.05);
  }
  // 店の前のひさし（通し）
  fbox(k.out.trim, front, 0, L, y0 + 2.7, y0 + 2.82, 0, 1.2, C_DARK, true);
}

