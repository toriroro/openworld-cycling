// 名所の模型（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）。OSM の外形・木・噴水などの位置に、名所ごとの形を組む。
// 寸法は公開されている数字（テレビ塔の高さ 147.2m・展望台 90.38m など）と写真からの目測。細部は簡略。
// 材質は 4 つ（solid 普通の面、shiny 硝子と水、ground 地面に沿う芝・舗装・花壇、glow 自ら光る時計の文字・灯り）と木（板の木の位置）。

import type {
  LandmarkData,
  LandmarkFeature,
} from "../../shared/world/landmarks.ts";
import {
  distanceToPolyline,
  insidePolygon,
  polygonArea,
} from "../../shared/world/landmarks.ts";
import { unit } from "../building/mesher.ts";
import {
  add,
  beam,
  block,
  cylinder,
  fillPolygon,
  quadUp,
  gableRoof,
  hex,
  hipRoof,
  lerp3,
  Mesher,
  minRect,
  prism,
  pyramid,
  type Rgb,
  shade,
  UP,
  v3,
  type V3,
  windows,
} from "./kit.ts";

export interface TreeInst {
  x: number;
  y: number;
  z: number;
  /** 横・縦の倍率（板の木は 1 で高さ約 5m） */
  s: number;
  sy: number;
  rot: number;
  c: Rgb;
}

export interface LandmarkParts {
  solid: Mesher;
  shiny: Mesher;
  ground: Mesher;
  glow: Mesher;
  trees: TreeInst[];
  /** 後で少しずつ進める仕事（芝・林。1 フレームに使う時間を抑えるため。呼ぶ側が順に実行する） */
  jobs: (() => void)[];
}

/** 模型を作る時に要る周りの情報（世界座標） */
export interface BuildCtx {
  /** 地形の高さ */
  ground(x: number, z: number): number;
  /** 道路・走らない道・歩道の上か（pad m の余白を含む） */
  onRoad(x: number, z: number, pad: number): boolean;
  light: boolean;
}

// ---- 色 ----
const C = {
  lawn: hex("#52733a"),
  lawnDry: hex("#77904c"),
  paving: hex("#b8b3a8"),
  granite: hex("#a19d96"),
  stone: hex("#8f8b84"),
  darkStone: hex("#5d5b57"),
  water: hex("#3f6f86"),
  glass: hex("#56707e"),
  glassLight: hex("#a9c6d3"),
  frameWhite: hex("#e9e7e1"),
  black: hex("#26282a"),
  bronze: hex("#7a6446"),
  wood: hex("#8a6a45"),
  woodDark: hex("#5e4630"),
  copper: hex("#5f8273"),
  slate: hex("#4c5562"),
  white: hex("#f0eee8"),
  lampOn: hex("#fff2cf"),
};

const FLOWERS = [
  "#c8323c",
  "#e8c13a",
  "#7a4fa8",
  "#f2efe6",
  "#e57aa2",
  "#e8823a",
].map(hex);

/** 芝の縁と道路（走る道は歩道を含む）の間をあける幅 (m) */
const LAWN_ROAD_GAP = 0.2;

/** 木の種類ごとの大きさと色（札の species、名前から） */
function treeKind(
  f: LandmarkFeature | null,
  name = "",
): { h: number; w: number; c: Rgb } {
  const n = `${f?.tags.species ?? ""}${f?.tags["species:ja"] ?? ""}${f?.tags.name ?? ""}${name}`;
  if (/ポプラ|Populus/i.test(n))
    return { h: 26, w: 6.5, c: [0.82, 0.95, 0.74] };
  if (/イチョウ|Ginkgo/i.test(n)) return { h: 15, w: 8, c: [1.02, 1.06, 0.7] };
  if (/ニレ|Ulmus|ケヤキ|Zelkova/i.test(n))
    return { h: 17, w: 15, c: [0.86, 0.98, 0.8] };
  if (/サクラ|桜|Prunus/i.test(n)) return { h: 8, w: 9, c: [0.95, 0.98, 0.85] };
  if (/マツ|ヒノキ|スギ|モミ|トウヒ|Pinus|Picea|Abies/i.test(n))
    return { h: 15, w: 7, c: [0.62, 0.78, 0.62] };
  if (/カエデ|モミジ|Acer/i.test(n))
    return { h: 10, w: 9, c: [0.92, 1.0, 0.78] };
  return { h: 12, w: 10, c: [0.86, 0.97, 0.82] };
}

/** 名所の模型を作る。座標は (ox, oz) からの相対 */
export function buildLandmark(
  lm: LandmarkData,
  ox: number,
  oz: number,
  ctx: BuildCtx,
): LandmarkParts {
  const parts: LandmarkParts = {
    solid: new Mesher(),
    shiny: new Mesher(),
    ground: new Mesher(),
    glow: new Mesher(),
    trees: [],
    jobs: [],
  };
  const b = new Builder(lm, ox, oz, ctx, parts);
  switch (lm.kind) {
    case "tvtower":
      b.tvTower();
      break;
    case "odori":
      b.park({ lawnZone: true, woods: true });
      break;
    case "clocktower":
      b.clockTower();
      b.park({ lawnZone: false, woods: false });
      break;
    case "akarenga":
      b.akarenga();
      b.park({ lawnZone: false, woods: true });
      break;
    case "hokudai":
      b.park({ lawnZone: false, woods: true });
      b.hokudai();
      break;
    case "nakajima":
      b.hoheikan();
      b.park({ lawnZone: false, woods: true });
      break;
    case "jingu":
      b.jingu();
      b.park({ lawnZone: false, woods: false });
      break;
    case "asahiyama":
      b.asahiyama();
      break;
    case "moiwa":
      b.moiwa();
      break;
    case "moere":
      b.moere();
      b.park({ lawnZone: false, woods: false });
      break;
    case "okurayama":
      b.okurayama();
      break;
    case "hitsujigaoka":
      b.hitsujigaoka();
      break;
  }
  return parts;
}

type P2 = [number, number];

class Builder {
  private seed: number;
  private k = 0;
  /** 芝を張らない所（模型の足元・広場）。局所座標の円 [x, z, r] */
  private keepOut: [number, number, number][] = [];
  /** 芝を張らない多角形（局所座標） */
  private keepOutPolys: P2[][] = [];

  constructor(
    private lm: LandmarkData,
    private ox: number,
    private oz: number,
    private ctx: BuildCtx,
    private P: LandmarkParts,
  ) {
    this.seed = lm.osm >>> 0;
    for (const f of lm.features)
      if (f.t === "building") this.keepOutPolys.push(this.poly(f));
  }

  // ---- 共通の道具 ----
  private rnd() {
    return unit(this.seed, this.k++);
  }
  /** 局所座標の地面の高さ */
  private g(x: number, z: number) {
    return this.ctx.ground(x + this.ox, z + this.oz);
  }
  private poly(f: LandmarkFeature): P2[] {
    const out: P2[] = [];
    for (let i = 0; i < f.pts.length; i += 2)
      out.push([f.pts[i] - this.ox, f.pts[i + 1] - this.oz]);
    return out;
  }
  private pt(f: LandmarkFeature): P2 {
    const p = this.poly(f);
    return [
      p.reduce((a, q) => a + q[0], 0) / p.length,
      p.reduce((a, q) => a + q[1], 0) / p.length,
    ];
  }
  private feats(t: LandmarkFeature["t"]) {
    return this.lm.features.filter((f) => f.t === t);
  }
  private replaced() {
    return this.lm.features.filter((f) => f.t === "building" && f.replace);
  }
  /** 外形の 4 隅で一番低い地面 */
  private base(poly: P2[]) {
    return Math.min(...poly.map((p) => this.g(p[0], p[1])));
  }
  private zone(): P2[] {
    const z = this.lm.zone;
    const out: P2[] = [];
    for (let i = 0; i < z.length; i += 2)
      out.push([z[i] - this.ox, z[i + 1] - this.oz]);
    return out;
  }

  tree(
    x: number,
    z: number,
    kind: { h: number; w: number; c: Rgb },
    jitter = 0.15,
  ) {
    if (this.ctx.onRoad(x + this.ox, z + this.oz, 0.5)) return;
    const k = 1 + (this.rnd() - 0.5) * 2 * jitter;
    const v = 0.92 + this.rnd() * 0.16;
    this.P.trees.push({
      x,
      y: this.g(x, z) - 0.1,
      z,
      s: (kind.w / 4.9) * k,
      sy: (kind.h / 5) * k,
      rot: this.rnd() * Math.PI * 2,
      c: [kind.c[0] * v, kind.c[1] * v, kind.c[2] * v],
    });
  }

  /** 折れ線に沿って間隔 step で木を植える */
  treeRow(pts: P2[], step: number, kind: { h: number; w: number; c: Rgb }) {
    let carry = step / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i],
        [bx, bz] = pts[i + 1];
      const l = Math.hypot(bx - ax, bz - az);
      let s = carry;
      for (; s <= l; s += step)
        this.tree(
          ax + ((bx - ax) * s) / l,
          az + ((bz - az) * s) / l,
          kind,
          0.08,
        );
      carry = s - l;
    }
  }

  /**
   * 芝・木を置かない所の引き当て（呼んだ時の keepOut・keepOutPolys の写し）。
   * 多角形は 16m の格子に外接矩形で登録して、点の近くの多角形だけ調べる（北大で建物 426 棟 × 芝 2 万マスを総当たりして 1 秒かかったため）
   */
  private blockedCache: {
    n: number;
    m: number;
    fn: (x: number, z: number) => boolean;
  } | null = null;
  private blocked(): (x: number, z: number) => boolean {
    // keepOut・keepOutPolys は足すだけなので、数が同じなら前の引き当てを使う
    const bc = this.blockedCache;
    if (bc && bc.n === this.keepOut.length && bc.m === this.keepOutPolys.length)
      return bc.fn;
    const fn = this.makeBlocked();
    this.blockedCache = {
      n: this.keepOut.length,
      m: this.keepOutPolys.length,
      fn,
    };
    return fn;
  }
  private makeBlocked(): (x: number, z: number) => boolean {
    const circles = [...this.keepOut];
    const G = 16;
    const grid = new Map<number, number[]>();
    const polys = this.keepOutPolys.map((q, k) => {
      const f = q.flat();
      let x0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        z1 = -Infinity;
      for (const [x, z] of q) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++)
        for (let j = Math.floor(z0 / G); j <= Math.floor(z1 / G); j++) {
          const key = i * 92821 + j;
          let l = grid.get(key);
          if (!l) grid.set(key, (l = []));
          l.push(k);
        }
      return { f, x0, z0, x1, z1 };
    });
    return (x, z) => {
      for (const [cx, cz, r] of circles)
        if ((cx - x) ** 2 + (cz - z) ** 2 < r * r) return true;
      for (const k of grid.get(Math.floor(x / G) * 92821 + Math.floor(z / G)) ??
        []) {
        const p = polys[k];
        if (
          x >= p.x0 &&
          x <= p.x1 &&
          z >= p.z0 &&
          z <= p.z1 &&
          insidePolygon(p.f, x, z)
        )
          return true;
      }
      return false;
    };
  }

  /** 多角形の中に、間隔 step の格子を揺らして木を植える（列ごとに後の仕事にする） */
  fillTrees(
    poly: P2[],
    step: number,
    kind: (i: number) => { h: number; w: number; c: Rgb },
    skip?: (x: number, z: number) => boolean,
  ) {
    const xs = poly.map((p) => p[0]),
      zs = poly.map((p) => p[1]);
    const flat = poly.flat();
    const blocked = this.blocked();
    let i = 0;
    const zA = Math.min(...zs),
      zB = Math.max(...zs);
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step)
      this.P.jobs.push(() => {
        for (let z = zA + step / 2; z < zB; z += step) {
          const px = x + (this.rnd() - 0.5) * step * 0.7,
            pz = z + (this.rnd() - 0.5) * step * 0.7;
          if (!insidePolygon(flat, px, pz)) continue;
          if (skip?.(px, pz)) continue;
          if (blocked(px, pz)) continue;
          this.tree(px, pz, kind(i++));
        }
      });
  }

  /** 芝・舗装を地面に沿って張る（格子 cell m。道路・建物・keepOut は除く）。色は col(x, z) */
  lawn(
    poly: P2[],
    cell: number,
    col: (x: number, z: number) => Rgb,
    lift = 0.07,
    extraSkip?: (x: number, z: number) => boolean,
  ) {
    const xs = poly.map((p) => p[0]),
      zs = poly.map((p) => p[1]);
    const flat = poly.flat();
    const x0 = Math.floor(Math.min(...xs) / cell) * cell,
      z0 = Math.floor(Math.min(...zs) / cell) * cell;
    const nx = Math.ceil((Math.max(...xs) - x0) / cell),
      nz = Math.ceil((Math.max(...zs) - z0) / cell);
    const hcache = new Map<number, number>();
    const H = (i: number, j: number) => {
      const key = i * 100003 + j;
      let h = hcache.get(key);
      if (h === undefined) {
        h = this.g(x0 + i * cell, z0 + j * cell) + lift;
        hcache.set(key, h);
      }
      return h;
    };
    const m = this.P.ground;
    const blocked = this.blocked();
    /** 芝を張る点か（区域の中、道路から LAWN_ROAD_GAP より外、建物・keepOut の外） */
    const inside = (x: number, z: number) =>
      insidePolygon(flat, x, z) &&
      !this.ctx.onRoad(x + this.ox, z + this.oz, LAWN_ROAD_GAP) &&
      !blocked(x, z) &&
      !extraSkip?.(x, z);
    // 半マスの格子の点の判定（隣のマスと共有する）
    const half = cell / 2;
    const pin = new Map<number, boolean>();
    const In = (u: number, v: number) => {
      const key = u * 400009 + v;
      let r = pin.get(key);
      if (r === undefined) {
        r = inside(x0 + u * half, z0 + v * half);
        pin.set(key, r);
      }
      return r;
    };
    // 辺（半マス 1 つ分か 2 つ分）の上で、芝の内と外が入れ替わる所（二分探索で半マスの 1/64 まで）。
    // 隣のマスと同じ点になるよう、辺は番号の小さい端から探す
    const xing = new Map<number, P2>();
    const cross = (u0: number, v0: number, u1: number, v1: number): P2 => {
      if (u1 < u0 || v1 < v0) [u0, v0, u1, v1] = [u1, v1, u0, v0];
      const len = u1 - u0 + v1 - v0;
      const key = ((u0 * 400009 + v0) * 2 + (u1 > u0 ? 0 : 1)) * 2 + (len - 1);
      let p = xing.get(key);
      if (p) return p;
      const ax = x0 + u0 * half,
        az = z0 + v0 * half,
        dx = (u1 - u0) * half,
        dz = (v1 - v0) * half;
      const inA = In(u0, v0);
      let a = 0,
        b = 1;
      for (let k = 0; k < 5 + len; k++) {
        const t = (a + b) / 2;
        if (inside(ax + dx * t, az + dz * t) === inA) a = t;
        else b = t;
      }
      const t = (a + b) / 2;
      p = [ax + dx * t, az + dz * t];
      xing.set(key, p);
      return p;
    };
    // 8 列ずつ後の仕事にする
    for (let i0 = 0; i0 < nx; i0 += 8)
      this.P.jobs.push(() => {
        for (let i = i0; i < Math.min(nx, i0 + 8); i++)
          for (let j = 0; j < nz; j++) {
            const ax = x0 + i * cell,
              az = z0 + j * cell;
            // マスの中の高さ（4 隅の双一次。辺の上では隣のマスの四角形の辺と一致する）
            const h00 = H(i, j),
              h10 = H(i + 1, j),
              h01 = H(i, j + 1),
              h11 = H(i + 1, j + 1);
            const hAt = (x: number, z: number) => {
              const fx = (x - ax) / cell,
                fz = (z - az) / cell;
              return (
                (h00 * (1 - fx) + h10 * fx) * (1 - fz) +
                (h01 * (1 - fx) + h11 * fx) * fz
              );
            };
            const u = i * 2,
              v = j * 2;
            const corners = [
              In(u, v),
              In(u + 2, v),
              In(u, v + 2),
              In(u + 2, v + 2),
            ];
            const mid = In(u + 1, v + 1);
            const all = corners.every((c) => c === mid);
            if (all && !mid) continue;
            const c = col(ax + half, az + half);
            if (all) {
              m.quad(
                [
                  v3(ax, h01, az + cell),
                  v3(ax + cell, h11, az + cell),
                  v3(ax + cell, h10, az),
                  v3(ax, h00, az),
                ],
                [
                  [ax / 4, (az + cell) / 4],
                  [(ax + cell) / 4, (az + cell) / 4],
                  [(ax + cell) / 4, az / 4],
                  [ax / 4, az / 4],
                ],
                c,
              );
              continue;
            }
            // 縁のマス: 内と外の境を、辺の上の入れ替わる点でつないで切る（凸の多角形になる）
            const emit = (pts: P2[]) =>
              m.quad(
                pts.map(([x, z]) => v3(x, hAt(x, z), z)),
                pts.map(([x, z]): [number, number] => [x / 4, z / 4]),
                c,
              );
            /** 一辺 s 半マスの四角 (su, sv) を切った形。外から見て反時計回り（上から見て (0,1)→(1,1)→(1,0)→(0,0)） */
            const cut = (su: number, sv: number, s: number) => {
              const ring: [number, number][] = [
                [su, sv + s],
                [su + s, sv + s],
                [su + s, sv],
                [su, sv],
              ];
              const pts: P2[] = [];
              for (let k = 0; k < 4; k++) {
                const [pu, pv] = ring[k],
                  [qu, qv] = ring[(k + 1) % 4];
                const ip = In(pu, pv);
                if (ip) pts.push([x0 + pu * half, z0 + pv * half]);
                if (ip !== In(qu, qv)) pts.push(cross(pu, pv, qu, qv));
              }
              return pts;
            };
            // 境が 1 本の線で横切るだけなら（4 辺の中点と真ん中が切った形と合う）、マスのまま切る
            const edgesOk =
              (corners[0] !== corners[1] || In(u + 1, v) === corners[0]) &&
              (corners[1] !== corners[3] || In(u + 2, v + 1) === corners[1]) &&
              (corners[3] !== corners[2] || In(u + 1, v + 2) === corners[3]) &&
              (corners[2] !== corners[0] || In(u, v + 1) === corners[2]);
            if (edgesOk) {
              const pts = cut(u, v, 2);
              const ok =
                pts.length >= 3 &&
                insidePolygon(pts.flat(), ax + half, az + half) === mid;
              if (ok) {
                emit(pts);
                continue;
              }
            }
            // 入り組んだマスは半マス 4 つに分けて切る。軽量画質では分けず、真ん中が外なら張らない（三角形を増やさない）
            if (this.ctx.light) {
              const pts = mid ? cut(u, v, 2) : [];
              if (pts.length >= 3) emit(pts);
              continue;
            }
            for (let a = 0; a < 2; a++)
              for (let b = 0; b < 2; b++) {
                const pts = cut(u + a, v + b, 1);
                if (pts.length >= 3) emit(pts);
              }
          }
      });
  }

  /** 芝の色: 14m の格子の値をなめらかにつないだ ±5% の濃淡 */
  private lawnColor =
    (base: Rgb) =>
    (x: number, z: number): Rgb => {
      const G = 14;
      const gx = (x + this.ox) / G,
        gz = (z + this.oz) / G;
      const i = Math.floor(gx),
        j = Math.floor(gz);
      const fx = gx - i,
        fz = gz - j;
      const n = (a: number, b: number) =>
        unit(this.seed, a * 7919 + b * 104729);
      const v =
        (n(i, j) * (1 - fx) + n(i + 1, j) * fx) * (1 - fz) +
        (n(i, j + 1) * (1 - fx) + n(i + 1, j + 1) * fx) * fz;
      const k = 0.95 + v * 0.1;
      return [base[0] * k, base[1] * k, base[2] * k];
    };

  /** 花壇: 縁石の上に花の色の斑。広い庭（120m² を超える）は芝にして、縁 1.3m だけ花 */
  flowerbed(poly: P2[]) {
    const flatP = poly.flat();
    if (polygonArea(flatP) > 120) {
      const lawn = this.lawnColor(C.lawn);
      // 縁の花は 3m ごとに色を変える（1 マスごとに変えると紙吹雪に見えた）
      this.lawn(poly, this.ctx.light ? 2 : 1.3, (x, z) => {
        if (distanceToPolyline(flatP, x, z, true) > 1.3) return lawn(x, z);
        const k = unit(
          this.seed,
          Math.floor((x + this.ox) / 3) * 7919 +
            Math.floor((z + this.oz) / 3) * 104729,
        );
        return k < 0.2
          ? lawn(x, z)
          : shade(FLOWERS[Math.floor(k * 977) % FLOWERS.length], 0.8);
      });
      this.keepOutPolys.push(poly);
      return;
    }
    const y0 = this.base(poly);
    prism(this.P.solid, poly, y0 - 0.3, y0 + 0.22, C.granite, null);
    const flat = poly.flat();
    const xs = poly.map((p) => p[0]),
      zs = poly.map((p) => p[1]);
    const cell = 0.9;
    for (let x = Math.min(...xs); x < Math.max(...xs); x += cell)
      for (let z = Math.min(...zs); z < Math.max(...zs); z += cell) {
        if (!insidePolygon(flat, x + cell / 2, z + cell / 2)) continue;
        const r = this.rnd();
        const c =
          r < 0.45
            ? shade(C.lawn, 0.8)
            : shade(FLOWERS[Math.floor(this.rnd() * FLOWERS.length)], 0.85);
        const h = y0 + 0.24 + this.rnd() * 0.12;
        block(
          this.P.solid,
          v3(x + cell / 2, y0 + 0.2, z + cell / 2),
          v3(1, 0, 0),
          cell,
          h - y0 - 0.2,
          cell,
          c,
        );
      }
    this.keepOutPolys.push(poly);
  }

  /** 噴水: 石の縁、水面、中央の噴き上げ */
  fountain(poly: P2[], jet = 3.5) {
    const y0 = this.base(poly);
    const top = y0 + 0.55;
    prism(this.P.solid, poly, y0 - 0.4, top, C.granite, null);
    // 縁の上面（外形を内側へ 0.45m 縮めた輪）
    const [cx, cz] = [
      poly.reduce((a, p) => a + p[0], 0) / poly.length,
      poly.reduce((a, p) => a + p[1], 0) / poly.length,
    ];
    const inner = poly.map(([x, z]): P2 => {
      const dx = x - cx,
        dz = z - cz,
        l = Math.hypot(dx, dz) || 1;
      const k = Math.max(0.2, (l - 0.45) / l);
      return [cx + dx * k, cz + dz * k];
    });
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      quadUp(
        this.P.solid,
        [
          v3(inner[i][0], top, inner[i][1]),
          v3(poly[i][0], top, poly[i][1]),
          v3(poly[j][0], top, poly[j][1]),
          v3(inner[j][0], top, inner[j][1]),
        ],
        C.paving,
      );
    }
    fillPolygon(this.P.shiny, inner, () => top - 0.12, C.water);
    const r = Math.min(...poly.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
    cylinder(
      this.P.solid,
      v3(cx, top - 0.1, cz),
      Math.min(0.9, r * 0.12),
      0.5,
      C.granite,
      10,
    );
    cylinder(
      this.P.glow,
      v3(cx, top + 0.3, cz),
      Math.max(0.12, r * 0.02),
      jet,
      [0.85, 0.9, 0.95],
      8,
      0.08,
    );
    // 噴き上げの周りの飛沫（下へ広がる白い円錐）
    cylinder(
      this.P.glow,
      v3(cx, top - 0.05, cz),
      Math.min(r * 0.45, 2.4),
      jet * 0.35,
      [0.78, 0.85, 0.9],
      12,
      0.15,
      null,
    );
    this.keepOutPolys.push(poly);
  }

  /** 平らな水面（小さな池。大きな池・川は地形の水面が描く） */
  pond(poly: P2[]) {
    const y = Math.min(...poly.map((p) => this.g(p[0], p[1]))) + 0.12;
    fillPolygon(this.P.shiny, poly, () => y, C.water);
    this.keepOutPolys.push(poly);
  }

  /** 公園の灯り（柱と灯具） */
  lamp(x: number, z: number, style: "park" | "stone" = "park") {
    const y = this.g(x, z);
    if (style === "stone") {
      block(this.P.solid, v3(x, y, z), v3(1, 0, 0), 0.8, 0.35, 0.8, C.stone);
      cylinder(this.P.solid, v3(x, y + 0.35, z), 0.16, 0.75, C.stone, 6);
      block(
        this.P.solid,
        v3(x, y + 1.1, z),
        v3(1, 0, 0),
        0.6,
        0.5,
        0.6,
        C.granite,
      );
      block(
        this.P.glow,
        v3(x, y + 1.18, z),
        v3(1, 0, 0),
        0.62,
        0.3,
        0.3,
        C.lampOn,
      );
      pyramid(
        this.P.solid,
        [
          v3(x - 0.5, y + 1.6, z - 0.5),
          v3(x + 0.5, y + 1.6, z - 0.5),
          v3(x + 0.5, y + 1.6, z + 0.5),
          v3(x - 0.5, y + 1.6, z + 0.5),
        ],
        v3(x, y + 1.95, z),
        C.stone,
      );
      return;
    }
    cylinder(this.P.solid, v3(x, y, z), 0.09, 4.2, C.black, 6, 0.06);
    cylinder(this.P.glow, v3(x, y + 4.0, z), 0.22, 0.5, C.lampOn, 8, 0.18);
    cylinder(this.P.solid, v3(x, y + 4.5, z), 0.3, 0.12, C.black, 8, 0.05);
  }

  /** 像・碑（台座と、ブロンズの塊） */
  monument(x: number, z: number, bust = false) {
    const y = this.g(x, z);
    block(
      this.P.solid,
      v3(x, y - 0.3, z),
      v3(1, 0, 0),
      1.2,
      1.9,
      1.0,
      C.granite,
    );
    if (bust) {
      block(
        this.P.solid,
        v3(x, y + 1.6, z),
        v3(1, 0, 0),
        0.7,
        0.45,
        0.4,
        C.bronze,
      );
      block(
        this.P.solid,
        v3(x, y + 2.05, z),
        v3(1, 0, 0),
        0.28,
        0.36,
        0.3,
        C.bronze,
      );
    } else {
      block(
        this.P.solid,
        v3(x, y + 1.6, z),
        v3(1, 0, 0),
        0.5,
        1.5,
        0.4,
        C.bronze,
      );
      block(
        this.P.solid,
        v3(x, y + 3.1, z),
        v3(1, 0, 0),
        0.26,
        0.3,
        0.28,
        C.bronze,
      );
    }
  }

  /** 公園の共通部分: 芝、花壇、噴水、池、木、並木、林、灯り、像 */
  park(o: { lawnZone: boolean; woods: boolean }) {
    for (const f of this.feats("garden"))
      if (f.pts.length >= 6) this.flowerbed(this.poly(f));
    for (const f of this.feats("fountain")) {
      if (f.pts.length >= 6) this.fountain(this.poly(f));
      else {
        const [x, z] = this.pt(f);
        const r = 3;
        this.fountain(
          [...Array(12).keys()].map((i): P2 => [
            x + Math.cos((i / 12) * Math.PI * 2) * r,
            z + Math.sin((i / 12) * Math.PI * 2) * r,
          ]),
          2.5,
        );
      }
    }
    for (const f of this.feats("water"))
      if (f.pts.length >= 6 && f.pts.length <= 400) this.pond(this.poly(f));
    for (const f of this.feats("tree")) {
      const [x, z] = this.pt(f);
      this.tree(x, z, treeKind(f));
    }
    for (const f of this.feats("row")) {
      const k = treeKind(f);
      this.treeRow(
        this.poly(f),
        k.h > 20 ? 5.5 : k.h > 14 && k.w < 10 ? 7 : 9,
        k,
      );
    }
    if (o.woods)
      for (const f of this.feats("wood"))
        if (f.pts.length >= 6)
          this.fillTrees(this.poly(f), 9, () =>
            treeKind(
              null,
              ["ハルニレ", "カエデ", "", "マツ"][Math.floor(this.rnd() * 4)],
            ),
          );
    for (const f of this.feats("lamp")) {
      const [x, z] = this.pt(f);
      this.lamp(x, z, this.lm.kind === "jingu" ? "stone" : "park");
    }
    for (const f of this.feats("statue")) {
      if (this.lm.kind === "hitsujigaoka") continue;
      const [x, z] = this.pt(f);
      this.monument(
        x,
        z,
        f.tags.artwork_type === "bust" || /博士像/.test(f.tags.name ?? ""),
      );
    }
    const grass = this.feats("grass").filter((f) => f.pts.length >= 6);
    const lawnCol = this.lawnColor(C.lawn);
    const cell = this.ctx.light ? 4 : 3;
    if (o.lawnZone) this.lawn(this.zone(), cell, lawnCol);
    else for (const f of grass) this.lawn(this.poly(f), cell, lawnCol);
  }

  // ---- テレビ塔 ----
  tvTower() {
    const f = this.replaced()[0];
    const fp = this.poly(f);
    const r = minRect(fp);
    const X = r.X,
      Z = v3(-X.z, 0, X.x);
    const y0 = this.base(fp);
    const c = v3(r.cx, y0, r.cz);
    const at = (a: number, b: number, y: number) =>
      v3(c.x + X.x * a + Z.x * b, y0 + y, c.z + X.z * a + Z.z * b);
    const steel = hex("#b5512f"),
      steelDark = shade(steel, 0.75);
    const S = this.P.solid;
    const half = Math.min(r.w, r.d) / 2 - 1.2;
    const DECK = 90.4;
    const hw = (y: number) =>
      5.6 + (half - 5.6) * Math.pow(Math.max(0, 1 - y / DECK), 1.7);
    // 脚・横材・筋かい（展望台まで）
    const levels = [0, 5, 11, 18, 26, 35, 45, 56, 67, 79, DECK];
    const corner = (i: number, y: number) => {
      const s = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ][i];
      return at(s[0] * hw(y), s[1] * hw(y), y);
    };
    for (let L = 0; L + 1 < levels.length; L++) {
      const ya = levels[L],
        yb = levels[L + 1];
      const lw = 1.5 - (L / levels.length) * 0.8;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        beam(S, corner(i, ya), corner(i, yb), lw, steel);
        beam(S, corner(i, yb), corner(j, yb), 0.45, steelDark);
        beam(S, corner(i, ya), corner(j, yb), 0.28, steel);
        beam(S, corner(j, ya), corner(i, yb), 0.28, steel);
      }
    }
    // 下の建物（脚の内側、3 階）
    const bw = Math.min(half * 2 - 4, 24);
    block(S, at(0, 0, -1.5), X, bw, 15.5, bw, hex("#cdbfa8"));
    for (const [n, ofs] of [
      [X, bw / 2],
      [Z, bw / 2],
      [v3(-X.x, 0, -X.z), bw / 2],
      [v3(-Z.x, 0, -Z.z), bw / 2],
    ] as [V3, number][]) {
      const u = v3(n.z, 0, -n.x);
      const p0 = add(add(v3(c.x, 0, c.z), n, ofs), u, -bw / 2);
      for (const fy of [1.2, 5.6, 9.8])
        windows(this.P.shiny, p0, n, bw, y0 + fy, 2.6, 2.4, 3, C.glass);
    }
    block(S, at(0, 0, 14), X, bw + 0.6, 0.6, bw + 0.6, hex("#8d4430"));
    // 展望台（2 層の硝子の箱）
    const dw = 14.5;
    block(S, at(0, 0, DECK - 0.6), X, dw + 1, 0.8, dw + 1, hex("#d9d3c7"));
    block(this.P.shiny, at(0, 0, DECK + 0.2), X, dw, 3.4, dw, C.glass);
    block(S, at(0, 0, DECK + 3.6), X, dw + 0.4, 0.7, dw + 0.4, hex("#e2ddd3"));
    block(this.P.shiny, at(0, 0, DECK + 4.3), X, dw - 1, 3, dw - 1, C.glass);
    block(S, at(0, 0, DECK + 7.3), X, dw + 0.6, 0.9, dw + 0.6, steel);
    // 上の格子（展望台の上 → 128m）
    const UP0 = DECK + 8.2,
      UP1 = 128;
    const hu = (y: number) => 4.2 - ((y - UP0) / (UP1 - UP0)) * 2.8;
    const ups = [UP0, UP0 + 6, UP0 + 12, UP0 + 18, UP0 + 24, UP1];
    for (let L = 0; L + 1 < ups.length; L++) {
      const ya = ups[L],
        yb = ups[L + 1];
      const cu = (i: number, y: number) => {
        const s = [
          [1, 1],
          [-1, 1],
          [-1, -1],
          [1, -1],
        ][i];
        return at(s[0] * hu(y), s[1] * hu(y), y);
      };
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        beam(S, cu(i, ya), cu(i, yb), 0.55, steel);
        beam(S, cu(i, yb), cu(j, yb), 0.25, steelDark);
        beam(S, cu(i, ya), cu(j, yb), 0.16, steel);
      }
    }
    block(S, at(0, 0, 112), X, 6, 1.2, 6, steel);
    // 電波の柱（白と赤の帯）
    let y = UP1;
    for (let i = 0; i < 6; i++) {
      const h = (147.2 - UP1) / 6;
      cylinder(
        S,
        at(0, 0, y),
        0.75 - i * 0.08,
        h,
        i % 2 ? C.white : steel,
        8,
        0.7 - i * 0.08,
      );
      y += h;
    }
    // 電光時計（大通公園の側 = 西を向く面）
    const faces: V3[] = [X, Z, v3(-X.x, 0, -X.z), v3(-Z.x, 0, -Z.z)];
    const west = faces.reduce((a, n) => (n.x < a.x ? n : a));
    const ty = 60;
    const off = hw(ty + 3) + 0.4;
    const u = v3(west.z, 0, -west.x);
    const p0 = add(add(v3(c.x, y0 + ty, c.z), west, off), u, -6);
    S.wall(add(p0, west, -0.05), west, 12, 5.5, C.black, 1);
    // 4 けたの数字（光る板）と、間の点
    for (let i = 0; i < 4; i++) {
      const dx = 1.2 + i * 2.6 + (i >= 2 ? 0.4 : 0);
      for (const [sx, sy, w, h] of [
        [0, 0.7, 1.6, 0.3],
        [0, 2.6, 1.6, 0.3],
        [0, 4.4, 1.6, 0.3],
        [0, 0.7, 0.3, 4.0],
        [1.3, 0.7, 0.3, 4.0],
      ] as const)
        this.P.glow.wall(
          add(add(p0, u, dx + sx), UP, sy),
          west,
          w,
          h,
          hex("#ffe9b8"),
          1,
        );
    }
    for (const sy of [1.9, 3.4])
      this.P.glow.wall(
        add(add(p0, u, 6.05), UP, sy),
        west,
        0.3,
        0.3,
        hex("#ffe9b8"),
        1,
      );
  }

  // ---- 時計台 ----
  clockTower() {
    const f = this.replaced()[0];
    const fp = this.poly(f);
    const r = minRect(fp);
    const w = Math.min(r.w, 30),
      d = Math.min(r.d, 15);
    const X = r.X,
      Z = v3(-X.z, 0, X.x);
    const y0 = this.base(fp) - 0.2;
    const S = this.P.solid;
    const c = v3(r.cx, y0, r.cz);
    const at = (a: number, b: number, y: number) =>
      v3(c.x + X.x * a + Z.x * b, y0 + y, c.z + X.z * a + Z.z * b);
    const wall = hex("#eeece6"),
      trim = hex("#d4cfc3"),
      roof = hex("#b5473c"),
      win = hex("#3a434b");
    const EAVE = 8.6;
    block(S, at(0, 0, 0), X, w + 0.3, 0.9, d + 0.3, C.stone);
    block(S, at(0, 0, 0.9), X, w, EAVE - 0.9, d, wall);
    // 下見板の影の線
    for (let yy = 1.3; yy < EAVE; yy += 0.42)
      for (const [n, ofs, len] of [
        [X, w / 2, d],
        [Z, d / 2, w],
        [v3(-X.x, 0, -X.z), w / 2, d],
        [v3(-Z.x, 0, -Z.z), d / 2, w],
      ] as [V3, number, number][]) {
        const u = v3(n.z, 0, -n.x);
        S.wall(
          add(add(at(0, 0, yy), n, ofs + 0.02), u, -len / 2),
          n,
          len,
          0.05,
          shade(wall, 0.8),
          1,
        );
      }
    for (const [n, ofs, len] of [
      [X, w / 2, d],
      [Z, d / 2, w],
      [v3(-X.x, 0, -X.z), w / 2, d],
      [v3(-Z.x, 0, -Z.z), d / 2, w],
    ] as [V3, number, number][]) {
      const u = v3(n.z, 0, -n.x);
      const p0 = add(add(v3(c.x, 0, c.z), n, ofs), u, -len / 2);
      for (const fy of [1.6, 5.4])
        windows(S, p0, n, len, y0 + fy, 2.1, 0.95, 2.4, win, trim);
    }
    gableRoof(S, at(0, 0, EAVE), X, w, d, d * 0.38, 0.6, roof, wall);
    // 時計塔: 道路に近い方の妻の上
    const ends = [1, -1].map((s) => ({ s, p: at((s * w) / 2, 0, 0) }));
    const roadGap = (p: V3) => {
      for (let k = 2; k <= 40; k += 2)
        if (
          this.ctx.onRoad(
            p.x + X.x * Math.sign(p.x - c.x || 1) * k + this.ox,
            p.z + this.oz,
            0,
          )
        )
          return k;
      return 99;
    };
    const s = roadGap(ends[0].p) <= roadGap(ends[1].p) ? 1 : -1;
    const tw = 4.4;
    const tx = s * (w / 2 - tw / 2 - 0.2);
    const rise = d * 0.38;
    const top = EAVE + rise * 0.5 + 3.2;
    block(S, at(tx, 0, EAVE - 0.5), X, tw, top - EAVE + 0.5, tw, wall);
    block(S, at(tx, 0, top), X, tw + 0.4, 0.35, tw + 0.4, trim);
    // 時計の文字盤 4 面
    for (const n of [X, Z, v3(-X.x, 0, -X.z), v3(-Z.x, 0, -Z.z)]) {
      const cc = add(at(tx, 0, top - 1.7), n, tw / 2 + 0.06);
      const ring = (rad: number, col: Rgb, lift: number) => {
        const u = v3(n.z, 0, -n.x);
        const pts = [...Array(16).keys()].map((i) =>
          add(
            add(add(cc, n, lift), u, Math.cos((i / 16) * Math.PI * 2) * rad),
            UP,
            Math.sin((i / 16) * Math.PI * 2) * rad,
          ),
        );
        for (let i = 1; i < 15; i++)
          S.tri(
            [pts[0], pts[i], pts[i + 1]],
            [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
            col,
          );
      };
      ring(1.45, C.black, 0.0);
      ring(1.3, hex("#f6f3ea"), 0.03);
      beam(S, add(cc, n, 0.08), add(add(cc, n, 0.08), UP, 0.95), 0.1, C.black);
      beam(
        S,
        add(cc, n, 0.08),
        add(add(add(cc, n, 0.08), UP, -0.3), v3(n.z, 0, -n.x), 0.7),
        0.1,
        C.black,
      );
    }
    // 鐘楼と屋根
    const bw = 3.4;
    block(S, at(tx, 0, top + 0.35), X, bw, 2.4, bw, wall);
    for (const n of [X, Z, v3(-X.x, 0, -X.z), v3(-Z.x, 0, -Z.z)])
      S.wall(
        add(
          add(at(tx, 0, top + 0.8), n, bw / 2 + 0.03),
          v3(n.z, 0, -n.x),
          -0.7,
        ),
        n,
        1.4,
        1.6,
        C.black,
        1,
      );
    const ry = y0 + top + 2.75;
    const q = (a: number, b: number) => at(tx + a, b, top + 2.75);
    pyramid(
      S,
      [q(-2, -2), q(2, -2), q(2, 2), q(-2, 2)],
      v3(at(tx, 0, 0).x, ry + 2.6, at(tx, 0, 0).z),
      roof,
    );
    const spireBase = at(tx, 0, top + 5.3);
    beam(S, spireBase, add(spireBase, UP, 1.6), 0.12, C.black);
    beam(
      S,
      add(spireBase, UP, 1.3),
      add(add(spireBase, UP, 1.3), X, 0.7),
      0.06,
      C.black,
    );
  }

  // ---- 北海道庁旧本庁舎（赤れんが） ----
  akarenga() {
    const f = this.replaced()[0];
    const fp = this.poly(f);
    const r = minRect(fp);
    const w = Math.min(r.w, 62),
      d = Math.min(r.d, 34);
    let X = r.X;
    let Z = v3(-X.z, 0, X.x);
    // 正面（長い面）は東（+x）を向く
    if (Z.x < 0) {
      X = v3(-X.x, 0, -X.z);
      Z = v3(-X.z, 0, X.x);
    }
    const y0 = this.base(fp) - 0.2;
    const S = this.P.solid;
    const at = (a: number, b: number, y: number) =>
      v3(r.cx + X.x * a + Z.x * b, y0 + y, r.cz + X.z * a + Z.z * b);
    const brick = hex("#9b3a2a"),
      trim = hex("#e6e0d2"),
      roof = hex("#4b5361"),
      win = hex("#2e363d");
    const BODY = 10.8;
    const wing = (a: number, b: number, ww: number, dd: number, hh: number) => {
      block(S, at(a, b, 0), X, ww + 0.4, 1.3, dd + 0.4, C.stone);
      block(S, at(a, b, 1.3), X, ww, hh - 1.3, dd, brick);
      block(S, at(a, b, 5.9), X, ww + 0.15, 0.35, dd + 0.15, trim);
      block(S, at(a, b, hh), X, ww + 0.5, 0.6, dd + 0.5, trim);
      for (const [n, ofs, len] of [
        [X, ww / 2, dd],
        [Z, dd / 2, ww],
        [v3(-X.x, 0, -X.z), ww / 2, dd],
        [v3(-Z.x, 0, -Z.z), dd / 2, ww],
      ] as [V3, number, number][]) {
        const u = v3(n.z, 0, -n.x);
        const p0 = add(add(at(a, b, 0), n, ofs), u, -len / 2);
        for (const fy of [2.0, 6.8])
          windows(S, p0, n, len, y0 + fy, 2.7, 1.3, 3.1, win, trim);
      }
    };
    wing(0, 0, w, d, BODY);
    // 正面の中央・両端の張り出し
    wing(0, d / 2 + 1.2, 15, 3, BODY + 1.4);
    for (const s of [1, -1])
      wing(s * (w / 2 - 5), d / 2 + 0.5, 10, 2, BODY + 0.6);
    for (const s of [1, -1])
      wing(s * (w / 2 - 5), -d / 2 - 0.5, 10, 2, BODY + 0.6);
    // 正面の破風と玄関の柱
    const pf = (a: number, y: number) => at(a, d / 2 + 2.75, y);
    S.tri(
      [pf(-7.5, BODY + 2), pf(7.5, BODY + 2), pf(0, BODY + 5)],
      [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      trim,
    );
    S.tri(
      [pf(7.5, BODY + 2), pf(-7.5, BODY + 2), pf(0, BODY + 5)].map((p) =>
        add(p, Z, -0.4),
      ),
      [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      trim,
    );
    for (const a of [-3, -1, 1, 3])
      cylinder(S, at(a, d / 2 + 4, 0.2), 0.3, 4.6, trim, 8);
    block(S, at(0, d / 2 + 3.8, 4.8), X, 9, 0.5, 3, trim);
    // 屋根（寄棟、急な勾配）と屋根窓
    hipRoof(S, at(0, 0, BODY + 0.6), X, w, d, 5.2, 0.3, roof);
    for (let a = -w / 2 + 6; a <= w / 2 - 6; a += 6.5)
      for (const s of [1, -1]) {
        const p = at(a, s * (d / 2 - 2.3), BODY + 1.2);
        block(S, p, X, 1.6, 1.8, 1.6, trim);
        gableRoof(S, add(p, UP, 1.8), Z, 1.6, 1.6, 0.8, 0.15, roof, trim);
      }
    // 中央の八角塔
    const tb = at(0, 0, BODY + 5.0);
    const oct = (rad: number, y: number) =>
      [...Array(8).keys()]
        .map((i): P2 => [
          tb.x + Math.cos(((i + 0.5) / 8) * Math.PI * 2) * rad,
          tb.z + Math.sin(((i + 0.5) / 8) * Math.PI * 2) * rad,
        ])
        .map((p) => v3(p[0], y, p[1]));
    const drum = oct(4.0, 0).map((p): P2 => [p.x, p.z]);
    prism(S, drum, tb.y - 1, tb.y + 5.2, brick, null);
    prism(
      S,
      drum.map(([x, z]): P2 => [
        tb.x + (x - tb.x) * 1.08,
        tb.z + (z - tb.z) * 1.08,
      ]),
      tb.y + 5.2,
      tb.y + 5.8,
      trim,
      null,
    );
    for (let i = 0; i < 8; i++) {
      const a = ((i + 1) / 8) * Math.PI * 2;
      const n = v3(Math.cos(a), 0, Math.sin(a));
      S.wall(
        add(add(v3(tb.x, tb.y + 1.2, tb.z), n, 3.75), v3(n.z, 0, -n.x), -0.6),
        n,
        1.2,
        2.8,
        win,
        1,
      );
    }
    let yb = tb.y + 5.8;
    for (const [r0, r1, h] of [
      [4.2, 3.2, 1.6],
      [3.2, 1.6, 1.8],
      [1.6, 0.9, 0.8],
    ] as const) {
      const a = oct(r0, yb),
        bb = oct(r1, yb + h);
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        S.quad(
          [a[j], a[i], bb[i], bb[j]],
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          roof,
        );
      }
      yb += h;
    }
    prism(
      S,
      oct(0.9, 0).map((p): P2 => [p.x, p.z]),
      yb,
      yb + 1.8,
      trim,
      null,
    );
    pyramid(S, oct(1.1, yb + 1.8), v3(tb.x, yb + 3.4, tb.z), roof);
    beam(
      S,
      v3(tb.x, yb + 3.2, tb.z),
      v3(tb.x, yb + 7.0, tb.z),
      0.12,
      C.frameWhite,
    );
  }

  // ---- 中島公園の豊平館 ----
  hoheikan() {
    const f = this.replaced()[0];
    if (!f) return;
    const fp = this.poly(f);
    const r = minRect(fp);
    const w = Math.min(r.w, 36),
      d = Math.min(r.d, 17);
    let X = r.X;
    let Z = v3(-X.z, 0, X.x);
    // 正面: 近くの池（一番大きい水面）の方
    const ponds = this.feats("water")
      .map((p) => this.poly(p))
      .sort((a, b) => b.length - a.length);
    if (ponds.length) {
      const pc = ponds[0].reduce(
        (a, p) => [
          a[0] + p[0] / ponds[0].length,
          a[1] + p[1] / ponds[0].length,
        ],
        [0, 0],
      );
      if ((pc[0] - r.cx) * Z.x + (pc[1] - r.cz) * Z.z < 0) {
        X = v3(-X.x, 0, -X.z);
        Z = v3(-X.z, 0, X.x);
      }
    }
    const y0 = this.base(fp) - 0.2;
    const S = this.P.solid;
    const at = (a: number, b: number, y: number) =>
      v3(r.cx + X.x * a + Z.x * b, y0 + y, r.cz + X.z * a + Z.z * b);
    const wall = hex("#f2f1ec"),
      blue = hex("#27459b"),
      roof = hex("#5f646b"),
      win = hex("#30383f");
    const EAVE = 9;
    block(S, at(0, 0, 0), X, w + 0.3, 0.8, d + 0.3, C.stone);
    block(S, at(0, 0, 0.8), X, w, EAVE - 0.8, d, wall);
    block(S, at(0, 0, EAVE - 0.4), X, w + 0.25, 0.4, d + 0.25, blue);
    block(S, at(0, 0, 4.7), X, w + 0.12, 0.25, d + 0.12, blue);
    for (const sx of [1, -1])
      for (const sz of [1, -1])
        block(
          S,
          at(sx * (w / 2 - 0.15), sz * (d / 2 - 0.15), 0.8),
          X,
          0.45,
          EAVE - 1.2,
          0.45,
          blue,
        );
    for (const [n, ofs, len] of [
      [X, w / 2, d],
      [Z, d / 2, w],
      [v3(-X.x, 0, -X.z), w / 2, d],
      [v3(-Z.x, 0, -Z.z), d / 2, w],
    ] as [V3, number, number][]) {
      const u = v3(n.z, 0, -n.x);
      const p0 = add(add(at(0, 0, 0), n, ofs), u, -len / 2);
      for (const fy of [1.5, 5.6])
        windows(S, p0, n, len, y0 + fy, 2.4, 1.1, 2.6, win, blue);
    }
    hipRoof(S, at(0, 0, EAVE), X, w, d, d * 0.32, 0.7, roof);
    // 正面の車寄せと 2 階の露台、半円の破風
    const pd = 4.2,
      pw = 8;
    for (const a of [-pw / 2 + 0.3, pw / 2 - 0.3])
      for (const fl of [0.8, 5.0])
        cylinder(S, at(a, d / 2 + pd - 0.4, fl), 0.22, 4.0, wall, 8);
    block(S, at(0, d / 2 + pd / 2, 4.6), X, pw + 0.4, 0.45, pd, blue);
    for (let a = -pw / 2; a <= pw / 2 + 0.01; a += 0.5)
      beam(
        S,
        at(a, d / 2 + pd - 0.2, 5.05),
        at(a, d / 2 + pd - 0.2, 5.95),
        0.06,
        blue,
      );
    beam(
      S,
      at(-pw / 2, d / 2 + pd - 0.2, 6.0),
      at(pw / 2, d / 2 + pd - 0.2, 6.0),
      0.12,
      blue,
    );
    block(S, at(0, d / 2 + pd / 2, 8.8), X, pw + 0.6, 0.45, pd + 0.4, blue);
    const arc = [...Array(9).keys()].map((i) => {
      const t = (i / 8) * Math.PI;
      return at(
        Math.cos(t) * (pw / 2 + 0.3),
        d / 2 + pd + 0.2,
        9.25 + Math.sin(t) * 2.4,
      );
    });
    for (let i = 0; i + 1 < arc.length; i++)
      S.tri(
        [at(0, d / 2 + pd + 0.2, 9.25), arc[i + 1], arc[i]].reverse(),
        [
          [0, 0],
          [1, 0],
          [0.5, 1],
        ],
        wall,
      );
    for (let i = 0; i + 1 < arc.length; i++)
      beam(S, arc[i], arc[i + 1], 0.25, blue);
    gableRoof(
      S,
      at(0, d / 2 + pd / 2 - 0.5, 9.25),
      Z,
      pd + 1,
      pw + 0.6,
      2.2,
      0.2,
      roof,
      null,
    );
  }

  // ---- 北海道大学 ----
  hokudai() {
    for (const f of this.feats("gate")) {
      const p = this.poly(f);
      if (p.length < 2) continue;
      const a = p[0],
        bb = p[p.length - 1];
      const dx = bb[0] - a[0],
        dz = bb[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const ux = dx / l,
        uz = dz / l;
      for (const [s, x, z] of [
        [-1, a[0], a[1]],
        [1, bb[0], bb[1]],
      ] as const) {
        const px = x - ux * s * 0.6,
          pz = z - uz * s * 0.6;
        block(
          this.P.solid,
          v3(px, this.g(px, pz) - 0.2, pz),
          v3(ux, 0, uz),
          0.9,
          2.9,
          0.9,
          C.granite,
        );
        block(
          this.P.solid,
          v3(px, this.g(px, pz) + 2.7, pz),
          v3(ux, 0, uz),
          1.15,
          0.3,
          1.15,
          C.stone,
        );
        // 門から左右へ低い塀
        const ex = px - ux * s * 9,
          ez = pz - uz * s * 9;
        const yy = Math.min(this.g(px, pz), this.g(ex, ez));
        beam(
          this.P.solid,
          v3(px, yy + 0.5, pz),
          v3(ex, yy + 0.5, ez),
          0.5,
          C.stone,
          1.1,
        );
      }
    }
  }

  // ---- 北海道神宮 ----
  jingu() {
    const S = this.P.solid;
    const paths = this.feats("path").map((f) => this.poly(f));
    for (const f of this.feats("torii")) {
      const p = this.poly(f);
      let a: P2, bb: P2;
      const big = /令和|第[一二三]/.test(f.tags.name ?? "");
      if (p.length >= 2) {
        a = p[0];
        bb = p[p.length - 1];
      } else {
        // 点の鳥居: 一番近い参道に直交させる
        const [x, z] = p[0];
        let best = { d: Infinity, ux: 1, uz: 0 };
        for (const q of paths)
          for (let i = 0; i + 1 < q.length; i++) {
            const dx = q[i + 1][0] - q[i][0],
              dz = q[i + 1][1] - q[i][1];
            const l2 = dx * dx + dz * dz || 1;
            const t = Math.max(
              0,
              Math.min(1, ((x - q[i][0]) * dx + (z - q[i][1]) * dz) / l2),
            );
            const dd = Math.hypot(q[i][0] + dx * t - x, q[i][1] + dz * t - z);
            if (dd < best.d)
              best = { d: dd, ux: dx / Math.sqrt(l2), uz: dz / Math.sqrt(l2) };
          }
        const span = big ? 8 : 4.5;
        a = [x + (best.uz * span) / 2, z - (best.ux * span) / 2];
        bb = [x - (best.uz * span) / 2, z + (best.ux * span) / 2];
      }
      this.torii(
        a,
        bb,
        f.tags.material === "wood" ? hex("#6e5238") : hex("#7b7a76"),
      );
    }
    // 社殿: 置き換える建物ごと
    const wood = hex("#b99b70"),
      white = hex("#efece4"),
      roof = C.copper;
    for (const f of this.replaced()) {
      const fp = this.poly(f);
      const r = minRect(fp);
      const y0 = this.base(fp) - 0.2;
      const area = r.w * r.d;
      if (area > 2500) {
        // 回廊で囲んだ本殿の一画: 外形に沿う回廊と、中の拝殿
        for (let i = 0; i < fp.length; i++) {
          const a = fp[i],
            bb = fp[(i + 1) % fp.length];
          const l = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
          if (l < 3) continue;
          const X = v3((bb[0] - a[0]) / l, 0, (bb[1] - a[1]) / l);
          const mid = v3((a[0] + bb[0]) / 2, y0, (a[1] + bb[1]) / 2);
          block(S, mid, X, l, 4, 4.5, white);
          gableRoof(S, add(mid, UP, 4), X, l, 4.5, 1.8, 0.9, roof, white);
        }
        const hall = v3(r.cx, y0, r.cz);
        block(S, hall, r.X, 22, 6.5, 14, wood);
        gableRoof(S, add(hall, UP, 6.5), r.X, 22, 14, 6, 2.4, roof, wood);
        gableRoof(
          S,
          add(hall, UP, 9.4),
          v3(-r.X.z, 0, r.X.x),
          7,
          6,
          2.5,
          0.5,
          roof,
          wood,
        );
        continue;
      }
      const h = area > 600 ? 6 : area > 120 ? 4.5 : 3.2;
      block(S, v3(r.cx, y0, r.cz), r.X, r.w, 0.6, r.d, C.stone);
      block(
        S,
        v3(r.cx, y0 + 0.6, r.cz),
        r.X,
        r.w - 0.4,
        h,
        r.d - 0.4,
        area > 200 ? white : wood,
      );
      // 柱
      const Z = v3(-r.X.z, 0, r.X.x);
      for (
        let a = -r.w / 2 + 0.3;
        a <= r.w / 2 - 0.2;
        a += Math.max(2.2, r.w / 8)
      )
        for (const s of [1, -1])
          block(
            S,
            v3(
              r.cx + r.X.x * a + Z.x * s * (r.d / 2 - 0.15),
              y0 + 0.6,
              r.cz + r.X.z * a + Z.z * s * (r.d / 2 - 0.15),
            ),
            r.X,
            0.35,
            h,
            0.35,
            wood,
          );
      gableRoof(
        S,
        v3(r.cx, y0 + 0.6 + h, r.cz),
        r.X,
        r.w,
        r.d,
        Math.min(r.d * 0.45, 7),
        Math.min(2.2, 0.6 + r.d * 0.1),
        roof,
        wood,
      );
    }
  }

  /** 明神鳥居（柱の足 a・b） */
  torii(a: P2, bb: P2, col: Rgb) {
    const S = this.P.solid;
    const span = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
    if (span < 1.5) return;
    const H = span * 1.18;
    const X = v3((bb[0] - a[0]) / span, 0, (bb[1] - a[1]) / span);
    const y = Math.min(this.g(a[0], a[1]), this.g(bb[0], bb[1]));
    const pr = span * 0.05;
    for (const p of [a, bb])
      cylinder(
        S,
        v3(p[0], y - 0.3, p[1]),
        pr * 1.1,
        H + 0.3,
        col,
        10,
        pr * 0.9,
      );
    const mid = v3((a[0] + bb[0]) / 2, y, (a[1] + bb[1]) / 2);
    // 笠木（両端を少し反らせる）と島木
    const top = y + H;
    const ext = span * 0.75;
    const L = add(mid, X, -ext),
      R = add(mid, X, ext);
    beam(
      S,
      add(L, UP, top - y + pr * 2.6),
      add(add(mid, UP, top - y + pr * 2.2), X, -span * 0.2),
      pr * 1.4,
      col,
      pr * 2.2,
    );
    beam(
      S,
      add(add(mid, UP, top - y + pr * 2.2), X, -span * 0.2),
      add(add(mid, UP, top - y + pr * 2.2), X, span * 0.2),
      pr * 1.4,
      col,
      pr * 2.2,
    );
    beam(
      S,
      add(add(mid, UP, top - y + pr * 2.2), X, span * 0.2),
      add(R, UP, top - y + pr * 2.6),
      pr * 1.4,
      col,
      pr * 2.2,
    );
    beam(
      S,
      add(add(mid, X, -span * 0.64), UP, top - y + pr * 0.6),
      add(add(mid, X, span * 0.64), UP, top - y + pr * 0.6),
      pr * 1.2,
      col,
      pr * 1.4,
    );
    // 貫と額束
    beam(
      S,
      add(add(mid, X, -span * 0.62), UP, H * 0.74),
      add(add(mid, X, span * 0.62), UP, H * 0.74),
      pr * 0.8,
      col,
      pr * 1.3,
    );
    beam(
      S,
      add(mid, UP, H * 0.74),
      add(mid, UP, top - y),
      pr * 0.7,
      shade(col, 0.8),
      pr * 1.2,
    );
  }

  // ---- 旭山記念公園 ----
  asahiyama() {
    const S = this.P.solid;
    const vp = this.feats("viewpoint")[0];
    const [vx, vz] = vp ? this.pt(vp) : [0, 0];
    const vy = this.g(vx, vz);
    // 展望広場: 舗装の円と、下り側の手すり
    const R = 17;
    const ring = [...Array(28).keys()].map((i): P2 => [
      vx + Math.cos((i / 28) * Math.PI * 2) * R,
      vz + Math.sin((i / 28) * Math.PI * 2) * R,
    ]);
    fillPolygon(
      this.P.ground,
      ring,
      (x, z) => Math.max(this.g(x, z), vy - 0.6) + 0.08,
      (x, z) =>
        Math.floor(Math.hypot(x - vx, z - vz) / 2.2) % 2
          ? C.paving
          : shade(C.paving, 0.92),
    );
    this.keepOut.push([vx, vz, R + 0.5]);
    for (let i = 0; i < 28; i++) {
      const [x, z] = ring[i],
        [x2, z2] = ring[(i + 1) % 28];
      if (this.g(x, z) > vy - 1.2 && this.g(x2, z2) > vy - 1.2) continue;
      const y1 = Math.max(this.g(x, z), vy - 0.6) + 0.08,
        y2 = Math.max(this.g(x2, z2), vy - 0.6) + 0.08;
      beam(S, v3(x, y1 - 1.5, z), v3(x, y1 + 1.1, z), 0.12, C.black);
      beam(S, v3(x, y1 + 1.1, z), v3(x2, y2 + 1.1, z2), 0.1, C.black);
      beam(S, v3(x, y1 + 0.5, z), v3(x2, y2 + 0.5, z2), 0.05, C.black);
      // 広場の縁の石段（地面より高い所の側面）
      S.quad(
        [
          v3(x, y1 - 1.5, z),
          v3(x2, y2 - 1.5, z2),
          v3(x2, y2, z2),
          v3(x, y1, z),
        ],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        C.granite,
      );
      S.quad(
        [
          v3(x2, y2 - 1.5, z2),
          v3(x, y1 - 1.5, z),
          v3(x, y1, z),
          v3(x2, y2, z2),
        ],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        C.granite,
      );
    }
    // レストハウスと展望の屋根
    for (const f of this.replaced()) {
      const fp = this.poly(f);
      const r = minRect(fp);
      const y0 = this.base(fp) - 0.2;
      if (r.w * r.d > 150) {
        block(S, v3(r.cx, y0, r.cz), r.X, r.w, 4, r.d, hex("#c8c2b6"));
        block(
          this.P.shiny,
          v3(r.cx, y0 + 4, r.cz),
          r.X,
          r.w - 0.6,
          3.2,
          r.d - 0.6,
          C.glass,
        );
        block(
          S,
          v3(r.cx, y0 + 7.2, r.cz),
          r.X,
          r.w + 1.2,
          0.5,
          r.d + 1.2,
          hex("#6d5a46"),
        );
        windows(
          this.P.shiny,
          add(v3(r.cx, 0, r.cz), v3(-r.X.z, 0, r.X.x), r.d / 2),
          v3(-r.X.z, 0, r.X.x),
          r.w * 0.8,
          y0 + 0.8,
          2.6,
          2.4,
          3,
          C.glass,
        );
      } else {
        for (const sx of [1, -1])
          for (const sz of [1, -1]) {
            const Z = v3(-r.X.z, 0, r.X.x);
            const px =
                r.cx +
                r.X.x * sx * (r.w / 2 - 0.3) +
                Z.x * sz * (r.d / 2 - 0.3),
              pz =
                r.cz +
                r.X.z * sx * (r.w / 2 - 0.3) +
                Z.z * sz * (r.d / 2 - 0.3);
            block(S, v3(px, y0, pz), r.X, 0.3, 3.2, 0.3, hex("#6d5a46"));
          }
        block(
          S,
          v3(r.cx, y0 + 3.2, r.cz),
          r.X,
          r.w + 0.8,
          0.4,
          r.d + 0.8,
          hex("#6d5a46"),
        );
      }
    }
    for (const f of this.feats("fountain"))
      if (f.pts.length >= 6) this.fountain(this.poly(f), 2);
    // 頂上の芝生広場と、まわりの林
    const zone = this.zone();
    const lawnR = 85;
    this.lawn(
      [...Array(32).keys()].map((i): P2 => [
        vx + Math.cos((i / 32) * Math.PI * 2) * lawnR,
        vz + Math.sin((i / 32) * Math.PI * 2) * lawnR,
      ]),
      this.ctx.light ? 4 : 3,
      this.lawnColor(C.lawn),
      0.07,
      (x, z) => !insidePolygon(zone.flat(), x, z),
    );
    this.fillTrees(
      zone,
      this.ctx.light ? 16 : 12,
      () =>
        treeKind(
          null,
          ["カエデ", "ハルニレ", "マツ", ""][Math.floor(this.rnd() * 4)],
        ),
      (x, z) =>
        Math.hypot(x - vx, z - vz) < lawnR + 4 ||
        this.ctx.onRoad(x + this.ox, z + this.oz, 3),
    );
  }

  // ---- 藻岩山展望台 ----
  moiwa() {
    const S = this.P.solid;
    const f = this.replaced()[0];
    const fp = this.poly(f);
    const r = minRect(fp);
    const top = Math.max(...fp.map((p) => this.g(p[0], p[1])));
    const y0 = this.base(fp) - 0.3;
    const X = r.X,
      Z = v3(-X.z, 0, X.x);
    const c = v3(r.cx, 0, r.cz);
    const base = top + 0.2;
    block(
      S,
      v3(c.x, y0, c.z),
      X,
      r.w * 0.85,
      base - y0 + 4.2,
      r.d * 0.8,
      hex("#8f8d88"),
    );
    block(
      this.P.shiny,
      v3(c.x, base + 4.2, c.z),
      X,
      r.w,
      3.8,
      r.d,
      C.glassLight,
    );
    for (let a = -r.w / 2; a <= r.w / 2 + 0.01; a += 2.5)
      for (const s of [1, -1])
        block(
          S,
          add(add(v3(c.x, base + 4.2, c.z), X, a), Z, (s * r.d) / 2),
          X,
          0.18,
          3.8,
          0.18,
          C.frameWhite,
        );
    block(
      S,
      v3(c.x, base + 8.0, c.z),
      X,
      r.w + 1.2,
      0.5,
      r.d + 1.2,
      C.frameWhite,
    );
    // 屋上の展望の手すり
    const rail = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) =>
      add(
        add(v3(c.x, base + 8.5, c.z), X, (a * (r.w + 1)) / 2),
        Z,
        (b * (r.d + 1)) / 2,
      ),
    );
    for (let i = 0; i < 4; i++) {
      const p = rail[i],
        q = rail[(i + 1) % 4];
      const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 2);
      for (let k = 0; k <= n; k++)
        beam(
          S,
          lerp3(p, q, k / n),
          add(lerp3(p, q, k / n), UP, 1.1),
          0.07,
          C.black,
        );
      beam(S, add(p, UP, 1.1), add(q, UP, 1.1), 0.08, C.black);
    }
    block(
      S,
      add(add(v3(c.x, base + 8.5, c.z), X, -r.w / 2 + 3.5), Z, 0),
      X,
      5,
      3,
      4.5,
      hex("#9a978f"),
    );
    // 鐘の門（屋上の端）
    const bp = add(add(v3(c.x, base + 8.5, c.z), X, r.w / 2 - 3), Z, 0);
    beam(
      S,
      add(bp, Z, -1.2),
      add(add(bp, Z, -1.2), UP, 2.6),
      0.18,
      C.frameWhite,
    );
    beam(S, add(bp, Z, 1.2), add(add(bp, Z, 1.2), UP, 2.6), 0.18, C.frameWhite);
    beam(
      S,
      add(add(bp, Z, -1.3), UP, 2.6),
      add(add(bp, Z, 1.3), UP, 2.6),
      0.2,
      C.frameWhite,
    );
    cylinder(S, add(bp, UP, 1.7), 0.35, 0.7, hex("#c9a443"), 10, 0.18);
  }

  // ---- モエレ沼公園 ----
  moere() {
    const S = this.P.solid;
    const glass = hex("#b9d3dd");
    const pyr = this.lm.features.find(
      (f) =>
        f.t === "building" && f.replace && /ピラミッド/.test(f.tags.name ?? ""),
    );
    if (pyr) {
      const fp = this.poly(pyr);
      const r = minRect(fp);
      const y0 = this.base(fp) - 0.2;
      const X = r.X,
        Z = v3(-X.z, 0, X.x);
      // 本体の四角錐（外形の片側）と、低い硝子の棟
      const side = Math.min(r.d, r.w * 0.62);
      const pc = add(v3(r.cx, y0, r.cz), X, r.w / 2 - side / 2);
      const P = (a: number, b: number, y: number) =>
        v3(pc.x + X.x * a + Z.x * b, y0 + y, pc.z + X.z * a + Z.z * b);
      const h = side * 0.95;
      const base4 = [
        P(-side / 2, -side / 2, 1),
        P(side / 2, -side / 2, 1),
        P(side / 2, side / 2, 1),
        P(-side / 2, side / 2, 1),
      ];
      block(S, P(0, 0, 0), X, side + 1, 1, side + 1, C.granite);
      pyramid(this.P.shiny, base4, P(0, 0, h + 1), glass);
      const apex = P(0, 0, h + 1);
      for (const p of base4) beam(S, p, apex, 0.35, C.frameWhite);
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const q = base4.map((p) => lerp3(p, apex, t));
        for (let i = 0; i < 4; i++)
          beam(S, q[i], q[(i + 1) % 4], 0.12, C.frameWhite);
      }
      const ww = r.w - side;
      if (ww > 4) {
        const wc = add(v3(r.cx, y0, r.cz), X, -side / 2);
        block(this.P.shiny, wc, X, ww, 9, r.d * 0.8, glass);
        block(
          S,
          add(wc, UP, 9),
          X,
          ww + 0.4,
          0.5,
          r.d * 0.8 + 0.4,
          C.frameWhite,
        );
        for (let a = -ww / 2; a <= ww / 2 + 0.01; a += 3)
          for (const s of [1, -1])
            block(
              S,
              add(add(wc, X, a), Z, (s * r.d * 0.8) / 2),
              X,
              0.15,
              9,
              0.15,
              C.frameWhite,
            );
      }
    }
    for (const f of this.feats("fountain"))
      if (f.pts.length >= 6) this.fountain(this.poly(f), 6);
    // 芝: 札のある芝と、公園の区域の開けた所
    const grass = this.feats("grass").filter((f) => f.pts.length >= 6);
    for (const f of grass)
      this.lawn(this.poly(f), this.ctx.light ? 5 : 4, this.lawnColor(C.lawn));
  }

  // ---- 大倉山ジャンプ競技場 ----
  okurayama() {
    const S = this.P.solid;
    const lines = this.feats("skijump");
    const takeoff = this.feats("takeoff")[0];
    // 助走路 man_made=ski_jump、着地の斜面の面 leisure=pitch、斜面の線 piste:type=ski_jump
    const inrun = lines.find((f) => f.tags.man_made === "ski_jump");
    const area = lines.find((f) => f.tags.leisure === "pitch");
    const landing = lines.find((f) => f !== inrun && f !== area);
    if (inrun) {
      let p = this.poly(inrun);
      if (
        this.g(p[0][0], p[0][1]) <
        this.g(p[p.length - 1][0], p[p.length - 1][1])
      )
        p = p.reverse();
      if (takeoff) {
        const t = this.pt(takeoff);
        const last = p[p.length - 1];
        if (Math.hypot(last[0] - t[0], last[1] - t[1]) > 3) p.push(t);
      }
      const yTop = this.g(p[0][0], p[0][1]) + 6;
      const end = p[p.length - 1];
      const yEnd = this.g(end[0], end[1]) + 3;
      let total = 0;
      const acc = [0];
      for (let i = 1; i < p.length; i++)
        acc.push(
          (total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])),
        );
      // 道のり 2m ごとに、直線の勾配 + 終わりの 25m で水平へ曲げる
      const pts: V3[] = [];
      for (let s = 0; s <= total; s += 2) {
        let i = 1;
        while (i < acc.length - 1 && acc[i] < s) i++;
        const t = (s - acc[i - 1]) / (acc[i] - acc[i - 1] || 1);
        const x = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t,
          z = p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t;
        const u = s / total;
        const bend = Math.max(0, (s - (total - 25)) / 25);
        let y = yTop + (yEnd - yTop) * (u - 0.25 * bend * bend * (1 - u) * 4);
        y = Math.max(y, this.g(x, z) + 0.8);
        pts.push(v3(x, y, z));
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i],
          bb = pts[i + 1];
        const dx = bb.x - a.x,
          dz = bb.z - a.z,
          l = Math.hypot(dx, dz) || 1;
        const n = v3(-dz / l, 0, dx / l);
        const hw = 3.2;
        const q = [
          add(a, n, -hw),
          add(bb, n, -hw),
          add(bb, n, hw),
          add(a, n, hw),
        ];
        quadUp(S, q, i % 2 ? hex("#e6e8ea") : hex("#dcdfe2"));
        quadUp(
          S,
          q.map((v) => add(v, UP, -0.3)),
          shade(hex("#9aa0a6"), 0.8),
          false,
        );
        // 2 本の溝
        for (const off of [-0.9, 0.9])
          beam(
            S,
            add(add(a, n, off), UP, 0.05),
            add(add(bb, n, off), UP, 0.05),
            0.15,
            hex("#7d858c"),
            0.04,
          );
        // 側壁
        for (const s of [-1, 1])
          beam(
            S,
            add(add(a, n, s * hw), UP, 0.45),
            add(add(bb, n, s * hw), UP, 0.45),
            0.15,
            C.frameWhite,
            0.9,
          );
        // 支え（地面から 1.5m 以上の所、6m ごと）
        if (i % 3 === 0 && a.y - this.g(a.x, a.z) > 1.5)
          for (const s of [-1, 1]) {
            const pb = add(a, n, s * (hw - 0.4));
            beam(
              S,
              pb,
              v3(pb.x, this.g(pb.x, pb.z) - 0.5, pb.z),
              0.45,
              hex("#8d9399"),
            );
          }
      }
      // 踏み切りの台
      const e = pts[pts.length - 1];
      block(
        S,
        v3(e.x, this.g(e.x, e.z) - 0.5, e.z),
        v3(1, 0, 0),
        4,
        e.y - this.g(e.x, e.z) + 0.4,
        4,
        hex("#9aa0a6"),
      );
    }
    // 着地の斜面（夏は人工芝）と 10m ごとの白い線
    if (area) {
      const poly = this.poly(area);
      let dir: P2 = [1, 0];
      let org: P2 = poly[0];
      if (landing) {
        const lp = this.poly(landing);
        const a = lp[0],
          bb = lp[lp.length - 1];
        const l = Math.hypot(bb[0] - a[0], bb[1] - a[1]) || 1;
        dir = [(bb[0] - a[0]) / l, (bb[1] - a[1]) / l];
        org = a;
      }
      this.lawn(
        poly,
        this.ctx.light ? 3 : 2,
        (x, z) => {
          const s = (x - org[0]) * dir[0] + (z - org[1]) * dir[1];
          const k = ((s % 10) + 10) % 10;
          return k < 1.6
            ? hex("#e4e6e0")
            : shade(hex("#5a8c46"), 0.95 + (Math.floor(s / 10) % 2) * 0.06);
        },
        0.1,
      );
      // 審判の塔: 斜面の中ほどの横
      const zc = poly.reduce(
        (a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length],
        [0, 0],
      );
      const side = v3(-dir[1], 0, dir[0]);
      let best: V3 | null = null;
      for (const s of [1, -1])
        for (let k = 12; k < 60; k += 2) {
          const p = v3(
            zc[0] + side.x * s * k - dir[0] * 20,
            0,
            zc[1] + side.z * s * k - dir[1] * 20,
          );
          if (!insidePolygon(poly.flat(), p.x, p.z)) {
            best = best ?? add(p, side, s * 4);
            break;
          }
        }
      if (best) {
        const y = this.g(best.x, best.z);
        block(
          S,
          v3(best.x, y - 0.5, best.z),
          v3(dir[0], 0, dir[1]),
          6,
          12.5,
          5,
          hex("#d7d4cc"),
        );
        block(
          this.P.shiny,
          v3(best.x, y + 12, best.z),
          v3(dir[0], 0, dir[1]),
          6.4,
          3,
          5.4,
          C.glass,
        );
        block(
          S,
          v3(best.x, y + 15, best.z),
          v3(dir[0], 0, dir[1]),
          7,
          0.5,
          6,
          hex("#55606b"),
        );
      }
    }
    // スタートハウス（展望ラウンジ）
    for (const f of this.replaced()) {
      const fp = this.poly(f);
      const r = minRect(fp);
      const y0 = this.base(fp) - 0.3;
      block(
        S,
        v3(r.cx, y0, r.cz),
        r.X,
        r.w * 0.8,
        9,
        r.d * 0.8,
        hex("#c9c6bf"),
      );
      block(this.P.shiny, v3(r.cx, y0 + 9, r.cz), r.X, r.w, 4, r.d, C.glass);
      block(
        S,
        v3(r.cx, y0 + 13, r.cz),
        r.X,
        r.w + 1,
        0.6,
        r.d + 1,
        hex("#55606b"),
      );
    }
    // リフト: 線の点ごとに支柱、上に 2 本の索
    for (const f of this.feats("lift")) {
      const p = this.poly(f);
      const tops: V3[] = [];
      for (const [x, z] of p) {
        const y = this.g(x, z);
        beam(S, v3(x, y - 0.3, z), v3(x, y + 7, z), 0.4, hex("#7a8188"));
        tops.push(v3(x, y + 7, z));
      }
      for (let i = 0; i + 1 < tops.length; i++) {
        const a = tops[i],
          bb = tops[i + 1];
        const l = Math.hypot(bb.x - a.x, bb.z - a.z) || 1;
        const n = v3(-(bb.z - a.z) / l, 0, (bb.x - a.x) / l);
        beam(S, add(a, n, -1.8), add(a, n, 1.8), 0.25, hex("#7a8188"));
        for (const s of [-1.6, 1.6])
          beam(S, add(a, n, s), add(bb, n, s), 0.05, C.black);
      }
    }
  }

  // ---- 羊ヶ丘展望台 ----
  hitsujigaoka() {
    const S = this.P.solid;
    const st = this.feats("statue")[0];
    const [sx, sz] = st ? this.pt(st) : [0, 0];
    const sy = this.g(sx, sz);
    // 像の広場
    const R = 9;
    const ring = [...Array(20).keys()].map((i): P2 => [
      sx + Math.cos((i / 20) * Math.PI * 2) * R,
      sz + Math.sin((i / 20) * Math.PI * 2) * R,
    ]);
    fillPolygon(this.P.ground, ring, (x, z) => this.g(x, z) + 0.08, C.paving);
    this.keepOut.push([sx, sz, R + 0.5]);
    // 台座と、遠くを指す立像（札幌の中心の方を向く）
    const dl = Math.hypot(this.ox + sx, this.oz + sz) || 1;
    const F = v3(-(this.ox + sx) / dl, 0, -(this.oz + sz) / dl);
    const Rt = v3(-F.z, 0, F.x);
    const b0 = v3(sx, sy, sz);
    block(S, b0, F, 2.6, 0.5, 2.6, C.granite);
    block(S, add(b0, UP, 0.5), F, 1.7, 2.1, 1.7, C.darkStone);
    const s0 = add(b0, UP, 2.6);
    const B = C.bronze;
    const K = 1.3;
    for (const s of [-1, 1])
      beam(
        S,
        add(s0, Rt, s * 0.2 * K),
        add(add(s0, Rt, s * 0.18 * K), UP, 1.15 * K),
        0.26 * K,
        B,
      );
    block(
      S,
      add(s0, UP, 0.7 * K),
      F,
      0.62 * K,
      1.3 * K,
      0.85 * K,
      shade(B, 0.95),
    );
    block(S, add(s0, UP, 1.9 * K), F, 0.5 * K, 0.45 * K, 0.6 * K, B);
    block(S, add(s0, UP, 2.38 * K), F, 0.26 * K, 0.3 * K, 0.28 * K, B);
    const sh = add(add(s0, UP, 2.25 * K), Rt, 0.32 * K);
    beam(S, sh, add(add(sh, F, 0.62 * K), UP, 0.42 * K), 0.16 * K, B);
    const sl = add(add(s0, UP, 2.2 * K), Rt, -0.32 * K);
    beam(S, sl, add(add(sl, UP, -0.75 * K), F, 0.12 * K), 0.16 * K, B);
    // 牧草地と柵、羊
    const zone = this.zone();
    this.lawn(zone, this.ctx.light ? 5 : 4, this.lawnColor(C.lawnDry));
    const fence: P2[] = zone;
    for (let i = 0; i < fence.length; i++) {
      const [ax, az] = fence[i],
        [bx, bz] = fence[(i + 1) % fence.length];
      const l = Math.hypot(bx - ax, bz - az);
      if (
        Math.min(Math.hypot(ax - sx, az - sz), Math.hypot(bx - sx, bz - sz)) >
        160
      )
        continue;
      const n = Math.max(1, Math.ceil(l / 2.5));
      let prev: V3 | null = null;
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n,
          z = az + ((bz - az) * k) / n;
        if (
          this.ctx.onRoad(x + this.ox, z + this.oz, 1) ||
          this.keepOutPolys.some((q) => insidePolygon(q.flat(), x, z)) ||
          this.keepOut.some(
            ([cx, cz, rr]) => (cx - x) ** 2 + (cz - z) ** 2 < (rr + 1) ** 2,
          )
        ) {
          prev = null;
          continue;
        }
        const y = this.g(x, z);
        beam(S, v3(x, y - 0.2, z), v3(x, y + 1.1, z), 0.12, C.white);
        const p = v3(x, y, z);
        if (prev)
          for (const hgt of [0.5, 1.0])
            beam(S, add(prev, UP, hgt), add(p, UP, hgt), 0.07, C.white, 0.12);
        prev = p;
      }
    }
    const flat = zone.flat();
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < 16; tries++) {
      const a = this.rnd() * Math.PI * 2,
        d = 28 + this.rnd() * 80;
      const x = sx + Math.cos(a) * d,
        z = sz + Math.sin(a) * d;
      if (
        !insidePolygon(flat, x, z) ||
        this.ctx.onRoad(x + this.ox, z + this.oz, 3) ||
        this.keepOutPolys.some((q) => insidePolygon(q.flat(), x, z))
      )
        continue;
      const y = this.g(x, z);
      const f = v3(Math.cos(a * 3.1), 0, Math.sin(a * 3.1));
      const r = v3(-f.z, 0, f.x);
      const wool = hex("#e8e2d2"),
        dark = hex("#3b3430");
      block(S, v3(x, y + 0.42, z), f, 1.15, 0.62, 0.68, wool);
      block(S, add(v3(x, y + 0.75, z), f, 0.68), f, 0.32, 0.32, 0.3, dark);
      for (const [fa, ra] of [
        [0.4, 0.22],
        [0.4, -0.22],
        [-0.4, 0.22],
        [-0.4, -0.22],
      ] as const) {
        const p = add(add(v3(x, y, z), f, fa), r, ra);
        beam(S, p, add(p, UP, 0.45), 0.09, dark);
      }
      placed++;
    }
  }
}
