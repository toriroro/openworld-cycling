// 北海道の世界の電柱・電線と街灯（北海道の草案 26 章）。置き場所は変換で決める（scripts/hokkaido/poles.ts）。
// 範囲の電柱・変圧器・防犯灯・街灯を 1 つの形に焼き込み（影を落とす近くの分と遠くの分の 2 つ）、電線は 1 つの線の集まりにする（描画命令 3）。
// 灯りは夜と霧で光らせる（道を照らす光源は作らない。車の灯火と同じ）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { type HokkaidoSidewalks, POLE_FLAGS, POLE_REC } from "../shared/world/hokkaido.ts";
import type { TerrainLike } from "../shared/world/terrain.ts";

/** 電柱の上の腕金の高さ・通信線の高さ (m)。電線を張る高さ */
const TOP = 10.2;
const LOW = 6.4;

type Part = { geo: THREE.BufferGeometry; color: string; glow?: number };

function part(geo: THREE.BufferGeometry, x: number, y: number, z: number, color: string, glow = 0): Part {
  geo.translate(x, y, z);
  return { geo, color, glow };
}

/** 部品を色と glow の頂点属性つきで 1 つの形に */
function merged(parts: Part[]): THREE.BufferGeometry {
  const gs = parts.map(({ geo, color, glow }) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute("uv");
    const n = g.getAttribute("position").count;
    const c = new THREE.Color(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute("glow", new THREE.Float32BufferAttribute(new Float32Array(n).fill(glow ?? 0), 1));
    return g;
  });
  return mergeGeometries(gs)!;
}

/** 形（局所座標: +X が道に沿う向き／街灯の腕の向き、+Z が道の方、y = 0 が地面） */
function shapes() {
  const C_POLE = "#9a9892", C_ARM = "#6f7275", C_TRANS = "#8d9094", C_LAMP = "#e8ebe6", C_LIGHT = "#8a8e92";
  const pole = merged([
    part(new THREE.CylinderGeometry(0.11, 0.17, TOP + 1.3, 8, 1, true), 0, (TOP + 1.3) / 2 - 0.5, 0, C_POLE),
    part(new THREE.BoxGeometry(0.09, 0.09, 1.7), 0, TOP, 0, C_ARM),
    part(new THREE.BoxGeometry(0.07, 0.07, 1.1), 0, TOP - 0.9, 0, C_ARM),
    part(new THREE.BoxGeometry(0.06, 0.12, 0.3), 0, LOW, 0, C_ARM),
  ]);
  const transformer = merged([part(new THREE.CylinderGeometry(0.27, 0.27, 0.85, 8), 0.42, 8.0, 0, C_TRANS)]);
  // 防犯灯: 道の方（+Z）へ出した短い腕と灯具
  const lamp = merged([part(new THREE.BoxGeometry(0.05, 0.05, 1.3), 0, 5.6, 0.7, C_ARM), part(new THREE.BoxGeometry(0.2, 0.1, 0.55), 0, 5.55, 1.45, C_LAMP, 1)]);
  // 街灯（道路照明）: 細い柱と、道の方（+X）へ出す腕と灯具
  const street = merged([
    part(new THREE.CylinderGeometry(0.07, 0.12, 10.4, 8, 1, true), 0, 4.95, 0, C_LIGHT),
    part(new THREE.BoxGeometry(2.1, 0.08, 0.08), 1.0, 9.85, 0, C_LIGHT),
    part(new THREE.BoxGeometry(0.75, 0.14, 0.3), 2.2, 9.8, 0, C_LIGHT),
    part(new THREE.BoxGeometry(0.66, 0.06, 0.26), 2.2, 9.71, 0, C_LAMP, 1),
  ]);
  return { pole, transformer, lamp, street };
}

/** 頂点の glow の量だけ、頂点色で光らせる材質（traffic-view.ts と同じ） */
function glowMaterial(lights: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLights = lights;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;\nuniform float uLights;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * uLights;");
  };
  m.customProgramCacheKey = () => "poles-glow-v1";
  return m;
}

type Kind = "pole" | "transformer" | "lamp" | "street";

export class RealPoles {
  readonly group = new THREE.Group();
  /** 描く範囲・影を落とす範囲 (m)【初期値】 */
  range = 450;
  shadowRange = 220;
  private readonly lights = { value: 0 };
  readonly material: THREE.MeshStandardMaterial;
  private readonly wireMat = new THREE.LineBasicMaterial({ color: "#26282a", transparent: true, opacity: 0.6 });
  private readonly geos = shapes();
  private objects: (THREE.Mesh | THREE.LineSegments)[] = [];
  private key = "";
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  private at = { x: 0, z: 0 };
  stats = { poles: 0, streetlights: 0, spans: 0 };
  /** 作り直しにかかった時間 (ms) */
  readonly buildMs: number[] = [];
  /** 区画ごとに焼き込んだ形（区画の隅からの相対）。範囲が変わったらつなぎ直すだけにする */
  private readonly cellCache = new Map<string, CellBake>();

  constructor(
    private data: HokkaidoSidewalks,
    private heights: TerrainLike,
    /** (x, z) の地形の頁を読み終えているか（走らない道の電柱の高さを地形から取るので、読む前の区画は焼き直す） */
    private terrainReady: (x: number, z: number) => boolean = () => true,
  ) {
    this.group.name = "real-poles";
    this.material = glowMaterial(this.lights);
  }

  setQuality(light: boolean) {
    this.range = light ? 260 : 450;
    this.shadowRange = light ? 0 : 220;
    this.key = "";
    this.lastT = 0;
  }

  /** 灯りの明るさ（0 = 昼、夜と霧で上げる） */
  setLights(v: number) {
    this.lights.value = v;
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
        if (this.data.index.poles[`${i},${j}`]) out.push(`${i},${j}`);
      }
    return out.sort();
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 300) return;
    this.lastT = now;
    const cells = this.cellsWithin(cx, cz, this.range);
    const near = new Set(this.shadowRange > 0 ? this.cellsWithin(cx, cz, this.shadowRange) : []);
    // 地形の頁を読む前に焼いた区画は、読み終えたら焼き直す
    const C = this.data.index.cell;
    let pending = 0;
    for (const k of cells) {
      const b = this.cellCache.get(k);
      if (b?.provisional && this.terrainReady(b.bx + C / 2, b.bz + C / 2)) pending++;
    }
    const key = `${cells.join("|")}#${[...near].join("|")}`;
    if (key === this.key && !pending) return;
    this.key = key;
    this.rebuild(cells, near, Math.round(cx / 256) * 256, Math.round(cz / 256) * 256);
  }

  /** 区画 1 つの電柱・街灯を焼き込む（区画の隅 (i·C, j·C) からの相対） */
  private bake(k: string): CellBake {
    const C = this.data.index.cell;
    const old = this.cellCache.get(k);
    if (old && !(old.provisional && this.terrainReady(old.bx + C / 2, old.bz + C / 2))) return old;
    const [ci, cj] = k.split(",").map(Number);
    const bx = ci * C, bz = cj * C;
    const provisional = !this.terrainReady(bx + C / 2, bz + C / 2);
    const D = this.data.poles;
    const yOf = (o: number) => (Number.isNaN(D[o + 1]) ? this.heights.height(D[o], D[o + 2]) : D[o + 1]);
    const inst: Record<Kind, number[]> = { pole: [], transformer: [], lamp: [], street: [] };
    const wires: number[] = [];
    let poles = 0, streetlights = 0, spans = 0;
    for (const [off, count] of this.data.index.poles[k]) {
      let prev = -1;
      let prevY = 0;
      for (let q = 0; q < count; q++) {
        const o = (off + q) * POLE_REC;
        const f = D[o + 5];
        const y = yOf(o);
        if (!(f & POLE_FLAGS.anchor)) {
          // 位置・向き（局所の +X を (tx, tz) へ回す角度）
          const rec = [D[o] - bx, y, D[o + 2] - bz, Math.atan2(-D[o + 4], D[o + 3])];
          if (f & POLE_FLAGS.streetlight) {
            inst.street.push(...rec);
            streetlights++;
          } else {
            inst.pole.push(...rec);
            if (f & POLE_FLAGS.transformer) inst.transformer.push(...rec);
            if (f & POLE_FLAGS.lamp) inst.lamp.push(...rec);
            poles++;
          }
        }
        if (f & POLE_FLAGS.streetlight) continue;
        // 電線: 前の電柱から（上の腕金に 3 本、下の腕金に 2 本、通信線 1 本）
        if (prev >= 0) {
          const p = prev;
          const ay = prevY;
          const span = (oa: number, ha: number, ob: number, hb: number, sag: number) => {
            // 腕金の上の位置: 道に沿う向きの右 (−tz, tx) へ o
            const ax = D[p] - D[p + 4] * oa - bx, az = D[p + 2] + D[p + 3] * oa - bz;
            const ex = D[o] - D[o + 4] * ob - bx, ez = D[o + 2] + D[o + 3] * ob - bz;
            const N = 6;
            for (let i = 0; i < N; i++) {
              const t0 = i / N, t1 = (i + 1) / N;
              wires.push(ax + (ex - ax) * t0, ha + (hb - ha) * t0 - sag * 4 * t0 * (1 - t0), az + (ez - az) * t0);
              wires.push(ax + (ex - ax) * t1, ha + (hb - ha) * t1 - sag * 4 * t1 * (1 - t1), az + (ez - az) * t1);
            }
          };
          // 隣の電柱の向きが逆なら、腕金の上の位置も逆にする（電線を交差させない）
          const same = D[p + 3] * D[o + 3] + D[p + 4] * D[o + 4] >= 0 ? 1 : -1;
          for (const w of [-0.75, 0, 0.75]) span(w, ay + TOP + 0.08, w * same, y + TOP + 0.08, 0.45);
          for (const w of [-0.45, 0.45]) span(w, ay + TOP - 0.84, w * same, y + TOP - 0.84, 0.5);
          span(0, ay + LOW, 0, y + LOW, 0.6);
          spans++;
        }
        prev = o;
        prevY = y;
      }
    }
    let nv = 0;
    for (const kind of KINDS) nv += (inst[kind].length / 4) * this.geos[kind].getAttribute("position").count;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), Cl = new Float32Array(nv * 3), G = new Float32Array(nv);
    let v = 0;
    for (const kind of KINDS) {
      const list = inst[kind];
      const geo = this.geos[kind];
      const gp = geo.getAttribute("position").array, gn = geo.getAttribute("normal").array, gc = geo.getAttribute("color").array, gg = geo.getAttribute("glow").array;
      const n = geo.getAttribute("position").count;
      for (let i = 0; i < list.length; i += 4) {
        // 局所の +X を角度 a だけ y 軸まわりに回す（Three.js の回転と同じ向き）
        const ca = Math.cos(list[i + 3]), sa = Math.sin(list[i + 3]);
        for (let q = 0; q < n; q++, v++) {
          const lx = gp[q * 3], lz = gp[q * 3 + 2], nx = gn[q * 3], nz = gn[q * 3 + 2];
          P[v * 3] = list[i] + lx * ca + lz * sa;
          P[v * 3 + 1] = list[i + 1] + gp[q * 3 + 1];
          P[v * 3 + 2] = list[i + 2] - lx * sa + lz * ca;
          N[v * 3] = nx * ca + nz * sa;
          N[v * 3 + 1] = gn[q * 3 + 1];
          N[v * 3 + 2] = -nx * sa + nz * ca;
          Cl[v * 3] = gc[q * 3];
          Cl[v * 3 + 1] = gc[q * 3 + 1];
          Cl[v * 3 + 2] = gc[q * 3 + 2];
          G[v] = gg[q];
        }
      }
    }
    const b: CellBake = { bx, bz, P, N, C: Cl, G, W: Float32Array.from(wires), poles, streetlights, spans, provisional };
    this.cellCache.delete(k);
    this.cellCache.set(k, b);
    // 古い区画を忘れる（頁は捨てないので、また来たら焼き直す）
    if (this.cellCache.size > 600) {
      let drop = this.cellCache.size - 400;
      for (const key of this.cellCache.keys()) {
        if (drop-- <= 0) break;
        this.cellCache.delete(key);
      }
    }
    return b;
  }

  private rebuild(cells: string[], near: Set<string>, ox: number, oz: number) {
    const t0 = performance.now();
    for (const o of this.objects) {
      this.group.remove(o);
      o.geometry.dispose();
    }
    this.objects = [];
    this.at = { x: ox, z: oz };
    const bakes = cells.map((k) => ({ b: this.bake(k), near: near.has(k) }));
    // 影を落とす近くの分と遠くの分の 2 つの形につなぐ（部品ごとの InstancedMesh だと描画命令が部品の数の 2 倍になったため）
    for (const shadow of [true, false]) {
      const list = bakes.filter((q) => q.near === shadow).map((q) => q.b);
      let nv = 0;
      for (const b of list) nv += b.G.length;
      if (!nv) continue;
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Float32Array(nv * 3), G = new Float32Array(nv);
      let v = 0;
      for (const b of list) {
        const dx = b.bx - ox, dz = b.bz - oz;
        for (let i = 0; i < b.G.length; i++) {
          P[(v + i) * 3] = b.P[i * 3] + dx;
          P[(v + i) * 3 + 1] = b.P[i * 3 + 1];
          P[(v + i) * 3 + 2] = b.P[i * 3 + 2] + dz;
        }
        N.set(b.N, v * 3);
        C.set(b.C, v * 3);
        G.set(b.G, v);
        v += b.G.length;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(P, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
      g.setAttribute("color", new THREE.BufferAttribute(C, 3));
      g.setAttribute("glow", new THREE.BufferAttribute(G, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = shadow ? "real-poles:near" : "real-poles:far";
      mesh.castShadow = shadow;
      this.objects.push(mesh);
    }
    let nw = 0;
    for (const { b } of bakes) nw += b.W.length;
    if (nw) {
      const W = new Float32Array(nw);
      let w = 0;
      for (const { b } of bakes) {
        const dx = b.bx - ox, dz = b.bz - oz;
        for (let i = 0; i < b.W.length; i += 3) {
          W[w + i] = b.W[i] + dx;
          W[w + i + 1] = b.W[i + 1];
          W[w + i + 2] = b.W[i + 2] + dz;
        }
        w += b.W.length;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(W, 3));
      g.computeBoundingSphere();
      const l = new THREE.LineSegments(g, this.wireMat);
      l.name = "real-poles:wires";
      this.objects.push(l);
    }
    let poles = 0, streetlights = 0, spans = 0;
    for (const { b } of bakes) {
      poles += b.poles;
      streetlights += b.streetlights;
      spans += b.spans;
    }
    for (const o of this.objects) {
      o.position.set(ox - this.originX, 0, oz - this.originZ);
      this.group.add(o);
    }
    this.stats = { poles, streetlights, spans };
    this.buildMs.push(performance.now() - t0);
    if (this.buildMs.length > 200) this.buildMs.splice(0, 100);
  }
}

const KINDS: Kind[] = ["pole", "transformer", "lamp", "street"];

interface CellBake {
  bx: number;
  bz: number;
  P: Float32Array;
  N: Float32Array;
  C: Float32Array;
  G: Float32Array;
  /** 電線の線分の点 */
  W: Float32Array;
  poles: number;
  streetlights: number;
  spans: number;
  /** 地形の頁を読む前に焼いた（走らない道の電柱の高さが縮図の値） */
  provisional: boolean;
}
