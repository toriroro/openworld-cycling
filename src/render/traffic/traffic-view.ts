// 交通の描画（都市と交通の草案 6.8）。車種ごとに 2 つのインスタンス描画（塗装・決まった色の部分）。
// sim/traffic の状態を読むだけ。夜と霧では灯火を光らせる（道を照らす光源は作らない）。バス停の標柱と待合所も描く。

import * as THREE from "three";
import type { BusStop } from "../../sim/traffic/bus-stops.ts";
import type { Traffic } from "../../sim/traffic/traffic.ts";
import { VEHICLE_TYPES, type VehicleType } from "../../sim/traffic/vehicle-types.ts";
import { vehicleGeometry } from "./vehicle-shapes.ts";

const CAPACITY: Record<VehicleType, number> = { sedan: 150, kei: 150, minivan: 150, van: 150, keiTruck: 150, bus: 40, courier: 60 };

/** 頂点の glow の量だけ、頂点色で光らせる材質 */
function glowMaterial(params: THREE.MeshStandardMaterialParameters, lights: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...params });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLights = lights;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;\nuniform float uLights;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * uLights;");
  };
  m.customProgramCacheKey = () => "traffic-glow-v1";
  return m;
}

function tinted(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  g.deleteAttribute("uv");
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("glow", new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  return g;
}

function boxAt(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(cx, cy, cz);
  return tinted(g, color);
}

/** バス停の標柱（原点は根元、+x が道路から離れる向き） */
function stopPole(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.04, 0.05, 2.4, 8).toNonIndexed();
  pole.translate(0, 1.2, 0);
  const plate = new THREE.CylinderGeometry(0.27, 0.27, 0.04, 20).toNonIndexed();
  plate.rotateZ(Math.PI / 2);
  plate.rotateY(Math.PI / 2);
  plate.translate(0, 2.25, 0);
  const ring = new THREE.CylinderGeometry(0.3, 0.3, 0.03, 20).toNonIndexed();
  ring.rotateZ(Math.PI / 2);
  ring.rotateY(Math.PI / 2);
  ring.translate(0, 2.25, 0);
  const base = new THREE.CylinderGeometry(0.22, 0.25, 0.12, 12).toNonIndexed();
  base.translate(0, 0.06, 0);
  const parts = [
    tinted(pole, "#c9ccc8"),
    tinted(ring, "#c23a2e"),
    tinted(plate, "#f1efe6"),
    tinted(base, "#5d6062"),
    // 時刻表の板
    boxAt(0, 1.35, 0, 0.04, 0.5, 0.38, "#f4f2ea"),
  ];
  const g = mergeAll(parts);
  return g;
}

/** 待合所（雪国の小屋型。道路側の面が開いている。原点は道路側の縁の中央、+x が奥） */
function shelter(): THREE.BufferGeometry {
  const w = 2.6;
  const d = 1.5;
  const h = 2.25;
  const wall = "#d8cfb8";
  const parts = [
    // 奥の壁と左右の壁
    boxAt(d - 0.05, h / 2, 0, 0.1, h, w, wall),
    boxAt(d / 2, h / 2, -w / 2 + 0.05, d, h, 0.1, wall),
    boxAt(d / 2, h / 2, w / 2 - 0.05, d, h, 0.1, wall),
    // 左右の壁の窓
    boxAt(d / 2, 1.45, -w / 2 - 0.005, 0.8, 0.6, 0.02, "#2a3338"),
    boxAt(d / 2, 1.45, w / 2 + 0.005, 0.8, 0.6, 0.02, "#2a3338"),
    // 道路側の柱と腰壁
    boxAt(0.05, h / 2, -w / 2 + 0.05, 0.1, h, 0.1, wall),
    boxAt(0.05, h / 2, w / 2 - 0.05, 0.1, h, 0.1, wall),
    // 長椅子
    boxAt(d - 0.35, 0.45, 0, 0.4, 0.06, w - 0.4, "#8a6a48"),
    // 床
    boxAt(d / 2, 0.04, 0, d, 0.08, w, "#8f9090"),
  ];
  // 屋根（奥へ下がる片流れ、雪を落とす）
  const roof = new THREE.BoxGeometry(d + 0.5, 0.08, w + 0.3).toNonIndexed();
  roof.rotateZ(-0.22);
  roof.translate(d / 2, h + 0.14, 0);
  parts.push(tinted(roof, "#38506a"));
  return mergeAll(parts);
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // 属性はそろえてある（position・normal・color・glow）
  let count = 0;
  for (const p of parts) count += p.getAttribute("position").count;
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color", "glow"]) {
    const size = parts[0].getAttribute(name).itemSize;
    const arr = new Float32Array(count * size);
    let o = 0;
    for (const p of parts) {
      const a = p.getAttribute(name).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

export class TrafficView {
  readonly group = new THREE.Group();
  private paint = new Map<VehicleType, THREE.InstancedMesh>();
  private fixed = new Map<VehicleType, THREE.InstancedMesh>();
  private lights = { value: 0 };
  private paintMat = new THREE.MeshStandardMaterial({ color: "#ffffff", metalness: 0.35, roughness: 0.38 });
  private fixedMat: THREE.MeshStandardMaterial;
  private poles: THREE.InstancedMesh;
  private shelters: THREE.InstancedMesh;
  private stopKey = "";
  private stopT = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  readonly stats = { drawn: 0, stops: 0, shelters: 0 };

  constructor() {
    this.group.name = "traffic";
    this.fixedMat = glowMaterial({ roughness: 0.55, metalness: 0.1 }, this.lights);
    for (const t of VEHICLE_TYPES) {
      const g = vehicleGeometry(t);
      const a = new THREE.InstancedMesh(g.paint, this.paintMat, CAPACITY[t]);
      const b = new THREE.InstancedMesh(g.fixed, this.fixedMat, CAPACITY[t]);
      for (const im of [a, b]) {
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
      }
      a.setColorAt(0, new THREE.Color(1, 1, 1));
      a.name = `traffic-${t}-paint`;
      b.name = `traffic-${t}-fixed`;
      this.paint.set(t, a);
      this.fixed.set(t, b);
    }
    this.poles = new THREE.InstancedMesh(stopPole(), this.fixedMat, 64);
    this.shelters = new THREE.InstancedMesh(shelter(), this.fixedMat, 32);
    for (const im of [this.poles, this.shelters]) {
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.group.add(im);
    }
  }

  setQuality(light: boolean) {
    for (const im of [...this.paint.values(), ...this.fixed.values(), this.poles, this.shelters]) im.castShadow = !light;
  }

  /**
   * 描く。originX, originZ は描画の原点。lights は灯火の明るさ（0 = 昼、夜と霧で上げる）。
   * cx, cz はカメラの世界座標（バス停を選ぶ）
   */
  update(traffic: Traffic, originX: number, originZ: number, lights: number, cx: number, cz: number, hide?: ReadonlySet<number>) {
    this.lights.value = lights;
    const counts = new Map<VehicleType, number>();
    for (const v of traffic.vehicles) {
      // 別の形で描いている物（近くの配達員を人の形で。npc-riders.ts）
      if (hide?.has(v.id)) continue;
      const t = v.type;
      const i = counts.get(t) ?? 0;
      if (i >= CAPACITY[t]) continue;
      counts.set(t, i + 1);
      this.e.set(-Math.atan(v.grade), Math.atan2(v.dx, v.dz), 0);
      this.q.setFromEuler(this.e);
      this.p.set(v.x - originX, v.y + 0.02, v.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      const a = this.paint.get(t)!;
      const b = this.fixed.get(t)!;
      a.setMatrixAt(i, this.m);
      b.setMatrixAt(i, this.m);
      a.setColorAt(i, this.c.set(v.color));
    }
    let drawn = 0;
    for (const t of VEHICLE_TYPES) {
      const n = counts.get(t) ?? 0;
      drawn += n;
      const a = this.paint.get(t)!;
      const b = this.fixed.get(t)!;
      a.count = n;
      b.count = n;
      a.visible = b.visible = n > 0;
      if (n) {
        a.instanceMatrix.needsUpdate = true;
        b.instanceMatrix.needsUpdate = true;
        if (a.instanceColor) a.instanceColor.needsUpdate = true;
      }
    }
    this.stats.drawn = drawn;
    this.updateStops(traffic, originX, originZ, cx, cz);
  }

  private updateStops(traffic: Traffic, originX: number, originZ: number, cx: number, cz: number) {
    const now = performance.now();
    const key = `${originX},${originZ}`;
    if (now - this.stopT < 500 && key === this.stopKey.split("|")[0]) return;
    this.stopT = now;
    const stops: BusStop[] = traffic.stopsNear(cx, cz, 700);
    const ids = stops.map((s) => s.id).join(",");
    const full = `${key}|${ids}`;
    if (full === this.stopKey) return;
    this.stopKey = full;
    let np = 0;
    let ns = 0;
    for (const st of stops) {
      if (np >= 64) break;
      // 道路から離れる向き（右が正の左右位置に、どちら側かを掛ける）
      const ox = -st.dz * st.side;
      const oz = st.dx * st.side;
      const yaw = Math.atan2(ox, oz) - Math.PI / 2;
      this.e.set(0, yaw, 0);
      this.q.setFromEuler(this.e);
      this.p.set(st.x - originX, st.y, st.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      this.poles.setMatrixAt(np++, this.m);
      if (st.shelter && ns < 32) {
        this.p.set(st.x + ox * 0.6 - st.dx * 2.2 * st.side - originX, st.y, st.z + oz * 0.6 - st.dz * 2.2 * st.side - originZ);
        this.m.compose(this.p, this.q, this.one);
        this.shelters.setMatrixAt(ns++, this.m);
      }
    }
    this.poles.count = np;
    this.shelters.count = ns;
    this.poles.instanceMatrix.needsUpdate = true;
    this.shelters.instanceMatrix.needsUpdate = true;
    this.stats.stops = np;
    this.stats.shelters = ns;
  }
}
