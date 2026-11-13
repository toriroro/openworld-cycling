// ロードバイク。メートル単位、+Z が前、+Y が上、+X が乗り手の左。駆動系は右側（-X）。
// 描画は「車体・ハンドルまわり・前輪・後輪・クランク・ペダル（2つで1命令）・サイコンの画面」の7つ。
// 形の設定（フレーム形・リムの高さ）と画質（lod）が変わった時だけ形状を作り直す。色は PaletteMaterial の表で変える。

import * as THREE from "three";
import type { BikeOutfit } from "../../shared/outfit.ts";
import { type PaletteMaterial, SLOT } from "./palette.ts";
import { box, loft, PartSet, revolve, sweep, toothedRing, triangles, tube, type V3, v3 } from "./shapes.ts";

export type Lod = "high" | "low";

const DEG = Math.PI / 180;
/** 寸法（ライダーの姿勢もここを見る） */
export const FIT = {
  wheelR: 0.336,
  rearAxle: v3(0, 0.336, -0.405),
  frontAxle: v3(0, 0.336, 0.584),
  bb: v3(0, 0.268, 0),
  crank: 0.1725,
  /** ペダルの中心の左右位置 */
  pedalX: 0.112,
  headTop: v3(0, 0.833, 0.385),
  /** 0 度の操舵で、手を置くブラケットの上（左側。右は x を反転） */
  hood: v3(0.208, 0.928, 0.568),
  /** 操舵軸（上向き） */
  steerAxis: v3(0, Math.sin(73 * DEG), -Math.cos(73 * DEG)),
  seatDir: v3(0, Math.sin(73.5 * DEG), -Math.cos(73.5 * DEG)),
  /** サドルの上面の中心 */
  saddle: v3(0, 0.978, -0.215),
};

interface Shape {
  key: string;
  disc: boolean;
  steel: boolean;
  aero: boolean;
  seg: number;
  wheelSeg: number;
  spokes: number;
  rimDepth: number;
}

function shapeOf(b: BikeOutfit, lod: Lod): Shape {
  const high = lod === "high";
  return {
    key: `${b.frame}/${b.wheels}/${lod}`,
    disc: b.frame !== "steel",
    steel: b.frame === "steel",
    aero: b.frame === "aero",
    seg: high ? 12 : 6,
    wheelSeg: high ? 72 : 32,
    spokes: high ? (b.wheels === "deep" ? 20 : 24) : 12,
    rimDepth: b.wheels === "low" ? 0.022 : b.wheels === "mid" ? 0.042 : 0.06,
  };
}

const along = (a: V3, b: V3, t: number) => a.clone().lerp(b, t);

export class RoadBike {
  readonly group = new THREE.Group();
  /** 操舵軸の上端に置き、子の steering を軸まわりに回す */
  private readonly steerPivot = new THREE.Group();
  readonly steering = new THREE.Group();
  readonly frontWheel = new THREE.Group();
  readonly rearWheel = new THREE.Group();
  readonly crankset = new THREE.Group();
  private readonly frameMesh: THREE.Mesh;
  private readonly steerMesh: THREE.Mesh;
  private readonly frontMesh: THREE.Mesh;
  private readonly rearMesh: THREE.Mesh;
  private readonly crankMesh: THREE.Mesh;
  private readonly pedals: THREE.InstancedMesh;
  readonly screen: THREE.Mesh;
  private key = "";
  private rotation = 0;
  private previousDistance = 0;
  private phase = 0;
  private steer = 0;
  private display?: CanvasRenderingContext2D;
  private displayTexture?: THREE.CanvasTexture;
  private displaySpeed = -1;

  constructor(material: PaletteMaterial) {
    this.group.name = "road-bike";
    const mk = (name: string, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), material);
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    this.steerPivot.position.copy(FIT.headTop);
    this.steerPivot.quaternion.setFromUnitVectors(v3(0, 1, 0), FIT.steerAxis);
    this.steerPivot.add(this.steering);
    this.group.add(this.steerPivot, this.rearWheel, this.crankset);
    this.steering.add(this.frontWheel);
    this.frameMesh = mk("bike-frame", this.group);
    this.steerMesh = mk("bike-steering", this.steering);
    this.frontMesh = mk("bike-front-wheel", this.frontWheel);
    this.rearMesh = mk("bike-rear-wheel", this.rearWheel);
    this.crankMesh = mk("bike-crankset", this.crankset);
    this.pedals = new THREE.InstancedMesh(new THREE.BufferGeometry(), material, 2);
    this.pedals.name = "bike-pedals";
    this.pedals.castShadow = true;
    this.pedals.receiveShadow = true;
    this.pedals.frustumCulled = false;
    this.group.add(this.pedals);
    this.rearWheel.position.copy(FIT.rearAxle);
    this.crankset.position.copy(FIT.bb);
    // 前輪の位置は操舵の座標で
    this.frontWheel.position.copy(this.toSteering(FIT.frontAxle));

    let screenMaterial: THREE.Material = new THREE.MeshBasicMaterial({ color: "#c8d5af" });
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 192;
      this.display = canvas.getContext("2d") ?? undefined;
      this.displayTexture = new THREE.CanvasTexture(canvas);
      this.displayTexture.colorSpace = THREE.SRGBColorSpace;
      this.displayTexture.minFilter = THREE.LinearFilter;
      this.displayTexture.generateMipmaps = false;
      screenMaterial = new THREE.MeshBasicMaterial({ map: this.displayTexture, toneMapped: false });
    }
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.044, 0.062), screenMaterial);
    this.screen.name = "bike-computer-screen";
    this.steering.add(this.screen);
  }

  /** 車体の座標 → 操舵の座標（操舵 0 度の時） */
  private toSteering(p: V3) {
    const m = new THREE.Matrix4().compose(FIT.headTop, new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), FIT.steerAxis), v3(1, 1, 1));
    return p.clone().applyMatrix4(m.invert());
  }

  build(b: BikeOutfit, lod: Lod) {
    const s = shapeOf(b, lod);
    if (s.key === this.key) return;
    this.key = s.key;
    const steerInv = new THREE.Matrix4().compose(FIT.headTop, new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), FIT.steerAxis), v3(1, 1, 1)).invert();
    const replace = (mesh: THREE.Mesh, g: THREE.BufferGeometry) => {
      mesh.geometry.dispose();
      mesh.geometry = g;
    };
    replace(this.frameMesh, buildFrame(s, lod));
    const steer = buildSteering(s, lod);
    steer.applyMatrix4(steerInv);
    replace(this.steerMesh, steer);
    replace(this.frontMesh, buildWheel(s, false));
    replace(this.rearMesh, buildWheel(s, true));
    replace(this.crankMesh, buildCrankset(s, lod));
    this.pedals.geometry.dispose();
    this.pedals.geometry = buildPedal(lod);
    // サイコンの画面（本体の上面）
    const top = v3(0, 0.915, 0.567);
    this.screen.position.copy(top.applyMatrix4(steerInv));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.2, 0, 0));
    this.screen.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), FIT.steerAxis).invert().multiply(q));
    this.screen.visible = lod === "high";
    this.updatePedals();
    this.updateSpeed(Math.max(0, this.displaySpeed) / 3.6, true);
  }

  /** 走った距離から車輪を回し、操舵角とクランクの角度（phase、左クランクが前を向く時 0、下へ回ると増える）を付ける */
  update(distance: number, steer: number, speed: number, phase: number) {
    this.updateSpeed(speed);
    const delta = distance - this.previousDistance;
    if (Math.abs(delta) < 5) this.rotation += delta / FIT.wheelR;
    this.previousDistance = distance;
    this.rearWheel.rotation.x = this.rotation;
    this.frontWheel.rotation.x = this.rotation;
    this.steer = steer;
    this.steering.rotation.y = -steer;
    this.phase = phase;
    this.crankset.rotation.x = phase;
    this.updatePedals();
  }

  /** 左（side=1）右（side=-1）のペダルの中心（車体の座標） */
  pedalPoint(side: number, phase = this.phase) {
    const a = phase + (side < 0 ? Math.PI : 0);
    return v3(side * FIT.pedalX, FIT.bb.y - Math.sin(a) * FIT.crank, FIT.bb.z + Math.cos(a) * FIT.crank);
  }

  /** 左（side=1）右（side=-1）の手を置く所（車体の座標、操舵込み） */
  hoodPoint(side: number) {
    const local = this.toSteering(v3(side * FIT.hood.x, FIT.hood.y, FIT.hood.z));
    local.applyAxisAngle(v3(0, 1, 0), -this.steer);
    return local.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), FIT.steerAxis)).add(FIT.headTop);
  }

  private updatePedals() {
    const m = new THREE.Matrix4();
    for (const side of [1, -1]) {
      const p = this.pedalPoint(side);
      m.makeRotationY(side > 0 ? 0 : Math.PI);
      m.setPosition(p);
      this.pedals.setMatrixAt(side > 0 ? 0 : 1, m);
    }
    this.pedals.instanceMatrix.needsUpdate = true;
  }

  private updateSpeed(speed: number, force = false) {
    const kph = Math.max(0, Math.round(speed * 3.6));
    if (kph === this.displaySpeed && !force) return;
    this.displaySpeed = kph;
    const c = this.display;
    if (!c) return;
    c.fillStyle = "#c8d5af";
    c.fillRect(0, 0, 128, 192);
    c.fillStyle = "#17281e";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `700 ${kph < 100 ? 84 : 64}px Arial, sans-serif`;
    c.fillText(String(kph), 64, 82);
    c.font = "700 22px Arial, sans-serif";
    c.fillText("km/h", 64, 148);
    this.displayTexture!.needsUpdate = true;
  }

  stats() {
    let tris = 0;
    let draws = 0;
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) {
        draws++;
        tris += triangles(o.geometry) * (o instanceof THREE.InstancedMesh ? o.count : 1);
      }
    });
    return { key: this.key, draws, triangles: tris };
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.displayTexture?.dispose();
  }
}

// ---- 車体 ----

function buildFrame(s: Shape, lod: Lod): THREE.BufferGeometry {
  const P = new PartSet();
  const high = lod === "high";
  const { bb, rearAxle, headTop, steerAxis, seatDir } = FIT;
  const headBottom = headTop.clone().addScaledVector(steerAxis, -0.155);
  const seatLen = s.steel ? 0.555 : 0.5;
  const seatTop = bb.clone().addScaledVector(seatDir, seatLen);
  const ttFront = headTop.clone().addScaledVector(steerAxis, s.steel ? -0.035 : -0.025);
  const dtFront = headBottom.clone().addScaledVector(steerAxis, 0.03);
  const seg = s.seg;
  const F = SLOT.FRAME;
  const A = SLOT.ACCENT;

  // ヘッドチューブ（下が太い）
  P.add(tube(headBottom.clone().addScaledVector(steerAxis, -0.012), headTop.clone().addScaledVector(steerAxis, 0.004), s.steel ? A : A, { r0: s.steel ? 0.0175 : 0.026, r1: s.steel ? 0.0175 : 0.0205, seg, aspect: s.aero ? 1.25 : 1 }));
  // トップチューブ
  P.add(tube(ttFront, seatTop.clone().addScaledVector(seatDir, -0.02), F, { r0: s.steel ? 0.0143 : s.aero ? 0.015 : 0.017, r1: s.steel ? 0.0143 : 0.0135, aspect: s.aero ? 1.5 : s.steel ? 1 : 1.15, seg }));
  // ダウンチューブ（中ほどに差し色の帯）
  const dt = (t0: number, t1: number, slot: number) =>
    tube(along(dtFront, bb, t0), along(dtFront, bb, t1), slot, {
      r0: s.steel ? 0.0159 : s.aero ? 0.016 : 0.023,
      r1: s.steel ? 0.0159 : s.aero ? 0.018 : 0.024,
      aspect: s.aero ? 2.5 : s.steel ? 1 : 1.12,
      aspect1: s.aero ? 2.1 : undefined,
      seg,
      caps: false,
    });
  P.add(dt(0, 0.3, F), dt(0.3, 0.62, A), dt(0.62, 1, F));
  // シートチューブ
  P.add(tube(bb, seatTop, F, { r0: s.steel ? 0.0143 : s.aero ? 0.014 : 0.0165, aspect: s.aero ? 2 : 1, seg }));
  // BB
  P.add(revolve([[0.001, -0.043], [s.steel ? 0.02 : 0.024, -0.043], [s.steel ? 0.02 : 0.025, 0], [s.steel ? 0.02 : 0.024, 0.043], [0.001, 0.043]], F, seg + 4, bb));
  // 後ろのエンド
  const dropX = s.disc ? 0.068 : 0.064;
  const stayTop = s.aero ? along(bb, seatTop, 0.66) : seatTop.clone().addScaledVector(seatDir, -0.03);
  for (const side of [1, -1]) {
    const drop = rearAxle.clone().setX(side * dropX);
    // チェーンステー（BB の後ろで少し外へ曲げる）
    const csStart = bb.clone().add(v3(side * 0.035, 0.005, -0.03));
    const csMid = along(csStart, drop, 0.35).add(v3(side * 0.018, 0, 0));
    P.add(sweep([csStart, csMid, drop.clone().add(v3(0, 0.01, 0.015))], F, { r0: s.steel ? 0.011 : 0.0125, r1: s.steel ? 0.007 : 0.0085, aspect: s.steel ? 1 : 1.35, side: v3(1, 0, 0), seg: Math.max(6, seg - 2), samples: high ? 10 : 4 }));
    // シートステー
    const ssTop = stayTop.clone().add(v3(side * 0.018, 0, -0.012));
    const ssMid = along(drop, ssTop, 0.55).add(v3(side * 0.01, 0, 0));
    P.add(sweep([drop.clone().add(v3(0, 0.012, -0.006)), ssMid, ssTop], F, { r0: s.steel ? 0.0068 : 0.0075, r1: s.steel ? 0.0085 : s.aero ? 0.0085 : 0.0095, aspect: s.aero ? 1.6 : 1, side: v3(1, 0, 0), seg: Math.max(6, seg - 2), samples: high ? 8 : 3 }));
    // エンドの板
    P.add(box(drop.clone().add(v3(0, 0.004, 0.006)), v3(0.006, 0.034, 0.03), F));
  }
  if (s.steel) {
    // ラグ（つなぎ目の継手）は差し色
    for (const [p, dir, r] of [
      [headTop.clone().addScaledVector(steerAxis, -0.02), steerAxis, 0.0195],
      [headBottom.clone().addScaledVector(steerAxis, 0.015), steerAxis, 0.0195],
      [seatTop.clone().addScaledVector(seatDir, -0.012), seatDir, 0.0165],
    ] as const)
      P.add(tube(p.clone().addScaledVector(dir, -0.018), p.clone().addScaledVector(dir, 0.018), A, { r0: r, seg }));
    // シートステーのブリッジとリムブレーキ
    const bridge = along(rearAxle, stayTop, 0.62);
    P.add(tube(bridge.clone().setX(-0.022), bridge.clone().setX(0.022), F, { r0: 0.005, seg: 6 }));
    P.add(rimBrake(bridge.clone().add(v3(0, 0.005, -0.012)), rearAxle, high));
  }
  // シートポストとクランプ
  const postTop = bb.clone().addScaledVector(seatDir, 0.69);
  P.add(tube(seatTop.clone().addScaledVector(seatDir, -0.02), postTop, s.steel ? SLOT.ALLOY : SLOT.CARBON, { r0: s.aero ? 0.012 : 0.0136, aspect: s.aero ? 2 : 1, seg }));
  P.add(tube(seatTop.clone().addScaledVector(seatDir, -0.008), seatTop.clone().addScaledVector(seatDir, 0.012), s.steel ? SLOT.ALLOY : A, { r0: s.aero ? 0.016 : 0.019, aspect: s.aero ? 1.7 : 1, seg }));
  // サドル
  P.add(...saddle(high));
  // 後ろのブレーキ（ディスク）
  if (s.disc) {
    const at = rearAxle.clone().add(v3(0.058, 0.052, 0.045));
    P.add(caliper(at, v3(0, 0.6, 0.8).normalize(), high));
  }
  // 変速機（右）
  P.add(...rearDerailleur(high));
  if (high) {
    const fdAt = bb.clone().addScaledVector(seatDir, 0.17);
    P.add(tube(fdAt.clone().addScaledVector(seatDir, -0.008), fdAt.clone().addScaledVector(seatDir, 0.008), SLOT.STEEL, { r0: s.steel ? 0.0165 : s.aero ? 0.017 : 0.0185, seg }));
    P.add(box(fdAt.clone().add(v3(-0.054, -0.018, 0.03)), v3(0.014, 0.03, 0.062), SLOT.STEEL, new THREE.Euler(-0.25, 0, 0)));
  }
  // チェーン
  P.add(...chain(high));
  // ボトルケージとボトル（ダウンチューブの上）
  {
    const c = along(dtFront, bb, 0.5);
    const up = new THREE.Vector3().crossVectors(v3(1, 0, 0), bb.clone().sub(dtFront).normalize()).normalize();
    if (up.y < 0) up.negate();
    const dir = dtFront.clone().sub(bb).normalize();
    const base = c.clone().addScaledVector(up, s.aero ? 0.034 : 0.03);
    const bottleAxis = base.clone().addScaledVector(up, 0.038);
    const bottle = revolve(
      [[0.001, -0.095], [0.033, -0.093], [0.036, -0.08], [0.035, 0.03], [0.03, 0.06], [0.014, 0.075], [0.011, 0.088], [0.005, 0.098], [0.001, 0.1]],
      SLOT.BOTTLE,
      high ? 18 : 8,
    );
    // 回転体の軸 X をボトルの軸（ダウンチューブの向き）に
    bottle.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(v3(1, 0, 0), dir)));
    bottle.translate(bottleAxis.x, bottleAxis.y, bottleAxis.z);
    P.add(bottle);
    // ケージ（2本の細い腕）
    for (const sx of [1, -1]) {
      const a0 = base.clone().addScaledVector(dir, -0.07).add(v3(sx * 0.012, 0, 0));
      const a1 = bottleAxis.clone().addScaledVector(dir, -0.02).add(v3(sx * 0.038, 0, 0));
      const a2 = bottleAxis.clone().addScaledVector(dir, 0.055).add(v3(sx * 0.03, 0, 0)).addScaledVector(up, 0.01);
      P.add(sweep([a0, a1, a2], SLOT.ACCENT, { r0: 0.0025, seg: 4, samples: high ? 8 : 3 }));
    }
  }
  return P.build();
}

function saddle(high: boolean): THREE.BufferGeometry[] {
  const { saddle: c } = FIT;
  const sections: V3[][] = [];
  const n = high ? 16 : 8;
  const rows = high ? 14 : 6;
  const smooth = (e0: number, e1: number, x: number) => {
    const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return k * k * (3 - 2 * k);
  };
  for (let i = 0; i <= rows; i++) {
    const t = i / rows; // 0 が後ろ、1 が先端
    const z = c.z - 0.135 + t * 0.27;
    // 後ろは幅広く、中ほどから先へ細くなる
    const w = 0.004 + 0.066 * (1 - smooth(0.22, 0.82, t)) + 0.012 * (1 - smooth(0.82, 1, t)) - 0.012 * smooth(0, 0.08, 0.08 - t);
    const top = 0.019 - 0.006 * t + 0.006 * smooth(0.12, 0, t);
    const base = c.y - 0.014 - 0.006 * smooth(0.85, 1, t);
    const ring: V3[] = [];
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      const s = Math.sin(a);
      const y = s >= 0 ? Math.pow(s, 0.45) * top : -Math.pow(-s, 0.8) * 0.009;
      ring.push(v3(Math.cos(a) * w, base + y, z));
    }
    sections.push(ring);
  }
  const out = [loft(sections, SLOT.SADDLE)];
  // レール
  for (const side of [1, -1])
    out.push(sweep([v3(side * 0.035, c.y - 0.022, c.z - 0.11), v3(side * 0.022, c.y - 0.04, c.z - 0.04), v3(side * 0.018, c.y - 0.038, c.z + 0.04), v3(side * 0.01, c.y - 0.02, c.z + 0.115)], SLOT.STEEL, { r0: 0.0035, seg: 5, samples: high ? 10 : 4 }));
  // クランプ
  const post = FIT.bb.clone().addScaledVector(FIT.seatDir, 0.69);
  out.push(box(post.clone().add(v3(0, 0.012, 0)), v3(0.05, 0.016, 0.03), SLOT.CARBON));
  return out;
}

function caliper(at: V3, along: V3, high: boolean): THREE.BufferGeometry {
  const P = new PartSet();
  // ローター（x = 0.046 付近）をはさむ本体
  const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 0, 1), along);
  const e = new THREE.Euler().setFromQuaternion(q);
  P.add(box(at, v3(0.024, 0.026, 0.052), SLOT.CARBON, e));
  if (high) P.add(box(at.clone().add(v3(0.013, 0, 0)), v3(0.004, 0.018, 0.034), SLOT.ALLOY, e));
  return P.build();
}

function rimBrake(at: V3, axle: V3, high: boolean): THREE.BufferGeometry {
  const P = new PartSet();
  const r = FIT.wheelR + 0.012;
  const dir = at.clone().sub(axle).normalize();
  const center = axle.clone().addScaledVector(dir, r);
  // タイヤを越える腕
  for (const side of [1, -1]) {
    const pad = axle.clone().addScaledVector(dir, 0.3).add(v3(side * 0.017, 0, 0));
    P.add(sweep([center.clone().add(v3(0, 0.006, 0)), center.clone().add(v3(side * 0.02, -0.004, 0)), pad], SLOT.ALLOY, { r0: 0.005, r1: 0.004, aspect: 1.8, seg: high ? 6 : 4, samples: high ? 6 : 3 }));
    P.add(box(pad, v3(0.006, 0.01, 0.032), SLOT.RUBBER));
  }
  return P.build();
}

function rearDerailleur(high: boolean): THREE.BufferGeometry[] {
  const { rearAxle } = FIT;
  const x = -0.066;
  const upper = rearAxle.clone().add(v3(0, -0.058, 0.012)).setX(x);
  const lower = rearAxle.clone().add(v3(0, -0.118, 0.03)).setX(x);
  const out: THREE.BufferGeometry[] = [];
  // 本体（ハンガーから斜め下）
  out.push(box(rearAxle.clone().add(v3(0, -0.028, -0.02)).setX(x - 0.008), v3(0.016, 0.042, 0.03), SLOT.CARBON, new THREE.Euler(0.5, 0, 0)));
  // ケージの板と滑車
  for (const dx of [-0.006, 0.006]) out.push(box(along(upper, lower, 0.5).setX(x + dx), v3(0.002, 0.085, 0.024), SLOT.ALLOY, new THREE.Euler(-0.3, 0, 0)));
  for (const p of [upper, lower]) out.push(toothedRing(0.0175, 0.003, high ? 11 : 6, 0.004, SLOT.STEEL, 0).translate(p.x, p.y, p.z));
  return out;
}

/** チェーンの経路（チェーンリング 52T、中ほどのスプロケット、変速機の滑車2つ） */
function chainPath(): V3[] {
  const { bb, rearAxle } = FIT;
  const ring = 0.1052;
  const cog = 0.04;
  const pts: V3[] = [];
  const arc = (c: V3, r: number, a0: number, a1: number, n: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push(v3(0, c.y + Math.sin(a) * r, c.z + Math.cos(a) * r));
    }
  };
  // チェーンリングの前半分（上から前を回って下へ）
  arc(bb, ring, Math.PI / 2, -Math.PI / 2, 16);
  // 下側は変速機の下の滑車へ
  const lower = v3(0, rearAxle.y - 0.118, rearAxle.z + 0.03);
  const upper = v3(0, rearAxle.y - 0.058, rearAxle.z + 0.012);
  arc(lower, 0.0175, -Math.PI / 2, -Math.PI * 1.5 + 0.4, 8);
  arc(upper, 0.0175, Math.PI * 0.6, 0.2, 6);
  // スプロケットの後ろを回って上へ
  arc(rearAxle, cog, -Math.PI * 0.9, -Math.PI * 1.5, 8);
  pts.push(v3(0, bb.y + ring, bb.z));
  return pts;
}

function chain(high: boolean): THREE.BufferGeometry[] {
  const x = -0.0485;
  const pts = chainPath().map((p) => p.setX(x));
  if (!high) return [sweep(pts, SLOT.CHAIN, { r0: 0.0028, aspect: 1.9, seg: 4, samples: pts.length * 2, caps: false, side: v3(1, 0, 0) })];
  // 12.7mm ごとに色の違う駒を並べる
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const len = curve.getLength();
  const n = Math.round(len / 0.0127);
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const a = curve.getPointAt(i / n);
    const b = curve.getPointAt((i + 1) / n);
    out.push(tube(a, b, i % 2 ? SLOT.CHAIN : SLOT.STEEL, { r0: i % 2 ? 0.0029 : 0.0024, aspect: i % 2 ? 1.5 : 1.3, seg: 4, side: v3(1, 0, 0), caps: false }));
  }
  return out;
}

// ---- ハンドルまわり（車体の座標で作り、呼ぶ側で操舵の座標へ移す） ----

function buildSteering(s: Shape, lod: Lod): THREE.BufferGeometry {
  const P = new PartSet();
  const high = lod === "high";
  const { headTop, steerAxis, frontAxle } = FIT;
  const seg = s.seg;
  const headBottom = headTop.clone().addScaledVector(steerAxis, -0.155);
  // フォーク
  const forward = new THREE.Vector3().crossVectors(v3(1, 0, 0), steerAxis).normalize(); // 前向きで操舵軸に直交
  const crown = headBottom.clone().addScaledVector(steerAxis, -0.022);
  P.add(tube(headBottom.clone().addScaledVector(steerAxis, 0.004), crown.clone().addScaledVector(steerAxis, -0.006), s.steel ? SLOT.ACCENT : SLOT.FRAME, { r0: s.steel ? 0.019 : 0.028, aspect: s.aero ? 1.3 : 1, seg }));
  const dropX = s.disc ? 0.051 : 0.05;
  for (const side of [1, -1]) {
    const top = crown.clone().add(v3(side * (s.steel ? 0.03 : 0.036), -0.004, 0));
    const tip = frontAxle.clone().setX(side * dropX);
    const mid = along(top, tip, 0.55).add(v3(0, 0, 0)).addScaledVector(forward, s.steel ? 0.004 : -0.004);
    const tipUp = tip.clone().addScaledVector(steerAxis, 0.012);
    P.add(sweep(s.steel ? [top, mid, tipUp.clone().addScaledVector(forward, 0.012), tip] : [top, mid, tipUp, tip], SLOT.FRAME, { r0: s.steel ? 0.013 : s.aero ? 0.012 : 0.016, r1: s.steel ? 0.007 : 0.0085, aspect: s.aero ? 2.3 : s.steel ? 1.15 : 1.4, aspect1: s.aero ? 1.6 : 1.1, side: v3(1, 0, 0), seg: Math.max(6, seg - 2), samples: high ? 10 : 4 }));
  }
  if (s.steel) P.add(rimBrake(crown.clone().addScaledVector(forward, 0.016), frontAxle, high));
  else P.add(caliper(frontAxle.clone().add(v3(0.058, 0.055, -0.035)), v3(0, 0.75, -0.66).normalize(), high));
  // ヘッドの上の小物（ヘッドパーツ、スペーサー、コラム）
  P.add(tube(headTop.clone().addScaledVector(steerAxis, 0.002), headTop.clone().addScaledVector(steerAxis, 0.03), SLOT.CARBON, { r0: s.aero ? 0.021 : 0.018, aspect: s.aero ? 1.25 : 1, seg }));
  // ステム
  const stemBase = headTop.clone().addScaledVector(steerAxis, 0.05);
  const stemDir = v3(0, Math.sin(11 * DEG), Math.cos(11 * DEG));
  const clamp = stemBase.clone().addScaledVector(stemDir, 0.1);
  const stemSlot = s.steel ? SLOT.ALLOY : SLOT.CARBON;
  P.add(tube(stemBase.clone().addScaledVector(steerAxis, -0.022), stemBase.clone().addScaledVector(steerAxis, 0.024), stemSlot, { r0: 0.0185, seg }));
  P.add(tube(stemBase, clamp, stemSlot, { r0: 0.0165, r1: 0.014, aspect: s.aero ? 0.7 : 1.15, side: v3(1, 0, 0), seg }));
  P.add(tube(clamp.clone().setX(-0.026), clamp.clone().setX(0.026), stemSlot, { r0: 0.018, seg }));
  // ハンドル（中央はむき出し、外側はバーテープ）
  const bar = (side: number): V3[] => [
    v3(side * 0.04, clamp.y, clamp.z),
    v3(side * 0.16, clamp.y, clamp.z + 0.004),
    v3(side * 0.198, clamp.y - 0.002, clamp.z + 0.03),
    v3(side * 0.207, clamp.y - 0.012, clamp.z + 0.075),
    v3(side * 0.21, clamp.y - 0.06, clamp.z + 0.105),
    v3(side * 0.212, clamp.y - 0.11, clamp.z + 0.09),
    v3(side * 0.214, clamp.y - 0.128, clamp.z + 0.04),
    v3(side * 0.215, clamp.y - 0.128, clamp.z - 0.02),
  ];
  for (const side of [1, -1]) {
    const pts = bar(side);
    if (s.aero) {
      // 一体型のエアロハンドル: 平たい上面
      P.add(sweep([v3(0, clamp.y, clamp.z), pts[1], pts[2]], SLOT.CARBON, { r0: 0.016, aspect: 0.38, side: v3(0, 0, 1), seg, samples: high ? 8 : 3, caps: false }));
      P.add(sweep(pts.slice(2), SLOT.TAPE, { r0: 0.0135, seg, samples: high ? 24 : 8 }));
    } else {
      P.add(sweep([v3(0, clamp.y, clamp.z), pts[0], pts[1]], s.steel ? SLOT.ALLOY : SLOT.CARBON, { r0: 0.0135, seg, samples: 2, caps: false }));
      P.add(sweep(pts.slice(1), SLOT.TAPE, { r0: 0.0135, seg, samples: high ? 28 : 10 }));
    }
    // ブラケット（レバーの本体）とレバー
    const h0 = v3(side * 0.208, clamp.y + 0.002, clamp.z + 0.07);
    const sections: V3[][] = [];
    const n = high ? 10 : 6;
    const rows = high ? 7 : 4;
    for (let i = 0; i <= rows; i++) {
      const t = i / rows;
      const c = h0.clone().add(v3(0, 0.008 + t * 0.016 + (t > 0.7 ? (t - 0.7) * 0.03 : 0), t * 0.065));
      const w = 0.0145 - t * 0.003;
      const hh = 0.021 - t * 0.005 + (t > 0.8 ? 0.004 : 0);
      const ring: V3[] = [];
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2;
        ring.push(c.clone().add(v3(Math.cos(a) * w, Math.sin(a) * hh, 0)));
      }
      sections.push(ring);
    }
    P.add(loft(sections, SLOT.RUBBER));
    const blade = [h0.clone().add(v3(0, 0.002, 0.058)), h0.clone().add(v3(0, -0.04, 0.075)), h0.clone().add(v3(side * 0.003, -0.095, 0.06)), h0.clone().add(v3(side * 0.006, -0.115, 0.04))];
    P.add(sweep(blade, s.steel ? SLOT.ALLOY : SLOT.CARBON, { r0: 0.0055, r1: 0.0045, aspect: 1.9, side: v3(1, 0, 0), seg: high ? 6 : 4, samples: high ? 10 : 4 }));
    if (high) P.add(sweep([blade[1].clone().add(v3(-side * 0.004, -0.004, -0.006)), blade[2].clone().add(v3(-side * 0.006, -0.002, -0.008))], SLOT.CARBON, { r0: 0.003, aspect: 2, seg: 4 }));
  }
  // サイコンと台座
  P.add(tube(clamp.clone().add(v3(0, 0, 0.012)), v3(0, clamp.y + 0.006, clamp.z + 0.085), SLOT.CARBON, { r0: 0.006, aspect: 1.6, seg: high ? 6 : 4 }));
  P.add(box(v3(0, clamp.y + 0.014, clamp.z + 0.095), v3(0.054, 0.018, 0.078), SLOT.CARBON, new THREE.Euler(-0.2, 0, 0)));
  return P.build();
}

// ---- 車輪 ----

function buildWheel(s: Shape, rear: boolean): THREE.BufferGeometry {
  const P = new PartSet();
  const R = FIT.wheelR;
  const bead = 0.311;
  const rimIn = bead - s.rimDepth;
  const halfW = s.aero ? 0.0145 : 0.0128;
  const rs = s.wheelSeg;
  // リム（断面: 外側の縁 → 側面 → 内側の丸み）
  P.add(
    revolve(
      [
        [bead + 0.001, halfW * 0.85],
        [bead + 0.004, halfW],
        [bead - 0.006, halfW],
        [rimIn + 0.012, halfW * 0.92],
        [rimIn + 0.003, halfW * 0.55],
        [rimIn, 0],
        [rimIn + 0.003, -halfW * 0.55],
        [rimIn + 0.012, -halfW * 0.92],
        [bead - 0.006, -halfW],
        [bead + 0.004, -halfW],
        [bead + 0.001, -halfW * 0.85],
      ],
      [SLOT.RIM, s.steel ? SLOT.ALLOY : SLOT.RIM, SLOT.RIM, SLOT.RIM, SLOT.RIM, SLOT.RIM, SLOT.RIM, SLOT.RIM, s.steel ? SLOT.ALLOY : SLOT.RIM, SLOT.RIM],
      rs,
    ),
  );
  // タイヤ（踏面は黒、側面は設定の色）
  const tr = (R - bead) / 2 + 0.0005;
  const tc = bead + tr - 0.0005;
  const prof: [number, number][] = [];
  const slots: number[] = [];
  const steps = rs > 40 ? 14 : 8;
  for (let i = 0; i <= steps; i++) {
    const a = -1.95 + (3.9 * i) / steps; // 断面の角度。0 が踏面の中心
    prof.push([tc + Math.cos(a) * tr, Math.sin(a) * tr * 1.02]);
    if (i < steps) {
      const mid = -1.95 + (3.9 * (i + 0.5)) / steps;
      slots.push(Math.abs(mid) < 0.85 ? SLOT.RUBBER : SLOT.TIRE_WALL);
    }
  }
  P.add(revolve(prof, slots, rs));
  // ハブ
  const flangeX = rear ? 0.028 : 0.026;
  const flangeR = rear ? 0.024 : 0.021;
  P.add(revolve([[0.005, -0.05], [0.012, -0.048], [0.013, -flangeX - 0.004], [flangeR, -flangeX - 0.002], [flangeR, -flangeX + 0.002], [0.015, -flangeX + 0.006], [0.016, 0], [0.015, flangeX - 0.006], [flangeR, flangeX - 0.002], [flangeR, flangeX + 0.002], [0.013, flangeX + 0.004], [0.012, 0.048], [0.005, 0.05]], s.steel ? SLOT.ALLOY : SLOT.CARBON, 16));
  // スポーク（後輪は交差組み）
  const n = s.spokes;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const a = (i / n) * Math.PI * 2;
    const cross = rear ? (i % 4 < 2 ? 1 : -1) * 0.35 : 0;
    const hub = v3(side * flangeX, Math.sin(a + cross) * flangeR, Math.cos(a + cross) * flangeR);
    const rim = v3(side * 0.003, Math.sin(a) * (rimIn + 0.004), Math.cos(a) * (rimIn + 0.004));
    P.add(tube(hub, rim, SLOT.STEEL, { r0: 0.0012, aspect: s.aero || s.rimDepth > 0.05 ? 2.4 : 1, side: v3(1, 0, 0), seg: rs > 40 ? 4 : 3, caps: false }));
  }
  if (s.disc) {
    // ローター（左）
    const x = 0.046;
    P.add(revolve([[0.058, x - 0.0009], [0.08, x - 0.0009], [0.08, x + 0.0009], [0.058, x + 0.0009], [0.058, x - 0.0009]], SLOT.DISC, rs > 40 ? 40 : 20));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      P.add(box(v3(x, Math.sin(a) * 0.04, Math.cos(a) * 0.04), v3(0.003, 0.008, 0.04), SLOT.CARBON, new THREE.Euler(-a, 0, 0)));
    }
  }
  if (rear) {
    // スプロケット（右、11 枚）
    const teeth = [11, 12, 13, 14, 15, 17, 19, 21, 23, 25, 28];
    for (let i = 0; i < teeth.length; i++) {
      if (rs < 40 && i % 2) continue;
      const t = teeth[i];
      const r = 0.0127 / (2 * Math.sin(Math.PI / t));
      const x = -0.064 + i * 0.0037;
      P.add(rs > 40 ? toothedRing(r + 0.003, 0.016, t, 0.0018, SLOT.STEEL, x, 0.0035) : revolve([[0.016, x], [r + 0.002, x], [r + 0.002, x + 0.003]], SLOT.STEEL, 16));
    }
  }
  return P.build();
}

// ---- クランク ----

function buildCrankset(s: Shape, lod: Lod): THREE.BufferGeometry {
  const P = new PartSet();
  const high = lod === "high";
  const arm = s.steel ? SLOT.ALLOY : SLOT.CARBON;
  // チェーンリング（右、52/36）
  if (high) {
    P.add(toothedRing(0.1052 + 0.0035, 0.09, 52, 0.0035, SLOT.STEEL, -0.0525));
    P.add(toothedRing(0.0729 + 0.0035, 0.06, 36, 0.0035, SLOT.STEEL, -0.0455));
  } else {
    P.add(revolve([[0.088, -0.054], [0.108, -0.054], [0.108, -0.051], [0.088, -0.051]], SLOT.STEEL, 24));
  }
  // スパイダー（4本）
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    P.add(tube(v3(-0.05, 0, 0), v3(-0.05, Math.sin(a) * 0.092, Math.cos(a) * 0.092), arm, { r0: 0.009, r1: 0.006, aspect: 0.55, side: v3(1, 0, 0), seg: high ? 6 : 4 }));
  }
  // 軸
  P.add(tube(v3(-0.07, 0, 0), v3(0.07, 0, 0), SLOT.STEEL, { r0: 0.012, seg: high ? 10 : 6 }));
  // 腕（左は前、右は後ろが 0 度）。先細りで外へ開く
  for (const side of [1, -1]) {
    const from = v3(side * 0.066, 0, 0);
    const to = v3(side * 0.082, 0, side * FIT.crank);
    P.add(tube(from, to, arm, { r0: 0.0105, r1: 0.0075, aspect: 1.9, side: v3(1, 0, 0), seg: high ? 8 : 4 }));
    P.add(tube(to.clone().setX(side * 0.074), to.clone().setX(side * 0.09), SLOT.STEEL, { r0: 0.006, seg: 6 }));
  }
  return P.build();
}

function buildPedal(lod: Lod): THREE.BufferGeometry {
  const P = new PartSet();
  const high = lod === "high";
  // 左のペダル（右は Y 軸まわりに反転して使う）。中心が原点、軸は -X 側から
  P.add(tube(v3(-0.03, 0, 0), v3(0.02, 0, 0), SLOT.STEEL, { r0: 0.006, seg: 6 }));
  const sections: V3[][] = [];
  const n = high ? 8 : 6;
  for (const [z, w, h] of [
    [-0.045, 0.026, 0.006],
    [-0.02, 0.034, 0.009],
    [0.025, 0.032, 0.009],
    [0.05, 0.02, 0.006],
  ] as const) {
    const ring: V3[] = [];
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      ring.push(v3(0.005 + Math.cos(a) * w, Math.sin(a) * h, z));
    }
    sections.push(ring);
  }
  P.add(loft(sections, SLOT.CARBON));
  return P.build();
}
