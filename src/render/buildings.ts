// 建物と喫茶店の描画（モック仕様 5.4）。配置は towns.ts（town-layout.ts）が決め、ここでまとめて描く。
// - 建物: 壁（窓の模様はシェーダーで描く。downhill-3D の sapporo-buildings.ts の外壁表現を移した）、陸屋根、切妻屋根。インスタンス描画で 3 命令
// - 喫茶店: 箱形の建物、ひさし、店名の看板（文字は店名だけ）、自転車ラック、駐輪スペース。店ごとに 2 命令

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Building, Cafe } from "./town-layout.ts";
import type { Towns } from "./towns.ts";

const WALLS = ["#d1c4ac", "#bcc5c6", "#9eaaa9", "#d4d1c7", "#b5a79a", "#8a8d8b", "#c6bbac"];
const ROOFS = ["#535c62", "#76534a", "#56666a", "#657479", "#6d7370", "#4c565b", "#736459"];

/** 窓・窓枠を描く外壁（downhill-3D の facadeMaterial を移した）。上下の面と、地面に埋めた下 0.4m には窓を描かない */
function facadeMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: "#f3f1e8", roughness: 0.86 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `varying vec3 vFacade;
${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
   vec3 dimensions=vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));
   float u=abs(normal.x)>.5?(position.z+.5)*dimensions.z:(position.x+.5)*dimensions.x;
   vFacade=vec3(u,(position.y+.5)*dimensions.y,abs(normal.y)>.5?-1.:dimensions.y);
  `,
    );
    shader.fragmentShader = `varying vec3 vFacade;
${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
   if(vFacade.z>0.){
     float floorHeight=3.1; vec2 cell=vec2(vFacade.x/2.8,(vFacade.y-.4)/floorHeight);
     vec2 f=fract(cell),aa=max(fwidth(cell),vec2(.002));
     float win=(smoothstep(.19-aa.x,.19+aa.x,f.x)-smoothstep(.77-aa.x,.77+aa.x,f.x))*(smoothstep(.27-aa.y,.27+aa.y,f.y)-smoothstep(.81-aa.y,.81+aa.y,f.y));
     win*=step(0.,cell.y)*step(cell.y,vFacade.z/floorHeight-.6);
     float seed=fract(sin(dot(floor(cell),vec2(127.1,311.7)))*43758.5453);
     vec3 glass=mix(vec3(.10,.18,.21),vec3(.38,.48,.51),seed);
     float frame=1.-smoothstep(.018,.035,abs(f.x-.48));
     glass=mix(glass,vec3(.63,.67,.65),frame*.6);
     diffuseColor.rgb=mix(diffuseColor.rgb,glass,win*.87);
   }
  `,
    );
  };
  m.customProgramCacheKey = () => "owc-facades-v1";
  return m;
}

function gableGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5], 3));
  g.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 2, 5, 4, 2, 4, 1, 0, 1, 4, 0, 4, 3]);
  g.computeVertexNormals();
  return g;
}

/** 色つきの箱（頂点色）を世界の向きに置いた形 */
function coloredBox(w: number, h: number, d: number, color: string, x: number, y: number, z: number, angle: number, tilt = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  if (tilt) g.rotateX(tilt);
  g.rotateY(-angle);
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.deleteAttribute("uv");
  return g;
}

function signTexture(name: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2b2420";
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#f4ead6";
  let size = 72;
  ctx.font = `700 ${size}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  while (ctx.measureText(name).width > 470 && size > 30) {
    size -= 4;
    ctx.font = `700 ${size}px system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class BuildingMeshes {
  readonly group = new THREE.Group();
  private wallMat = facadeMaterial();
  private roofMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.78 });
  private cafeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  private box = new THREE.BoxGeometry(1, 1, 1);
  private gable = gableGeometry();
  private meshes: THREE.Object3D[] = [];
  private key = "";
  private lastT = 0;
  private originX = 0;
  private originZ = 0;
  range = 2200;
  cafeRange = 1600;
  stats = { buildings: 0, cafes: 0 };

  constructor(private towns: Towns) {
    this.group.name = "buildings";
  }

  setOrigin(x: number, z: number) {
    this.originX = x;
    this.originZ = z;
    this.key = "";
  }

  setQuality(light: boolean) {
    this.range = light ? 1100 : 2200;
    this.cafeRange = light ? 900 : 1600;
    this.key = "";
  }

  update(cx: number, cz: number) {
    const now = performance.now();
    if (now - this.lastT < 400) return;
    this.lastT = now;
    const towns = this.towns.townsNear(cx, cz, this.range);
    const cafes = this.towns.cafesNear(cx, cz, this.cafeRange);
    const key = `${towns.map((t) => t.node).join("|")}#${cafes.map((c) => c.poi.id).join("|")}@${this.originX},${this.originZ}`;
    if (key === this.key) return;
    this.key = key;
    this.rebuild(
      towns.flatMap((t) => t.buildings),
      cafes,
    );
  }

  private clear() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry !== this.box && o.geometry !== this.gable) o.geometry.dispose();
        if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial) {
          o.material.map?.dispose();
          o.material.dispose();
        }
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
    }
    this.meshes = [];
  }

  private rebuild(buildings: Building[], cafes: Cafe[]) {
    this.clear();
    const ox = this.originX, oz = this.originZ;
    const d = new THREE.Object3D();
    if (buildings.length) {
      const wall = new THREE.InstancedMesh(this.box, this.wallMat, buildings.length);
      const pitched = buildings.filter((b) => b.h < 11 && b.tone % 3 !== 0);
      const flat = buildings.filter((b) => !(b.h < 11 && b.tone % 3 !== 0));
      const roof = new THREE.InstancedMesh(this.box, this.roofMat, Math.max(1, flat.length));
      const gable = new THREE.InstancedMesh(this.gable, this.roofMat, Math.max(1, pitched.length));
      roof.count = flat.length;
      gable.count = pitched.length;
      const set = (mesh: THREE.InstancedMesh, i: number, b: Building, y: number, w: number, h: number, dep: number) => {
        d.rotation.set(0, -b.angle, 0);
        d.position.set(b.x - ox, y, b.z - oz);
        d.scale.set(w, h, dep);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
      };
      const color = new THREE.Color();
      buildings.forEach((b, i) => {
        // 壁は地面の最低から、地面の最高 + 建物の高さまで
        const top = b.top + b.h;
        set(wall, i, b, (b.base + top) / 2, b.w, top - b.base, b.d);
        wall.setColorAt(i, color.set(WALLS[b.tone % WALLS.length]));
      });
      flat.forEach((b, i) => {
        set(roof, i, b, b.top + b.h + 0.18, b.w + 0.6, 0.36, b.d + 0.6);
        roof.setColorAt(i, color.set(ROOFS[b.tone % ROOFS.length]));
      });
      pitched.forEach((b, i) => {
        set(gable, i, b, b.top + b.h, b.w + 0.7, Math.min(3, b.w * 0.18), b.d + 0.7);
        gable.setColorAt(i, color.set(ROOFS[b.tone % ROOFS.length]));
      });
      for (const m of [wall, roof, gable]) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.computeBoundingSphere();
        this.group.add(m);
        this.meshes.push(m);
      }
    }
    for (const c of cafes) {
      const g = this.cafeGroup(c, ox, oz);
      this.group.add(g);
      this.meshes.push(g);
    }
    this.stats = { buildings: buildings.length, cafes: cafes.length };
  }

  /** 喫茶店1軒: 建物・ひさし・ラック・駐輪スペース（頂点色で 1 命令）と看板（1 命令） */
  private cafeGroup(c: Cafe, ox: number, oz: number): THREE.Group {
    const grp = new THREE.Group();
    grp.name = `cafe:${c.poi.id}`;
    const parts: THREE.BufferGeometry[] = [];
    const x = c.x - ox, z = c.z - oz;
    const top = c.top + c.h;
    // 建物（正面は道路側）。angle は幅の向き、正面の向き (fx, fz)
    parts.push(coloredBox(c.w, top - c.base, c.d, "#e9dcc4", x, (c.base + top) / 2, z, c.angle));
    // 屋根
    parts.push(coloredBox(c.w + 0.8, 0.35, c.d + 0.8, "#4a3f38", x, top + 0.17, z, c.angle));
    // 正面のガラス（壁の少し外に暗い面）
    const fx = c.fx, fz = c.fz;
    const front = (k: number) => [x + fx * (c.d / 2 + k), z + fz * (c.d / 2 + k)] as const;
    const [gx, gz] = front(0.03);
    parts.push(coloredBox(c.w * 0.7, 2.2, 0.06, "#27383d", gx, c.top + 1.5, gz, c.angle));
    // 扉
    const [dx, dz] = front(0.05);
    const ax = Math.cos(c.angle), az = Math.sin(c.angle);
    parts.push(coloredBox(1.1, 2.2, 0.08, "#6b4a2e", dx + ax * (c.w * 0.38), c.top + 1.1, dz + az * (c.w * 0.38), c.angle));
    // ひさし（正面に張り出して少し下がる）。正面がローカルの −z か +z かで傾きの向きを変える
    const localFront = -Math.sin(c.angle) * fx + Math.cos(c.angle) * fz > 0 ? 1 : -1;
    const [hx, hz] = front(1.0);
    parts.push(coloredBox(c.w * 0.92, 0.12, 2.0, "#2f5d43", hx, c.top + 3.0, hz, c.angle, 0.28 * localFront));
    // 駐輪スペース（建物の前の舗装）
    const [px, pz] = front(3.6);
    parts.push(coloredBox(c.w + 4, Math.max(0.2, c.top - c.base + 0.08), 6.6, "#5d5d5a", px, (c.base + c.top + 0.08) / 2, pz, c.angle));
    // 自転車ラック（逆 U 字を 3 つ）
    for (let k = -1; k <= 1; k++) {
      const [rx0, rz0] = front(2.2);
      const bx = rx0 + ax * k * 1.6, bz = rz0 + az * k * 1.6;
      const y0 = c.top + 0.08;
      for (const e of [-0.35, 0.35]) parts.push(coloredBox(0.06, 0.8, 0.06, "#b8bcbd", bx + fx * e, y0 + 0.4, bz + fz * e, c.angle));
      parts.push(coloredBox(0.06, 0.06, 0.76, "#b8bcbd", bx, y0 + 0.8, bz, c.angle));
    }
    const geo = mergeGeometries(parts)!;
    geo.computeVertexNormals();
    const body = new THREE.Mesh(geo, this.cafeMat);
    body.castShadow = true;
    body.receiveShadow = true;
    grp.add(body);
    // 看板（ひさしの上、正面に向ける）
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), new THREE.MeshBasicMaterial({ map: signTexture(c.poi.name) }));
    const [sx, sz] = front(0.08);
    sign.position.set(sx, c.top + 3.75, sz);
    sign.rotation.y = Math.atan2(fx, fz);
    grp.add(sign);
    return grp;
  }
}
