// downhill-3D の src/render/ から移した（2026-11-13）。元は1行が長いので、ここで手を入れる時に読みやすく整える。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const sphere = new THREE.SphereGeometry(1, 16, 10);
const box = new RoundedBoxGeometry(1, 1, 1, 2, .09);
const cylinder = new THREE.CylinderGeometry(.82, 1, 1, 12);
const materials = new Map<string, THREE.MeshStandardMaterial>();
export const material = (color: string) => {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: .75 }));
  return materials.get(color)!;
};
export const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export function shape(parent: THREE.Object3D, color: string, position: number[], scale: number[], round = true): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  const mesh = new THREE.Mesh(round ? sphere : box, material(color));
  mesh.position.set(...position as [number, number, number]); mesh.scale.set(...scale as [number, number, number]); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
export function bone(parent: THREE.Object3D, color: string) { const mesh = new THREE.Mesh(cylinder, material(color)); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh; }
const up = v(0, 1, 0);
export function connect(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number) {
  const d = b.clone().sub(a); mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.scale.set(radius, Math.max(.001, d.length()), radius); mesh.quaternion.setFromUnitVectors(up, d.normalize());
}
/** Two-link limb joint in the requested bend plane. */
export function joint(a: THREE.Vector3, b: THREE.Vector3, l1: number, l2: number, bend: THREE.Vector3) {
  const delta = b.clone().sub(a), distance = Math.max(.001, delta.length()), dir = delta.divideScalar(distance);
  const d = Math.min(distance, l1 + l2 - .0001);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const perpendicular = bend.clone().addScaledVector(dir, -bend.dot(dir)).normalize();
  return a.clone().addScaledVector(dir, along).addScaledVector(perpendicular, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
}
