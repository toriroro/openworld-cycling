// 建物と喫茶店の描画（モック仕様 5.4）。配置は towns.ts（town-layout.ts）が決め、ここで形を作ってまとめて描く。
// 形は生成し、外壁と屋根は写真素材（Poly Haven、CC0。public/assets/buildings/）を貼って建物ごとに色を変える。
// - 家（1〜2 階）: 切妻か寄棟の屋根（軒の出 0.5m、瓦か金属）、サイディングかモルタルの壁、各階の窓（枠とガラス）、道路側の玄関、ブロック塀
// - 町の中心の建物（3 階以上）: 陸屋根とパラペット、各階の窓、道路側のベランダ、1 階の店のガラス面
// - 喫茶店: 杉板の壁、ガラスの正面、扉、ひさし、店名の看板（文字は店名だけ）、自転車ラック、駐輪スペース
// 材質ごとに 1 つのメッシュにまとめる（窓・扉・塀などは頂点色の 1 材質）。描画命令は 町全体で 6、喫茶店の看板が 1 軒 1。

import * as THREE from "three";
import type { Building, Cafe } from "./town-layout.ts";
import type { Towns } from "./towns.ts";

const BASE = `${import.meta.env.BASE_URL}assets/buildings/`;

type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};

/** 素材ごとの色（写真の色に掛ける） */
const SIDING = ["#f2efe6", "#dcd6c8", "#c9c3b5", "#b7b2a8", "#8f8d88", "#d8cbb4", "#6d7174"].map(hex);
const PLASTER = ["#ffffff", "#f3eee0", "#e6dfcf", "#d8d6d0", "#efe6d2"].map(hex);
const TILE = ["#ffffff", "#c9ced6", "#b3a49a", "#9da6ad"].map(hex);
const METAL = ["#6b5a4e", "#4f5b66", "#7c8287", "#5d6b5c", "#8a4e3e"].map(hex);
const CEDAR: Rgb = [1, 1, 1];

const C_FRAME = hex("#c9ccce");
const C_GLASS_A = hex("#2a3a44");
const C_GLASS_B = hex("#46606c");
const C_DOOR = hex("#5a4232");
const C_BLOCK = hex("#a7a59f");
const C_SLAB = hex("#b4b2ad");
const C_RAIL = hex("#b9bdbf");
const C_DARK = hex("#3d3936");
const C_AWNING = hex("#2f5d43");
const C_RACK = hex("#b8bcbd");
const C_PAVE = hex("#5d5d5a");
const C_ROOF_EDGE = hex("#3a3836");

interface V3 {
  x: number;
  y: number;
  z: number;
}
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3, k = 1): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const UP = v3(0, 1, 0);

/** 材質ごとの頂点の集まり */
class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** p0→p1→p2→p3 が外から見て反時計回りの四角形。uv は各頂点 */
  quad(p: V3[], uv: [number, number][], c: Rgb) {
    this.poly(p, uv, c);
  }
  tri(p: V3[], uv: [number, number][], c: Rgb) {
    this.poly(p, uv, c);
  }
  private poly(p: V3[], uv: [number, number][], c: Rgb) {
    const a = p[0], b = p[1], d = p[p.length - 1];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.pos.length / 3;
    p.forEach((q, i) => {
      this.pos.push(q.x, q.y, q.z);
      this.nor.push(nx, ny, nz);
      this.uv.push(uv[i][0], uv[i][1]);
      this.col.push(c[0], c[1], c[2]);
    });
    for (let i = 1; i < p.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }
  /** 外向き n の鉛直の面。左下 p0、幅 w（u 軸 = UP × n）、高さ h。uv は m を tex で割る */
  wall(p0: V3, n: V3, w: number, h: number, c: Rgb, tex: number, u0 = 0, v0 = 0) {
    const u = v3(n.z, 0, -n.x);
    const p1 = add(p0, u, w);
    this.quad([p0, p1, add(p1, UP, h), add(p0, UP, h)], [
      [u0 / tex, v0 / tex],
      [(u0 + w) / tex, v0 / tex],
      [(u0 + w) / tex, (v0 + h) / tex],
      [u0 / tex, (v0 + h) / tex],
    ], c);
  }
  /** 中心 c、軸 X・Z、寸法の直方体（6 面、頂点色） */
  box(c: V3, X: V3, Z: V3, w: number, h: number, d: number, col: Rgb, tex = 1) {
    const hw = w / 2, hd = d / 2;
    const at = (a: number, b: number, y: number) => v3(c.x + X.x * a + Z.x * b, y, c.z + X.z * a + Z.z * b);
    const y0 = c.y - h / 2, y1 = c.y + h / 2;
    this.wall(at(-hw, hd, y0), Z, w, h, col, tex);
    this.wall(at(hw, -hd, y0), v3(-Z.x, 0, -Z.z), w, h, col, tex);
    this.wall(at(hw, hd, y0), X, d, h, col, tex);
    this.wall(at(-hw, -hd, y0), v3(-X.x, 0, -X.z), d, h, col, tex);
    this.quad([at(-hw, hd, y1), at(hw, hd, y1), at(hw, -hd, y1), at(-hw, -hd, y1)], [[0, 0], [w / tex, 0], [w / tex, d / tex], [0, d / tex]], col);
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

/** 写真素材の材質。tex は 1 枚が覆う長さ (m) */
interface Surface {
  name: string;
  tex: number;
  material: THREE.MeshStandardMaterial;
}

/**
 * contrast < 1 なら、写真の模様を平均の色へ寄せて薄くする（しみの多い写真をきれいな壁に見せる）。
 * 平均の色はいちばん小さいミップマップから取る。
 */
function surface(loader: THREE.TextureLoader, name: string, tex: number, roughness: number, metalness = 0, doubleSide = false, contrast = 1): Surface {
  const map = loader.load(`${BASE}${name}_Diffuse.jpg`);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = loader.load(`${BASE}${name}_nor_gl.jpg`);
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  const material = new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, roughness, metalness, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  if (contrast < 1) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec3 meanColor = textureLod( map, vMapUv, 12.0 ).rgb;
  sampledDiffuseColor.rgb = mix( meanColor, sampledDiffuseColor.rgb, ${contrast.toFixed(2)} );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
    };
    material.customProgramCacheKey = () => `owc-surface-contrast-${contrast}`;
  }
  return { name, tex, material };
}

const unit = (seed: number, k: number) => {
  let x = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
};

function signTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2b2420";
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#f4ead6";
  let size = 72;
  ctx.font = `700 ${size}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  while (ctx.measureText(name).width > 470 && size > 30) {
    size -= 4;
    ctx.font = `700 ${size}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 建物の組み立て先 */
interface Out {
  siding: Mesher;
  plaster: Mesher;
  tile: Mesher;
  metal: Mesher;
  cedar: Mesher;
  trim: Mesher;
}

export class BuildingMeshes {
  readonly group = new THREE.Group();
  private surfaces: Record<"siding" | "plaster" | "tile" | "metal" | "cedar", Surface>;
  private trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });
  private meshes: THREE.Object3D[] = [];
  private key = "";
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  range = 2200;
  cafeRange = 1600;
  stats = { buildings: 0, cafes: 0, triangles: 0 };

  constructor(private towns: Towns) {
    this.group.name = "buildings";
    const loader = new THREE.TextureLoader();
    this.surfaces = {
      siding: surface(loader, "exterior_wall_cladding_03", 1.96, 0.85),
      plaster: surface(loader, "white_plaster_02", 1.6, 0.92, 0, false, 0.35),
      tile: surface(loader, "grey_roof_tiles", 3.0, 0.8, 0, true),
      metal: surface(loader, "corrugated_iron", 1.12, 0.55, 0.35, true),
      cedar: surface(loader, "japanese_cedar_planks", 1.85, 0.8),
    };
    // 写真の色が暗め・灰色がかっているので明るくする（頂点色で建物ごとの色を掛ける前の倍率）
    this.surfaces.plaster.material.color.setScalar(1.45);
    this.surfaces.siding.material.color.setScalar(1.15);
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    this.key = "";
  }

  setQuality(light: boolean) {
    this.range = light ? 1100 : 2200;
    this.cafeRange = light ? 900 : 1600;
    this.key = "";
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 400) return;
    this.lastT = now;
    const towns = this.towns.townsNear(cx, cz, this.range);
    const cafes = this.towns.cafesNear(cx, cz, this.cafeRange);
    const key = `${towns.map((t) => t.node).join("|")}#${cafes.map((c) => c.poi.id).join("|")}@${this.originX},${this.originZ}`;
    if (key === this.key) return;
    this.key = key;
    this.rebuild(
      towns.flatMap((t) => t.buildings),
      cafes,
    );
  }

  private clear() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        if (o.material instanceof THREE.MeshBasicMaterial) {
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
    }
    this.meshes = [];
  }

  private rebuild(buildings: Building[], cafes: Cafe[]) {
    this.clear();
    const out: Out = { siding: new Mesher(), plaster: new Mesher(), tile: new Mesher(), metal: new Mesher(), cedar: new Mesher(), trim: new Mesher() };
    for (const b of buildings) this.building(b, out);
    for (const c of cafes) this.cafe(c, out);
    let tris = 0;
    for (const [k, m] of Object.entries(out) as [keyof Out, Mesher][]) {
      const g = m.geometry();
      if (!g) continue;
      tris += m.idx.length / 3;
      const mesh = new THREE.Mesh(g, k === "trim" ? this.trimMat : this.surfaces[k].material);
      mesh.name = `buildings:${k}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    for (const c of cafes) {
      const s = this.sign(c);
      this.group.add(s);
      this.meshes.push(s);
    }
    this.stats = { buildings: buildings.length, cafes: cafes.length, triangles: tris };
  }

  /** 世界座標 → 描画座標 */
  private local(x: number, y: number, z: number): V3 {
    return v3(x - this.originX, y, z - this.originZ);
  }

  private building(b: Building, out: Out) {
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    // 長い方を X（棟の向き）にする
    let X = v3(ca, 0, sa), Z = v3(-sa, 0, ca);
    let w = b.w, d = b.d;
    let front = b.front;
    const swap = d > w;
    if (swap) {
      // 90° 回す（X' = Z、Z' = −X）。道路の向きは Z から −X' 側へ
      const nX = Z, nZ = v3(-X.x, 0, -X.z);
      X = nX;
      Z = nZ;
      [w, d] = [d, w];
    }
    const wallTop = b.top + b.h;
    const c = this.local(b.x, 0, b.z);
    const at = (a: number, bb: number, y: number) => v3(c.x + X.x * a + Z.x * bb, y, c.z + X.z * a + Z.z * bb);
    const wallKind = b.wallMat;
    const wm = out[wallKind];
    const tex = this.surfaces[wallKind].tex;
    const wc = wallKind === "siding" ? SIDING[b.tone % SIDING.length] : PLASTER[b.tone % PLASTER.length];
    const H = wallTop - b.base;
    const hw = w / 2, hd = d / 2;
    const negZ = v3(-Z.x, 0, -Z.z), negX = v3(-X.x, 0, -X.z);
    // 壁（4 面）。u は角から連続させて模様をつなぐ
    wm.wall(at(-hw, hd, b.base), Z, w, H, wc, tex, 0, b.base);
    wm.wall(at(hw, hd, b.base), X, d, H, wc, tex, w, b.base);
    wm.wall(at(hw, -hd, b.base), negZ, w, H, wc, tex, w + d, b.base);
    wm.wall(at(-hw, -hd, b.base), negX, d, H, wc, tex, 2 * w + d, b.base);

    // 道路側の面（ローカルの元の z の向き。回したら X の向き）
    const roadN = swap ? (front > 0 ? negX : X) : front > 0 ? Z : negZ;
    // 屋根
    const roofCol = b.roofMat === "tile" ? TILE[b.tone % TILE.length] : METAL[b.tone % METAL.length];
    const rm = out[b.roofMat];
    const rtex = this.surfaces[b.roofMat].tex;
    if (b.roof === "flat") {
      // 陸屋根: 屋上の面とパラペット
      out.trim.quad([at(-hw, hd, wallTop), at(hw, hd, wallTop), at(hw, -hd, wallTop), at(-hw, -hd, wallTop)], [[0, 0], [1, 0], [1, 1], [0, 1]], C_SLAB);
      const p = 0.7;
      wm.wall(at(-hw, hd, wallTop), Z, w, p, wc, tex, 0, wallTop);
      wm.wall(at(hw, hd, wallTop), X, d, p, wc, tex, w, wallTop);
      wm.wall(at(hw, -hd, wallTop), negZ, w, p, wc, tex, w + d, wallTop);
      wm.wall(at(-hw, -hd, wallTop), negX, d, p, wc, tex, 2 * w + d, wallTop);
      // パラペットの天端
      out.trim.box(v3(c.x, wallTop + p, c.z), X, Z, w, 0.06, d, C_DARK);
    } else {
      const o = 0.5;
      const pitch = b.roofMat === "tile" ? 0.5 : 0.36;
      const ye = wallTop - o * pitch;
      const yr = wallTop + hd * pitch;
      const ex = hw + o, ez = hd + o;
      const slope = Math.sqrt(1 + pitch * pitch);
      if (b.roof === "gable") {
        // 2 面と妻の三角
        rm.quad([at(-ex, ez, ye), at(ex, ez, ye), at(ex, 0, yr), at(-ex, 0, yr)], [[0, 0], [(2 * ex) / rtex, 0], [(2 * ex) / rtex, (ez * slope) / rtex], [0, (ez * slope) / rtex]], roofCol);
        rm.quad([at(ex, -ez, ye), at(-ex, -ez, ye), at(-ex, 0, yr), at(ex, 0, yr)], [[0, 0], [(2 * ex) / rtex, 0], [(2 * ex) / rtex, (ez * slope) / rtex], [0, (ez * slope) / rtex]], roofCol);
        const gy = wallTop + hd * pitch;
        wm.tri([at(hw, hd, wallTop), at(hw, -hd, wallTop), at(hw, 0, gy)], [[w / tex, wallTop / tex], [(w + d) / tex, wallTop / tex], [(w + hd) / tex, gy / tex]], wc);
        wm.tri([at(-hw, -hd, wallTop), at(-hw, hd, wallTop), at(-hw, 0, gy)], [[(2 * w + d) / tex, wallTop / tex], [(2 * w + 2 * d) / tex, wallTop / tex], [(2 * w + d + hd) / tex, gy / tex]], wc);
        // 棟の押さえ
        out.trim.box(v3(c.x, yr + 0.06, c.z), X, Z, 2 * ex, 0.14, 0.3, C_ROOF_EDGE);
      } else {
        // 寄棟: 長い 2 面の台形と短い 2 面の三角
        const rx = Math.max(0, hw - hd);
        const u = (ez * slope) / rtex;
        rm.quad([at(-ex, ez, ye), at(ex, ez, ye), at(rx, 0, yr), at(-rx, 0, yr)], [[0, 0], [(2 * ex) / rtex, 0], [(ex + rx) / rtex, u], [(ex - rx) / rtex, u]], roofCol);
        rm.quad([at(ex, -ez, ye), at(-ex, -ez, ye), at(-rx, 0, yr), at(rx, 0, yr)], [[0, 0], [(2 * ex) / rtex, 0], [(ex + rx) / rtex, u], [(ex - rx) / rtex, u]], roofCol);
        rm.tri([at(ex, ez, ye), at(ex, -ez, ye), at(rx, 0, yr)], [[0, 0], [(2 * ez) / rtex, 0], [ez / rtex, u]], roofCol);
        rm.tri([at(-ex, -ez, ye), at(-ex, ez, ye), at(-rx, 0, yr)], [[0, 0], [(2 * ez) / rtex, 0], [ez / rtex, u]], roofCol);
        if (rx > 0.1) out.trim.box(v3(c.x, yr + 0.06, c.z), X, Z, 2 * rx, 0.14, 0.3, C_ROOF_EDGE);
      }
    }

    // 窓・扉: 4 面それぞれ、階ごと
    const floorH = b.floors >= 3 ? 3.1 : b.h / b.floors;
    const faces: { p0: V3; n: V3; len: number }[] = [
      { p0: at(-hw, hd, 0), n: Z, len: w },
      { p0: at(hw, hd, 0), n: X, len: d },
      { p0: at(hw, -hd, 0), n: negZ, len: w },
      { p0: at(-hw, -hd, 0), n: negX, len: d },
    ];
    let k = 0;
    for (const f of faces) {
      const u = v3(f.n.z, 0, -f.n.x);
      const isRoad = Math.abs(f.n.x - roadN.x) < 1e-6 && Math.abs(f.n.z - roadN.z) < 1e-6;
      const count = Math.max(1, Math.floor((f.len - 1.2) / 2.7));
      const step = f.len / count;
      for (let fl = 0; fl < b.floors; fl++) {
        const y0 = b.top + fl * floorH;
        for (let i = 0; i < count; i++) {
          k++;
          const along = step * (i + 0.5);
          // 1 階の道路側: 真ん中寄りに玄関、町の中心の建物は店のガラス面
          if (fl === 0 && isRoad && b.floors >= 3 && i === 0) {
            this.window(out.trim, f.p0, f.n, u, f.len * 0.08, y0 + 0.2, f.len * 0.84, 2.5, b.seed + k, true);
            break;
          }
          if (fl === 0 && isRoad && i === Math.floor(count / 2)) {
            this.door(out.trim, f.p0, f.n, u, along - 0.5, y0 + 0.05);
            continue;
          }
          // ところどころ窓のない壁
          if (unit(b.seed, k) < 0.18 && count > 1) continue;
          const big = fl === 0 && !isRoad && b.floors < 3 && unit(b.seed, k + 99) < 0.4;
          const ww = big ? 1.7 : 1.4;
          const wh = big ? 1.9 : 1.1;
          const sill = big ? 0.15 : 0.9;
          this.window(out.trim, f.p0, f.n, u, along - ww / 2, y0 + sill, ww, wh, b.seed + k, false);
        }
        // 2 階以上の道路側のベランダ（町の中心の建物）
        if (fl > 0 && isRoad && b.floors >= 3) {
          const mid = add(add(f.p0, u, f.len / 2), f.n, 0.55);
          out.trim.box(v3(mid.x, y0 + 0.05, mid.z), u, f.n, f.len * 0.9, 0.12, 1.1, C_SLAB);
          const rail = add(add(f.p0, u, f.len * 0.05), f.n, 1.08);
          out.trim.wall(v3(rail.x, y0 + 0.11, rail.z), f.n, f.len * 0.9, 1.0, C_RAIL, 1);
        }
      }
    }

    // ブロック塀（路面の端から 0.6m 内側。玄関の前は開ける）
    if (b.fence) {
      const fz = hd + b.gap - 0.6;
      const doorAlong = (() => {
        const len = swap ? d : w;
        const count = Math.max(1, Math.floor((len - 1.2) / 2.7));
        return (len / count) * (Math.floor(count / 2) + 0.5) - len / 2;
      })();
      // 塀の向き: 道路側の面と平行
      const fu = v3(roadN.z, 0, -roadN.x);
      const center = add(add(c, roadN, swap ? hw + b.gap - 0.6 : fz), UP, 0);
      const y0 = Math.min(b.base, b.roadY - 0.8);
      const y1 = b.roadY - 0.25 + 1.1;
      const half = (swap ? d : w) / 2 + 1.5;
      // 玄関の位置は面の左端からの距離。面の u 軸は roadN の UP × n
      const gate0 = doorAlong - 0.9, gate1 = doorAlong + 0.9;
      for (const [a0, a1] of [
        [-half, gate0],
        [gate1, half],
      ]) {
        if (a1 - a0 < 0.3) continue;
        const mid = (a0 + a1) / 2;
        const p = add(center, fu, mid);
        out.trim.box(v3(p.x, (y0 + y1) / 2, p.z), fu, roadN, a1 - a0, y1 - y0, 0.15, C_BLOCK);
      }
    }
  }

  /** 窓（枠とガラス）。p0 は面の左下（y は 0）、n は外向き、u は面に沿う向き */
  private window(m: Mesher, p0: V3, n: V3, u: V3, a: number, y: number, w: number, h: number, seed: number, shop: boolean) {
    const f = 0.08;
    const b0 = add(add(p0, u, a - f), n, 0.03);
    m.wall(v3(b0.x, y - f, b0.z), n, w + 2 * f, h + 2 * f, C_FRAME, 1);
    const g0 = add(add(p0, u, a), n, 0.045);
    const t = unit(seed, 7);
    const glass: Rgb = [C_GLASS_A[0] + (C_GLASS_B[0] - C_GLASS_A[0]) * t, C_GLASS_A[1] + (C_GLASS_B[1] - C_GLASS_A[1]) * t, C_GLASS_A[2] + (C_GLASS_B[2] - C_GLASS_A[2]) * t];
    m.wall(v3(g0.x, y, g0.z), n, w, h, glass, 1);
    // 縦の桟（店は 3 本、窓は 1 本）
    const bars = shop ? 3 : 1;
    for (let i = 1; i <= bars; i++) {
      const x = a + (w * i) / (bars + 1) - 0.03;
      const p = add(add(p0, u, x), n, 0.055);
      m.wall(v3(p.x, y, p.z), n, 0.06, h, C_FRAME, 1);
    }
  }

  private door(m: Mesher, p0: V3, n: V3, u: V3, a: number, y: number) {
    const f = add(add(p0, u, a - 0.08), n, 0.03);
    m.wall(v3(f.x, y, f.z), n, 1.16, 2.18, C_FRAME, 1);
    const d = add(add(p0, u, a), n, 0.05);
    m.wall(v3(d.x, y, d.z), n, 1.0, 2.1, C_DOOR, 1);
    // ひさし
    const c = add(add(p0, u, a + 0.5), n, 0.45);
    m.box(v3(c.x, y + 2.45, c.z), u, n, 1.6, 0.08, 0.9, C_ROOF_EDGE);
  }

  /** 喫茶店: 杉板の壁、金属の屋根の縁、ガラスの正面と扉、ひさし、駐輪スペース、ラック */
  private cafe(c: Cafe, out: Out) {
    const X = v3(Math.cos(c.angle), 0, Math.sin(c.angle));
    const Zr = v3(-X.z, 0, X.x);
    // 正面（道路側）の向き F
    const F = Zr.x * c.fx + Zr.z * c.fz > 0 ? Zr : v3(-Zr.x, 0, -Zr.z);
    const cc = this.local(c.x, 0, c.z);
    const top = c.top + c.h;
    const H = top - c.base;
    const hw = c.w / 2, hd = c.d / 2;
    const U = v3(F.z, 0, -F.x);
    const at = (a: number, b: number, y: number) => v3(cc.x + U.x * a + F.x * b, y, cc.z + U.z * a + F.z * b);
    const tex = this.surfaces.cedar.tex;
    const negF = v3(-F.x, 0, -F.z), negU = v3(-U.x, 0, -U.z);
    out.cedar.wall(at(-hw, hd, c.base), F, c.w, H, CEDAR, tex, 0, c.base);
    out.cedar.wall(at(hw, hd, c.base), U, c.d, H, CEDAR, tex, c.w, c.base);
    out.cedar.wall(at(hw, -hd, c.base), negF, c.w, H, CEDAR, tex, c.w + c.d, c.base);
    out.cedar.wall(at(-hw, -hd, c.base), negU, c.d, H, CEDAR, tex, 2 * c.w + c.d, c.base);
    // 屋根（少し張り出す陸屋根）
    out.trim.box(v3(cc.x, top + 0.17, cc.z), U, F, c.w + 0.8, 0.35, c.d + 0.8, C_DARK);
    // 正面のガラスと扉
    const p0 = at(-hw, hd, 0);
    this.window(out.trim, p0, F, U, c.w * 0.1, c.top + 0.4, c.w * 0.6, 2.2, 3, true);
    this.door(out.trim, p0, F, U, c.w * 0.78, c.top + 0.05);
    // 横の窓
    this.window(out.trim, at(hw, hd, 0), U, negF, 2, c.top + 1.0, 2.2, 1.2, 5, false);
    // ひさし（正面に張り出して少し下がる）
    const e0 = at(-c.w * 0.46, hd + 0.05, c.top + 3.2), e1 = at(c.w * 0.46, hd + 0.05, c.top + 3.2);
    const e2 = at(c.w * 0.46, hd + 1.9, c.top + 2.7), e3 = at(-c.w * 0.46, hd + 1.9, c.top + 2.7);
    out.trim.quad([e3, e2, e1, e0], [[0, 0], [1, 0], [1, 1], [0, 1]], C_AWNING);
    out.trim.quad([e0, e1, e2, e3], [[0, 0], [1, 0], [1, 1], [0, 1]], C_AWNING);
    // 駐輪スペース（建物の前の舗装）
    const pv = at(0, hd + 3.6, 0);
    out.trim.box(v3(pv.x, (c.base + c.top + 0.08) / 2, pv.z), U, F, c.w + 4, Math.max(0.2, c.top - c.base + 0.08), 6.6, C_PAVE);
    // 自転車ラック（逆 U 字を 3 つ）
    for (let k = -1; k <= 1; k++) {
      const b = at(k * 1.6, hd + 2.2, 0);
      const y0 = c.top + 0.08;
      for (const e of [-0.35, 0.35]) {
        const q = add(b, F, e);
        out.trim.box(v3(q.x, y0 + 0.4, q.z), U, F, 0.06, 0.8, 0.06, C_RACK);
      }
      out.trim.box(v3(b.x, y0 + 0.8, b.z), U, F, 0.06, 0.06, 0.76, C_RACK);
    }
  }

  /** 看板（ひさしの上、正面に向ける） */
  private sign(c: Cafe): THREE.Mesh {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), new THREE.MeshBasicMaterial({ map: signTexture(c.poi.name) }));
    sign.name = `cafe-sign:${c.poi.id}`;
    const X = v3(Math.cos(c.angle), 0, Math.sin(c.angle));
    const Zr = v3(-X.z, 0, X.x);
    const F = Zr.x * c.fx + Zr.z * c.fz > 0 ? Zr : v3(-Zr.x, 0, -Zr.z);
    const p = this.local(c.x + F.x * (c.d / 2 + 0.08), c.top + 3.85, c.z + F.z * (c.d / 2 + 0.08));
    sign.position.set(p.x, p.y, p.z);
    sign.rotation.y = Math.atan2(F.x, F.z);
    return sign;
  }
}
