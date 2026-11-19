// 北海道の世界の道路標識（北海道の草案 27 章）。置き場所は変換で決める（scripts/hokkaido/signs.ts）。
// 規制標識は 1 枚の絵の表（canvas に描く。外部の素材は使わない）を貼った板と柱を、区画ごとに焼いて 1 つの形につなぐ。
// 案内標識の板は、近い順に 16 枚まで、文字を描いた絵の表（canvas）の枠に描いて 1 つの形にする。描画命令は 2。
// 文字は標識の決まった文字（止まれ・一方通行・数字）と、案内標識の道路名だけ。
// 北海道の草案 28 章: 矢羽根（固定式視線誘導柱）、防雪柵、住宅街の道の停止線も同じ形に焼く。

import * as THREE from "three";
import { type HokkaidoSidewalks, SIGN_REC, SIGN_TYPES } from "../shared/world/hokkaido.ts";
import type { TerrainLike } from "../shared/world/terrain.ts";

/** 規制標識の絵の表: 128px の枠、横 8・縦 4 */
const CELL = 128;
const COLS = 8;
const ROWS = 4;
const SPEEDS = [20, 30, 40, 50, 60, 70, 80];
const CELLS = {
  stop: [0, 0],
  crosswalk: [1, 0],
  onewayRight: [2, 0],
  onewayLeft: [3, 0],
  noEntry: [4, 0],
  white: [5, 0],
  backTriangle: [0, 2],
  backSquare: [1, 2],
  backRect: [2, 2],
  backCircle: [3, 2],
  yabane: [0, 3],
  louver: [1, 3],
} as const;
const speedCell = (v: number): [number, number] => {
  let best = 0;
  SPEEDS.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs(SPEEDS[best] - v)) best = i;
  });
  return [best, 1];
};

const RED = "#c8102e";
const BLUE = "#1d4f9e";
const BACK = "#b9bab6";
const FONT = `"Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif`;

function drawRegulation(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = CELL * COLS;
  cv.height = CELL * ROWS;
  const c = cv.getContext("2d")!;
  const at = ([i, j]: readonly [number, number] | [number, number]) => [i * CELL, j * CELL] as const;
  const tri = (x: number, y: number, inset: number) => {
    // 下向きの正三角形（上の辺が枠の幅）
    const w = CELL - inset * 2;
    const h = w * 0.866;
    const top = y + (CELL - CELL * 0.866) / 2 + inset * 0.5;
    c.beginPath();
    c.moveTo(x + inset, top);
    c.lineTo(x + CELL - inset, top);
    c.lineTo(x + CELL / 2, top + h);
    c.closePath();
  };
  const circle = (x: number, y: number, r: number) => {
    c.beginPath();
    c.arc(x + CELL / 2, y + CELL / 2, r, 0, Math.PI * 2);
  };
  c.textAlign = "center";
  c.textBaseline = "middle";
  // 止まれ
  {
    const [x, y] = at(CELLS.stop);
    c.fillStyle = "#fff";
    tri(x, y, 2);
    c.fill();
    c.fillStyle = RED;
    tri(x, y, 9);
    c.fill();
    c.fillStyle = "#fff";
    c.font = `bold 26px ${FONT}`;
    c.fillText("止まれ", x + CELL / 2, y + CELL * 0.36);
  }
  // 横断歩道（青い正方形に白い三角と人）
  {
    const [x, y] = at(CELLS.crosswalk);
    c.fillStyle = "#fff";
    c.fillRect(x + 4, y + 4, CELL - 8, CELL - 8);
    c.fillStyle = BLUE;
    c.fillRect(x + 9, y + 9, CELL - 18, CELL - 18);
    c.fillStyle = "#fff";
    c.beginPath();
    c.moveTo(x + CELL / 2, y + 18);
    c.lineTo(x + CELL - 18, y + CELL - 22);
    c.lineTo(x + 18, y + CELL - 22);
    c.closePath();
    c.fill();
    c.fillStyle = "#222";
    c.beginPath();
    c.arc(x + CELL / 2 + 2, y + 50, 6, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "#222";
    c.lineWidth = 5;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x + CELL / 2, y + 58);
    c.lineTo(x + CELL / 2 - 3, y + 78);
    c.moveTo(x + CELL / 2 - 3, y + 78);
    c.lineTo(x + CELL / 2 - 12, y + 94);
    c.moveTo(x + CELL / 2 - 3, y + 78);
    c.lineTo(x + CELL / 2 + 10, y + 94);
    c.moveTo(x + CELL / 2 - 12, y + 66);
    c.lineTo(x + CELL / 2 + 12, y + 70);
    c.stroke();
    // 縞
    c.fillStyle = "#222";
    for (let k = 0; k < 5; k++) c.fillRect(x + 30 + k * 15, y + CELL - 32, 8, 6);
  }
  // 一方通行（青い横長の板に白い矢印と文字）。右向きと左向き
  for (const [cellXY, dir] of [
    [CELLS.onewayRight, 1],
    [CELLS.onewayLeft, -1],
  ] as const) {
    const [x, y] = at(cellXY);
    const h = CELL / 3;
    const y0 = y + (CELL - h) / 2;
    c.fillStyle = "#fff";
    c.fillRect(x + 1, y0, CELL - 2, h);
    c.fillStyle = BLUE;
    c.fillRect(x + 4, y0 + 3, CELL - 8, h - 6);
    c.fillStyle = "#fff";
    const cy = y0 + h / 2;
    const tip = dir > 0 ? x + CELL - 10 : x + 10;
    const base = dir > 0 ? x + CELL - 34 : x + 34;
    const tail = dir > 0 ? x + 10 : x + CELL - 10;
    c.beginPath();
    c.moveTo(tail, cy - 8);
    c.lineTo(base, cy - 8);
    c.lineTo(base, cy - 14);
    c.lineTo(tip, cy);
    c.lineTo(base, cy + 14);
    c.lineTo(base, cy + 8);
    c.lineTo(tail, cy + 8);
    c.closePath();
    c.fill();
    c.fillStyle = BLUE;
    c.font = `bold 13px ${FONT}`;
    c.fillText("一方通行", x + CELL / 2 - dir * 10, cy + 1);
  }
  // 車両進入禁止（赤い円に白い横棒）
  {
    const [x, y] = at(CELLS.noEntry);
    c.fillStyle = "#fff";
    circle(x, y, CELL / 2 - 2);
    c.fill();
    c.fillStyle = RED;
    circle(x, y, CELL / 2 - 6);
    c.fill();
    c.fillStyle = "#fff";
    c.fillRect(x + 22, y + CELL / 2 - 10, CELL - 44, 20);
  }
  // 柱など（頂点の色を掛ける白）
  {
    const [x, y] = at(CELLS.white);
    c.fillStyle = "#fff";
    c.fillRect(x, y, CELL, CELL);
  }
  // 最高速度（白い円に赤い輪、青い数字）
  SPEEDS.forEach((v) => {
    const [x, y] = at(speedCell(v));
    c.fillStyle = "#fff";
    circle(x, y, CELL / 2 - 2);
    c.fill();
    c.strokeStyle = RED;
    c.lineWidth = 12;
    circle(x, y, CELL / 2 - 10);
    c.stroke();
    c.fillStyle = BLUE;
    c.font = `bold 52px ${FONT}`;
    c.fillText(String(v), x + CELL / 2, y + CELL / 2 + 3);
  });
  // 矢羽根（下向きの矢印に赤と白の斜めの縞。細長い板に縦に伸ばして貼る）
  {
    const [x, y] = at(CELLS.yabane);
    c.save();
    c.beginPath();
    c.moveTo(x + 8, y + 2);
    c.lineTo(x + CELL - 8, y + 2);
    c.lineTo(x + CELL - 8, y + 86);
    c.lineTo(x + CELL / 2, y + CELL - 2);
    c.lineTo(x + 8, y + 86);
    c.closePath();
    c.clip();
    c.fillStyle = "#fff";
    c.fillRect(x, y, CELL, CELL);
    c.fillStyle = RED;
    for (let k = -4; k < 8; k++) {
      c.beginPath();
      const y0 = y + k * 26;
      c.moveTo(x, y0);
      c.lineTo(x + CELL, y0 + 40);
      c.lineTo(x + CELL, y0 + 53);
      c.lineTo(x, y0 + 13);
      c.closePath();
      c.fill();
    }
    c.restore();
  }
  // 防雪柵の板（横の羽板と、羽板の間のすき間）
  {
    const [x, y] = at(CELLS.louver);
    c.fillStyle = "#7d8186";
    c.fillRect(x, y, 4, CELL);
    c.fillRect(x + CELL - 4, y, 4, CELL);
    for (let k = 0; k < 6; k++) {
      c.fillStyle = "#8e9297";
      c.fillRect(x, y + 4 + k * 21, CELL, 13);
      c.fillStyle = "#6f7378";
      c.fillRect(x, y + 4 + k * 21 + 11, CELL, 2);
    }
  }
  // 裏（灰色の形）
  c.fillStyle = BACK;
  {
    const [x, y] = at(CELLS.backTriangle);
    tri(x, y, 2);
    c.fill();
  }
  {
    const [x, y] = at(CELLS.backSquare);
    c.fillRect(x + 4, y + 4, CELL - 8, CELL - 8);
  }
  {
    const [x, y] = at(CELLS.backRect);
    c.fillRect(x + 1, y + (CELL - CELL / 3) / 2, CELL - 2, CELL / 3);
  }
  {
    const [x, y] = at(CELLS.backCircle);
    circle(x, y, CELL / 2 - 2);
    c.fill();
  }
  return cv;
}

/** 案内標識の絵の表: 512×256 の枠、横 4・縦 4 */
const GW = 512;
const GH = 256;
const GCOLS = 4;
const GSLOTS = 16;

function drawGuide(c: CanvasRenderingContext2D, slot: number, text: [string, string, string]) {
  const x = (slot % GCOLS) * GW;
  const y = Math.floor(slot / GCOLS) * GH;
  c.save();
  c.translate(x, y);
  c.clearRect(0, 0, GW, GH);
  c.fillStyle = "#fff";
  c.fillRect(0, 0, GW, GH);
  c.fillStyle = BLUE;
  c.fillRect(6, 6, GW - 12, GH - 12);
  const [l, s, r] = text;
  // 交差点の形: 下から上への太い線と、左右の腕。矢印の先
  c.fillStyle = "#fff";
  const cx = GW / 2, cy = 150;
  c.fillRect(cx - 12, cy, 24, GH - 20 - cy);
  if (s) {
    c.fillRect(cx - 12, 95, 24, cy - 95 + 12);
    c.beginPath();
    c.moveTo(cx, 70);
    c.lineTo(cx + 26, 100);
    c.lineTo(cx - 26, 100);
    c.closePath();
    c.fill();
  }
  if (l) {
    c.fillRect(cx - 105, cy - 12, 105, 24);
    c.beginPath();
    c.moveTo(cx - 132, cy);
    c.lineTo(cx - 102, cy - 26);
    c.lineTo(cx - 102, cy + 26);
    c.closePath();
    c.fill();
  }
  if (r) {
    c.fillRect(cx, cy - 12, 105, 24);
    c.beginPath();
    c.moveTo(cx + 132, cy);
    c.lineTo(cx + 102, cy - 26);
    c.lineTo(cx + 102, cy + 26);
    c.closePath();
    c.fill();
  }
  // 道路名（幅に収まるよう文字を小さくする）
  const label = (t: string, tx: number, ty: number, maxW: number, align: CanvasTextAlign) => {
    if (!t) return;
    let size = 38;
    c.font = `bold ${size}px ${FONT}`;
    while (size > 18 && c.measureText(t).width > maxW) {
      size -= 2;
      c.font = `bold ${size}px ${FONT}`;
    }
    c.textAlign = align;
    c.textBaseline = "middle";
    c.fillText(t, tx, ty);
  };
  label(s, cx, 40, GW - 40, "center");
  label(l, 18, cy + 52, cx - 40, "left");
  label(r, GW - 18, cy + 52, cx - 40, "right");
  c.restore();
}

/** 頂点の集まり（位置・法線・uv・色） */
class Buf {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  c: number[] = [];
  /** 四角形（a, b, c, d を表から見て反時計回りに） */
  quad(a: number[], b: number[], cc: number[], d: number[], nrm: number[], uv: [number, number, number, number], col: number[]) {
    const [u0, v0, u1, v1] = uv;
    for (const [q, u, v] of [
      [a, u0, v0],
      [b, u1, v0],
      [cc, u1, v1],
      [a, u0, v0],
      [cc, u1, v1],
      [d, u0, v1],
    ] as const) {
      this.p.push(q[0], q[1], q[2]);
      this.n.push(nrm[0], nrm[1], nrm[2]);
      this.uv.push(u, v);
      this.c.push(col[0], col[1], col[2]);
    }
  }
  /** 板: 中心 (x, y, z)、表の向き (nx, nz)、幅・高さ。表から見た右は (nz, −nx) */
  plate(x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, uv: [number, number, number, number], col = WHITE) {
    const rx = nz * (w / 2), rz = -nx * (w / 2);
    this.quad([x - rx, y - h / 2, z - rz], [x + rx, y - h / 2, z + rz], [x + rx, y + h / 2, z + rz], [x - rx, y + h / 2, z - rz], [nx, 0, nz], uv, col);
  }
  /** 四角柱（側面だけ）。底の中心 (x, y, z)、幅 w・奥行き d（向き (fx, fz) に沿って d）、高さ h */
  prism(x: number, y: number, z: number, fx: number, fz: number, w: number, d: number, h: number, col: number[], uv: [number, number, number, number]) {
    const ax = fx * (d / 2), az = fz * (d / 2);
    const bx = fz * (w / 2), bz = -fx * (w / 2);
    const corners = [
      [x + ax + bx, z + az + bz],
      [x - ax + bx, z - az + bz],
      [x - ax - bx, z - az - bz],
      [x + ax - bx, z + az - bz],
    ];
    for (let i = 0; i < 4; i++) {
      const [p0x, p0z] = corners[i];
      const [p1x, p1z] = corners[(i + 1) % 4];
      // 角の並びは上から見て時計回りなので、外向きは辺の向きを左へ 90 度
      let nx = -(p1z - p0z), nz = p1x - p0x;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      this.quad([p0x, y, p0z], [p1x, y, p1z], [p1x, y + h, p1z], [p0x, y + h, p0z], [nx, 0, nz], uv, col);
    }
  }
  /** 水平の角材: 始点 (x, y, z) から向き (dx, dz) へ長さ len、断面 s */
  beam(x: number, y: number, z: number, dx: number, dz: number, len: number, s: number, col: number[], uv: [number, number, number, number]) {
    const mx = x + dx * (len / 2), mz = z + dz * (len / 2);
    // 側面 2 枚と上下 2 枚
    const px = -dz * (s / 2), pz = dx * (s / 2);
    const a0 = [mx - dx * (len / 2), mz - dz * (len / 2)], a1 = [mx + dx * (len / 2), mz + dz * (len / 2)];
    this.quad([a0[0] + px, y - s / 2, a0[1] + pz], [a1[0] + px, y - s / 2, a1[1] + pz], [a1[0] + px, y + s / 2, a1[1] + pz], [a0[0] + px, y + s / 2, a0[1] + pz], [-dz, 0, dx], uv, col);
    this.quad([a1[0] - px, y - s / 2, a1[1] - pz], [a0[0] - px, y - s / 2, a0[1] - pz], [a0[0] - px, y + s / 2, a0[1] - pz], [a1[0] - px, y + s / 2, a1[1] - pz], [dz, 0, -dx], uv, col);
    this.quad([a0[0] + px, y + s / 2, a0[1] + pz], [a1[0] + px, y + s / 2, a1[1] + pz], [a1[0] - px, y + s / 2, a1[1] - pz], [a0[0] - px, y + s / 2, a0[1] - pz], [0, 1, 0], uv, col);
    this.quad([a0[0] - px, y - s / 2, a0[1] - pz], [a1[0] - px, y - s / 2, a1[1] - pz], [a1[0] + px, y - s / 2, a1[1] + pz], [a0[0] + px, y - s / 2, a0[1] + pz], [0, -1, 0], uv, col);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = [1, 1, 1];
const POST = [0.6, 0.61, 0.6];
const GUIDE_BACK = [0.55, 0.56, 0.55];
const FENCE_POST = [0.5, 0.52, 0.54];
/** 住宅街の道の路面の上げ（city-build.ts の STREET_LIFT と、折れ線ごとのずらしの最大）より少し上 */
const STOP_LINE_LIFT = 0.075;

/** 規制標識の絵の表の枠の uv（少し内側。v は下が 0） */
function cellUv([i, j]: readonly [number, number] | [number, number]): [number, number, number, number] {
  const e = 1.5;
  return [(i * CELL + e) / (CELL * COLS), 1 - ((j + 1) * CELL - e) / (CELL * ROWS), ((i + 1) * CELL - e) / (CELL * COLS), 1 - (j * CELL + e) / (CELL * ROWS)];
}
const WHITE_UV = (() => {
  const [u0, v0, u1, v1] = cellUv(CELLS.white);
  const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
  return [u, v, u, v] as [number, number, number, number];
})();

interface CellBake {
  bx: number;
  bz: number;
  p: Float32Array;
  n: Float32Array;
  uv: Float32Array;
  c: Float32Array;
  count: number;
  provisional: boolean;
}

export class RealSigns {
  readonly group = new THREE.Group();
  /** 規制標識と案内標識を描く範囲 (m)【初期値】 */
  range = 300;
  guideRange = 450;
  readonly material: THREE.MeshStandardMaterial;
  readonly guideMaterial: THREE.MeshStandardMaterial;
  private readonly guideCanvas: HTMLCanvasElement;
  private readonly guideTexture: THREE.CanvasTexture;
  /** 案内標識の文字の番号 → 絵の表の枠 */
  private slots = new Map<number, number>();
  private objects: THREE.Mesh[] = [];
  private readonly cellCache = new Map<string, CellBake>();
  private key = "";
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  private at = { x: 0, z: 0 };
  stats = { signs: 0, guides: 0 };
  readonly buildMs: number[] = [];

  constructor(
    private data: HokkaidoSidewalks,
    private heights: TerrainLike,
    private terrainReady: (x: number, z: number) => boolean = () => true,
    anisotropy = 1,
  ) {
    this.group.name = "real-signs";
    const reg = new THREE.CanvasTexture(drawRegulation());
    reg.colorSpace = THREE.SRGBColorSpace;
    reg.anisotropy = anisotropy;
    this.material = new THREE.MeshStandardMaterial({ map: reg, vertexColors: true, roughness: 0.6, alphaTest: 0.5 });
    this.guideCanvas = document.createElement("canvas");
    this.guideCanvas.width = GW * GCOLS;
    this.guideCanvas.height = GH * (GSLOTS / GCOLS);
    this.guideTexture = new THREE.CanvasTexture(this.guideCanvas);
    this.guideTexture.colorSpace = THREE.SRGBColorSpace;
    this.guideTexture.anisotropy = anisotropy;
    this.guideMaterial = new THREE.MeshStandardMaterial({ map: this.guideTexture, roughness: 0.6 });
  }

  setQuality(light: boolean) {
    this.range = light ? 180 : 300;
    this.guideRange = light ? 300 : 450;
    this.key = "";
    this.lastT = 0;
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const o of this.objects) o.position.set(this.at.x - x, 0, this.at.z - z);
  }

  private cellsWithin(cx: number, cz: number, range: number): string[] {
    const C = this.data.index.cell;
    const out: string[] = [];
    for (let i = Math.floor((cx - range) / C); i <= Math.floor((cx + range) / C); i++)
      for (let j = Math.floor((cz - range) / C); j <= Math.floor((cz + range) / C); j++) {
        const dx = Math.max(i * C - cx, 0, cx - (i + 1) * C);
        const dz = Math.max(j * C - cz, 0, cz - (j + 1) * C);
        if (dx * dx + dz * dz > range * range) continue;
        if (this.data.index.signs[`${i},${j}`]) out.push(`${i},${j}`);
      }
    return out.sort();
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 300) return;
    this.lastT = now;
    const cells = this.cellsWithin(cx, cz, this.range);
    const gcells = this.cellsWithin(cx, cz, this.guideRange);
    const C = this.data.index.cell;
    let pending = 0;
    for (const k of cells) {
      const b = this.cellCache.get(k);
      if (b?.provisional && this.terrainReady(b.bx + C / 2, b.bz + C / 2)) pending++;
    }
    // 案内標識は近い順に枠へ入れるので、50m 動くごとに見直す
    const key = `${cells.join("|")}#${gcells.join("|")}#${Math.round(cx / 50)},${Math.round(cz / 50)}`;
    if (key === this.key && !pending) return;
    this.key = key;
    this.rebuild(cells, gcells, cx, cz, Math.round(cx / 256) * 256, Math.round(cz / 256) * 256);
  }

  /** 区画 1 つの規制標識と、案内標識の柱・腕・裏を焼き込む（区画の隅からの相対） */
  private bake(k: string): CellBake {
    const C = this.data.index.cell;
    const old = this.cellCache.get(k);
    if (old && !(old.provisional && this.terrainReady(old.bx + C / 2, old.bz + C / 2))) return old;
    const [ci, cj] = k.split(",").map(Number);
    const bx = ci * C, bz = cj * C;
    const provisional = !this.terrainReady(bx + C / 2, bz + C / 2);
    const D = this.data.signs;
    const b = new Buf();
    let count = 0;
    for (const t of this.data.index.signs[k]) {
      const o = t * SIGN_REC;
      const wx = D[o], wz = D[o + 2];
      const y = Number.isNaN(D[o + 1]) ? this.heights.height(wx, wz) : D[o + 1];
      const x = wx - bx, z = wz - bz;
      const fx = D[o + 3], fz = D[o + 4];
      const type = D[o + 5];
      count++;
      if (type === SIGN_TYPES.yabane) {
        // 柱（路肩の外）と、道の方への腕、道の端の上に下がる矢印（両面。板は道に沿う向きに見える）
        const reach = D[o + 7];
        b.prism(x, y - 0.3, z, fx, fz, 0.08, 0.08, 5.6, POST, WHITE_UV);
        b.beam(x, y + 5.2, z, fx, fz, reach + 0.12, 0.06, POST, WHITE_UV);
        const ax = x + fx * reach, az = z + fz * reach;
        b.plate(ax, y + 4.6, az, -fz, fx, 0.42, 1.1, cellUv(CELLS.yabane));
        b.plate(ax, y + 4.6, az, fz, -fx, 0.42, 1.1, cellUv(CELLS.yabane));
        continue;
      }
      if (type === SIGN_TYPES.fence) {
        // 1 枚: (x, z) から (fx, fz) へ値 m。下を 0.9m あけ、高さ 3.1m（両面）。始めに柱
        const L = D[o + 6];
        const x1 = x + fx * L, z1 = z + fz * L;
        const y1 = this.heights.height(wx + fx * L, wz + fz * L);
        const uv = cellUv(CELLS.louver);
        const a0 = [x, y + 0.9, z], a1 = [x1, y1 + 0.9, z1], t1 = [x1, y1 + 4, z1], t0 = [x, y + 4, z];
        b.quad(a0, a1, t1, t0, [-fz, 0, fx], uv, WHITE);
        b.quad(a1, a0, t0, t1, [fz, 0, -fx], [uv[2], uv[1], uv[0], uv[3]], WHITE);
        b.prism(x, y - 0.3, z, fx, fz, 0.12, 0.12, 4.4, FENCE_POST, WHITE_UV);
        continue;
      }
      if (type === SIGN_TYPES.stopLine) {
        // 道の幅いっぱい（両端 0.2m あける）、進む向きに 0.45m の白い線
        const hw = Math.max(0.5, D[o + 6] / 2 - 0.2), hd = 0.225;
        const rx = -fz, rz = fx;
        const yl = y + STOP_LINE_LIFT;
        b.quad(
          [x - rx * hw - fx * hd, yl, z - rz * hw - fz * hd],
          [x + rx * hw - fx * hd, yl, z + rz * hw - fz * hd],
          [x + rx * hw + fx * hd, yl, z + rz * hw + fz * hd],
          [x - rx * hw + fx * hd, yl, z - rz * hw + fz * hd],
          [0, 1, 0],
          WHITE_UV,
          WHITE,
        );
        continue;
      }
      if (type === SIGN_TYPES.guide) {
        // 柱・道の上へ張り出す腕・板の裏（板の表は案内標識の形）
        const ax = fz, az = -fx;
        const reach = D[o + 7];
        b.prism(x, y - 0.3, z, fx, fz, 0.22, 0.22, 7.5, POST, WHITE_UV);
        b.beam(x, y + 6.95, z, ax, az, reach + 1.6, 0.16, POST, WHITE_UV);
        b.beam(x, y + 5.15, z, ax, az, reach + 1.6, 0.12, POST, WHITE_UV);
        const gx = x + ax * reach + fx * 0.1, gz = z + az * reach + fz * 0.1;
        b.plate(gx - fx * 0.03, y + 6.05, gz - fz * 0.03, -fx, -fz, 3.6, 1.8, WHITE_UV, GUIDE_BACK);
        continue;
      }
      // 柱
      b.prism(x, y - 0.3, z, fx, fz, 0.06, 0.06, 2.95, POST, WHITE_UV);
      const px = x + fx * 0.05, pz = z + fz * 0.05;
      if (type === SIGN_TYPES.stop) {
        b.plate(px, y + 2.25, pz, fx, fz, 0.8, 0.8, cellUv(CELLS.stop));
        b.plate(px - fx * 0.01, y + 2.25, pz - fz * 0.01, -fx, -fz, 0.8, 0.8, mirror(cellUv(CELLS.backTriangle)));
      } else if (type === SIGN_TYPES.crosswalk) {
        // 両面
        b.plate(px, y + 2.35, pz, fx, fz, 0.6, 0.6, cellUv(CELLS.crosswalk));
        b.plate(x - fx * 0.05, y + 2.35, z - fz * 0.05, -fx, -fz, 0.6, 0.6, cellUv(CELLS.crosswalk));
      } else if (type === SIGN_TYPES.noEntry) {
        b.plate(px, y + 2.3, pz, fx, fz, 0.6, 0.6, cellUv(CELLS.noEntry));
        b.plate(px - fx * 0.01, y + 2.3, pz - fz * 0.01, -fx, -fz, 0.6, 0.6, cellUv(CELLS.backCircle));
      } else if (type === SIGN_TYPES.speed) {
        b.plate(px, y + 2.3, pz, fx, fz, 0.6, 0.6, cellUv(speedCell(D[o + 6])));
        b.plate(px - fx * 0.01, y + 2.3, pz - fz * 0.01, -fx, -fz, 0.6, 0.6, cellUv(CELLS.backCircle));
      } else if (type === SIGN_TYPES.oneway) {
        // 板は道に沿う。表 (−fz, fx) から見ると右が矢印の向き、裏から見ると左
        const nx = -fz, nz = fx;
        b.plate(x + nx * 0.05, y + 2.0, z + nz * 0.05, nx, nz, 0.9, 0.9, cellUv(CELLS.onewayRight));
        b.plate(x - nx * 0.05, y + 2.0, z - nz * 0.05, -nx, -nz, 0.9, 0.9, cellUv(CELLS.onewayLeft));
      }
    }
    const bake: CellBake = { bx, bz, p: Float32Array.from(b.p), n: Float32Array.from(b.n), uv: Float32Array.from(b.uv), c: Float32Array.from(b.c), count, provisional };
    this.cellCache.delete(k);
    this.cellCache.set(k, bake);
    if (this.cellCache.size > 600) {
      let drop = this.cellCache.size - 400;
      for (const key of this.cellCache.keys()) {
        if (drop-- <= 0) break;
        this.cellCache.delete(key);
      }
    }
    return bake;
  }

  private rebuild(cells: string[], gcells: string[], cx: number, cz: number, ox: number, oz: number) {
    const t0 = performance.now();
    for (const o of this.objects) {
      this.group.remove(o);
      o.geometry.dispose();
    }
    this.objects = [];
    this.at = { x: ox, z: oz };
    // 規制標識と案内標識の柱など（案内標識の柱は案内標識の範囲の区画も焼く）
    const all = [...new Set([...cells, ...gcells])];
    const bakes = all.map((k) => this.bake(k));
    let nv = 0;
    let signs = 0;
    for (const b of bakes) {
      nv += b.p.length / 3;
      signs += b.count;
    }
    if (nv) {
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), Cl = new Float32Array(nv * 3);
      let v = 0;
      for (const b of bakes) {
        const dx = b.bx - ox, dz = b.bz - oz;
        const n = b.p.length / 3;
        for (let i = 0; i < n; i++) {
          P[(v + i) * 3] = b.p[i * 3] + dx;
          P[(v + i) * 3 + 1] = b.p[i * 3 + 1];
          P[(v + i) * 3 + 2] = b.p[i * 3 + 2] + dz;
        }
        N.set(b.n, v * 3);
        UV.set(b.uv, v * 2);
        Cl.set(b.c, v * 3);
        v += n;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(P, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(UV, 2));
      g.setAttribute("color", new THREE.BufferAttribute(Cl, 3));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.material);
      m.name = "real-signs";
      this.objects.push(m);
    }
    // 案内標識の板: 近い順に枠へ
    const D = this.data.signs;
    const list: { o: number; d: number; gi: number }[] = [];
    for (const k of gcells)
      for (const t of this.data.index.signs[k]) {
        const o = t * SIGN_REC;
        if (D[o + 5] !== SIGN_TYPES.guide) continue;
        list.push({ o, d: Math.hypot(D[o] - cx, D[o + 2] - cz), gi: D[o + 6] });
      }
    list.sort((a, b) => a.d - b.d);
    const shown = list.slice(0, GSLOTS);
    const keep = new Set(shown.map((q) => q.gi));
    for (const gi of [...this.slots.keys()]) if (!keep.has(gi)) this.slots.delete(gi);
    const used = new Set(this.slots.values());
    const ctx = this.guideCanvas.getContext("2d")!;
    let drew = false;
    for (const q of shown) {
      if (this.slots.has(q.gi)) continue;
      let s = 0;
      while (used.has(s)) s++;
      used.add(s);
      this.slots.set(q.gi, s);
      drawGuide(ctx, s, this.data.guides[q.gi] ?? ["", "", ""]);
      drew = true;
    }
    if (drew) this.guideTexture.needsUpdate = true;
    if (shown.length) {
      const b = new Buf();
      for (const q of shown) {
        const o = q.o;
        const y = Number.isNaN(D[o + 1]) ? this.heights.height(D[o], D[o + 2]) : D[o + 1];
        const fx = D[o + 3], fz = D[o + 4];
        const ax = fz, az = -fx;
        const reach = D[o + 7];
        const s = this.slots.get(q.gi)!;
        const W = GW * GCOLS, H = GH * (GSLOTS / GCOLS);
        const u0 = ((s % GCOLS) * GW) / W, u1 = ((s % GCOLS) * GW + GW) / W;
        const v1 = 1 - (Math.floor(s / GCOLS) * GH) / H, v0 = 1 - (Math.floor(s / GCOLS) * GH + GH) / H;
        b.plate(D[o] - ox + ax * reach + fx * 0.1, y + 6.05, D[o + 2] - oz + az * reach + fz * 0.1, fx, fz, 3.6, 1.8, [u0, v0, u1, v1]);
      }
      const m = new THREE.Mesh(b.geometry(), this.guideMaterial);
      m.name = "real-signs:guide";
      this.objects.push(m);
    }
    for (const o of this.objects) {
      o.position.set(ox - this.originX, 0, oz - this.originZ);
      this.group.add(o);
    }
    this.stats = { signs, guides: shown.length };
    this.buildMs.push(performance.now() - t0);
    if (this.buildMs.length > 200) this.buildMs.splice(0, 100);
  }
}

/** uv を左右反対に（裏の形を表と重ねる。三角は左右対称なので見た目は同じ） */
function mirror(uv: [number, number, number, number]): [number, number, number, number] {
  return [uv[2], uv[1], uv[0], uv[3]];
}
