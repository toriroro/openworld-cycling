// 頂点の配列（Mesher.arrays、Worker から届いたもの）を描画の形にする。

import * as THREE from "three";
import type { MeshArrays } from "./mesher.ts";

export function toGeometry(a: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(a.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(a.nor, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(a.uv, 2));
  g.setAttribute("color", new THREE.BufferAttribute(a.col, 3));
  g.setIndex(new THREE.BufferAttribute(a.idx, 1));
  if (a.sphere) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(a.sphere[0], a.sphere[1], a.sphere[2]), a.sphere[3]);
  else g.computeBoundingSphere();
  return g;
}
