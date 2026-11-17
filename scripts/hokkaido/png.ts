// 地理院の標高タイル（PNG）の復号（北海道の草案 3.2）。ライブラリを足さず、Node.js の zlib だけで読む。
// 対応: 8 ビット、インターレースなし、色の型 2（RGB）・6（RGBA）・3（パレット）。

import { inflateSync } from "node:zlib";

export interface RgbImage {
  width: number;
  height: number;
  /** 画素ごとに R, G, B */
  rgb: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(buf: Uint8Array): RgbImage {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIGNATURE[i]) throw new Error("PNG ではない");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const depth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (depth !== 8 || interlace !== 0 || ![2, 3, 6].includes(colorType)) {
        throw new Error(`対応していない PNG（ビット ${depth}、色の型 ${colorType}、インターレース ${interlace}）`);
      }
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * bpp);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`PNG の行の型 ${f}`);
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      const k = out[i] * 3;
      rgb[i * 3] = palette![k];
      rgb[i * 3 + 1] = palette![k + 1];
      rgb[i * 3 + 2] = palette![k + 2];
    } else {
      rgb[i * 3] = out[i * bpp];
      rgb[i * 3 + 1] = out[i * bpp + 1];
      rgb[i * 3 + 2] = out[i * bpp + 2];
    }
  }
  return { width, height, rgb };
}

/** 欠けた画素 */
export const DEM_MISSING = Number.NaN;

/**
 * 標高タイルの画素 → 標高 (m)。x = R·2¹⁶ + G·2⁸ + B。
 * x < 2²³ なら x·0.01、x = 2²³ は欠け、x > 2²³ なら (x − 2²⁴)·0.01（地理院タイル一覧の標高タイルの説明）。
 */
export function demHeights(img: RgbImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = img.rgb[i * 3] * 65536 + img.rgb[i * 3 + 1] * 256 + img.rgb[i * 3 + 2];
    out[i] = x === 8388608 ? DEM_MISSING : (x < 8388608 ? x : x - 16777216) * 0.01;
  }
  return out;
}
