// 路面への地面の突き抜けを光線で調べる（モック仕様 M2 の完了条件）。
// 近くの道路の点で、路面の中央と両端の少し内側に真上から光線を落とし、最初に当たるのが地形で、
// しかも路面より上なら突き抜けとして数える。

import * as THREE from "three";
import { roadSpacing } from "../sim/road-network.ts";
import type { WorldView } from "./world-view.ts";

export interface RayCheckResult {
  rays: number;
  poke: number;
  /** 地形にも道路にも当たらなかった光線（道路のメッシュがまだない所など） */
  missed: number;
  worst: { road: string; s: number; over: number } | null;
  samples: { road: string; s: number; over: number; level: number; dist: number; off: number; bridge: boolean }[];
}

export function rayCheck(view: WorldView, cx: number, cz: number, radius: number, step = 5): RayCheckResult {
  const terrainMeshes: THREE.Object3D[] = [];
  view.terrain.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible) terrainMeshes.push(o);
  });
  const roadMeshes: THREE.Object3D[] = [];
  view.roadMeshes.group.traverse((o) => {
    if (o instanceof THREE.Mesh) roadMeshes.push(o);
  });
  view.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.near = 0;
  ray.far = 400;
  const down = new THREE.Vector3(0, -1, 0);
  const res: RayCheckResult = { rays: 0, poke: 0, missed: 0, worst: null, samples: [] };
  for (const e of view.roads.roadEntries()) {
    const r = e.road;
    const ds = roadSpacing(r);
    const n = r.points.length / 3;
    const k = Math.max(1, Math.round(step / ds));
    for (let i = 0; i < n; i += k) {
      const x = r.points[i * 3] + r.origin[0];
      const z = r.points[i * 3 + 2] + r.origin[1];
      if ((x - cx) ** 2 + (z - cz) ** 2 > radius * radius) continue;
      const y = r.points[i * 3 + 1];
      // トンネルの中は地形が路面の上にある（山の中）
      if (e.bridge[i] === 2) continue;
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = r.points[b * 3] - r.points[a * 3];
      let tz = r.points[b * 3 + 2] - r.points[a * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      for (const off of [0, -(r.width / 2 - 0.3), r.width / 2 - 0.3]) {
        const px = x - tz * off;
        const pz = z + tx * off;
        ray.set(view.toRender(px, y + 60, pz), down);
        const hitT = ray.intersectObjects(terrainMeshes, false)[0];
        const hitR = ray.intersectObjects(roadMeshes, false)[0];
        res.rays++;
        if (!hitR) {
          res.missed++;
          continue;
        }
        // 地形が路面の上（光線で先に当たる）にあれば突き抜け
        if (hitT && hitT.distance < hitR.distance - 0.005) {
          res.poke++;
          const over = hitR.distance - hitT.distance;
          if (!res.worst || over > res.worst.over) res.worst = { road: r.id, s: i * ds, over };
          if (res.samples.length < 40)
            res.samples.push({ road: r.id, s: i * ds, over, level: hitT.object.userData.level, dist: Math.hypot(x - cx, z - cz), off, bridge: e.bridge[i] === 1 });
        }
      }
    }
  }
  return res;
}

/** 描いている地形（近景のタイル）の高さを、上からの光線で求める（検証用）。当たらなければ null */
export function groundProbe(view: WorldView, points: [number, number][]): (number | null)[] {
  const meshes: THREE.Object3D[] = [];
  view.terrain.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible && o.userData.level === 0) meshes.push(o);
  });
  view.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 3000;
  const down = new THREE.Vector3(0, -1, 0);
  return points.map(([x, z]) => {
    ray.set(new THREE.Vector3(x - view.originX, 1500, z - view.originZ), down);
    const h = ray.intersectObjects(meshes, false)[0];
    return h ? h.point.y : null;
  });
}
