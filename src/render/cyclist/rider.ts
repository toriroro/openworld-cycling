// ライダー。MakeHuman（CC0）の人体と骨を本プロジェクトの Blender 手順（scripts/build-cyclist.py）で着せた GLB を読み、
// 骨を目標点へ向けて姿勢を付ける（downhill-3D の src/render/human-rider.ts の手法を写して直した物）。
// 足はペダル、手はブラケットの位置を自転車から受け取る。材質は PaletteMaterial 1つ。
//
// GLB の中の形状の名前の規則:
//   *_lod1 … 軽量画質の簡略版（標準では隠す）
//   first_person_arms* … 一人称の時だけ出す腕
//   helmet_road* / helmet_aero* … ヘルメットの形（設定で片方を出す）

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { HelmetShape } from "../../shared/outfit.ts";
import { type PaletteMaterial, SLOT } from "./palette.ts";
import type { Lod } from "./road-bike.ts";
import { v3, type V3 } from "./shapes.ts";

type Bind = { bone: THREE.Bone; head: V3; direction: V3; rotation: THREE.Quaternion; local: THREE.Quaternion; localPosition: V3; length: number };
type RigData = { bones: Record<string, { head: number[]; tail: number[]; length: number }>; helmetCenter?: number[] };

export interface RiderTargets {
  /** 左右のペダルの中心（車体の座標）。[左, 右] */
  pedals: [V3, V3];
  /** 左右の手を置く所 */
  hands: [V3, V3];
  /** サドルの上面の中心 */
  saddle: V3;
  /** 0..1 立ち漕ぎに近い力み */
  effort: number;
  phase: number;
  tuck: boolean;
  firstPerson: boolean;
}

/** 古い GLB（材質ごとに分かれた物）の材質名 → 色の表の番号 */
const LEGACY_SLOTS: Record<string, number> = {
  glove_and_rubber: SLOT.GLOVE,
  sock_and_shoe: SLOT.SHOE,
  skin: SLOT.SKIN,
  jersey_fabric: SLOT.JERSEY,
  bib_fabric: SLOT.BIB,
  helmet_foam: SLOT.HELMET_INNER,
  helmet_shell: SLOT.HELMET,
  smoke_lens: SLOT.LENS,
};

interface Part {
  mesh: THREE.Mesh;
  firstPerson: boolean;
  lod1: boolean;
  helmet: HelmetShape | null;
}

const FINGERS = ["index", "middle", "ring", "pinky"];
const REQUIRED = ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head", "thigh_l", "calf_l", "foot_l", "hand_l", "upperarm_l", "lowerarm_l", "clavicle_l", "thigh_r", "calf_r", "foot_r", "hand_r", "upperarm_r", "lowerarm_r", "clavicle_r"];

export class Rider {
  readonly group = new THREE.Group();
  private model?: THREE.Object3D;
  private bindings = new Map<string, Bind>();
  private parts: Part[] = [];
  private error: string | null = null;
  private reachExcess = 0;
  private lod: Lod = "high";
  private helmet: HelmetShape = "road";
  private last: RiderTargets | null = null;
  readonly ready: Promise<void>;

  constructor(private readonly material: PaletteMaterial) {
    this.group.name = "rider";
    const base = import.meta.env?.BASE_URL ?? "/";
    this.ready = Promise.all([
      new GLTFLoader().loadAsync(`${base}assets/rider/cyclist-v2.glb`),
      fetch(`${base}assets/rider/rig-v2.json`).then((r) => {
        if (!r.ok) throw new Error(`rider rig HTTP ${r.status}`);
        return r.json() as Promise<RigData>;
      }),
    ])
      .then(([gltf, data]) => this.setup(gltf.scene, data))
      .catch((e) => {
        this.error = String(e);
        console.error("Cyclist asset failed", e);
      });
  }

  private setup(model: THREE.Object3D, data: RigData) {
    model.updateMatrixWorld(true);
    const convert = (p: number[]) => v3(p[0], p[2], -p[1]);
    const meshes: THREE.Mesh[] = [];
    model.traverse((o) => {
      if (o instanceof THREE.Bone && data.bones[o.name]) {
        const d = data.bones[o.name];
        this.bindings.set(o.name, {
          bone: o,
          head: convert(d.head),
          direction: convert(d.tail).sub(convert(d.head)).normalize(),
          length: d.length,
          rotation: o.getWorldQuaternion(new THREE.Quaternion()),
          local: o.quaternion.clone(),
          localPosition: o.position.clone(),
        });
      }
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    for (const name of REQUIRED) if (!this.bindings.has(name)) throw new Error(`missing rider bone ${name}`);
    if (data.helmetCenter) this.material.setHeadCenter(data.helmetCenter[0], data.helmetCenter[1], data.helmetCenter[2]);
    for (const o of meshes) {
      const g = o.geometry as THREE.BufferGeometry;
      if (!g.getAttribute("slot")) {
        const uv = g.getAttribute("uv");
        const name = Array.isArray(o.material) ? o.material[0].name : o.material.name;
        if (name === "cyclist_palette" && uv) {
          // 色の表の番号は UV の u に入っている
          const s = new Float32Array(uv.count);
          for (let i = 0; i < uv.count; i++) s[i] = uv.getX(i);
          g.setAttribute("slot", new THREE.Float32BufferAttribute(s, 1));
        } else {
          const name = Array.isArray(o.material) ? o.material[0].name : o.material.name;
          const slot = LEGACY_SLOTS[name] ?? SLOT.GLOVE;
          g.setAttribute("slot", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count).fill(slot), 1));
        }
      }
      for (const name of Object.keys(g.attributes)) if (!["position", "normal", "slot", "skinIndex", "skinWeight"].includes(name)) g.deleteAttribute(name);
      o.material = this.material;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      let firstPerson = false;
      let lod1 = false;
      let helmet: HelmetShape | null = null;
      for (let a: THREE.Object3D | null = o; a; a = a.parent) {
        if (a.name.startsWith("first_person_arms")) firstPerson = true;
        if (a.name.endsWith("_lod1")) lod1 = true;
        if (a.name.startsWith("helmet_road")) helmet = "road";
        if (a.name.startsWith("helmet_aero")) helmet = "aero";
      }
      if (firstPerson) o.castShadow = false;
      this.parts.push({ mesh: o, firstPerson, lod1, helmet });
    }
    this.model = model;
    this.group.add(model);
    if (this.last) this.update(this.last);
  }

  setLod(lod: Lod) {
    this.lod = lod;
  }

  setHelmet(h: HelmetShape) {
    this.helmet = h;
  }

  /** 簡略版の形状があるか（無ければ軽量画質でも詳しい形状を使う） */
  private hasLod1() {
    return this.parts.some((p) => p.lod1);
  }

  stats() {
    let triangles = 0;
    let draws = 0;
    for (const p of this.parts)
      if (p.mesh.visible) {
        draws++;
        const g = p.mesh.geometry;
        triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
      }
    return { ready: !!this.model, error: this.error, bones: this.bindings.size, reachExcess: this.reachExcess, draws, triangles };
  }

  private setBone(name: string, position: V3, rotation: THREE.Quaternion) {
    const b = this.bindings.get(name)!.bone;
    const worldPos = this.group.localToWorld(position.clone());
    const worldQ = this.group.getWorldQuaternion(new THREE.Quaternion()).multiply(rotation);
    b.parent!.updateWorldMatrix(true, false);
    b.position.copy(b.parent!.worldToLocal(worldPos));
    b.quaternion.copy(b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ));
    b.updateWorldMatrix(false, true);
  }

  private aim(name: string, from: V3, to: V3) {
    const bind = this.bindings.get(name)!;
    const q = new THREE.Quaternion().setFromUnitVectors(bind.direction, to.clone().sub(from).normalize()).multiply(bind.rotation);
    this.setBone(name, from, q);
  }

  /** 2本の骨の関節（膝・肘）の位置。bend の向きへ曲げる */
  private static joint(a: V3, b: V3, l1: number, l2: number, bend: V3) {
    const delta = b.clone().sub(a);
    const distance = Math.max(0.001, delta.length());
    const dir = delta.divideScalar(distance);
    const d = Math.min(distance, l1 + l2 - 0.0001);
    const alongD = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const perpendicular = bend.clone().addScaledVector(dir, -bend.dot(dir)).normalize();
    return a.clone().addScaledVector(dir, alongD).addScaledVector(perpendicular, Math.sqrt(Math.max(0, l1 * l1 - alongD * alongD)));
  }

  update(t: RiderTargets) {
    this.last = t;
    if (!this.model) return;
    const useLod1 = this.lod === "low" && this.hasLod1();
    for (const p of this.parts) {
      // 一人称の腕は簡略版を持たないので画質によらず出す
      let visible = p.firstPerson === t.firstPerson && (p.firstPerson || p.lod1 === useLod1);
      if (p.helmet && p.helmet !== this.helmet) visible = false;
      p.mesh.visible = visible;
    }
    this.reachExcess = 0;
    for (const [name, b] of this.bindings)
      if (/^(index|middle|ring|pinky|thumb)/.test(name)) {
        b.bone.position.copy(b.localPosition);
        b.bone.quaternion.copy(b.local);
      }
    const effort = t.effort;
    const sway = Math.sin(t.phase) * effort * 0.037;
    const hip = t.saddle.clone().add(v3(sway, -0.006 + effort * 0.05, -0.014 + effort * 0.1));
    const tilt = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), t.tuck ? 1.13 : 0.9 - effort * 0.06);
    const root = this.bindings.get("pelvis")!.head;
    const body = (p: V3) => p.clone().sub(root).applyQuaternion(tilt).add(hip);
    for (const name of ["pelvis", "spine_01", "spine_02", "spine_03"]) {
      const b = this.bindings.get(name)!;
      this.setBone(name, body(b.head), tilt.clone().multiply(b.rotation));
    }
    const neck = this.bindings.get("neck_01")!;
    const neckQ = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), 0.45);
    const neckPos = body(neck.head);
    this.setBone("neck_01", neckPos, neckQ.clone().multiply(neck.rotation));
    const head = this.bindings.get("head")!;
    const headPos = head.head.clone().sub(neck.head).applyQuaternion(neckQ).add(neckPos);
    this.setBone("head", headPos, new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), 0.1).multiply(head.rotation));
    for (const side of [1, -1]) {
      const suffix = side > 0 ? "l" : "r";
      const pedal = t.pedals[side > 0 ? 0 : 1];
      // 足首はペダルの軸の上・少し後ろ（拇指球が軸に乗る）
      const ankle = pedal.clone().add(v3(side * 0.008, 0.066, -0.07));
      const thigh = this.bindings.get("thigh_" + suffix)!;
      const calf = this.bindings.get("calf_" + suffix)!;
      const hipJoint = thigh.head.clone().sub(root).add(hip);
      this.reachExcess = Math.max(this.reachExcess, hipJoint.distanceTo(ankle) - thigh.length - calf.length);
      const knee = Rider.joint(hipJoint, ankle, thigh.length, calf.length, v3(side * 0.06, 0, 1));
      this.aim("thigh_" + suffix, hipJoint, knee);
      this.aim("calf_" + suffix, knee, ankle);
      this.setBone("foot_" + suffix, ankle, this.bindings.get("foot_" + suffix)!.rotation);
      const clavicle = this.bindings.get("clavicle_" + suffix)!;
      this.setBone("clavicle_" + suffix, body(clavicle.head), tilt.clone().multiply(clavicle.rotation));
      const arm = this.bindings.get("upperarm_" + suffix)!;
      const forearm = this.bindings.get("lowerarm_" + suffix)!;
      const shoulder = body(arm.head);
      const hand = t.hands[side > 0 ? 0 : 1];
      const wrist = hand.clone().add(v3(0, 0.022, -0.06));
      this.reachExcess = Math.max(this.reachExcess, shoulder.distanceTo(wrist) - arm.length - forearm.length);
      const elbow = Rider.joint(shoulder, wrist, arm.length, forearm.length, v3(side, -0.15, -0.55));
      this.aim("upperarm_" + suffix, shoulder, elbow);
      this.aim("lowerarm_" + suffix, elbow, wrist);
      this.aim("hand_" + suffix, wrist, hand.clone().add(v3(0, 0, 0.03)));
      for (const finger of FINGERS)
        for (const segment of ["01", "02", "03"]) {
          const b = this.bindings.get(`${finger}_${segment}_${suffix}`);
          if (!b) continue;
          b.bone.updateWorldMatrix(true, false);
          const from = this.group.worldToLocal(b.bone.getWorldPosition(new THREE.Vector3()));
          const a = Number(segment) * 0.65;
          this.aim(`${finger}_${segment}_${suffix}`, from, from.clone().add(v3(0, -Math.sin(a), Math.cos(a))));
        }
      // 親指はハンドルの内側へ回す
      for (const segment of ["01", "02", "03"]) {
        const b = this.bindings.get(`thumb_${segment}_${suffix}`);
        if (!b) continue;
        b.bone.updateWorldMatrix(true, false);
        const from = this.group.worldToLocal(b.bone.getWorldPosition(new THREE.Vector3()));
        const k = Number(segment);
        this.aim(`thumb_${segment}_${suffix}`, from, from.clone().add(v3(-side * (0.6 + k * 0.2), -0.5 - k * 0.15, 0.55 - k * 0.2)));
      }
    }
    this.model.updateMatrixWorld(true);
  }
}
