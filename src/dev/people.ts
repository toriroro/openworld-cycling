// 歩く人のリアルな形の確かめ（開発用。町の見た目の草案 3 章）: 4 体を色の行を変えて並べ、その場で歩かせる。
// ?view=front|side|back|face（向き）、?phase=0〜1（歩みの位相。無ければ動く）、?still=1（立ち）、?rows=8（並べる数）

import * as THREE from "three";
import { type RealPerson, RealPedestrians } from "../render/pedestrian-real.ts";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#c9d3d8");
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight("#dfe8f0", "#6b6458", 1.2));
const sun = new THREE.DirectionalLight("#fff4e0", 2.4);
sun.position.set(-6, 10, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 6, bottom: -2 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshStandardMaterial({ color: "#9a9890", roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ?group=0|1（組）: その組の髪型を全部、体と色の行を変えて並べる
const grp = Number(q.get("group") ?? 0);
const rows = Number(q.get("rows") ?? (grp === 0 ? 5 : 6));
const real = new RealPedestrians(rows);
scene.add(real.group);
const view = q.get("view") ?? "front";
const yaw = view === "side" ? Math.PI / 2 : view === "back" ? Math.PI : view === "quarter" ? Math.PI / 4 : 0;
const people: RealPerson[] = [];
for (let i = 0; i < rows; i++)
  people.push({ x: (i - (rows - 1) / 2) * 1.0, y: 0, z: 0, yaw, gait: 0, still: q.get("still") === "1", seed: i, look: { group: grp, variant: i % 3, style: i, row: i * 7 + Number(q.get("row") ?? 0) } });
const cam = q.get("cam")?.split(",").map(Number);
const look = q.get("look")?.split(",").map(Number);
if (cam && look) {
  camera.position.set(cam[0], cam[1], cam[2]);
  camera.lookAt(look[0], look[1], look[2]);
  camera.fov = 25;
} else if (view === "face") {
  camera.position.set(people[Number(q.get("who") ?? 0)].x, 1.6, 1.2);
  camera.lookAt(people[Number(q.get("who") ?? 0)].x, 1.55, 0);
  camera.fov = 25;
} else {
  camera.position.set(0, 1.25, rows * 1.15);
  camera.lookAt(0, 0.9, 0);
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
const phase = q.get("phase");
const ready = real.load(import.meta.env.BASE_URL);
(window as unknown as { __people: unknown }).__people = { ready, real };
renderer.setAnimationLoop((t) => {
  for (const p of people) p.gait = phase !== null ? Number(phase) : (t / 1000 / 1.1) % 1;
  real.update(people, 0, 0);
  renderer.render(scene, camera);
});
