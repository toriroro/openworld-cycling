// リアルな歩く人（町の見た目の草案 3 章）。scripts/build-pedestrians.py が MakeHuman の CC0 人体から作った形と動き
// （public/assets/pedestrians/pedestrians-v2.bin）を読んで描く。
// - 体: 頭の形の同じ組（男性・差分なし）ごとに、体型・服の違う 3 体の頂点が 1 つの並びにある。歩き 1 周期・立ち 1 コマの
//   全頂点の位置と法線を画像（幅 2048 で折り返し、行 = コマ）にして、頂点の陰影器で前後のコマの間を移す。
//   画像と頂点の属性は組で共有し、三角形の並びだけ体ごとに分けた形で描く（人ごとにほかの体の頂点まで計算しない）。
// - 髪・帽子: 組ごとに髪型を並べた 1 つの形。頭の骨の動き（コマごとの 3×4 の行列）で動かし、人ごとに 1 つの髪型だけ残す。
// - 色は頂点ごとの「色の表の番号」と、人ごとの「色の行」で、色の表の画像から引く。
// 描画命令は体ごとに 1、髪は組ごとに 1（影を含めてそれぞれ 2 倍）。体 6・髪 2 で、人のいる分だけ最大 16。

import * as THREE from "three";

/** build-pedestrians.py の SLOT と同じ番号 */
export const SLOT = { SKIN: 0, HAIR: 1, EYE: 2, COAT: 3, TRIM: 4, PANTS: 5, SHOE: 6, HAT: 7, SCARF: 8, GLOVE: 9, LINING: 10 } as const;
const SLOTS = 11;
/** 色の行の数 */
export const ROWS = 64;

interface GroupInfo {
  name: string;
  styles: string[];
  variants: { name: string; height: number }[];
  vertices: number;
  triangles: number;
  lo: [number, number, number];
  hi: [number, number, number];
  index: number;
  slot: number;
  variant: number;
  position: number;
  normal: number;
  heads: number;
  hair: { vertices: number; triangles: number; index: number; slot: number; style: number; position: number; normal: number };
}
interface Header {
  version: number;
  walkFrames: number;
  stride: number;
  groups: GroupInfo[];
}

/** 冬の町の色（sRGB）。上着は今の箱の人形（pedestrians.ts）と同じ並び */
const SKINS = ["#d4ab8c", "#c89c7e", "#b98d70", "#cfa482", "#b08166", "#dbb699"];
/** 髪: 黒・こげ茶が多く、明るい茶と白髪まじりが少し */
const HAIRS = ["#15100d", "#1b1511", "#211913", "#2a1f17", "#15100d", "#3a2a1e", "#1b1511", "#553a27", "#2a1f17", "#6f6a64", "#15100d", "#8a857e"];
const COATS = ["#2b3442", "#3b3b3e", "#5b4a3a", "#2f4a3c", "#5a2a30", "#6b6f74", "#8a7a62", "#1f2226", "#40506a", "#7a3e2a", "#9a9488", "#2a2f3a", "#c9c3b6", "#7c2430"];
const PANTS = ["#24262b", "#2c3240", "#3a3a3a", "#4a4236", "#1c1d20", "#5a5650"];
const SHOES = ["#1d1b1a", "#3a2a20", "#4a4038", "#2a2a2e", "#5c4634"];
const HATS = ["#7a2e2e", "#2e3e5a", "#d8d4cc", "#3a3a3a", "#6a5a3a", "#3f5a4a"];
const SCARVES = ["#a03030", "#d8c8a8", "#3a4a6a", "#6a6a6a", "#8a5a7a", "#c08a3a"];
const GLOVES = ["#1d1d1f", "#3a2a22", "#5a2a2a"];

/** 色の表（行ごとに決まった組み合わせ） */
function paletteData(): Float32Array {
  const d = new Float32Array(SLOTS * ROWS * 4);
  const c = new THREE.Color();
  const pick = (list: string[], r: number, k: number) => list[(r * k + (r >> 2)) % list.length];
  for (let r = 0; r < ROWS; r++) {
    const coat = pick(COATS, r, 5);
    const row: Record<number, string> = {
      [SLOT.SKIN]: pick(SKINS, r, 7),
      [SLOT.HAIR]: pick(HAIRS, r, 5),
      [SLOT.EYE]: "#15100c",
      [SLOT.COAT]: coat,
      [SLOT.TRIM]: `#${c.set(coat).multiplyScalar(0.7).getHexString()}`,
      [SLOT.PANTS]: pick(PANTS, r, 11),
      [SLOT.SHOE]: pick(SHOES, r, 13),
      [SLOT.HAT]: pick(HATS, r, 17),
      [SLOT.SCARF]: pick(SCARVES, r, 19),
      [SLOT.GLOVE]: pick(GLOVES, r, 23),
      [SLOT.LINING]: "#2a2622",
    };
    for (let s = 0; s < SLOTS; s++) {
      c.set(row[s]); // 線形の色に直して入れる（THREE.Color は sRGB の文字列を線形にする）
      d.set([c.r, c.g, c.b, 1], (r * SLOTS + s) * 4);
    }
  }
  return d;
}

/** 頂点の画像の幅（WebGL2 で必ず使える 2048。頂点が多ければ次の行へ折り返す） */
const TEX_W = 2048;

/** 人ごとの属性: iAnim = (歩みの位相, 立っているか, 色の行, 体の番号)、iHair = 髪型の番号 */
const COMMON = /* glsl */ `
uniform sampler2D vatPal;
uniform float vatWalk;
attribute float vslot;
attribute vec4 iAnim;
void vatFrames(out int f0, out int f1, out float fa) {
  float fr = iAnim.y > 0.5 ? vatWalk : iAnim.x * vatWalk;
  f0 = int(floor(fr));
  fa = iAnim.y > 0.5 ? 0.0 : fract(fr);
  f1 = iAnim.y > 0.5 ? f0 : int(mod(float(f0 + 1), vatWalk));
}
`;

const BODY_HEAD = /* glsl */ `
${COMMON}
uniform sampler2D vatPos;
uniform sampler2D vatNor;
uniform float vatRows;
attribute float vid;
void vatSample(out vec3 p, out vec3 n) {
  int f0; int f1; float fa;
  vatFrames(f0, f1, fa);
  int col = int(mod(vid, ${TEX_W}.0));
  int row = int(floor(vid / ${TEX_W}.0));
  ivec2 c0 = ivec2(col, f0 * int(vatRows) + row);
  ivec2 c1 = ivec2(col, f1 * int(vatRows) + row);
  p = mix(texelFetch(vatPos, c0, 0).xyz, texelFetch(vatPos, c1, 0).xyz, fa);
  n = normalize(mix(texelFetch(vatNor, c0, 0).xyz, texelFetch(vatNor, c1, 0).xyz, fa));
}
bool vatHidden() { return false; }
`;

const HAIR_HEAD = /* glsl */ `
${COMMON}
uniform sampler2D hairMats;
attribute float hstyle;
attribute float iHair;
vec3 hairXf(int v, int f, vec3 p, float w) {
  vec4 r0 = texelFetch(hairMats, ivec2(f * 3, v), 0);
  vec4 r1 = texelFetch(hairMats, ivec2(f * 3 + 1, v), 0);
  vec4 r2 = texelFetch(hairMats, ivec2(f * 3 + 2, v), 0);
  vec4 q = vec4(p, w);
  return vec3(dot(r0, q), dot(r1, q), dot(r2, q));
}
void vatSample(out vec3 p, out vec3 n) {
  int f0; int f1; float fa;
  vatFrames(f0, f1, fa);
  int v = int(iAnim.w);
  p = mix(hairXf(v, f0, position, 1.0), hairXf(v, f1, position, 1.0), fa);
  n = normalize(mix(hairXf(v, f0, normal, 0.0), hairXf(v, f1, normal, 0.0), fa));
}
bool vatHidden() { return abs(hstyle - iHair) > 0.5; }
`;

function patch(shader: THREE.WebGLProgramParametersWithUniforms, head: string, u: Record<string, THREE.IUniform>, color: boolean) {
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${head}`)
    .replace("#include <begin_vertex>", "vec3 vatP; vec3 vatN; vatSample(vatP, vatN);\nvec3 transformed = vatP;")
    // この人の体・髪型でない頂点は画面の外へ（三角形ごと描かれない）
    .replace("#include <project_vertex>", "#include <project_vertex>\nif (vatHidden()) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);");
  if (color) {
    shader.vertexShader = shader.vertexShader
      .replace("#include <beginnormal_vertex>", "vec3 vatP0; vec3 vatN0; vatSample(vatP0, vatN0);\nvec3 objectNormal = vatN0;")
      .replace("#include <color_vertex>", "#include <color_vertex>\nvColor.rgb = texelFetch(vatPal, ivec2(int(vslot), int(iAnim.z)), 0).rgb;");
  }
}

function makeMesh(g: THREE.BufferGeometry, head: string, uniforms: Record<string, THREE.IUniform>, key: string, capacity: number, name: string): THREE.InstancedMesh {
  // 両面（コートの裾・長い髪の裏を見せる）。影は裏面で取る（両面で取ると自分の影が縞になった）
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.BackSide });
  mat.onBeforeCompile = (s) => patch(s, head, uniforms, true);
  mat.customProgramCacheKey = () => key;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depth.onBeforeCompile = (s) => patch(s, head, uniforms, false);
  depth.customProgramCacheKey = () => `${key}-depth`;
  const mesh = new THREE.InstancedMesh(g, mat, capacity);
  mesh.customDepthMaterial = depth;
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.name = name;
  return mesh;
}

interface Body {
  mesh: THREE.InstancedMesh;
  anim: THREE.InstancedBufferAttribute;
  count: number;
}

interface Group {
  info: GroupInfo;
  /** 体ごと（info.variants の順） */
  bodies: Body[];
  hair: THREE.InstancedMesh;
  hairAnim: THREE.InstancedBufferAttribute;
  hairStyle: THREE.InstancedBufferAttribute;
  count: number;
}

/** リアルな人 1 人の置き方 */
export interface RealPerson {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 歩みの位相（0〜1 で 1 周期） */
  gait: number;
  still: boolean;
  seed: number;
  /** 見た目を直に決める（開発用の並び）。無ければ種から */
  look?: { group: number; variant: number; style: number; row: number };
}

/** 種から見た目（組・体・髪型・色の行）を選ぶ */
export function lookOf(seed: number, groups: readonly { variants: unknown[]; styles: unknown[] }[]) {
  const g = (seed >>> 12) % groups.length;
  return { group: g, variant: (seed >>> 14) % groups[g].variants.length, style: (seed >>> 17) % groups[g].styles.length, row: (seed >>> 3) % ROWS };
}

export class RealPedestrians {
  readonly group = new THREE.Group();
  private groups: Group[] = [];
  ready = false;
  error: string | null = null;
  readonly stats = { people: 0, triangles: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly capacity: number) {
    this.group.name = "pedestrians-real";
  }

  load(base: string): Promise<void> {
    return fetch(`${base}assets/pedestrians/pedestrians-v2.bin`)
      .then((r) => {
        if (!r.ok) throw new Error(`pedestrians HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => this.setup(buf))
      .catch((e) => {
        this.error = String(e);
      });
  }

  /** 組ごとの体の数・髪型の数（種から見た目を選ぶのに使う） */
  get looks(): { variants: unknown[]; styles: unknown[] }[] {
    return this.groups.map((g) => g.info);
  }

  private setup(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x32444550) throw new Error("pedestrians: 形式が違う");
    const hl = dv.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as Header;
    const body = 8 + hl;
    const W = header.walkFrames;
    const frames = W + 1;
    const pal = new THREE.DataTexture(paletteData(), SLOTS, ROWS, THREE.RGBAFormat, THREE.FloatType);
    pal.needsUpdate = true;
    const toH = THREE.DataUtils.toHalfFloat;
    for (const info of header.groups) {
      const n = info.vertices;
      const pos16 = new Uint16Array(buf, body + info.position, n * 3 * frames);
      const nor8 = new Int8Array(buf, body + info.normal, n * 4 * frames);
      // 体の位置・法線の画像（幅 TEX_W。コマごとに rows 行、頂点 i は (i % TEX_W, コマ × rows + ⌊i / TEX_W⌋)。半精度）
      const rows = Math.ceil(n / TEX_W);
      const P = new Uint16Array(TEX_W * rows * frames * 4);
      const N = new Uint16Array(TEX_W * rows * frames * 4);
      const one = toH(1);
      const at = (src: number, a: number) => info.lo[a] + (pos16[src * 3 + a] / 65535) * (info.hi[a] - info.lo[a]);
      for (let f = 0; f < frames; f++)
        for (let i = 0; i < n; i++) {
          const src = f * n + i;
          const dst = (f * rows + Math.floor(i / TEX_W)) * TEX_W + (i % TEX_W);
          for (let a = 0; a < 3; a++) {
            P[dst * 4 + a] = toH(at(src, a));
            N[dst * 4 + a] = toH(nor8[src * 4 + a] / 127);
          }
          P[dst * 4 + 3] = one;
        }
      const tex = (d: Uint16Array) => {
        const t = new THREE.DataTexture(d, TEX_W, rows * frames, THREE.RGBAFormat, THREE.HalfFloatType);
        t.needsUpdate = true;
        return t;
      };
      // 形: 位置と法線は立ちのコマ（境界の球などに使う）、頂点の番号、色の番号。属性は 3 体で共有し、三角形の並びを体ごとに分ける
      const stand = new Float32Array(n * 3);
      const standN = new Float32Array(n * 3);
      for (let i = 0; i < n; i++)
        for (let a = 0; a < 3; a++) {
          stand[i * 3 + a] = at(W * n + i, a);
          standN[i * 3 + a] = nor8[(W * n + i) * 4 + a] / 127;
        }
      const vid = new Float32Array(n);
      for (let i = 0; i < n; i++) vid[i] = i;
      const shared = {
        position: new THREE.BufferAttribute(stand, 3),
        normal: new THREE.BufferAttribute(standN, 3),
        vid: new THREE.BufferAttribute(vid, 1),
        vslot: new THREE.BufferAttribute(Float32Array.from(new Uint8Array(buf, body + info.slot, n)), 1),
      };
      const vvar = new Uint8Array(buf, body + info.variant, n);
      const index = new Uint16Array(buf, body + info.index, info.triangles * 3);
      const lists: number[][] = info.variants.map(() => []);
      for (let t = 0; t < info.triangles; t++) lists[vvar[index[t * 3]]].push(index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
      const uniforms = { vatPos: { value: tex(P) }, vatNor: { value: tex(N) }, vatPal: { value: pal }, vatWalk: { value: W }, vatRows: { value: rows } };
      const bodies: Body[] = lists.map((list, vi) => {
        const g = new THREE.BufferGeometry();
        for (const [k, a] of Object.entries(shared)) g.setAttribute(k, a);
        g.setIndex(new THREE.BufferAttribute(Uint16Array.from(list), 1));
        const anim = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
        anim.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("iAnim", anim);
        const mesh = makeMesh(g, BODY_HEAD, uniforms, "pedestrian-vat", this.capacity, `pedestrian-real:${info.name}:${info.variants[vi].name}`);
        return { mesh, anim, count: 0 };
      });

      // 髪: 休みの姿勢の参照の頭の座標。頭の行列の画像は幅 = コマ × 3、行 = 体
      const h = info.hair;
      const hg = new THREE.BufferGeometry();
      hg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf.slice(body + h.position, body + h.position + h.vertices * 12)), 3));
      const hn8 = new Int8Array(buf, body + h.normal, h.vertices * 4);
      const hn = new Float32Array(h.vertices * 3);
      for (let i = 0; i < h.vertices; i++) for (let a = 0; a < 3; a++) hn[i * 3 + a] = hn8[i * 4 + a] / 127;
      hg.setAttribute("normal", new THREE.BufferAttribute(hn, 3));
      hg.setAttribute("vslot", new THREE.BufferAttribute(Float32Array.from(new Uint8Array(buf, body + h.slot, h.vertices)), 1));
      hg.setAttribute("hstyle", new THREE.BufferAttribute(Float32Array.from(new Uint8Array(buf, body + h.style, h.vertices)), 1));
      hg.setIndex(new THREE.BufferAttribute(new Uint16Array(buf.slice(body + h.index, body + h.index + h.triangles * 6)), 1));
      const hairAnim = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
      hairAnim.setUsage(THREE.DynamicDrawUsage);
      hg.setAttribute("iAnim", hairAnim);
      const hairStyle = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
      hairStyle.setUsage(THREE.DynamicDrawUsage);
      hg.setAttribute("iHair", hairStyle);
      const nv = info.variants.length;
      const mats = new Float32Array(buf.slice(body + info.heads, body + info.heads + nv * frames * 12 * 4));
      const M = new Float32Array(frames * 3 * nv * 4);
      for (let v = 0; v < nv; v++) for (let f = 0; f < frames; f++) for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) M[((v * frames * 3) + f * 3 + r) * 4 + c] = mats[(v * frames + f) * 12 + r * 4 + c];
      const mt = new THREE.DataTexture(M, frames * 3, nv, THREE.RGBAFormat, THREE.FloatType);
      mt.needsUpdate = true;
      const hairMesh = makeMesh(hg, HAIR_HEAD, { hairMats: { value: mt }, vatPal: { value: pal }, vatWalk: { value: W } }, "pedestrian-hair", this.capacity, `pedestrian-hair:${info.name}`);
      for (const b of bodies) this.group.add(b.mesh);
      this.group.add(hairMesh);
      this.groups.push({ info, bodies, hair: hairMesh, hairAnim, hairStyle, count: 0 });
    }
    this.ready = true;
  }

  setShadows(on: boolean) {
    for (const g of this.groups) {
      g.hair.castShadow = on;
      for (const b of g.bodies) b.mesh.castShadow = on;
    }
  }

  /** 描く。originX, originZ は描画の原点 */
  update(people: RealPerson[], originX: number, originZ: number) {
    for (const g of this.groups) {
      g.count = 0;
      for (const b of g.bodies) b.count = 0;
    }
    let tris = 0;
    const looks = this.looks;
    for (const w of people) {
      if (!looks.length) break;
      const look = w.look ?? lookOf(w.seed, looks);
      const g = this.groups[look.group];
      const b = g.bodies[look.variant];
      if (g.count >= this.capacity || b.count >= this.capacity) continue;
      const i = g.count++;
      const j = b.count++;
      this.q.setFromAxisAngle(this.up, w.yaw);
      this.p.set(w.x - originX, w.y, w.z - originZ);
      this.m.compose(this.p, this.q, this.one);
      b.mesh.setMatrixAt(j, this.m);
      g.hair.setMatrixAt(i, this.m);
      const ph = w.gait - Math.floor(w.gait);
      b.anim.setXYZW(j, ph, w.still ? 1 : 0, look.row, look.variant);
      g.hairAnim.setXYZW(i, ph, w.still ? 1 : 0, look.row, look.variant);
      g.hairStyle.setX(i, look.style);
      tris += g.info.triangles / g.info.variants.length + g.info.hair.triangles / g.info.styles.length;
    }
    for (const g of this.groups) {
      for (const b of g.bodies) {
        b.mesh.count = b.count;
        b.mesh.visible = b.count > 0;
        b.mesh.instanceMatrix.needsUpdate = true;
        b.anim.needsUpdate = true;
      }
      g.hair.count = g.count;
      g.hair.visible = g.count > 0;
      g.hair.instanceMatrix.needsUpdate = true;
      g.hairAnim.needsUpdate = g.hairStyle.needsUpdate = true;
    }
    this.stats.people = people.length;
    this.stats.triangles = Math.round(tris);
  }
}
