// 建物の細部の絵の表（1 枚の画像）: 窓、扉、店の正面、シャッター、玄関フード、室外機、看板。
// 写真ではなく、ここで canvas に描く（外部の素材を使わない）。窓 1 つ・看板 1 枚を四角形 1 枚で描けるので、三角形が少なくて済む。
// 看板の文字は業種だけ（世界の中の物の表示。標語や宣伝の文は書かない）。

import * as THREE from "three";
import { type AtlasLayout, atlasLayout, CELLS, type CellName, H, pairOf, SIGN_TEXT, VSIGN_TEXT, W } from "./atlas-layout.ts";

export { type CellName, SIGN_TEXT } from "./atlas-layout.ts";

type Ctx = CanvasRenderingContext2D;


export interface Atlas extends AtlasLayout {
  texture: THREE.CanvasTexture;
}


function glass(c: Ctx, x: number, y: number, w: number, h: number, bright = 0) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, bright ? "#8aa3b0" : "#62798a");
  g.addColorStop(0.5, bright ? "#566b78" : "#34454f");
  g.addColorStop(1, bright ? "#3d4d57" : "#222d35");
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.fillStyle = "rgba(255,255,255,0.08)";
  c.beginPath();
  c.moveTo(x + w * 0.2, y);
  c.lineTo(x + w * 0.5, y);
  c.lineTo(x + w * 0.1, y + h);
  c.lineTo(x - w * 0.2, y + h);
  c.fill();
  c.restore();
}

/** レースのカーテン（ガラスの内側の白いひだ） */
function lace(c: Ctx, x: number, y: number, w: number, h: number, alpha = 0.6) {
  c.fillStyle = `rgba(232,230,220,${alpha})`;
  c.fillRect(x, y, w, h);
  const n = Math.max(3, Math.round(w / 14));
  c.fillStyle = "rgba(0,0,0,0.07)";
  for (let i = 0; i < n; i++) c.fillRect(x + (w * (i + 0.6)) / n, y, (w / n) * 0.3, h);
}

/** 厚いカーテン（両脇に寄せた布） */
function drape(c: Ctx, x: number, y: number, w: number, h: number, col: string) {
  for (const [a, b] of [[0, 0.24], [0.76, 1]]) {
    c.fillStyle = col;
    c.fillRect(x + w * a, y, w * (b - a), h);
    c.fillStyle = "rgba(0,0,0,0.12)";
    for (let i = 0; i < 3; i++) c.fillRect(x + w * (a + ((b - a) * (i + 0.5)) / 3), y, 3, h);
  }
}

/** 枠の内側の影（窓が壁より奥にあるように見せる） */
function reveal(c: Ctx, x: number, y: number, w: number, h: number) {
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(x, y, w, 5);
  c.fillStyle = "rgba(0,0,0,0.18)";
  c.fillRect(x, y, 4, h);
}

/** 引き違いの窓。枠の色、ガラスの内側（lace・drape）、中桟、面格子 */
function slideWin(c: Ctx, x: number, y: number, w: number, h: number, frame: string, o: { lace?: number; drape?: string; mid?: number; bars?: boolean; frosted?: boolean; blind?: number } = {}) {
  c.fillStyle = frame;
  c.fillRect(x, y, w, h);
  const b = 13;
  c.fillStyle = "rgba(0,0,0,0.3)";
  c.fillRect(x + b - 3, y + b - 3, w - 2 * b + 6, h - 2 * b + 6);
  const gw = (w - 2 * b) / 2;
  for (let i = 0; i < 2; i++) {
    const gx = x + b + i * gw + (i ? -3 : 0), gy = y + b;
    c.fillStyle = frame;
    c.fillRect(gx, gy, gw + 3, h - 2 * b);
    const ix = gx + 8, iy = gy + 8, iw = gw + 3 - 16, ih = h - 2 * b - 16;
    if (o.frosted) {
      c.fillStyle = "#aebbc0";
      c.fillRect(ix, iy, iw, ih);
      c.fillStyle = "rgba(255,255,255,0.18)";
      for (let k = 0; k < 40; k++) c.fillRect(ix + ((k * 37) % iw), iy + ((k * 61) % ih), 3, 3);
    } else {
      glass(c, ix, iy, iw, ih);
      if (o.lace) lace(c, ix, iy, iw, ih, o.lace);
      if (o.blind) {
        const bh = ih * o.blind;
        c.fillStyle = "#d9d7cf";
        c.fillRect(ix, iy, iw, bh);
        c.fillStyle = "rgba(0,0,0,0.13)";
        for (let yy = 4; yy < bh; yy += 6) c.fillRect(ix, iy + yy, iw, 1.5);
      }
    }
    reveal(c, ix, iy, iw, ih);
    if (o.mid) {
      c.fillStyle = frame;
      c.fillRect(gx, gy + (h - 2 * b) * o.mid - 4, gw + 3, 8);
    }
  }
  if (o.drape) drape(c, x + b + 8, y + b + 8, w - 2 * b - 16, h - 2 * b - 16, o.drape);
  if (o.bars) {
    // 面格子（アルミの縦の棒）
    c.fillStyle = "#c9cdd0";
    for (let i = 0; i < 9; i++) c.fillRect(x + 10 + ((w - 26) * i) / 8, y + 6, 6, h - 12);
    c.fillRect(x + 4, y + h * 0.22, w - 8, 6);
    c.fillRect(x + 4, y + h * 0.74, w - 8, 6);
  }
}

/** 木の窓（桟で細かく割る） */
function woodWin(c: Ctx, x: number, y: number, w: number, h: number, frame: string, cols: number, rows: number, kick = 0) {
  c.fillStyle = frame;
  c.fillRect(x, y, w, h);
  const b = 12, n = 2;
  const gw = (w - 2 * b) / n;
  for (let i = 0; i < n; i++) {
    const gx = x + b + i * gw, gy = y + b, gh = (h - 2 * b) * (1 - kick);
    glass(c, gx + 6, gy + 6, gw - 12, gh - 12);
    lace(c, gx + 6, gy + 6, gw - 12, gh - 12, 0.35);
    reveal(c, gx + 6, gy + 6, gw - 12, gh - 12);
    c.fillStyle = frame;
    for (let k = 1; k < cols; k++) c.fillRect(gx + 6 + ((gw - 12) * k) / cols - 2, gy + 6, 4, gh - 12);
    for (let k = 1; k < rows; k++) c.fillRect(gx + 6, gy + 6 + ((gh - 12) * k) / rows - 2, gw - 12, 4);
    if (kick) {
      c.fillStyle = "rgba(0,0,0,0.18)";
      c.fillRect(gx + 8, gy + gh + 2, gw - 16, (h - 2 * b) * kick - 10);
    }
  }
}

function shutter(c: Ctx, x: number, y: number, w: number, h: number) {
  c.fillStyle = "#b9bdbe";
  c.fillRect(x, y, w, h);
  for (let yy = 0; yy < h - 14; yy += 8) {
    c.fillStyle = "rgba(255,255,255,0.25)";
    c.fillRect(x, y + yy, w, 2);
    c.fillStyle = "rgba(0,0,0,0.22)";
    c.fillRect(x, y + yy + 6, w, 2);
  }
  c.fillStyle = "#8f9496";
  c.fillRect(x, y + h - 14, w, 14);
  c.fillRect(x, y, w, 10);
  c.fillStyle = "#6f7477";
  c.fillRect(x + w / 2 - 10, y + h - 30, 20, 10);
  // 薄い汚れ
  c.fillStyle = "rgba(90,70,50,0.06)";
  for (let i = 0; i < 6; i++) c.fillRect(x + ((i * 53) % w), y + 10, 14, h - 24);
}

/** アルミの枠の店の正面。bays: g = ガラス、d = 扉（両開き）、p = 腰壁つきのガラス */
function shopFront(c: Ctx, x: number, y: number, w: number, h: number, frame: string, bays: string, inside: string[]) {
  c.fillStyle = frame;
  c.fillRect(x, y, w, h);
  const b = 10, bw = (w - b) / bays.length;
  const tr = h * 0.17; // 欄間
  for (let i = 0; i < bays.length; i++) {
    const gx = x + b + i * bw, gw = bw - b;
    glass(c, gx, y + b, gw, tr - b, 1);
    const top = y + tr + b * 0.6, k = bays[i];
    const kick = k === "p" ? h * 0.16 : k === "d" ? 8 : 6;
    const gh = y + h - kick - top;
    glass(c, gx, top, gw, gh, 1);
    // 店の中（棚や台の影）
    c.save();
    c.beginPath();
    c.rect(gx, top, gw, gh);
    c.clip();
    c.fillStyle = "rgba(20,24,28,0.35)";
    c.fillRect(gx, top + gh * 0.25, gw, gh);
    if (k !== "d")
      for (let s = 0; s < 3; s++) {
        c.fillStyle = inside[(i + s) % inside.length];
        c.globalAlpha = 0.5;
        c.fillRect(gx + 6 + ((gw - 12) * s) / 3, top + gh * (0.5 + 0.12 * ((i + s) % 2)), (gw - 18) / 3, gh * 0.5);
        c.globalAlpha = 1;
      }
    c.restore();
    reveal(c, gx, top, gw, gh);
    if (k === "p") {
      c.fillStyle = "#d4d2cb";
      c.fillRect(gx, y + h - kick + 3, gw, kick - 3);
    }
    if (k === "d") {
      c.fillStyle = frame;
      c.fillRect(gx + gw / 2 - 4, top, 8, gh);
      c.fillStyle = "#e8e8e6";
      c.fillRect(gx + gw / 2 - 16, top + gh * 0.42, 5, gh * 0.2);
      c.fillRect(gx + gw / 2 + 11, top + gh * 0.42, 5, gh * 0.2);
    }
  }
}

function door(c: Ctx, x: number, y: number, w: number, h: number, frame: string, leaf: string, kind: "slit" | "squares" | "apt") {
  c.fillStyle = frame;
  c.fillRect(x, y, w, h);
  const b = 9;
  c.fillStyle = leaf;
  c.fillRect(x + b, y + b, w - 2 * b, h - b - 3);
  c.fillStyle = "rgba(0,0,0,0.25)";
  c.fillRect(x + b, y + b, w - 2 * b, 4);
  c.fillRect(x + b, y + b, 3, h - b - 3);
  if (kind === "slit") {
    glass(c, x + w * 0.62, y + h * 0.14, w * 0.12, h * 0.6);
    c.fillStyle = "rgba(255,255,255,0.08)";
    for (let i = 0; i < 5; i++) c.fillRect(x + b + 6, y + h * (0.16 + i * 0.16), w * 0.42, 3);
  } else if (kind === "squares") {
    for (let i = 0; i < 4; i++) glass(c, x + w * 0.4, y + h * (0.12 + i * 0.13), w * 0.2, h * 0.09, 1);
  } else {
    // 鉄の扉: 郵便受け、のぞき窓、室名札（無地）
    c.fillStyle = "rgba(0,0,0,0.3)";
    c.fillRect(x + w * 0.3, y + h * 0.55, w * 0.4, 7);
    c.fillStyle = "#e9e7e0";
    c.fillRect(x + w * 0.36, y + h * 0.13, w * 0.28, 9);
    c.fillStyle = "rgba(0,0,0,0.12)";
    c.strokeStyle = "rgba(0,0,0,0.16)";
    c.lineWidth = 2;
    c.strokeRect(x + b + 8, y + b + 30, w - 2 * b - 16, h * 0.34);
    c.strokeRect(x + b + 8, y + h * 0.62, w - 2 * b - 16, h * 0.3);
  }
  // 取っ手
  c.fillStyle = "#d8d8d4";
  c.fillRect(x + (kind === "apt" ? b + 9 : w - b - 15), y + h * 0.45, 6, h * (kind === "apt" ? 0.05 : 0.16));
}

function signCell(c: Ctx, x: number, y: number, w: number, h: number, text: string, bg: string, fg: string) {
  c.fillStyle = bg;
  c.fillRect(x, y, w, h);
  c.strokeStyle = fg;
  c.globalAlpha = 0.35;
  c.lineWidth = 2;
  c.strokeRect(x + 5, y + 5, w - 10, h - 10);
  c.globalAlpha = 1;
  c.fillStyle = fg;
  c.textAlign = "center";
  c.textBaseline = "middle";
  const family = `"Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
  if (w >= h) {
    let size = Math.round(h * 0.66);
    c.font = `700 ${size}px ${family}`;
    while (c.measureText(text).width > w - 30 && size > 12) {
      size -= 2;
      c.font = `700 ${size}px ${family}`;
    }
    c.fillText(text, x + w / 2, y + h / 2 + 2);
  } else {
    const ch = [...text];
    const size = Math.min(w * 0.7, (h - 26) / ch.length - 4);
    c.font = `700 ${Math.round(size)}px ${family}`;
    const pitch = Math.min(size * 1.25, (h - 26) / ch.length);
    const y0 = y + h / 2 - (pitch * (ch.length - 1)) / 2;
    ch.forEach((t, i) => c.fillText(t, x + w / 2, y0 + pitch * i + 2));
  }
}

export function makeAtlas(aniso: number): Atlas {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#8c8f90";
  c.fillRect(0, 0, W, H);
  const R = (n: CellName) => CELLS[n] as readonly [number, number, number, number];
  const SILVER = "#c5c9cb", BRONZE = "#4a423b", WHITEF = "#e9e9e6", WOOD = "#5b4433";

  slideWin(c, ...R("winA"), SILVER, { lace: 0.62 });
  slideWin(c, ...R("winB"), BRONZE, { drape: "#b9a88a", lace: 0.25 });
  slideWin(c, ...R("tallA"), SILVER, { lace: 0.55, mid: 0.62 });
  slideWin(c, ...R("tallB"), BRONZE, { drape: "#8f9aa5", mid: 0.62 });
  slideWin(c, ...R("small"), SILVER, { frosted: true, bars: true });
  woodWin(c, ...R("wood"), WOOD, 2, 3);
  shutter(c, ...R("shutter"));
  // 玄関フード（風除室）の正面: アルミの枠、片引きの戸
  {
    const [x, y, w, h] = R("vest");
    c.fillStyle = SILVER;
    c.fillRect(x, y, w, h);
    for (let i = 0; i < 2; i++) {
      const gx = x + 9 + i * ((w - 9) / 2), gw = (w - 9) / 2 - 9;
      glass(c, gx, y + 9, gw, h * 0.14, 1);
      glass(c, gx, y + h * 0.14 + 16, gw, h * 0.6, 1);
      c.fillStyle = "rgba(225,228,226,0.5)";
      c.fillRect(gx, y + h * 0.14 + 16, gw, h * 0.6);
      c.fillStyle = "#b4b8ba";
      c.fillRect(gx, y + h * 0.74 + 22, gw, h * 0.26 - 26);
      reveal(c, gx, y + h * 0.14 + 16, gw, h * 0.6);
    }
    c.fillStyle = "#7d8285";
    c.fillRect(x + w / 2 + 14, y + h * 0.42, 6, h * 0.14);
  }
  shopFront(c, ...R("shopA"), SILVER, "ppdp", ["#b9a070", "#7f9a8c", "#a8756a", "#d6d0bd"]);
  shopFront(c, ...R("shopB"), BRONZE, "gdg", ["#c7b98f", "#8a8fa3", "#b58a5a"]);
  door(c, ...R("doorA"), SILVER, "#4c3a2e", "slit");
  door(c, ...R("doorB"), WHITEF, "#7b858c", "squares");
  door(c, ...R("doorApt"), "#8d9193", "#b9b3a2", "apt");
  // ガラスの両開きの扉（集合住宅・ビルの入口）
  {
    const [x, y, w, h] = R("doorGlass");
    c.fillStyle = SILVER;
    c.fillRect(x, y, w, h);
    for (let i = 0; i < 2; i++) {
      const gx = x + 7 + i * ((w - 7) / 2), gw = (w - 7) / 2 - 7;
      glass(c, gx, y + 8, gw, h - 20, 1);
      c.fillStyle = "rgba(20,24,28,0.3)";
      c.fillRect(gx, y + h * 0.3, gw, h * 0.7 - 12);
      reveal(c, gx, y + 8, gw, h - 20);
      c.fillStyle = "#eeeeec";
      c.fillRect(gx + (i ? 3 : gw - 7), y + h * 0.42, 4, h * 0.18);
    }
  }
  // 木の引き戸（古い商店・古い家）
  {
    const [x, y, w, h] = R("doorSlide");
    c.fillStyle = WOOD;
    c.fillRect(x, y, w, h);
    for (let i = 0; i < 2; i++) {
      const gx = x + 6 + i * ((w - 6) / 2), gw = (w - 6) / 2 - 6;
      glass(c, gx, y + 8, gw, h * 0.62);
      lace(c, gx, y + 8, gw, h * 0.62, 0.3);
      c.fillStyle = WOOD;
      for (let k = 1; k < 4; k++) c.fillRect(gx, y + 8 + (h * 0.62 * k) / 4 - 2, gw, 4);
      c.fillRect(gx + gw / 2 - 2, y + 8, 4, h * 0.62);
      c.fillStyle = "rgba(0,0,0,0.2)";
      c.fillRect(gx + 3, y + h * 0.62 + 16, gw - 6, h * 0.38 - 26);
    }
  }
  // 階段室のガラスブロック
  {
    const [x, y, w, h] = R("stair");
    c.fillStyle = "#9aa0a2";
    c.fillRect(x, y, w, h);
    const n = 4, m = 8, s = (w - 10) / n, t = (h - 10) / m;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        c.fillStyle = (i + j) % 2 ? "#bcd0d4" : "#a9c1c6";
        c.fillRect(x + 6 + i * s, y + 6 + j * t, s - 3, t - 3);
        c.fillStyle = "rgba(255,255,255,0.3)";
        c.fillRect(x + 8 + i * s, y + 8 + j * t, s * 0.35, t * 0.3);
      }
  }
  // 室外機
  {
    const [x, y, w, h] = R("ac");
    c.fillStyle = "#dedcd3";
    c.fillRect(x, y, w, h);
    c.fillStyle = "#c2c0b7";
    c.fillRect(x, y + h - 10, w, 10);
    c.fillStyle = "#4b4f50";
    c.beginPath();
    c.arc(x + w * 0.42, y + h * 0.48, h * 0.36, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#c9c7be";
    c.lineWidth = 2;
    for (let r = 6; r < h * 0.36; r += 7) {
      c.beginPath();
      c.arc(x + w * 0.42, y + h * 0.48, r, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = "#b7b5ac";
    for (let i = 0; i < 6; i++) c.fillRect(x + w * 0.84, y + 16 + i * 12, w * 0.1, 5);
  }
  // 壁の換気口
  {
    const [x, y, w, h] = R("vent");
    c.fillStyle = "#cfd1d0";
    c.fillRect(x, y, w, h);
    c.fillStyle = "rgba(0,0,0,0.3)";
    for (let i = 0; i < 6; i++) c.fillRect(x + 12, y + 16 + i * 17, w - 24, 7);
  }
  // 枠つきのガラス（玄関フードの横、入口の脇）
  {
    const [x, y, w, h] = R("glassPanel");
    c.fillStyle = SILVER;
    c.fillRect(x, y, w, h);
    glass(c, x + 8, y + 8, w - 16, h * 0.72, 1);
    c.fillStyle = "rgba(225,228,226,0.45)";
    c.fillRect(x + 8, y + 8, w - 16, h * 0.72);
    reveal(c, x + 8, y + 8, w - 16, h * 0.72);
    c.fillStyle = "#b4b8ba";
    c.fillRect(x + 8, y + h * 0.72 + 16, w - 16, h * 0.28 - 24);
  }
  slideWin(c, ...R("bldg"), BRONZE, { blind: 0.45 });
  // 横に長い窓（3 連）
  {
    const [x, y, w, h] = R("ribbon");
    c.fillStyle = "#6b7074";
    c.fillRect(x, y, w, h);
    for (let i = 0; i < 3; i++) {
      const gx = x + 8 + (i * (w - 8)) / 3, gw = (w - 8) / 3 - 8;
      glass(c, gx, y + 10, gw, h - 20);
      const bh = (h - 20) * (i === 1 ? 0.3 : 0.6);
      c.fillStyle = "#d6d4cc";
      c.fillRect(gx, y + 10, gw, bh);
      c.fillStyle = "rgba(0,0,0,0.13)";
      for (let yy = 4; yy < bh; yy += 6) c.fillRect(gx, y + 10 + yy, gw, 1.5);
      reveal(c, gx, y + 10, gw, h - 20);
    }
  }
  woodWin(c, ...R("shopWood"), WOOD, 2, 4, 0.22);
  // 下半分に目隠しのフィルムを貼った窓（2 階の店）
  {
    slideWin(c, ...R("winFilm"), SILVER, {});
    const [x, y, w, h] = R("winFilm");
    c.fillStyle = "rgba(222,226,224,0.72)";
    c.fillRect(x + 21, y + h * 0.5, w / 2 - 29, h * 0.5 - 21);
    c.fillRect(x + w / 2 + 6, y + h * 0.5, w / 2 - 29, h * 0.5 - 21);
  }

  SIGN_TEXT.forEach((t, i) => {
    const x = (i % 4) * 256, y = 512 + Math.floor(i / 4) * 64;
    const [bg, fg] = pairOf(i);
    signCell(c, x, y, 256, 64, t, bg, fg);
  });
  VSIGN_TEXT.forEach((t, i) => {
    const x = 1024 + i * 64, y = 512;
    const [bg, fg] = pairOf(i);
    signCell(c, x, y, 64, 256, t, bg, fg);
  });

  const texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = aniso;
  return { texture, ...atlasLayout() };
}

/** 繰り返す模様の絵（壁・屋根）。kind: mortar = 塗り壁、tile = 小口のタイル、seam = 金属の屋根（縦のはぜ）、lap = 下見板 */
export function patternTexture(kind: "mortar" | "tile" | "seam" | "lap", aniso: number): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const c = cv.getContext("2d")!;
  // 決まった乱数（毎回同じ模様）
  let s = kind.length * 7919 + 13;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  c.fillStyle = "#f4f4f2";
  c.fillRect(0, 0, 256, 256);
  if (kind === "mortar") {
    for (let i = 0; i < 2600; i++) {
      c.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.035)" : "rgba(255,255,255,0.06)";
      c.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 3, 2 + rnd() * 3);
    }
    // 雨だれ（縦の薄いすじ）
    for (let i = 0; i < 10; i++) {
      c.fillStyle = "rgba(60,55,45,0.035)";
      c.fillRect(rnd() * 256, 0, 3 + rnd() * 8, 256);
    }
  } else if (kind === "tile") {
    c.fillStyle = "#c9c9c4";
    c.fillRect(0, 0, 256, 256);
    const tw = 32, th = 16;
    for (let j = 0; j < 16; j++)
      for (let i = -1; i < 8; i++) {
        const v = 0.9 + rnd() * 0.1;
        c.fillStyle = `rgb(${Math.round(250 * v)},${Math.round(249 * v)},${Math.round(246 * v)})`;
        c.fillRect(i * tw + (j % 2 ? tw / 2 : 0) + 1, j * th + 1, tw - 2, th - 2);
      }
  } else if (kind === "seam") {
    for (let i = 0; i < 4; i++) {
      c.fillStyle = "rgba(0,0,0,0.3)";
      c.fillRect(i * 64 + 2, 0, 3, 256);
      c.fillStyle = "rgba(255,255,255,0.3)";
      c.fillRect(i * 64, 0, 2, 256);
    }
    for (let i = 0; i < 900; i++) {
      c.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.04)";
      c.fillRect(rnd() * 256, rnd() * 256, 2, 6 + rnd() * 20);
    }
  } else {
    for (let j = 0; j < 8; j++) {
      const g = c.createLinearGradient(0, j * 32, 0, j * 32 + 32);
      g.addColorStop(0, "rgba(0,0,0,0.34)");
      g.addColorStop(0.12, "rgba(0,0,0,0.05)");
      g.addColorStop(1, "rgba(255,255,255,0.05)");
      c.fillStyle = g;
      c.fillRect(0, j * 32, 256, 32);
    }
    for (let i = 0; i < 700; i++) {
      c.fillStyle = "rgba(0,0,0,0.035)";
      c.fillRect(rnd() * 256, rnd() * 256, 10 + rnd() * 40, 1.5);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}
