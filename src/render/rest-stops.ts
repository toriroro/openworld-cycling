// 体力を戻す所の描画（配達の草案 28 章）: 歩道の自販機と、チェーンの店の前の置き看板と、のぼり。
// 外部の素材は使わず、箱を組み、店の名前はキャンバスに書く。置く所は src/shared/rest-stops.ts が決め、ここは描くだけ。

import * as THREE from "three";
import { CHAIN_NAMES, type ChainKind, isFood, RING_R, type RestStop, restRing, type ServiceKind } from "../shared/rest-stops.ts";

const RINGS = 40;

/** 置き看板を立てる所（チェーンの店・自転車店・車の整備） */
type SignKind = ChainKind | ServiceKind;
const SIGN_KINDS: SignKind[] = ["gyudon", "teishoku", "bike", "car"];
/** 看板の 2 行の字 */
const SIGN_LINES: Record<SignKind, [string, string]> = {
  gyudon: CHAIN_NAMES.gyudon.split(" ") as [string, string],
  teishoku: CHAIN_NAMES.teishoku.split(" ") as [string, string],
  bike: ["自転車", "修理・空気入れ"],
  car: ["燃料", "車の整備"],
};

const VENDING = 80;
const SIGNS = 24;

/** 自販機の体の色（白・赤・青・緑）。種で選ぶ */
const VENDING_COLORS = ["#eef0f0", "#c62a2a", "#2a58b8", "#2f8c4a"];
/** 看板の地の色と字の色 */
const CHAIN_STYLE: Record<SignKind, { bg: string; ink: string; edge: string }> = {
  gyudon: { bg: "#e8731a", ink: "#ffffff", edge: "#7a3608" },
  teishoku: { bg: "#1f5a3a", ink: "#fff6d8", edge: "#0d2a1a" },
  bike: { bg: "#1f7a46", ink: "#ffffff", edge: "#0f3a22" },
  car: { bg: "#c62a2a", ink: "#ffffff", edge: "#4a1010" },
};

function colored(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  if (g.getAttribute("uv")) g.deleteAttribute("uv");
  return g;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(x, y, z);
  return colored(g, color);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute("position").count;
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color"]) {
    const arr = new Float32Array(n * 3);
    let o = 0;
    for (const p of parts) {
      const a = p.getAttribute(name).array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, 3));
  }
  for (const p of parts) p.dispose();
  out.computeBoundingSphere();
  return out;
}

/** 自販機の体（インスタンスの色で塗る。白で作る）。原点は足元、+z が表（道の側） */
function vendingBody(): THREE.BufferGeometry {
  return merge([box(1.0, 1.83, 0.72, 0, 0.915, 0, "#ffffff"), box(1.04, 0.08, 0.76, 0, 1.87, 0.0, "#ffffff")]);
}

/** 自販機の表（飲み物の並ぶ窓・押しボタン・取り出し口）。光る面は MeshBasic で描く */
function vendingFace(): THREE.BufferGeometry {
  const parts = [
    // 飲み物の並ぶ窓（明るい）
    box(0.86, 0.78, 0.02, 0, 1.36, 0.365, "#e9f4ff"),
    // 飲み物の段（色の帯）
    box(0.8, 0.07, 0.025, 0, 1.6, 0.37, "#d2473a"),
    box(0.8, 0.07, 0.025, 0, 1.36, 0.37, "#3a8ad2"),
    box(0.8, 0.07, 0.025, 0, 1.12, 0.37, "#e0b23a"),
    // 押しボタンの列
    box(0.8, 0.04, 0.025, 0, 0.94, 0.37, "#ffd34d"),
    // お金の口と取り出し口（暗い）
    box(0.16, 0.22, 0.02, 0.3, 0.72, 0.365, "#2a2d30"),
    box(0.7, 0.18, 0.03, 0, 0.26, 0.365, "#1b1d20"),
  ];
  return merge(parts);
}

/** 置き看板の柱と台（原点は足元） */
function signFrame(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8).toNonIndexed();
  pole.translate(0, 1.3, 0);
  return merge([colored(pole, "#3a3d40"), box(0.6, 0.12, 0.4, 0, 0.06, 0, "#4a4d50")]);
}

/** のぼり（柱と細長い布。布は +x へ出る）。原点は柱の根元 */
function banner(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.025, 0.025, 2.9, 6).toNonIndexed();
  pole.translate(0, 1.45, 0);
  return merge([colored(pole, "#d8d8d4"), box(0.42, 1.8, 0.02, 0.23, 1.85, 0, "#ffffff")]);
}

function chainTexture(kind: SignKind): THREE.CanvasTexture {
  const st = CHAIN_STYLE[kind];
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = st.edge;
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = st.bg;
  g.fillRect(12, 12, 488, 232);
  g.fillStyle = st.ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const [head, name] = SIGN_LINES[kind];
  const font = (n: number) => `bold ${n}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  g.font = font(64);
  g.fillText(head, 256, 74);
  let size = 96;
  g.font = font(size);
  while (size > 40 && g.measureText(name).width > 460) g.font = font((size -= 4));
  g.fillText(name, 256, 172);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class RestStopView {
  readonly group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private faces: THREE.InstancedMesh;
  private frames: THREE.InstancedMesh;
  private boards = new Map<SignKind, THREE.InstancedMesh>();
  private banners = new Map<SignKind, THREE.InstancedMesh>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private c = new THREE.Color();
  private key = "";
  readonly stats = { vending: 0, shops: 0, rings: 0 };
  /** 押して向かう円（配達の草案 30 章）: 縁の輪と、中の薄い円（押す判定にも使う） */
  private rings: THREE.InstancedMesh;
  private discs: THREE.InstancedMesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ringIds: string[] = [];
  private raycaster = new THREE.Raycaster();

  constructor() {
    this.group.name = "rest-stops";
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    const lit = new THREE.MeshBasicMaterial({ vertexColors: true });
    const make = (g: THREE.BufferGeometry, m: THREE.Material, n: number, name: string) => {
      const im = new THREE.InstancedMesh(g, m, n);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.name = name;
      this.group.add(im);
      return im;
    };
    this.bodies = make(vendingBody(), mat, VENDING, "vending-body");
    this.bodies.setColorAt(0, this.c.set("#ffffff"));
    this.faces = make(vendingFace(), lit, VENDING, "vending-face");
    this.faces.castShadow = false;
    this.frames = make(signFrame(), mat, SIGNS * 2, "rest-sign-frame");
    // 円は道の上に重ねて描く（深さを書かず、少し手前へずらして道の面とちらつかないようにする）
    const ringGeo = new THREE.RingGeometry(RING_R * 0.78, RING_R, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(RING_R * 0.78, 32);
    discGeo.rotateX(-Math.PI / 2);
    const flat = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
    this.ringMat = new THREE.MeshBasicMaterial({ color: "#ffffff", opacity: 0.9, ...flat });
    this.rings = make(ringGeo, this.ringMat, RINGS, "rest-rings");
    this.discs = make(discGeo, new THREE.MeshBasicMaterial({ color: "#ffffff", opacity: 0.28, ...flat }), RINGS, "rest-discs");
    for (const im of [this.rings, this.discs]) {
      im.castShadow = false;
      im.renderOrder = 2;
      im.setColorAt(0, this.c.set("#ffffff"));
    }
    // 板は両面に同じ字（道のどちらから来ても読める）
    const board = new THREE.PlaneGeometry(1.5, 0.75);
    board.translate(0, 2.1, 0);
    for (const k of SIGN_KINDS) {
      const bm = new THREE.MeshBasicMaterial({ map: chainTexture(k), side: THREE.DoubleSide });
      const b = make(board, bm, SIGNS, `rest-board-${k}`);
      b.castShadow = false;
      this.boards.set(k, b);
      const fm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, color: CHAIN_STYLE[k].bg, side: THREE.DoubleSide });
      this.banners.set(k, make(banner(), fm, SIGNS * 2, `rest-banner-${k}`));
    }
  }

  /** 円を明滅させる（t は秒） */
  pulse(t: number) {
    this.ringMat.opacity = 0.65 + 0.3 * Math.sin(t * 4);
  }

  /** 画面の点（-1〜1 の正規化座標）の下にある円の所の識別子。無ければ null */
  pick(ndcX: number, ndcY: number, camera: THREE.Camera): string | null {
    if (!this.discs.count) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hit = this.raycaster.intersectObject(this.discs, false)[0];
    return hit?.instanceId !== undefined ? (this.ringIds[hit.instanceId] ?? null) : null;
  }

  setQuality(light: boolean) {
    for (const im of [this.bodies, this.frames, ...this.banners.values()]) im.castShadow = !light;
  }

  /** 描く。stops は近い順でなくてよい（上限で落とす時は先の物を残す）。originX, originZ は描画の原点 */
  update(stops: readonly RestStop[], originX: number, originZ: number) {
    const key = `${originX},${originZ}|${stops.map((s) => s.id).join(",")}`;
    if (key === this.key) return;
    this.key = key;
    let nv = 0;
    let nf = 0;
    const nb = new Map<SignKind, number>();
    const nn = new Map<SignKind, number>();
    for (const st of stops) {
      // 表は道の側（建物と逆の向き）
      const yaw = Math.atan2(-st.fx, -st.fz);
      if (st.kind === "vending") {
        if (nv >= VENDING) continue;
        this.e.set(0, yaw, 0);
        this.q.setFromEuler(this.e);
        this.p.set(st.x - originX, st.y, st.z - originZ);
        this.m.compose(this.p, this.q, this.one);
        this.bodies.setMatrixAt(nv, this.m);
        const seed = Number(st.id.split(":")[1]) >>> 0;
        this.bodies.setColorAt(nv, this.c.set(VENDING_COLORS[(seed >>> 3) % VENDING_COLORS.length]));
        this.faces.setMatrixAt(nv, this.m);
        nv++;
        continue;
      }
      const k = st.kind;
      const i = nb.get(k) ?? 0;
      if (i >= SIGNS) continue;
      nb.set(k, i + 1);
      // 置き看板: 板は道に沿う向きの面（来る自転車から読める）。板の面の法線を道の向きにする
      this.e.set(0, yaw + Math.PI / 2, 0);
      this.q.setFromEuler(this.e);
      this.p.set(st.x - originX, st.y, st.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      this.boards.get(k)!.setMatrixAt(i, this.m);
      this.frames.setMatrixAt(nf++, this.m);
      // のぼり 2 本（看板の左右、建物寄り。チェーンの店だけ）
      if (k === "bike" || k === "car") continue;
      const rx = -st.fz;
      const rz = st.fx;
      for (const side of [-1, 1]) {
        const j = nn.get(k) ?? 0;
        nn.set(k, j + 1);
        this.e.set(0, yaw + (side > 0 ? 0 : Math.PI), 0);
        this.q.setFromEuler(this.e);
        this.p.set(st.x + rx * side * 2.2 + st.fx * 0.3 - originX, st.y, st.z + rz * side * 2.2 + st.fz * 0.3 - originZ);
        this.m.compose(this.p, this.q, this.one);
        this.banners.get(k)!.setMatrixAt(j, this.m);
      }
    }
    const done = (im: THREE.InstancedMesh, n: number) => {
      im.count = n;
      im.visible = n > 0;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    };
    done(this.bodies, nv);
    done(this.faces, nv);
    done(this.frames, nf);
    let shops = 0;
    for (const [k, b] of this.boards) {
      done(b, nb.get(k) ?? 0);
      shops += nb.get(k) ?? 0;
    }
    for (const [k, b] of this.banners) done(b, nn.get(k) ?? 0);
    // 押して向かう円（食べ物・飲み物の所だけ）
    let nr = 0;
    this.ringIds = [];
    for (const st of stops) {
      if (!isFood(st.kind) || nr >= RINGS) continue;
      const r = restRing(st);
      this.p.set(r.x - originX, st.y + 0.04, r.z - originZ);
      this.m.compose(this.p, this.q.identity(), this.one);
      this.rings.setMatrixAt(nr, this.m);
      this.discs.setMatrixAt(nr, this.m);
      const col = st.kind === "vending" ? "#4cc3ff" : "#ff9a3c";
      this.rings.setColorAt(nr, this.c.set(col));
      this.discs.setColorAt(nr, this.c.set(col));
      this.ringIds.push(st.id);
      nr++;
    }
    done(this.rings, nr);
    done(this.discs, nr);
    this.stats.rings = nr;
    this.stats.vending = nv;
    this.stats.shops = shops;
  }
}
