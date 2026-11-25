// 受け渡しの所の印（配達の草案 26 章）: 建物に立つ光の柱と、その前の道の上の光る円。円に入った時に、荷が柱から自転車へ
// （渡す時は自転車から柱へ）飛ぶ動き。外部の素材は使わず、円柱・輪・箱だけで描く。位置は src/game.ts が決め、ここは描くだけ。

import * as THREE from "three";

/** 受け取りと届け先の色（地図の印と同じ） */
export const HANDOFF_COLORS = { pickup: "#ff4fa3", dropoff: "#35e08a" } as const;
export type HandoffKind = keyof typeof HANDOFF_COLORS;

export interface HandoffMark {
  kind: HandoffKind;
  /** いま向かっている行き先（ほかの注文の行き先は薄く） */
  active: boolean;
  /** 光の柱の根元（世界座標） */
  px: number;
  py: number;
  pz: number;
  /** 円の中心と半径 (m) */
  zx: number;
  zy: number;
  zz: number;
  r: number;
}

const SLOTS = 3;
const PILLAR_H = 70;
const FLY_S = 0.7;
/** 円を道の面から浮かす高さ (m)（道の面は点の高さより少し上に張られている） */
const ROAD_LIFT = 0.3;

/** 下が濃く上へ薄くなる縦の帯の画像（柱に貼る） */
function fadeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.15, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 中心が薄く縁が濃い円の画像（道の上の円に貼る） */
function discTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.18)");
  grad.addColorStop(0.78, "rgba(255,255,255,0.32)");
  grad.addColorStop(0.86, "rgba(255,255,255,1)");
  grad.addColorStop(0.95, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Slot {
  pillar: THREE.Mesh;
  core: THREE.Mesh;
  disc: THREE.Mesh;
  ring: THREE.Mesh;
}

interface Fly {
  kind: HandoffKind;
  t: number;
  from: THREE.Vector3;
  to: () => THREE.Vector3;
  /** 円の中心（広がる輪を出す） */
  at: THREE.Vector3;
}

export class HandoffView {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private box: THREE.Mesh;
  private burst: THREE.Mesh;
  private fly: Fly | null = null;
  private clock = 0;

  constructor() {
    this.group.name = "handoff-marks";
    const fade = fadeTexture();
    const disc = discTexture();
    // 明るい空の前でも見えるよう、足す混ぜ方ではなく普通の半透明にする。外側の光は建物の向こうでも見せる（depthTest なし）
    const glow = (map: THREE.Texture, opacity: number, throughWalls: boolean) =>
      new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false, depthTest: !throughWalls, side: THREE.DoubleSide, fog: false });
    const pillarGeo = new THREE.CylinderGeometry(2.4, 2.4, PILLAR_H, 20, 1, true);
    pillarGeo.translate(0, PILLAR_H / 2, 0);
    const coreGeo = new THREE.CylinderGeometry(0.7, 0.7, PILLAR_H, 12, 1, true);
    coreGeo.translate(0, PILLAR_H / 2, 0);
    const discGeo = new THREE.CircleGeometry(1, 40);
    discGeo.rotateX(-Math.PI / 2);
    const ringGeo = new THREE.RingGeometry(0.92, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < SLOTS; i++) {
      const s: Slot = {
        pillar: new THREE.Mesh(pillarGeo, glow(fade, 0.6, true)),
        core: new THREE.Mesh(coreGeo, glow(fade, 0.95, false)),
        disc: new THREE.Mesh(discGeo, glow(disc, 0.9, false)),
        ring: new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, fog: false })),
      };
      for (const m of [s.pillar, s.core, s.disc, s.ring]) {
        m.frustumCulled = false;
        m.renderOrder = 5;
        m.visible = false;
        this.group.add(m);
      }
      this.slots.push(s);
    }
    // 飛ぶ荷（段ボールの箱）と、円に入った時に広がる輪
    this.box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.32), new THREE.MeshStandardMaterial({ color: "#c08a4e", roughness: 0.9 }));
    this.box.visible = false;
    this.group.add(this.box);
    this.burst = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.burst.visible = false;
    this.burst.renderOrder = 6;
    this.group.add(this.burst);
  }

  /** 受け取り・受け渡しの動きを始める。pickup は柱から自転車へ、dropoff は自転車から柱へ */
  play(kind: HandoffKind, pillar: { x: number; y: number; z: number }, zone: { x: number; y: number; z: number }, rider: () => { x: number; y: number; z: number }) {
    const p = new THREE.Vector3(pillar.x, pillar.y + 1.2, pillar.z);
    const r = () => {
      const q = rider();
      return new THREE.Vector3(q.x, q.y + 1.1, q.z);
    };
    this.fly =
      kind === "pickup"
        ? { kind, t: 0, from: p, to: r, at: new THREE.Vector3(zone.x, zone.y, zone.z) }
        : { kind, t: 0, from: r(), to: () => p, at: new THREE.Vector3(zone.x, zone.y, zone.z) };
  }

  /** 描く。marks は世界座標、origin を引いて置く。dt は秒 */
  update(marks: HandoffMark[], originX: number, originZ: number, dt: number) {
    this.clock += dt;
    const t = this.clock;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.slots[i];
      const m = marks[i];
      const on = !!m;
      for (const o of [s.pillar, s.core, s.disc, s.ring]) o.visible = on;
      if (!m) continue;
      const color = HANDOFF_COLORS[m.kind];
      const dim = m.active ? 1 : 0.45;
      for (const o of [s.pillar, s.core, s.disc, s.ring]) (o.material as THREE.MeshBasicMaterial).color.set(color).multiplyScalar(dim);
      const pulse = 1 + Math.sin(t * 3.2 + i) * 0.06;
      s.pillar.position.set(m.px - originX, m.py, m.pz - originZ);
      s.pillar.scale.set(pulse, 1, pulse);
      s.core.position.copy(s.pillar.position);
      s.disc.position.set(m.zx - originX, m.zy + ROAD_LIFT, m.zz - originZ);
      s.disc.scale.setScalar(m.r);
      // 縁の輪は円の中から外へ、くり返し広がる
      const k = (t * 0.8 + i * 0.3) % 1;
      s.ring.position.set(m.zx - originX, m.zy + ROAD_LIFT + 0.02, m.zz - originZ);
      s.ring.scale.setScalar(m.r * (0.35 + 0.65 * k));
      (s.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k);
    }
    const f = this.fly;
    if (!f) {
      this.box.visible = this.burst.visible = false;
      return;
    }
    f.t += dt;
    const u = Math.min(1, f.t / FLY_S);
    const a = f.from;
    const b = f.to();
    // 放物線で飛ばして、くるくる回す
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    const y = a.y + (b.y - a.y) * u + 4 * u * (1 - u) * 2.2;
    this.box.visible = u < 1;
    this.box.position.set(x - originX, y, z - originZ);
    this.box.rotation.set(u * 5, u * 7, 0);
    const v = Math.min(1, f.t / 0.5);
    this.burst.visible = v < 1;
    this.burst.position.set(f.at.x - originX, f.at.y + ROAD_LIFT + 0.04, f.at.z - originZ);
    this.burst.scale.setScalar(2 + v * 9);
    const mat = this.burst.material as THREE.MeshBasicMaterial;
    mat.color.set(HANDOFF_COLORS[f.kind]);
    mat.opacity = 1 - v;
    if (u >= 1 && v >= 1) this.fly = null;
  }
}
