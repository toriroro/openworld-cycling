// 動かない部品の多いモデルを、材質ごとに1つの形状へまとめて描画命令を減らす。
// group の直下にある Mesh だけをまとめる（子の Group は動く部品として残す）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export function mergeStatic(group: THREE.Object3D): number {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of [...group.children]) {
    if (!(c instanceof THREE.Mesh) || Array.isArray(c.material) || c.children.length) continue;
    const l = byMat.get(c.material);
    if (l) l.push(c);
    else byMat.set(c.material, [c]);
  }
  let merged = 0;
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      let g = m.geometry.clone().applyMatrix4(m.matrix);
      if (!g.index) g = g.toNonIndexed();
      // 属性をそろえる（位置・法線・UV）
      for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
      if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
      return g;
    });
    const indexed = geos.every((g) => g.index);
    const one = mergeGeometries(indexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g)));
    if (!one) continue;
    const mesh = new THREE.Mesh(one, mat);
    mesh.castShadow = meshes.some((m) => m.castShadow);
    mesh.receiveShadow = true;
    for (const m of meshes) group.remove(m);
    group.add(mesh);
    merged += meshes.length - 1;
  }
  return merged;
}
