// 掘割とアンダーパス（配達の草案 31 章）: 走る道が周りの地面より低く通る所に、両側のコンクリートの擁壁と腰壁を立て、
// 深い所（車の通れる高さがある所）は天井の床版と照明を付けて箱形のトンネルにする。
// 北海道の世界では、市街地の浅い地下の道（OSM の tunnel で、地面からの深さが 6m に届かない物）を普通の道として描いていて、
// 両側が地形の斜面のまま・上が空いたままだった（北5東7 付近の真駒内篠路線。JR の高架の下を通る）。
// 道路と地形（国土地理院の標高）を読むだけで、変換データは変えない。

import * as THREE from "three";
import type { TerrainLike } from "../shared/world/terrain.ts";
import type { Road } from "../shared/world/types.ts";

/** 擁壁を立てる深さ (m)、天井を掛ける深さ (m)、天井の続く長さの下限 (m)【初期値】 */
const WALL_MIN = 1.2;
const ROOF_MIN = 4.3;
const ROOF_RUN = 12;
/** 道の端から壁の内の面までの間 (m)、壁の厚み、腰壁の高さ、床版の厚み、地面を測る道の端からの距離 (m) */
const WALL_GAP = 0.5;
const WALL_T = 0.4;
const PARAPET = 0.9;
const SLAB = 0.8;
const GROUND_AT = 10;
/** 道に沿って測る間隔 (m) */
const STEP = 4;

const CONCRETE: [number, number, number] = [0.62, 0.62, 0.6];
const CONCRETE_DARK: [number, number, number] = [0.45, 0.45, 0.44];
const SLAB_TOP: [number, number, number] = [0.36, 0.37, 0.38];

interface Sample {
  x: number;
  y: number;
  z: number;
  /** 右（-dz, dx） */
  rx: number;
  rz: number;
  /** 左・右の深さ (m) */
  dl: number;
  dr: number;
}

/** 道に沿って STEP ごとに、両側の地面の高さと路面の差を測る（3 点の平均で均す） */
function profile(road: Road, ground: (x: number, z: number) => number): Sample[] {
  const P = road.points;
  const n = P.length / 3;
  const ds = road.length / (n - 1);
  const k = Math.max(1, Math.round(STEP / ds));
  const off = road.width / 2 + GROUND_AT;
  const out: Sample[] = [];
  for (let i = 0; i < n; i += k) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let dx = P[b * 3] - P[a * 3];
    let dz = P[b * 3 + 2] - P[a * 3 + 2];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const x = P[i * 3] + road.origin[0];
    const z = P[i * 3 + 2] + road.origin[1];
    const y = P[i * 3 + 1];
    const rx = -dz;
    const rz = dx;
    out.push({ x, y, z, rx, rz, dl: ground(x - rx * off, z - rz * off) - y, dr: ground(x + rx * off, z + rz * off) - y });
  }
  // 均す
  const sm = out.map((s, i) => {
    const w = out.slice(Math.max(0, i - 1), i + 2);
    return { ...s, dl: w.reduce((t, v) => t + v.dl, 0) / w.length, dr: w.reduce((t, v) => t + v.dr, 0) / w.length };
  });
  return sm;
}

class Builder {
  pos: number[] = [];
  col: number[] = [];
  quad(a: number[], b: number[], c: number[], d: number[], color: [number, number, number]) {
    // a-b-c-d は反時計回り（表から見て）
    this.pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) this.col.push(...color);
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** 1 本の道の擁壁・床版・照明を足す。数（壁の区間・天井の長さ）を返す */
function buildRoad(road: Road, ground: (x: number, z: number) => number, ox: number, oz: number, b: Builder, lamps: number[]): { walls: number; roof: number } {
  if (road.spans.length) return { walls: 0, roof: 0 };
  const S = profile(road, ground);
  // 両側とも地面が高い所（掘割）だけ。片側だけ高い坂の途中の道には立てない
  const cut = (s: Sample) => Math.min(s.dl, s.dr) >= WALL_MIN;
  if (S.length < 2 || !S.some(cut)) return { walls: 0, roof: 0 };
  const inner = road.width / 2 + WALL_GAP;
  let walls = 0;
  // 天井: 両側とも深い所が ROOF_RUN 以上続く区間
  const roofOk: boolean[] = S.map((s) => Math.min(s.dl, s.dr) >= ROOF_MIN);
  for (let i = 0; i < S.length; ) {
    if (!roofOk[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < S.length && roofOk[j + 1]) j++;
    if ((j - i) * STEP < ROOF_RUN) for (let k = i; k <= j; k++) roofOk[k] = false;
    i = j + 1;
  }
  let roof = 0;
  const pt = (s: Sample, side: number, d: number, y: number) => [s.x + s.rx * d * side - ox, y, s.z + s.rz * d * side - oz];
  for (let i = 0; i + 1 < S.length; i++) {
    const a = S[i];
    const c = S[i + 1];
    if (!cut(a) && !cut(c)) continue;
    for (const side of [-1, 1]) {
      const da = side < 0 ? a.dl : a.dr;
      const dc = side < 0 ? c.dl : c.dr;
      walls++;
      const topA = a.y + Math.max(0.3, da) + PARAPET;
      const topC = c.y + Math.max(0.3, dc) + PARAPET;
      const botA = a.y - 0.3;
      const botC = c.y - 0.3;
      // 内の面（道を向く）・上の面・外の面
      const in0 = pt(a, side, inner, botA), in1 = pt(c, side, inner, botC), in2 = pt(c, side, inner, topC), in3 = pt(a, side, inner, topA);
      const out0 = pt(a, side, inner + WALL_T, botA), out1 = pt(c, side, inner + WALL_T, botC), out2 = pt(c, side, inner + WALL_T, topC), out3 = pt(a, side, inner + WALL_T, topA);
      if (side > 0) {
        b.quad(in0, in1, in2, in3, CONCRETE);
        b.quad(out1, out0, out3, out2, CONCRETE_DARK);
        b.quad(in3, in2, out2, out3, CONCRETE_DARK);
      } else {
        b.quad(in1, in0, in3, in2, CONCRETE);
        b.quad(out0, out1, out2, out3, CONCRETE_DARK);
        b.quad(in2, in3, out3, out2, CONCRETE_DARK);
      }
    }
    // 天井の床版（上の面は地面の高さ、下の面はその SLAB 下）
    if (roofOk[i] && roofOk[i + 1]) {
      roof += STEP;
      const ya = a.y + Math.min(a.dl, a.dr);
      const yc = c.y + Math.min(c.dl, c.dr);
      const w = inner + WALL_T;
      const tl0 = pt(a, -1, w, ya), tr0 = pt(a, 1, w, ya), tl1 = pt(c, -1, w, yc), tr1 = pt(c, 1, w, yc);
      const bl0 = pt(a, -1, inner, ya - SLAB), br0 = pt(a, 1, inner, ya - SLAB), bl1 = pt(c, -1, inner, yc - SLAB), br1 = pt(c, 1, inner, yc - SLAB);
      b.quad(tl0, tr0, tr1, tl1, SLAB_TOP);
      b.quad(bl0, bl1, br1, br0, CONCRETE_DARK);
      // 天井の照明（真ん中に 1 列）
      lamps.push((a.x + c.x) / 2 - ox, (ya + yc) / 2 - SLAB - 0.06, (a.z + c.z) / 2 - oz, Math.atan2(c.x - a.x, c.z - a.z));
      // 床版の端の面（入口の上の壁）
      const startEdge = i === 0 || !roofOk[i - 1];
      const endEdge = i + 2 >= S.length || !roofOk[i + 2];
      if (startEdge) b.quad(bl0, br0, tr0, tl0, CONCRETE);
      if (endEdge) b.quad(br1, bl1, tl1, tr1, CONCRETE);
    }
  }
  return { walls, roof };
}

export class CutWallView {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lamps: THREE.InstancedMesh;
  private material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.FrontSide });
  private key = "";
  readonly stats = { roads: 0, walls: 0, roofM: 0, lamps: 0 };

  constructor() {
    this.group.name = "cut-walls";
    const lampGeo = new THREE.BoxGeometry(0.5, 0.08, 1.4);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: "#fff1cf" }), 400);
    this.lamps.count = 0;
    this.lamps.frustumCulled = false;
    this.group.add(this.lamps);
  }

  setQuality(light: boolean) {
    if (this.mesh) this.mesh.castShadow = !light;
  }

  /**
   * 近くの道の擁壁と天井を作り直す。key が変わった時だけ（読み込んだ道・描画の原点・近さの区切りが変わった時）
   */
  update(roads: Iterable<Road>, terrain: TerrainLike, originX: number, originZ: number, cx: number, cz: number, version: number, range = 700) {
    const key = `${version}|${originX},${originZ}|${Math.round(cx / 200)},${Math.round(cz / 200)}`;
    if (key === this.key) return;
    this.key = key;
    const b = new Builder();
    const lamps: number[] = [];
    let n = 0;
    let walls = 0;
    let roof = 0;
    for (const r of roads) {
      if (r.kind === "cycleway") continue;
      const P = r.points;
      const mx = P[Math.floor(P.length / 6) * 3] + r.origin[0];
      const mz = P[Math.floor(P.length / 6) * 3 + 2] + r.origin[1];
      if (Math.abs(mx - cx) > range + r.length || Math.abs(mz - cz) > range + r.length) continue;
      const got = buildRoad(r, (x, z) => terrain.height(x, z), originX, originZ, b, lamps);
      if (got.walls) n++;
      walls += got.walls;
      roof += got.roof;
    }
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const g = b.geometry();
    if (g) {
      this.mesh = new THREE.Mesh(g, this.material);
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
      this.mesh.name = "cut-walls";
      this.group.add(this.mesh);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const nl = Math.min(400, lamps.length / 4);
    for (let i = 0; i < nl; i++) {
      p.set(lamps[i * 4], lamps[i * 4 + 1], lamps[i * 4 + 2]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), lamps[i * 4 + 3]);
      m.compose(p, q, one);
      this.lamps.setMatrixAt(i, m);
    }
    this.lamps.count = nl;
    this.lamps.visible = nl > 0;
    this.lamps.instanceMatrix.needsUpdate = true;
    this.stats.roads = n;
    this.stats.walls = walls;
    this.stats.roofM = roof;
    this.stats.lamps = nl;
  }
}
