// 交差点の住所の看板（配達の草案 27 章）: 交差点の角に柱と青い板を立て、その角の街区の住所（北3西4 など）を両面に書く。
// 外部の素材は使わず、板の字はキャンバスに書く。置く所と字は src/game.ts が決め、ここは描くだけ。

import * as THREE from "three";

export interface AddressSign {
  /** 柱の根元（世界座標） */
  x: number;
  y: number;
  z: number;
  /** 板の表の向き（交差点の中心を向く。水平の単位ベクトル） */
  nx: number;
  nz: number;
  label: string;
}

const SLOTS = 48;
const POLE_H = 3.4;
/** 板の大きさ (m)。走りながら読めるよう、実物より大きめ【初期値】 */
const PLATE_W = 1.6;
const PLATE_H = 0.6;
/** 字の画像を覚えておく数 */
const CACHE = 160;

function plateTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1d4f91";
  g.fillRect(0, 0, 256, 96);
  g.strokeStyle = "#ffffff";
  g.lineWidth = 5;
  g.strokeRect(6, 6, 244, 84);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  let size = 54;
  const font = (n: number) => `bold ${n}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  g.font = font(size);
  while (size > 24 && g.measureText(label).width > 228) g.font = font((size -= 2));
  g.fillText(label, 128, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class AddressSignView {
  readonly group = new THREE.Group();
  private poles: THREE.InstancedMesh;
  private plates: THREE.Group[] = [];
  private cache = new Map<string, THREE.MeshBasicMaterial>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private one = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  readonly stats = { signs: 0, textures: 0 };

  constructor() {
    this.group.name = "address-signs";
    const poleGeo = new THREE.CylinderGeometry(0.045, 0.05, POLE_H, 8);
    poleGeo.translate(0, POLE_H / 2, 0);
    this.poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: "#8d949b", roughness: 0.6, metalness: 0.3 }), SLOTS);
    this.poles.count = 0;
    this.poles.frustumCulled = false;
    this.poles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.poles);
    // 板は両面: 表と、裏返した表（裏から見ても字が正しく読める）
    const plateGeo = new THREE.PlaneGeometry(PLATE_W, PLATE_H);
    const backGeo = new THREE.PlaneGeometry(PLATE_W, PLATE_H);
    backGeo.rotateY(Math.PI);
    for (let i = 0; i < SLOTS; i++) {
      const front = new THREE.Mesh(plateGeo);
      const back = new THREE.Mesh(backGeo);
      const g = new THREE.Group();
      g.add(front, back);
      g.visible = false;
      this.group.add(g);
      this.plates.push(g);
    }
  }

  private material(label: string): THREE.MeshBasicMaterial {
    let mat = this.cache.get(label);
    if (mat) {
      // 使った順に並べ直す（古い物から捨てる）
      this.cache.delete(label);
      this.cache.set(label, mat);
      return mat;
    }
    mat = new THREE.MeshBasicMaterial({ map: plateTexture(label), toneMapped: false });
    this.cache.set(label, mat);
    if (this.cache.size > CACHE) {
      const [k, old] = this.cache.entries().next().value as [string, THREE.MeshBasicMaterial];
      this.cache.delete(k);
      old.map?.dispose();
      old.dispose();
    }
    return mat;
  }

  /** 描く。signs は近い順（SLOTS を超えた分は描かない） */
  update(signs: AddressSign[], originX: number, originZ: number) {
    const n = Math.min(SLOTS, signs.length);
    for (let i = 0; i < SLOTS; i++) {
      const g = this.plates[i];
      const s = signs[i];
      if (i >= n || !s) {
        g.visible = false;
        continue;
      }
      // 柱
      this.p.set(s.x - originX, s.y, s.z - originZ);
      this.m.compose(this.p, this.q.identity(), this.one);
      this.poles.setMatrixAt(i, this.m);
      // 板: 柱の上の方、交差点の中心の側へ少し出す。表は中心を向く
      const yaw = Math.atan2(s.nx, s.nz);
      g.position.set(s.x - originX + s.nx * 0.06, s.y + POLE_H - PLATE_H / 2 - 0.05, s.z - originZ + s.nz * 0.06);
      g.quaternion.setFromAxisAngle(this.up, yaw);
      const mat = this.material(s.label);
      for (const c of g.children as THREE.Mesh[]) c.material = mat;
      g.visible = true;
    }
    this.poles.count = n;
    this.poles.visible = n > 0;
    this.poles.instanceMatrix.needsUpdate = true;
    this.stats.signs = n;
    this.stats.textures = this.cache.size;
  }
}
