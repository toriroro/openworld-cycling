// 植生の描画（モック仕様 5.4）。配置は Worker（vegetation-place）がタイルごとに決め、ここでインスタンス描画にまとめる。
// - 木: 板の画像。遠くは十字に組んだ2枚、近くは 60° ずつ回した3枚（同じ画像なので近づいても木が入れ替わって見えない）。さらに遠くは地表の色
//   以前は いちばん近い数本を立体モデルに替えていたが、板と形・明るさが違い、近づくと別の木に置き換わって見えたのでやめた
// - 低木・岩・草の株: 視点の近くのものだけ
// downhill-3D の src/render/vegetation.ts の作法（板の木、草の株、素材の正規化）を移し、タイル単位に書き直した。

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VEG_BALE, VEG_CROP_CORN, VEG_CROP_LEAF, VEG_CROP_RICE, VEG_CROP_STALK, VEG_GRASS, VEG_ROCK, VEG_SHRUB, VEG_STRIDE, VEG_TREE } from "../workers/vegetation-place.ts";
import { cropTexture, type CropTuft, TUFT_SIZE } from "./farm/crop-textures.ts";
import type { TerrainStreamer } from "./terrain-streamer.ts";

const BASE = `${import.meta.env.BASE_URL}assets/nature/`;

interface Limits {
  shrubs: number;
  rocks: number;
  grass: number;
  bales: number;
  /** 作物の株（種類ごと） */
  crops: number;
  nearZone: number;
}
const LIMITS_STANDARD: Limits = { shrubs: 120, rocks: 100, grass: 5000, bales: 1200, crops: 6000, nearZone: 320 };
const LIMITS_LIGHT: Limits = { shrubs: 40, rocks: 40, grass: 1500, bales: 400, crops: 1500, nearZone: 220 };
const CROP_TUFTS: [number, CropTuft][] = [[VEG_CROP_LEAF, "leaf"], [VEG_CROP_STALK, "stalk"], [VEG_CROP_RICE, "rice"], [VEG_CROP_CORN, "corn"]];

/** 容量を足りなくなったら作り直すインスタンス描画 */
class Pool {
  mesh: THREE.InstancedMesh | null = null;
  constructor(
    private group: THREE.Group,
    private geometry: THREE.BufferGeometry | null,
    private material: THREE.Material | THREE.Material[] | null,
    private shadow: boolean,
  ) {}
  setSource(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]) {
    this.geometry = geometry;
    this.material = material;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
  }
  /** count 個の行列（列優先 16 要素）を書く */
  write(count: number, fill: (arr: Float32Array) => void) {
    if (!this.geometry || !this.material) return;
    if (!this.mesh || this.mesh.instanceMatrix.count < count) {
      if (this.mesh) {
        this.group.remove(this.mesh);
        this.mesh.dispose();
      }
      const cap = Math.max(64, Math.ceil(count * 1.4));
      this.mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = this.shadow;
      this.mesh.receiveShadow = true;
      this.mesh.name = "vegetation";
      this.group.add(this.mesh);
    }
    fill(this.mesh.instanceMatrix.array as Float32Array);
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  setShadow(on: boolean) {
    this.shadow = on;
    if (this.mesh) this.mesh.castShadow = on;
  }
}

function writeMatrix(a: Float32Array, i: number, x: number, y: number, z: number, s: number, rot: number) {
  const c = Math.cos(rot) * s;
  const n = Math.sin(rot) * s;
  const o = i * 16;
  a[o] = c; a[o + 1] = 0; a[o + 2] = -n; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = n; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}

interface TileVeg {
  key: string;
  level: number;
  ox: number;
  oz: number;
  veg: Float32Array;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private farBB: Pool;
  private nearBB: Pool;

  private shrubs: Pool[] = [];
  private rocks: Pool[] = [];
  private grass: Pool;
  /** 牧草ロール（白いラップの円筒を横に寝かせた物） */
  private bales: Pool;
  private baleKey = "";
  /** 作物の株（十字に組んだ板 2 枚、種類ごとの絵） */
  private crops: { type: number; pool: Pool; material: THREE.MeshStandardMaterial }[] = [];
  private bbMaterial: THREE.MeshBasicMaterial;
  private limits = LIMITS_STANDARD;
  private lastSelect = 0;
  private farKey = "";
  private near3dKey = "";
  private originX = 0;
  private originZ = 0;
  stats = { farTrees: 0, nearTrees: 0, shrubs: 0, rocks: 0, grass: 0, bales: 0, crops: 0 };

  constructor(private terrain: TerrainStreamer) {
    this.group.name = "vegetation";
    const tex = new THREE.TextureLoader().load(`${BASE}tree_small_02_billboard.png`);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.bbMaterial = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, color: "#c9d6c0" });
    // 十字に組んだ2枚の板（downhill-3D の寸法）
    const a = new THREE.PlaneGeometry(4.92128, 4.92128).translate(0, 2.27837, 0);
    const b = a.clone().rotateY(Math.PI / 2);
    const cross = mergeGeometries([a, b])!;
    // 近くは 3 枚（0°・60°・120°）にして、どの向きから見ても薄く見えないようにする
    const star = mergeGeometries([a.clone(), a.clone().rotateY(Math.PI / 3), a.clone().rotateY((Math.PI * 2) / 3)])!;
    this.farBB = new Pool(this.group, cross, this.bbMaterial, false);
    this.nearBB = new Pool(this.group, star, this.bbMaterial, true);
    // 草の株: 細い円錐を束ねる（不透明）
    let seed = 91827;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const blades: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      const hgt = 0.28 + rand() * 0.2;
      const g = new THREE.ConeGeometry(0.018, hgt, 3);
      g.rotateZ((rand() - 0.5) * 0.8);
      g.rotateY(rand() * 6);
      g.translate((rand() - 0.5) * 0.35, hgt * 0.48, (rand() - 0.5) * 0.35);
      blades.push(g);
    }
    this.grass = new Pool(this.group, mergeGeometries(blades)!, new THREE.MeshStandardMaterial({ color: "#4f6a36", roughness: 1 }), false);
    const bale = new THREE.CylinderGeometry(0.62, 0.62, 1.2, 12).rotateX(Math.PI / 2).translate(0, 0.62, 0);
    this.bales = new Pool(this.group, bale, new THREE.MeshStandardMaterial({ color: "#e4e6e0", roughness: 0.55 }), false);
    for (const [type, kind] of CROP_TUFTS) {
      const [tw, th] = TUFT_SIZE[kind];
      const tuftA = new THREE.PlaneGeometry(tw, th).translate(0, th / 2, 0);
      const tuft = mergeGeometries([tuftA, tuftA.clone().rotateY(Math.PI), tuftA.clone().rotateY(Math.PI / 2), tuftA.clone().rotateY(-Math.PI / 2)])!;
      // 法線を上向きにして、地面と同じ明るさで照らす。裏から見ても暗くならないよう、板は表裏 2 枚ずつ（片面の材質）
      const nrm = tuft.getAttribute("normal");
      for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
      const material = new THREE.MeshStandardMaterial({ map: cropTexture(kind, 4), alphaTest: 0.5, roughness: 1 });
      this.crops.push({ type, material, pool: new Pool(this.group, tuft, material, false) });
    }
    void this.loadModels();
  }

  private async loadModels() {
    const loader = new GLTFLoader();
    const prepare = async (file: string, normalize: boolean) => {
      const gltf = await loader.loadAsync(BASE + file);
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const unit = normalize ? 1 / Math.max(size.x, size.y, size.z) : 1;
      const parts: { g: THREE.BufferGeometry; m: THREE.Material | THREE.Material[] }[] = [];
      model.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        g.translate(-center.x, -bounds.min.y, -center.z);
        g.scale(unit, unit, unit);
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m instanceof THREE.MeshStandardMaterial && m.transparent) {
            m.transparent = false;
            m.alphaTest = 0.4;
            m.depthWrite = true;
          }
        parts.push({ g, m: o.material });
      });
      return parts;
    };
    try {
      this.shrubs = (await prepare("shrub_stream.glb", true)).map((p) => new Pool(this.group, p.g, p.m, false));
    } catch (e) {
      console.warn("shrub model", e);
    }
    try {
      // 岩は1つ目の形だけを使う
      const r = await prepare("rock_stream.glb", true);
      this.rocks = r.slice(0, 1).map((p) => new Pool(this.group, p.g, p.m, false));
    } catch (e) {
      console.warn("rock model", e);
    }
    this.near3dKey = "";
    this.farKey = "";
  }

  setQuality(light: boolean) {
    this.limits = light ? LIMITS_LIGHT : LIMITS_STANDARD;
    this.nearBB.setShadow(!light);

    this.farKey = "";
    this.near3dKey = "";
    this.baleKey = "";
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    this.farKey = "";
    this.near3dKey = "";
    this.baleKey = "";
  }

  /** 昼夜で板の木の明るさを合わせる（光を受けない材質のため） */
  setDaylight(k: number) {
    this.bbMaterial.color.setRGB(0.79 * k, 0.84 * k, 0.75 * k);
  }

  /** 毎フレーム呼ぶ。カメラの世界座標 */
  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastSelect < 250) return;
    this.lastSelect = now;
    const tiles: TileVeg[] = this.terrain.vegetationTiles();
    const L = this.limits;
    const near: TileVeg[] = [];
    const far: TileVeg[] = [];
    for (const t of tiles) {
      const size = t.level === 0 ? 256 : 1024;
      const dx = Math.max(t.ox - cx, 0, cx - (t.ox + size));
      const dz = Math.max(t.oz - cz, 0, cz - (t.oz + size));
      if (t.level === 0 && Math.hypot(dx, dz) < L.nearZone) near.push(t);
      else far.push(t);
    }
    // 遠くの板の木: タイルの組が変わった時だけ作り直す
    const fk = far.map((t) => t.key).join("|") + `@${this.originX},${this.originZ}`;
    if (fk !== this.farKey) {
      this.farKey = fk;
      let count = 0;
      for (const t of far) for (let i = 0; i < t.veg.length; i += VEG_STRIDE) if (t.veg[i + 5] === VEG_TREE) count++;
      this.farBB.write(count, (arr) => {
        let k = 0;
        for (const t of far) {
          const v = t.veg;
          for (let i = 0; i < v.length; i += VEG_STRIDE)
            if (v[i + 5] === VEG_TREE) writeMatrix(arr, k++, t.ox + v[i] - this.originX, v[i + 1], t.oz + v[i + 2] - this.originZ, v[i + 3], v[i + 4]);
        }
      });
      this.stats.farTrees = count;
    }
    // 牧草ロール: いちばん細かいタイルの全部から、近い順に。タイルの組が変わった時だけ作り直す
    const bk = tiles.filter((t) => t.level === 0).map((t) => t.key).join("|") + `@${this.originX},${this.originZ}`;
    if (bk !== this.baleKey) {
      this.baleKey = bk;
      const bl: { d: number; t: TileVeg; i: number }[] = [];
      for (const t of tiles) {
        if (t.level !== 0) continue;
        const v = t.veg;
        for (let i = 0; i < v.length; i += VEG_STRIDE)
          if (v[i + 5] === VEG_BALE) bl.push({ d: (t.ox + v[i] - cx) ** 2 + (t.oz + v[i + 2] - cz) ** 2, t, i });
      }
      const pick = bl.length > L.bales ? bl.sort((a, b) => a.d - b.d).slice(0, L.bales) : bl;
      this.bales.write(pick.length, (arr) => pick.forEach((e, k) => this.put(arr, k, e.t, e.i)));
      this.stats.bales = pick.length;
    }
    // 近く: 板の木（3枚）、低木、岩、草
    const trees: { d: number; t: TileVeg; i: number }[] = [];
    const shrubs: { d: number; t: TileVeg; i: number }[] = [];
    const rocks: { d: number; t: TileVeg; i: number }[] = [];
    const grass: { d: number; t: TileVeg; i: number }[] = [];
    const crops = this.crops.map(() => [] as { d: number; t: TileVeg; i: number }[]);
    for (const t of near) {
      const v = t.veg;
      for (let i = 0; i < v.length; i += VEG_STRIDE) {
        const dx = t.ox + v[i] - cx;
        const dz = t.oz + v[i + 2] - cz;
        const d = dx * dx + dz * dz;
        const type = v[i + 5];
        if (type === VEG_TREE) trees.push({ d, t, i });
        else if (type === VEG_SHRUB && d < 180 * 180) shrubs.push({ d, t, i });
        else if (type === VEG_ROCK && d < 180 * 180) rocks.push({ d, t, i });
        else if (type === VEG_GRASS && d < 75 * 75) grass.push({ d, t, i });
        else if (type >= VEG_CROP_LEAF && d < 110 * 110) {
          const k = this.crops.findIndex((q) => q.type === type);
          if (k >= 0) crops[k].push({ d, t, i });
        }
      }
    }
    const nearest = (list: typeof trees, n: number) => (list.length > n ? list.sort((a, b) => a.d - b.d).slice(0, n) : list);
    // 近くの木はタイルの組が変わった時だけ作り直す
    const nearKey = `${near.map((t) => t.key).join("|")}@${this.originX},${this.originZ}`;
    if (nearKey !== this.near3dKey) {
      this.near3dKey = nearKey;
      this.nearBB.write(trees.length, (arr) => trees.forEach((e, k) => this.put(arr, k, e.t, e.i)));
      this.stats.nearTrees = trees.length;
    }
    const sh = nearest(shrubs, L.shrubs);
    for (const p of this.shrubs) p.write(sh.length, (arr) => sh.forEach((e, k) => this.put(arr, k, e.t, e.i)));
    const rk = nearest(rocks, L.rocks);
    for (const p of this.rocks) p.write(rk.length, (arr) => rk.forEach((e, k) => this.put(arr, k, e.t, e.i)));
    const gr = nearest(grass, L.grass);
    this.grass.write(gr.length, (arr) => gr.forEach((e, k) => this.put(arr, k, e.t, e.i)));
    let cropCount = 0;
    this.crops.forEach((q, k) => {
      const list = nearest(crops[k], L.crops);
      q.pool.write(list.length, (arr) => list.forEach((e, n) => this.put(arr, n, e.t, e.i)));
      cropCount += list.length;
    });
    this.stats.crops = cropCount;
    this.stats.shrubs = sh.length;
    this.stats.rocks = rk.length;
    this.stats.grass = gr.length;
  }

  private put(arr: Float32Array, k: number, t: TileVeg, i: number) {
    const v = t.veg;
    writeMatrix(arr, k, t.ox + v[i] - this.originX, v[i + 1], t.oz + v[i + 2] - this.originZ, v[i + 3], v[i + 4]);
  }
}
