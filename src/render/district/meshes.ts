// 街区の描画: 区画道路と路地の路面、路側の線、側溝、歩道と縁石、敷地の地面、電柱と電線、街路樹。
// 配置は layout.ts が決め、ここでは町ごとに材質別の 1 メッシュへまとめる（描画命令は 1 つの町で 7）。
// 建物は buildings.ts が描く。高さはすべて造成した面（surface）からの相対。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Towns } from "../towns.ts";
import type { P2 } from "./geom.ts";
import { type DistrictLayout, type LotUse, Y_LOT, Y_STREET, Y_WALK } from "./layout.ts";

type Rgb = [number, number, number];
type V3 = [number, number, number];
const hex = (h: string): Rgb => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};

const C_STREET: Rgb = [1, 1, 1];
const C_ALLEY: Rgb = [1.1, 1.08, 1.04];
const C_LINE = hex("#e9e9e4");
const C_GUTTER = hex("#b9b8b2");
const C_CURB = hex("#c4c2bc");
const C_WALK = hex("#ffffff");
const C_SKIRT = hex("#8e8c86");
const C_PIT = hex("#4a3b2c");
const C_POLE = hex("#9a9892");
const C_ARM = hex("#6f7275");
const C_TRANS = hex("#8d9094");
const C_LAMP = hex("#dfe3e6");
const LOT_COLOR: Record<LotUse, Rgb | null> = {
  shop: hex("#a9a7a1"),
  house: hex("#a09c8e"),
  apartment: hex("#8f8f8c"),
  parking: hex("#6a6a68"),
  field: hex("#6f7a45"),
  green: hex("#66803f"),
  vacant: null,
  reserved: null,
};
const C_FIELD_SOIL = hex("#6b5740");
const HOUSE_GROUND = ["#a09c8e", "#7f8a5c", "#a09c8e", "#8d8270", "#788656", "#aeaca6", "#9a9686"].map(hex);

/** 材質ごとの頂点の集まり。位置は町の中心からの相対、uv は平面（x, z）を scale で割ったもの */
class Geo {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  constructor(private scale: number) {}
  /** 平らな多角形（凸）。up が真なら上向き、偽なら out の向きを表にする */
  poly(p: V3[], c: Rgb, out: V3 = [0, 1, 0]) {
    const a = p[0], b = p[1], d = p[p.length - 1];
    let nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
    let ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    let nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const base = this.pos.length / 3;
    const vertical = Math.abs(ny) < 0.5;
    for (const q of p) {
      this.pos.push(q[0], q[1], q[2]);
      this.nor.push(nx, ny, nz);
      // 立った面は、面に沿う向きと高さを uv にする
      if (vertical) this.uv.push((q[0] * -nz + q[2] * nx) / this.scale, q[1] / this.scale);
      else this.uv.push(q[0] / this.scale, q[2] / this.scale);
      this.col.push(c[0], c[1], c[2]);
    }
    for (let i = 1; i < p.length - 1; i++) {
      if (flip) this.idx.push(base, base + i + 1, base + i);
      else this.idx.push(base, base + i, base + i + 1);
    }
  }
  /** 中心 (x, y, z)、軸 X（水平の単位ベクトル）に沿う幅 w、高さ h、奥行き d の箱 */
  box(x: number, y: number, z: number, ax: number, az: number, w: number, h: number, d: number, c: Rgb) {
    const bx = -az, bz = ax;
    const at = (a: number, b: number, yy: number): V3 => [x + ax * a + bx * b, yy, z + az * a + bz * b];
    const hw = w / 2, hd = d / 2, y0 = y - h / 2, y1 = y + h / 2;
    this.poly([at(-hw, hd, y0), at(hw, hd, y0), at(hw, hd, y1), at(-hw, hd, y1)], c, [bx, 0, bz]);
    this.poly([at(-hw, -hd, y0), at(hw, -hd, y0), at(hw, -hd, y1), at(-hw, -hd, y1)], c, [-bx, 0, -bz]);
    this.poly([at(hw, -hd, y0), at(hw, hd, y0), at(hw, hd, y1), at(hw, -hd, y1)], c, [ax, 0, az]);
    this.poly([at(-hw, -hd, y0), at(-hw, hd, y0), at(-hw, hd, y1), at(-hw, -hd, y1)], c, [-ax, 0, -az]);
    this.poly([at(-hw, -hd, y1), at(hw, -hd, y1), at(hw, hd, y1), at(-hw, hd, y1)], c);
  }
  /** 鉛直の柱（n 角形）。下の半径 r0、上の半径 r1 */
  column(x: number, y0: number, z: number, h: number, r0: number, r1: number, c: Rgb, n = 6) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.poly([[x + c0 * r0, y0, z + s0 * r0], [x + c1 * r0, y0, z + s1 * r0], [x + c1 * r1, y0 + h, z + s1 * r1], [x + c0 * r1, y0 + h, z + s0 * r1]], c, [(c0 + c1) / 2, 0, (s0 + s1) / 2]);
    }
  }
  get triangles() {
    return this.idx.length / 3;
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** 種付きの乱数（模様の画像用） */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, rand: () => number) => void, seed: number, aniso: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, lcg(seed));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

/** 歩道の舗装（インターロッキングの石張り、1 枚 2.4m 四方） */
function paverTexture(aniso: number) {
  return canvasTexture(256, (ctx, rand) => {
    ctx.fillStyle = "#8f8a80";
    ctx.fillRect(0, 0, 256, 256);
    const bw = 32, bh = 16;
    for (let j = 0; j < 256 / bh; j++)
      for (let i = -1; i < 256 / bw; i++) {
        const v = 168 + Math.floor(rand() * 34);
        const warm = rand() < 0.3 ? 10 : 0;
        ctx.fillStyle = `rgb(${v + warm},${v},${v - 8 - warm})`;
        ctx.fillRect(i * bw + (j % 2 ? bw / 2 : 0) + 1, j * bh + 1, bw - 2, bh - 2);
      }
  }, 7781, aniso);
}

/** コンクリート・土の細かいむら（1 枚 3m 四方） */
function speckleTexture(aniso: number) {
  return canvasTexture(128, (ctx, rand) => {
    const img = ctx.createImageData(128, 128);
    for (let i = 0; i < 128 * 128; i++) {
      const v = 205 + Math.floor(rand() * 50);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, 4409, aniso);
}

interface Entry {
  group: THREE.Group;
  x: number;
  z: number;
  triangles: number;
}

export class DistrictMeshes {
  readonly group = new THREE.Group();
  private entries = new Map<string, Entry>();
  private asphalt: THREE.MeshStandardMaterial;
  private ground: THREE.MeshStandardMaterial;
  private walk: THREE.MeshStandardMaterial;
  private props = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  private wire = new THREE.LineBasicMaterial({ color: "#26282a", transparent: true, opacity: 0.6 });
  private treeMat: THREE.MeshBasicMaterial;
  private treeGeo: THREE.BufferGeometry;
  private originX = 0;
  private originZ = 0;
  private lastT = 0;
  range = 1800;
  stats = { districts: 0, triangles: 0, buildMs: 0 };

  /** paved は道路の路面の材質（同じ写真素材を使う）、lines は区画線の材質 */
  constructor(
    private towns: Towns,
    paved: THREE.MeshStandardMaterial,
    private lines: THREE.Material,
    aniso: number,
  ) {
    this.group.name = "districts";
    this.asphalt = paved.clone();
    // 幹線の路面（−1, −2）より弱くして、重なる所では幹線を手前にする
    this.asphalt.polygonOffsetFactor = -0.5;
    this.asphalt.polygonOffsetUnits = -1;
    this.ground = new THREE.MeshStandardMaterial({ vertexColors: true, map: speckleTexture(aniso), roughness: 0.95 });
    this.walk = new THREE.MeshStandardMaterial({ vertexColors: true, map: paverTexture(aniso), roughness: 0.9 });
    const tex = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}assets/nature/tree_small_02_billboard.png`);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.treeMat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, color: "#c9d6c0" });
    const a = new THREE.PlaneGeometry(4.92128, 4.92128).translate(0, 2.27837, 0);
    this.treeGeo = mergeGeometries([a.clone(), a.clone().rotateY(Math.PI / 3), a.clone().rotateY((Math.PI * 2) / 3)])!;
  }

  get materials(): THREE.Material[] {
    return [this.asphalt, this.ground, this.walk, this.props];
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    for (const e of this.entries.values()) e.group.position.set(e.x - x, 0, e.z - z);
  }

  setQuality(light: boolean) {
    this.range = light ? 1000 : 1800;
  }

  setDaylight(k: number) {
    this.treeMat.color.set("#c9d6c0").multiplyScalar(k);
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 400) return;
    this.lastT = now;
    const want = new Set<string>();
    for (const t of this.towns.townsNear(cx, cz, this.range)) {
      if (!t.district) continue;
      want.add(t.node);
      if (this.entries.has(t.node)) continue;
      const t0 = performance.now();
      const e = this.build(t.district);
      this.stats.buildMs = performance.now() - t0;
      e.group.position.set(e.x - this.originX, 0, e.z - this.originZ);
      this.group.add(e.group);
      this.entries.set(t.node, e);
    }
    for (const [id, e] of this.entries) {
      if (want.has(id)) continue;
      this.group.remove(e.group);
      e.group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
      });
      this.entries.delete(id);
    }
    this.stats.districts = this.entries.size;
    this.stats.triangles = [...this.entries.values()].reduce((s, e) => s + e.triangles, 0);
  }

  private build(L: DistrictLayout): Entry {
    const { plan } = L;
    const ox = plan.cx, oz = plan.cz;
    const asphalt = new Geo(4), lines = new Geo(1), ground = new Geo(3), walk = new Geo(2.4), props = new Geo(1);
    const P = (x: number, z: number, dy: number): V3 => [x - ox, L.height(x, z) + dy, z - oz];
    const degree = L.graph.degree;
    const junctions = L.graph.nodes.filter((_, i) => degree[i] >= 3);
    const nearJunction = (x: number, z: number, r: number) => junctions.some((j) => Math.hypot(j[0] - x, j[1] - z) < r);

    // 区画道路・路地の路面と路側の線
    for (const run of L.runs) {
      const st = plan.streets[run.street];
      if (st.kind === "arterial") continue;
      const hw = st.width / 2;
      const pts = resample(run.pts, 4, run.trim[0], run.trim[1], run.trim[0] > 0 ? 0 : hw, run.trim[1] > 0 ? 0 : hw);
      const col = st.kind === "alley" ? C_ALLEY : C_STREET;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        // 水際には作らない
        if (!L.dry(a.x, a.z) || !L.dry(b.x, b.z)) continue;
        const al: V3 = P(a.x - a.tz * hw, a.z + a.tx * hw, Y_STREET), ar: V3 = P(a.x + a.tz * hw, a.z - a.tx * hw, Y_STREET);
        const bl: V3 = P(b.x - b.tz * hw, b.z + b.tx * hw, Y_STREET), br: V3 = P(b.x + b.tz * hw, b.z - b.tx * hw, Y_STREET);
        const am: V3 = P(a.x, a.z, Y_STREET), bm: V3 = P(b.x, b.z, Y_STREET);
        asphalt.poly([al, am, bm, bl], col);
        asphalt.poly([am, ar, br, bm], col);
        // 路側の線（幅 5m 以上の通り。交差点の近くは引かない）
        if (st.width >= 5 && !nearJunction((a.x + b.x) / 2, (a.z + b.z) / 2, 6.5))
          for (const sd of [-1, 1]) {
            const o0 = sd * (hw - 0.75), o1 = sd * (hw - 0.6);
            lines.poly([P(a.x - a.tz * o0, a.z + a.tx * o0, Y_STREET + 0.012), P(a.x - a.tz * o1, a.z + a.tx * o1, Y_STREET + 0.012), P(b.x - b.tz * o1, b.z + b.tx * o1, Y_STREET + 0.012), P(b.x - b.tz * o0, b.z + b.tx * o0, Y_STREET + 0.012)], C_LINE);
          }
      }
    }

    // 街区の縁: 幹線沿いは縁石と歩道、区画道路沿いは側溝
    for (const b of L.blocks) {
      if (!b.curb || !b.lotLine) continue;
      const C = b.curb.poly, n = C.length;
      for (let k = 0; k < n; k++) {
        const e = b.curb.edges[k];
        const st = plan.streets[b.streets[e]];
        if (st.kind === "edge") continue;
        const c0 = C[k], c1 = C[(k + 1) % n];
        const len = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
        if (len < 0.05 || !L.dry(c0[0], c0[1]) || !L.dry(c1[0], c1[1])) continue;
        // 街区の外（車道の側）の向き
        const ox2 = (c1[1] - c0[1]) / len, oz2 = -(c1[0] - c0[0]) / len;
        if (st.sidewalk > 0) {
          const k2 = b.lotLine.edges.indexOf(e);
          if (k2 < 0) continue;
          const l0 = b.lotLine.poly[k2], l1 = b.lotLine.poly[(k2 + 1) % b.lotLine.poly.length];
          const f = 0.18 / st.sidewalk;
          const m0: P2 = [c0[0] + (l0[0] - c0[0]) * f, c0[1] + (l0[1] - c0[1]) * f];
          const m1: P2 = [c1[0] + (l1[0] - c1[0]) * f, c1[1] + (l1[1] - c1[1]) * f];
          // 縁石（立った面と天端）と歩道
          ground.poly([P(c0[0], c0[1], Y_WALK), P(c1[0], c1[1], Y_WALK), P(c1[0], c1[1], -0.3), P(c0[0], c0[1], -0.3)], C_CURB, [ox2, 0, oz2]);
          ground.poly([P(c0[0], c0[1], Y_WALK), P(c1[0], c1[1], Y_WALK), P(m1[0], m1[1], Y_WALK), P(m0[0], m0[1], Y_WALK)], C_CURB);
          walk.poly([P(m0[0], m0[1], Y_WALK), P(m1[0], m1[1], Y_WALK), P(l1[0], l1[1], Y_WALK), P(l0[0], l0[1], Y_WALK)], C_WALK);
        } else {
          // 側溝: 車道の端の 0.45m（路面より少し上に重ねる）
          const g = 0.45;
          ground.poly([P(c0[0], c0[1], Y_STREET + 0.02), P(c1[0], c1[1], Y_STREET + 0.02), P(c1[0] + ox2 * g, c1[1] + oz2 * g, Y_STREET + 0.02), P(c0[0] + ox2 * g, c0[1] + oz2 * g, Y_STREET + 0.02)], C_GUTTER);
        }
      }
    }

    // 敷地の地面（面より少し高い台。縁は下へ伸ばして地形とのすき間を隠す）
    L.lots.forEach((info, li) => {
      let col = LOT_COLOR[info.use];
      if (!col) return;
      const field = info.use === "field" || info.use === "green";
      if (info.use === "field" && li % 3 === 0) col = C_FIELD_SOIL;
      // 家の庭: 砂利、草、土、コンクリート
      if (info.use === "house") col = HOUSE_GROUND[(li * 7 + (li >> 3)) % HOUSE_GROUND.length];
      const dy = field ? 0.04 : Y_LOT;
      const pts = info.lot.poly.map((q) => P(q[0], q[1], dy));
      ground.poly(pts, col);
      const n = pts.length;
      const [cx, cz] = info.lot.poly.reduce((s, q) => [s[0] + q[0] / n, s[1] + q[1] / n], [0, 0]);
      for (let i = 0; i < n; i++) {
        const a = pts[i], c = pts[(i + 1) % n];
        const mx = (a[0] + c[0]) / 2 + ox - cx, mz = (a[2] + c[2]) / 2 + oz - cz;
        ground.poly([a, c, [c[0], c[1] - 0.45, c[2]], [a[0], a[1] - 0.45, a[2]]], field ? col : C_SKIRT, [mx, 0, mz]);
      }
    });

    // 街路樹の植え桝
    for (const t of L.trees) {
      const y = t.y + Y_WALK + 0.012;
      ground.poly([[t.x - ox - 0.55, y, t.z - oz - 0.55], [t.x - ox + 0.55, y, t.z - oz - 0.55], [t.x - ox + 0.55, y, t.z - oz + 0.55], [t.x - ox - 0.55, y, t.z - oz + 0.55]], C_PIT);
    }

    // 電柱と電線
    const wires: number[] = [];
    const TOP = 10.2, LOW = 6.4;
    for (const p of L.poles) {
      const x = p.x - ox, z = p.z - oz;
      props.column(x, p.y - 0.3, z, TOP + 0.8, 0.17, 0.11, C_POLE);
      // 腕金（通りと直角）
      props.box(x, p.y + TOP, z, -p.tz, p.tx, 1.7, 0.09, 0.09, C_ARM);
      props.box(x, p.y + TOP - 0.9, z, -p.tz, p.tx, 1.1, 0.07, 0.07, C_ARM);
      if (p.transformer) props.column(x + p.tx * 0.42, p.y + 7.6, z + p.tz * 0.42, 0.85, 0.27, 0.27, C_TRANS, 8);
      if (p.lamp) {
        props.box(x - p.tz * 0.7, p.y + 5.6, z + p.tx * 0.7, -p.tz, p.tx, 1.4, 0.05, 0.05, C_ARM);
        props.box(x - p.tz * 1.45, p.y + 5.56, z + p.tx * 1.45, -p.tz, p.tx, 0.55, 0.1, 0.2, C_LAMP);
      }
      if (p.next < 0) continue;
      const q = L.poles[p.next];
      const span = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, sag: number) => {
        const N = 6;
        for (let i = 0; i < N; i++) {
          const t0 = i / N, t1 = (i + 1) / N;
          wires.push(ax + (bx - ax) * t0, ay + (by - ay) * t0 - sag * 4 * t0 * (1 - t0), az + (bz - az) * t0);
          wires.push(ax + (bx - ax) * t1, ay + (by - ay) * t1 - sag * 4 * t1 * (1 - t1), az + (bz - az) * t1);
        }
      };
      for (const o of [-0.75, 0, 0.75]) span(x - p.tz * o, p.y + TOP + 0.08, z + p.tx * o, q.x - ox - q.tz * o, q.y + TOP + 0.08, q.z - oz + q.tx * o, 0.45);
      for (const o of [-0.45, 0.45]) span(x - p.tz * o, p.y + TOP - 0.84, z + p.tx * o, q.x - ox - q.tz * o, q.y + TOP - 0.84, q.z - oz + q.tx * o, 0.5);
      span(x, p.y + LOW, z, q.x - ox, q.y + LOW, q.z - oz, 0.6);
    }

    const group = new THREE.Group();
    group.name = `district:${plan.id}`;
    let triangles = 0;
    const add = (g: Geo, mat: THREE.Material, name: string, cast: boolean) => {
      const geo = g.geometry();
      if (!geo) return;
      triangles += g.triangles;
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.castShadow = cast;
      m.receiveShadow = true;
      group.add(m);
    };
    add(asphalt, this.asphalt, "district:asphalt", false);
    add(lines, this.lines, "district:lines", false);
    add(ground, this.ground, "district:ground", false);
    add(walk, this.walk, "district:walk", false);
    add(props, this.props, "district:props", true);
    if (wires.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
      g.computeBoundingSphere();
      const l = new THREE.LineSegments(g, this.wire);
      l.name = "district:wires";
      group.add(l);
    }
    const allTrees = [...L.trees.map((t) => ({ t, dy: Y_WALK - 0.1 })), ...L.gardenTrees.map((t) => ({ t, dy: -0.1 }))];
    if (allTrees.length) {
      const inst = new THREE.InstancedMesh(this.treeGeo, this.treeMat, allTrees.length);
      inst.name = "district:trees";
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      allTrees.forEach(({ t, dy }, i) => {
        q.setFromAxisAngle(up, t.rot);
        m.compose(new THREE.Vector3(t.x - ox, t.y + dy, t.z - oz), q, new THREE.Vector3(t.scale, t.scale, t.scale));
        inst.setMatrixAt(i, m);
      });
      inst.castShadow = true;
      inst.frustumCulled = false;
      triangles += allTrees.length * 6;
      group.add(inst);
    }
    return { group, x: ox, z: oz, triangles };
  }
}

/** 折れ線を、端を縮める・延ばすしたうえで、step 以下の間隔の点と向きにする */
function resample(pts: P2[], step: number, trim0: number, trim1: number, ext0: number, ext1: number): { x: number; z: number; tx: number; tz: number }[] {
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(l);
    total += l;
  }
  const s0 = trim0 - ext0, s1 = total - trim1 + ext1;
  if (s1 - s0 < 0.5) return [];
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const out: { x: number; z: number; tx: number; tz: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    // s を含む線分（範囲の外は端の線分を延ばす）
    let acc = 0, i = 0;
    while (i < seg.length - 1 && s > acc + seg[i]) acc += seg[i++];
    const l = seg[i] || 1;
    const tx = (pts[i + 1][0] - pts[i][0]) / l, tz = (pts[i + 1][1] - pts[i][1]) / l;
    out.push({ x: pts[i][0] + tx * (s - acc), z: pts[i][1] + tz * (s - acc), tx, tz });
  }
  return out;
}
