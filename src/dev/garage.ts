// 開発用: 自分の自転車とライダーだけを置いた場面（garage.html）。形と色の確認、画面写真、描画量の計測に使う。
// ?lod=low で軽量画質の簡略版。window.__garage から角度・設定・姿勢を変える。

import * as THREE from "three";
import { DEFAULT_OUTFIT, type Outfit, sanitizeOutfit } from "../shared/outfit.ts";
import { CyclistModel } from "../render/cyclist/cyclist.ts";
import type { Lod } from "../render/cyclist/road-bike.ts";
import { showcaseView } from "../render/cyclist/showcase.ts";
import { OutfitPanel } from "../ui/outfit-panel.ts";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = q.get("lod") !== "low";
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color("#c9d6dd");
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
const sun = new THREE.DirectionalLight("#ffffff", 3);
sun.position.set(4, 8, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -2.5;
sc.right = sc.top = 2.5;
sc.near = 1;
sc.far = 20;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, new THREE.HemisphereLight("#bcd4ee", "#5b5a44", 1.1));
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#5a5d5f", roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);

let outfit: Outfit = sanitizeOutfit(q.get("outfit") ? JSON.parse(q.get("outfit")!) : DEFAULT_OUTFIT);
let lod: Lod = q.get("lod") === "low" ? "low" : "high";
const cyclist = new CyclistModel(outfit, lod);
scene.add(cyclist.group);
if (q.has("norider")) cyclist.rider.group.visible = false;

// ?panel で設定画面を開き、ゲームと同じ視点（showcaseView）で見る
const panel = new OutfitPanel(document.body, outfit);
panel.onChange = (o) => {
  outfit = o;
  cyclist.setOutfit(o);
};
if (q.has("panel")) panel.open(outfit);

const view = { yaw: Number(q.get("yaw") ?? 90), pitch: Number(q.get("pitch") ?? 8), dist: Number(q.get("dist") ?? 3.2), ty: Number(q.get("ty") ?? 0.75), tz: Number(q.get("tz") ?? 0), fov: 30 };
const pose = { phase: 0.6, speed: 8, watts: 180, steer: 0, look: 0, headYaw: 0, firstPerson: false, spin: q.has("spin") };
let distance = 0;
let last = performance.now();

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function frame(t: number) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (pose.spin) {
    distance += pose.speed * dt;
    pose.phase = (pose.phase + dt * 9) % (Math.PI * 2);
  }
  cyclist.pose(dt, { phase: pose.phase, speed: pose.speed, watts: pose.watts, distance, steer: pose.steer, lean: 0, firstPerson: pose.firstPerson, look: pose.look, headYaw: pose.headYaw });
  if (panel.isOpen) {
    const r = panel.root.getBoundingClientRect();
    const portrait = innerWidth / innerHeight < 0.8;
    const share = portrait ? (innerHeight - r.top) / innerHeight : (innerWidth - r.left) / innerWidth;
    const s = showcaseView(cyclist.group, camera.aspect, share);
    camera.fov = s.fov;
    camera.updateProjectionMatrix();
    camera.position.copy(s.eye);
    camera.lookAt(s.target);
  } else {
    const yaw = (view.yaw * Math.PI) / 180;
    const pitch = (view.pitch * Math.PI) / 180;
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * view.dist, view.ty + Math.sin(pitch) * view.dist, view.tz + Math.cos(yaw) * Math.cos(pitch) * view.dist);
    camera.lookAt(0, view.ty, view.tz);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as Record<string, unknown>).__garage = {
  view,
  pose,
  cyclist,
  renderer,
  panel,
  setOutfit(o: unknown) {
    outfit = sanitizeOutfit(o);
    cyclist.setOutfit(outfit);
  },
  setLod(l: Lod) {
    lod = l;
    cyclist.setLod(l);
  },
  get outfit() {
    return outfit;
  },
  stats: () => ({ ...cyclist.stats(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
};
