// 建物と喫茶店の描画（モック仕様 5.4）。配置は towns.ts（town-layout.ts、district/layout.ts）が決め、ここで材質を用意してまとめて描く。
// - 建物: 型ごとの形は building/styles.ts、部品は building/kit.ts、窓・扉・看板の絵は building/atlas.ts
// - 喫茶店: 杉板の壁、ガラスの正面、扉、ひさし、店名の看板（文字は店名だけ）、自転車ラック、駐輪スペース
// 材質: 写真素材（Poly Haven、CC0。public/assets/buildings/）のサイディング・モルタル・杉板・トタン・瓦と、
// canvas に描いた模様（塗り壁・タイル・金属の屋根・下見板）、頂点色だけの 1 つ、絵の表の 1 つ。
// 材質ごとに 1 つのメッシュにまとめる。描画命令は建物ぜんぶで最大 11、喫茶店の看板が 1 軒 1。

import * as THREE from "three";
import { makeAtlas, patternTexture } from "./building/atlas.ts";
import type { Kit, Out, SurfaceKind } from "./building/kit.ts";
import { add, hex, Mesher, type Rgb, unit, type V3, v3 } from "./building/mesher.ts";
import { buildBuilding } from "./building/styles.ts";
import { toGeometry } from "./building/to-geometry.ts";
import { type BuildingKind, SURFACE_TEX } from "./city-build.ts";
import type { Building, Cafe } from "./town-layout.ts";
import type { Towns } from "./towns.ts";

const BASE = `${import.meta.env.BASE_URL}assets/buildings/`;

const CEDAR: Rgb = [1, 1, 1];
const C_FRAME = hex("#c9ccce");
const C_GLASS_A = hex("#2a3a44");
const C_GLASS_B = hex("#46606c");
const C_DOOR = hex("#5a4232");
const C_DARK = hex("#3d3936");
const C_AWNING = hex("#2f5d43");
const C_RACK = hex("#b8bcbd");
const C_PAVE = hex("#5d5d5a");
const C_ROOF_EDGE = hex("#3a3836");

/** 写真素材の材質。tex は 1 枚が覆う長さ (m) */
interface Surface {
  tex: number;
  material: THREE.MeshStandardMaterial;
}

/**
 * 写真素材の材質。
 * contrast < 1 なら、写真の模様を平均の色へ寄せて薄くする（しみの多い写真をきれいな壁に見せる）。
 * normalize なら、写真を平均の色で割って模様だけを使う（建物ごとの色は頂点色がそのまま出る）。
 * 平均の色はいちばん小さいミップマップから取る。
 */
function surface(loader: THREE.TextureLoader, name: string, tex: number, roughness: number, o: { metalness?: number; doubleSide?: boolean; contrast?: number; normalize?: boolean } = {}): Surface {
  const map = loader.load(`${BASE}${name}_Diffuse.jpg`);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = loader.load(`${BASE}${name}_nor_gl.jpg`);
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  const material = new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true, roughness, metalness: o.metalness ?? 0, side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  const contrast = o.contrast ?? 1;
  if (contrast < 1 || o.normalize) {
    const mixed = o.normalize
      ? `mix( vec3( 1.0 ), sampledDiffuseColor.rgb / max( meanColor, vec3( 0.04 ) ), ${contrast.toFixed(2)} )`
      : `mix( meanColor, sampledDiffuseColor.rgb, ${contrast.toFixed(2)} )`;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec3 meanColor = textureLod( map, vMapUv, 12.0 ).rgb;
  sampledDiffuseColor.rgb = ${mixed};
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
    };
    material.customProgramCacheKey = () => `owc-surface-${o.normalize ? "n" : "c"}-${contrast}`;
  }
  return { tex, material };
}

/** canvas に描いた模様の材質（塗り壁・タイル・金属の屋根・下見板） */
function pattern(kind: "mortar" | "tile" | "seam" | "lap", tex: number, roughness: number, aniso: number, metalness = 0, doubleSide = false): Surface {
  return { tex, material: new THREE.MeshStandardMaterial({ map: patternTexture(kind, aniso), vertexColors: true, roughness, metalness, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide }) };
}

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

export class BuildingMeshes {
  readonly group = new THREE.Group();
  private surfaces: Record<SurfaceKind, Surface>;
  private trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });
  private atlas;
  private atlasMat: THREE.MeshStandardMaterial;
  private meshes: THREE.Object3D[] = [];
  private key = "";
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  range = 2200;
  cafeRange = 1600;
  stats = { buildings: 0, cafes: 0, triangles: 0, buildMs: 0 };

  constructor(private towns: Towns, aniso = 4) {
    this.group.name = "buildings";
    const loader = new THREE.TextureLoader();
    const T = SURFACE_TEX;
    this.surfaces = {
      // 1 枚が覆う長さは city-build.ts の SURFACE_TEX（Worker で形を作る時と同じ値）
      siding: surface(loader, "exterior_wall_cladding_03", T.siding, 0.85, { normalize: true }),
      plaster: surface(loader, "white_plaster_02", T.plaster, 0.92, { normalize: true, contrast: 0.6 }),
      cedar: surface(loader, "japanese_cedar_planks", T.cedar, 0.8),
      metal: surface(loader, "corrugated_iron", T.metal, 0.6, { metalness: 0.2, doubleSide: true, normalize: true, contrast: 0.8 }),
      tile: surface(loader, "grey_roof_tiles", T.tile, 0.8, { doubleSide: true }),
      seam: pattern("seam", T.seam, 0.5, aniso, 0.25, true),
      mortar: pattern("mortar", T.mortar, 0.92, aniso),
      tilewall: pattern("tile", T.tilewall, 0.6, aniso),
      lap: pattern("lap", T.lap, 0.85, aniso),
    };
    this.atlas = makeAtlas(aniso);
    // 窓・扉・看板は壁から 3〜4cm 浮かせた四角形。遠くで壁と重なって見えないよう、奥行きを少し手前へずらす
    this.atlasMat = new THREE.MeshStandardMaterial({ map: this.atlas.texture, vertexColors: true, roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
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
    const t0 = performance.now();
    this.clear();
    const kinds: (SurfaceKind | "trim" | "atlas")[] = ["siding", "plaster", "cedar", "metal", "tile", "seam", "mortar", "tilewall", "lap", "trim", "atlas"];
    const out = Object.fromEntries(kinds.map((k) => [k, new Mesher()])) as Out;
    const tex = Object.fromEntries((Object.keys(this.surfaces) as SurfaceKind[]).map((k) => [k, this.surfaces[k].tex])) as Record<SurfaceKind, number>;
    const kit: Kit = { out, tex, atlas: this.atlas };
    for (const b of buildings) buildBuilding(kit, b, this.local(b.x, 0, b.z));
    for (const c of cafes) this.cafe(c, out);
    let tris = 0;
    for (const k of kinds) {
      const m = out[k];
      const a = m.arrays();
      const g = a ? toGeometry(a) : null;
      if (!g) continue;
      tris += m.triangles;
      const mesh = new THREE.Mesh(g, k === "trim" ? this.trimMat : k === "atlas" ? this.atlasMat : this.surfaces[k].material);
      mesh.name = `buildings:${k}`;
      mesh.castShadow = k !== "atlas";
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    for (const c of cafes) {
      const s = this.sign(c);
      this.group.add(s);
      this.meshes.push(s);
    }
    this.stats = { buildings: buildings.length, cafes: cafes.length, triangles: tris, buildMs: Math.round(performance.now() - t0) };
  }

  /** 北海道の世界の建物（real-buildings.ts）: Worker で作った形に、同じ材質を付けたメッシュ */
  meshFor(kind: BuildingKind, g: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(g, kind === "trim" ? this.trimMat : kind === "atlas" ? this.atlasMat : this.surfaces[kind].material);
    mesh.name = `buildings:${kind}`;
    mesh.castShadow = kind !== "atlas";
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** 遠くの建物（箱）の材質: 頂点色だけ */
  get boxMaterial(): THREE.Material {
    return this.trimMat;
  }

  /** 世界座標 → 描画座標 */
  private local(x: number, y: number, z: number): V3 {
    return v3(x - this.originX, y, z - this.originZ);
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
