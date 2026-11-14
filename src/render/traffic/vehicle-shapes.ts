// 車の形（都市と交通の草案 6.8）。この作品で形を作る（外部の素材は使わない）。車種ごとに 2 つのジオメトリへまとめる:
// - paint: 車体の塗装の部分。色はインスタンスの色
// - fixed: 窓・タイヤ・灯火・バンパーなど、色の決まった部分。頂点色と、灯火の光る量（glow）を持つ
// 原点は車の真下の中心、前が +z。寸法は sim/traffic/vehicle-types.ts と合わせる。
// 胴の形は downhill-3D の carBody（断面を前後に並べて張る）の考え方を写して書き直した。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { VehicleType } from "../../sim/traffic/vehicle-types.ts";

export interface VehicleGeometry {
  paint: THREE.BufferGeometry;
  fixed: THREE.BufferGeometry;
}

/** 断面: z、下の半幅、上の半幅、下端、上端 */
type Section = [number, number, number, number, number];

const GLASS = "#1b2328";
const TIRE = "#15181a";
const TRIM = "#24282b";
const HEAD = "#fff3d2";
const TAIL = "#b5221d";
const PLATE = "#e8e6da";
const BED = "#5d6062";

/** 断面を並べて張った胴（8 角の断面、前後の端を閉じる） */
function loft(sections: Section[]): THREE.BufferGeometry {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const [z, w, wt, y0, y1] of sections) {
    const h = y1 - y0;
    const r = Math.min(0.12, h * 0.25);
    const ring = [
      [-w * 0.94, y0],
      [-w, y0 + Math.min(0.1, h * 0.2)],
      [-w, y1 - r],
      [-wt, y1],
      [wt, y1],
      [w, y1 - r],
      [w, y0 + Math.min(0.1, h * 0.2)],
      [w * 0.94, y0],
    ];
    for (const [x, y] of ring) vertices.push(x, y, z);
  }
  const n = sections.length;
  for (let s = 0; s < n - 1; s++)
    for (let j = 0; j < 8; j++) {
      const a = s * 8 + j;
      const b = s * 8 + ((j + 1) % 8);
      indices.push(a, b + 8, b, a, a + 8, b + 8);
    }
  // 端のふた（後ろは −z 向き、前は +z 向き）
  for (let j = 1; j < 7; j++) {
    indices.push(0, j, j + 1);
    const a = (n - 1) * 8;
    indices.push(a, a + j + 1, a + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  g.setIndex(indices);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

/** 断面の表から、細かく補間した断面の列を作る（上端・下端・幅を直線で補間） */
function profile(keys: Section[], step = 0.15): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const n = Math.max(1, Math.ceil((b[0] - a[0]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push(a.map((v, m) => v + (b[m] - v) * t) as Section);
    }
  }
  out.push(keys[keys.length - 1]);
  return out;
}

function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(cx, cy, cz);
  return g;
}

function wheel(x: number, z: number, r: number, w: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, w, 14, 1).toNonIndexed();
  g.rotateZ(Math.PI / 2);
  g.translate(x, r, z);
  return g;
}

/** 頂点色と光る量を付ける（fixed 用）。uv は使わないので消す */
function tint(g: THREE.BufferGeometry, color: string, glow = 0): THREE.BufferGeometry {
  g.deleteAttribute("uv");
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const gl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    gl[i] = glow;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("glow", new THREE.Float32BufferAttribute(gl, 1));
  return g;
}

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute("uv");
  return g;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list, false);
  if (!g) throw new Error("車の形をまとめられない");
  g.computeBoundingSphere();
  return g;
}

/** 前後の灯火・バンパー・ナンバー（共通） */
function lamps(len: number, hw: number, yHead: number, yTail: number, out: THREE.BufferGeometry[], bumper = true) {
  const zf = len / 2;
  const zr = -len / 2;
  for (const side of [-1, 1]) {
    out.push(tint(box(side * (hw - 0.22), yHead, zf - 0.01, 0.3, 0.1, 0.06), HEAD, 1));
    out.push(tint(box(side * (hw - 0.14), yTail, zr + 0.01, 0.16, 0.2, 0.05), TAIL, 0.45));
  }
  if (bumper) {
    out.push(tint(box(0, 0.42, zf - 0.02, hw * 2 - 0.08, 0.18, 0.08), TRIM));
    out.push(tint(box(0, 0.42, zr + 0.02, hw * 2 - 0.08, 0.18, 0.08), TRIM));
  }
  out.push(tint(box(0, 0.52, zf + 0.025, 0.33, 0.17, 0.02), PLATE));
  out.push(tint(box(0, 0.62, zr - 0.025, 0.33, 0.17, 0.02), PLATE));
}

function wheels(xs: number, zs: number[], r: number, out: THREE.BufferGeometry[], w = 0.2) {
  for (const z of zs)
    for (const side of [-1, 1]) {
      out.push(tint(wheel(side * xs, z, r, w), TIRE));
      // ホイール（外側の面だけ見えればよい）
      const hub = wheel(side * (xs + 0.012), z, r * 0.58, w);
      hub.translate(0, r * 0.42, 0);
      out.push(tint(hub, "#8e9497"));
    }
}

/** 乗用車（セダン） */
function sedan(): VehicleGeometry {
  const hw = 0.88;
  const body = loft(
    profile([
      [-2.3, hw - 0.06, hw - 0.1, 0.36, 0.78],
      [-2.2, hw, hw - 0.04, 0.3, 0.95],
      [-1.4, hw, hw - 0.03, 0.28, 1.0],
      [1.1, hw, hw - 0.03, 0.28, 0.98],
      [1.9, hw, hw - 0.06, 0.28, 0.86],
      [2.3, hw - 0.08, hw - 0.14, 0.34, 0.68],
    ]),
  );
  const cabin = loft(
    profile([
      [-1.45, hw - 0.06, hw - 0.1, 0.96, 1.0],
      [-0.95, hw - 0.08, 0.68, 0.96, 1.4],
      [0.4, hw - 0.08, 0.68, 0.96, 1.43],
      [1.15, hw - 0.06, hw - 0.12, 0.96, 0.99],
    ]),
  );
  const roof = loft(
    profile([
      [-0.92, 0.68, 0.6, 1.39, 1.45],
      [0.38, 0.68, 0.6, 1.42, 1.46],
    ]),
  );
  const fixed: THREE.BufferGeometry[] = [tint(cabin, GLASS)];
  wheels(hw - 0.1, [-1.38, 1.38], 0.32, fixed);
  lamps(4.6, hw, 0.78, 0.86, fixed);
  for (const side of [-1, 1]) fixed.push(tint(box(side * (hw + 0.06), 1.0, 0.85, 0.1, 0.08, 0.14), TRIM));
  return { paint: merge([plain(body), plain(roof)]), fixed: merge(fixed) };
}

/** 背の高い軽自動車（箱型） */
function kei(): VehicleGeometry {
  const hw = 0.74;
  const body = loft(
    profile([
      [-1.7, hw - 0.02, hw - 0.04, 0.3, 0.98],
      [1.25, hw, hw - 0.03, 0.28, 0.98],
      [1.55, hw - 0.02, hw - 0.06, 0.3, 0.86],
      [1.7, hw - 0.06, hw - 0.12, 0.34, 0.72],
    ]),
  );
  const cabin = loft(
    profile([
      [-1.68, hw - 0.03, hw - 0.06, 0.96, 1.7],
      [0.65, hw - 0.03, hw - 0.06, 0.96, 1.72],
      [1.3, hw - 0.03, hw - 0.08, 0.96, 1.0],
    ]),
  );
  const roof = loft(
    profile([
      [-1.7, hw - 0.04, hw - 0.1, 1.66, 1.78],
      [0.62, hw - 0.04, hw - 0.1, 1.68, 1.78],
    ]),
  );
  const paint = [plain(body), plain(roof)];
  // 柱（B・C）
  for (const side of [-1, 1]) {
    paint.push(plain(box(side * (hw - 0.02), 1.33, -1.55, 0.06, 0.74, 0.26)));
    paint.push(plain(box(side * (hw - 0.02), 1.33, -0.1, 0.06, 0.74, 0.12)));
  }
  const fixed: THREE.BufferGeometry[] = [tint(cabin, GLASS)];
  wheels(hw - 0.1, [-1.13, 1.13], 0.29, fixed, 0.18);
  lamps(3.4, hw, 0.82, 0.95, fixed);
  return { paint: merge(paint), fixed: merge(fixed) };
}

/** ミニバン */
function minivan(): VehicleGeometry {
  const hw = 0.9;
  const body = loft(
    profile([
      [-2.35, hw - 0.03, hw - 0.05, 0.32, 1.0],
      [1.4, hw, hw - 0.03, 0.3, 1.0],
      [2.05, hw, hw - 0.06, 0.3, 0.88],
      [2.35, hw - 0.08, hw - 0.14, 0.34, 0.7],
    ]),
  );
  const cabin = loft(
    profile([
      [-2.32, hw - 0.04, hw - 0.1, 0.98, 1.74],
      [0.7, hw - 0.04, hw - 0.1, 0.98, 1.78],
      [1.5, hw - 0.04, hw - 0.12, 0.98, 1.02],
    ]),
  );
  const roof = loft(
    profile([
      [-2.34, hw - 0.06, hw - 0.14, 1.72, 1.85],
      [0.66, hw - 0.06, hw - 0.14, 1.75, 1.85],
    ]),
  );
  const paint = [plain(body), plain(roof)];
  for (const side of [-1, 1]) for (const z of [-2.1, -0.75, 0.25]) paint.push(plain(box(side * (hw - 0.04), 1.36, z, 0.08, 0.76, z < -2 ? 0.3 : 0.12)));
  const fixed: THREE.BufferGeometry[] = [tint(cabin, GLASS)];
  wheels(hw - 0.1, [-1.45, 1.45], 0.33, fixed);
  lamps(4.7, hw, 0.85, 1.0, fixed);
  return { paint: merge(paint), fixed: merge(fixed) };
}

/** 商用バン（前の短い箱型。後ろの横に窓がない） */
function van(): VehicleGeometry {
  const hw = 0.85;
  const body = loft(
    profile([
      [-2.35, hw - 0.02, hw - 0.06, 0.3, 1.94],
      [1.75, hw, hw - 0.06, 0.28, 1.96],
      [2.15, hw, hw - 0.1, 0.3, 1.2],
      [2.35, hw - 0.06, hw - 0.12, 0.34, 0.8],
    ]),
  );
  const fixed: THREE.BufferGeometry[] = [];
  // 前の窓と、運転席の横の窓
  fixed.push(tint(box(0, 1.52, 2.03, hw * 2 - 0.18, 0.62, 0.04), GLASS));
  for (const side of [-1, 1]) fixed.push(tint(box(side * (hw + 0.005), 1.5, 1.2, 0.02, 0.6, 0.95), GLASS));
  wheels(hw - 0.1, [-1.45, 1.35], 0.31, fixed);
  lamps(4.7, hw, 0.9, 1.0, fixed);
  return { paint: merge([plain(body)]), fixed: merge(fixed) };
}

/** 軽トラック */
function keiTruck(): VehicleGeometry {
  const hw = 0.74;
  const cab = loft(
    profile([
      [0.35, hw, hw - 0.04, 0.3, 1.0],
      [1.55, hw, hw - 0.04, 0.3, 1.0],
      [1.7, hw - 0.05, hw - 0.1, 0.34, 0.75],
    ]),
  );
  const cabTop = loft(
    profile([
      [0.37, hw - 0.04, hw - 0.1, 1.0, 1.76],
      [1.25, hw - 0.04, hw - 0.1, 1.0, 1.8],
      [1.58, hw - 0.04, hw - 0.12, 1.0, 1.05],
    ]),
  );
  const paint = [plain(cab)];
  // 荷台のあおり（3 方）
  paint.push(plain(box(0, 0.88, -1.68, hw * 2, 0.32, 0.05)));
  for (const side of [-1, 1]) paint.push(plain(box(side * (hw - 0.025), 0.88, -0.66, 0.05, 0.32, 2.05)));
  // 荷台の後ろの鳥居（運転席の後ろの枠）
  paint.push(plain(box(0, 1.25, 0.31, hw * 2 - 0.04, 0.06, 0.06)));
  const fixed: THREE.BufferGeometry[] = [];
  const top = tint(cabTop, GLASS);
  fixed.push(top);
  // 屋根は塗装（ガラスの上に重ねる）
  paint.push(plain(box(0, 1.79, 0.82, hw * 2 - 0.2, 0.05, 0.86)));
  fixed.push(tint(box(0, 0.7, -0.66, hw * 2 - 0.06, 0.06, 2.05), BED));
  fixed.push(tint(box(0, 0.48, -0.66, hw * 2 - 0.3, 0.3, 2.0), TRIM));
  wheels(hw - 0.1, [-1.0, 1.1], 0.28, fixed, 0.17);
  lamps(3.4, hw, 0.78, 0.8, fixed, false);
  fixed.push(tint(box(0, 0.42, 1.68, hw * 2 - 0.08, 0.16, 0.08), TRIM));
  return { paint: merge(paint), fixed: merge(fixed) };
}

/** 路線バス。車体は白に近い色、帯がインスタンスの色 */
function bus(): VehicleGeometry {
  const hw = 1.245;
  const len = 10.5;
  const zf = len / 2;
  const fixed: THREE.BufferGeometry[] = [];
  const shell = loft(
    profile(
      [
        [-zf, hw - 0.02, hw - 0.12, 0.4, 2.98],
        [zf - 0.25, hw, hw - 0.12, 0.38, 3.05],
        [zf, hw - 0.04, hw - 0.16, 0.42, 2.95],
      ],
      0.6,
    ),
  );
  fixed.push(tint(shell, "#ecebe4"));
  // 横の窓の列、前の大きな窓、後ろの窓
  for (const side of [-1, 1]) {
    fixed.push(tint(box(side * (hw + 0.012), 2.15, -0.6, 0.02, 0.95, 7.6), GLASS));
    // 前の扉（左側は乗降口）
    fixed.push(tint(box(side * (hw + 0.014), 1.45, 4.1, 0.02, 2.0, 0.95), side < 0 ? GLASS : "#d9d8d0"));
  }
  fixed.push(tint(box(0, 1.9, zf + 0.012, hw * 2 - 0.2, 1.55, 0.02), GLASS));
  fixed.push(tint(box(0, 2.25, -zf - 0.012, hw * 2 - 0.5, 0.7, 0.02), GLASS));
  // 行き先の表示（光る）
  fixed.push(tint(box(0, 2.8, zf + 0.02, 1.5, 0.22, 0.02), "#f2a93a", 0.8));
  wheels(hw - 0.15, [-2.6, 3.1], 0.48, fixed, 0.3);
  for (const side of [-1, 1]) {
    fixed.push(tint(box(side * (hw - 0.3), 0.65, zf + 0.01, 0.34, 0.14, 0.06), HEAD, 1));
    fixed.push(tint(box(side * (hw - 0.15), 1.0, -zf - 0.01, 0.18, 0.4, 0.05), TAIL, 0.45));
  }
  fixed.push(tint(box(0, 0.5, zf + 0.02, hw * 2 - 0.1, 0.22, 0.08), TRIM));
  // 帯（腰の高さ）と屋根の縁
  const paint: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    paint.push(plain(box(side * (hw + 0.016), 1.05, -0.2, 0.02, 0.3, 9.9)));
    paint.push(plain(box(side * (hw + 0.016), 2.75, -0.2, 0.02, 0.1, 9.9)));
  }
  paint.push(plain(box(0, 1.05, zf + 0.022, hw * 2 - 0.1, 0.3, 0.02)));
  paint.push(plain(box(0, 1.05, -zf - 0.022, hw * 2 - 0.1, 0.3, 0.02)));
  return { paint: merge(paint), fixed: merge(fixed) };
}

const BUILDERS: Record<VehicleType, () => VehicleGeometry> = { sedan, kei, minivan, van, keiTruck, bus };

const cache = new Map<VehicleType, VehicleGeometry>();
export function vehicleGeometry(type: VehicleType): VehicleGeometry {
  let g = cache.get(type);
  if (!g) cache.set(type, (g = BUILDERS[type]()));
  return g;
}
