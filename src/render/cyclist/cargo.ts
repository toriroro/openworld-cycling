// 配達の荷の入れ物（配達の草案 29 章）: 背中の配達鞄と、自転車の後ろのリアキャリアと箱。
// 外部の素材は使わず、箱を組む。鞄は胸の骨（spine_03）に合わせて動き、キャリアは自転車の車体に付く。
// 座標は自転車の形（road-bike.ts の FIT）と同じ: 前が +z、上が +y、原点は地面の後輪と前輪の間。

import * as THREE from "three";

export interface CargoLook {
  /** 鞄の色（業者の色など） */
  bag: string;
  /** リアキャリアと箱を付ける */
  rack: boolean;
}

/** 鞄の大きさ (m): 幅・高さ（背骨に沿う向き）・奥行き。胸の骨の付け根からの中心の位置【初期値】 */
const BAG = { w: 0.4, h: 0.42, d: 0.3 };
const BAG_AT = new THREE.Vector3(0, 0.12, -0.16);
/** キャリアの台の高さと前後の端 (m)。後輪（半径 0.336m）の上 */
const RACK_Y = 0.74;
const RACK_Z0 = -0.3;
const RACK_Z1 = -0.64;

function box(w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/** 2 点の間の細い棒 */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), m);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh.castShadow = true;
  return mesh;
}

export class Cargo {
  /** 鞄（胸に合わせて置き直す） */
  readonly bag = new THREE.Group();
  /** リアキャリアと箱（自転車の車体の子） */
  readonly rack = new THREE.Group();
  private bagMat = new THREE.MeshStandardMaterial({ color: "#d8642a", roughness: 0.7 });
  private dark = new THREE.MeshStandardMaterial({ color: "#1e2124", roughness: 0.6, metalness: 0.2 });
  private light = new THREE.MeshStandardMaterial({ color: "#d9dde0", roughness: 0.4, emissive: "#3a3d40" });
  private metal = new THREE.MeshStandardMaterial({ color: "#2a2d30", roughness: 0.45, metalness: 0.6 });
  /** 鞄の中心の位置（胸の骨の付け根から、立った姿勢の向きで） */
  readonly bagAt = BAG_AT.clone();

  constructor() {
    this.bag.name = "delivery-bag";
    this.rack.name = "rear-rack";
    // 鞄: 箱・ふたの縁・反射の帯・肩ひも（胸の前へ回る所は体に隠れるので、肩の上だけ）
    const { w, h, d } = BAG;
    this.bag.add(box(w, h, d, 0, 0, 0, this.bagMat));
    this.bag.add(box(w + 0.01, 0.03, d + 0.01, 0, h / 2 - 0.04, 0, this.dark));
    this.bag.add(box(w + 0.006, 0.035, 0.006, 0, -0.04, -d / 2, this.light));
    for (const s of [-1, 1]) this.bag.add(box(0.05, 0.03, 0.16, s * 0.11, h / 2 - 0.08, d / 2 + 0.06, this.dark));
    // キャリア: 台・横の枠・後輪の軸へ下りる脚・前の止め
    const zc = (RACK_Z0 + RACK_Z1) / 2;
    this.rack.add(box(0.13, 0.012, RACK_Z0 - RACK_Z1, 0, RACK_Y, zc, this.metal));
    for (const s of [-1, 1]) {
      this.rack.add(rod(new THREE.Vector3(s * 0.065, RACK_Y, RACK_Z0), new THREE.Vector3(s * 0.065, RACK_Y, RACK_Z1), 0.006, this.metal));
      this.rack.add(rod(new THREE.Vector3(s * 0.065, RACK_Y, RACK_Z1 + 0.02), new THREE.Vector3(s * 0.07, 0.34, -0.41), 0.006, this.metal));
      this.rack.add(rod(new THREE.Vector3(s * 0.065, RACK_Y, -0.48), new THREE.Vector3(s * 0.07, 0.36, -0.4), 0.005, this.metal));
      this.rack.add(rod(new THREE.Vector3(s * 0.06, RACK_Y, RACK_Z0), new THREE.Vector3(s * 0.03, 0.8, -0.27), 0.005, this.metal));
    }
    // 箱（キャリアの上。腰に当たらないよう後ろ寄り）
    this.rack.add(box(0.4, 0.27, 0.36, 0, RACK_Y + 0.141, -0.5, this.bagMat));
    this.rack.add(box(0.405, 0.03, 0.365, 0, RACK_Y + 0.26, -0.5, this.dark));
    this.rack.add(box(0.406, 0.035, 0.004, 0, RACK_Y + 0.1, -0.68, this.light));
    this.bag.visible = false;
    this.rack.visible = false;
  }

  /** 見た目を変える。null なら隠す（サイクリング） */
  set(look: CargoLook | null) {
    this.bag.userData.on = !!look;
    this.rack.visible = !!look?.rack;
    if (look) this.bagMat.color.set(look.bag);
    if (!look) this.bag.visible = false;
  }

  /** 鞄を胸に合わせる。chest は胸の骨の付け根、q は胸から上の向き（立った姿勢からの回し） */
  placeBag(chest: THREE.Vector3 | null, q: THREE.Quaternion | null, firstPerson: boolean) {
    const on = !!this.bag.userData.on && !!chest && !!q && !firstPerson;
    this.bag.visible = on;
    if (!on) return;
    this.bag.position.copy(this.bagAt).applyQuaternion(q!).add(chest!);
    this.bag.quaternion.copy(q!);
  }

  dispose() {
    for (const m of [this.bagMat, this.dark, this.light, this.metal]) m.dispose();
    for (const g of [this.bag, this.rack]) g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}
