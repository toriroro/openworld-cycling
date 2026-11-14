// 3D の描画をまとめる。地形・道路・空、原点の置き直し（モック仕様 5.2）、画質2段階（5.6）。
// sim の状態は読むだけで書き換えない。

import * as THREE from "three";
import { Terrain } from "../shared/world/terrain.ts";
import type { RoadClient } from "../workers/road-client.ts";
import { Environment, loadTexture, terrainMaterial } from "./environment.ts";
import { createGravelTexture } from "./gravel-texture.ts";
import { RoadMeshes } from "./road-meshes.ts";
import { RANGES_LIGHT, RANGES_STANDARD, TerrainStreamer } from "./terrain-streamer.ts";
import { Vegetation } from "./vegetation.ts";
import { BuildingMeshes } from "./buildings.ts";
import { DistrictMeshes } from "./district/meshes.ts";
import { Towns } from "./towns.ts";

export type Quality = "standard" | "light";

/** 原点を置き直す距離と単位（モック仕様 5.2） */
const REBASE_DISTANCE = 2000;
const REBASE_UNIT = 1024;

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly env: Environment;
  readonly terrain: TerrainStreamer;
  readonly roadMeshes: RoadMeshes;
  readonly vegetation: Vegetation;
  readonly heights: Terrain;
  /** 町・集落の建物と喫茶店の配置 */
  readonly towns: Towns;
  readonly buildings: BuildingMeshes;
  /** 町の街区（区画道路・歩道・敷地・電柱・街路樹） */
  readonly districts: DistrictMeshes;
  private pruneT = 0;
  quality: Quality = "standard";
  /** 描画の原点（世界座標、REBASE_UNIT の倍数） */
  originX = 0;
  originZ = 0;
  rebases = 0;
  private materials: THREE.Material[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    seed: number,
    readonly roads: RoadClient,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.8, 30000);
    this.heights = new Terrain(seed);
    this.env = new Environment(this.scene);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const loader = new THREE.TextureLoader();
    const ground = loadTexture(loader, "aerial_grass_rock_Diffuse", true, aniso);
    const terrainMat = terrainMaterial(ground);
    const asphalt = (name: string, color: boolean) => loadTexture(loader, `asphalt_02_${name}`, color, aniso);
    const paved = new THREE.MeshStandardMaterial({
      map: asphalt("Diffuse", true),
      normalMap: asphalt("nor_gl", false),
      roughnessMap: asphalt("Rough", false),
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 1,
      vertexColors: true,
      color: "#a8a8a4",
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    const gravel = new THREE.MeshStandardMaterial({
      map: createGravelTexture(512, aniso),
      roughness: 1,
      vertexColors: true,
      color: "#ffffff",
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    const structure = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      side: THREE.DoubleSide,
      // 区画線は補修跡の上に引き直されるので、補修跡より手前に描く
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
    const patch = paved.clone();
    patch.polygonOffsetFactor = -2;
    patch.polygonOffsetUnits = -4;
    this.materials.push(terrainMat, paved, gravel, structure, patch);

    this.terrain = new TerrainStreamer(seed, terrainMat, roads);
    this.roadMeshes = new RoadMeshes(roads, this.heights, { paved, gravel, structure, patch });
    this.vegetation = new Vegetation(this.terrain);
    this.towns = new Towns(seed, roads, this.heights);
    this.terrain.towns = this.towns;
    this.buildings = new BuildingMeshes(this.towns, aniso);
    this.districts = new DistrictMeshes(this.towns, paved, structure, aniso);
    this.materials.push(...this.districts.materials);
    this.scene.add(this.terrain.group, this.roadMeshes.group, this.vegetation.group, this.buildings.group, this.districts.group);
    this.setQuality(matchMedia("(pointer: coarse)").matches ? "light" : "standard");
  }

  setQuality(q: Quality) {
    this.quality = q;
    const light = q === "light";
    const dpr = Math.min(window.devicePixelRatio || 1, light ? 1.5 : 2);
    this.renderer.setPixelRatio(light ? dpr * 0.75 : dpr);
    this.renderer.shadowMap.enabled = !light;
    this.env.setShadows(!light);
    this.terrain.ranges = light ? RANGES_LIGHT : RANGES_STANDARD;
    this.terrain.vegDensity = light ? 0.5 : 1;
    this.vegetation?.setQuality(light);
    this.buildings?.setQuality(light);
    this.districts?.setQuality(light);
    this.roadMeshes.range = light ? 900 : 1600;
    const far = this.terrain.ranges.far;
    this.env.setFar(far);
    this.camera.far = far * 1.3;
    this.camera.updateProjectionMatrix();
    // 材質の作り直し（影の有無で shader が変わる）
    for (const m of this.materials) m.needsUpdate = true;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /**
   * カメラを世界座標で置き、ストリーミングを進めて描く。
   * eye と target は世界座標（倍精度）。描画には原点からの相対で渡す。
   */
  frame(eye: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, fov?: number, beforeRender?: () => void) {
    if (Math.abs(eye.x - this.originX) > REBASE_DISTANCE || Math.abs(eye.z - this.originZ) > REBASE_DISTANCE) {
      this.originX = Math.round(eye.x / REBASE_UNIT) * REBASE_UNIT;
      this.originZ = Math.round(eye.z / REBASE_UNIT) * REBASE_UNIT;
      this.terrain.setOrigin(this.originX, this.originZ);
      this.roadMeshes.setOrigin(this.originX, this.originZ);
      this.vegetation.setOrigin(this.originX, this.originZ);
      this.buildings.setOrigin(this.originX, this.originZ);
      this.districts.setOrigin(this.originX, this.originZ);
      this.rebases++;
    }
    this.camera.position.set(eye.x - this.originX, eye.y, eye.z - this.originZ);
    this.camera.lookAt(target.x - this.originX, target.y, target.z - this.originZ);
    if (fov !== undefined && Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.roads.update(eye.x, eye.z);
    this.terrain.update(eye.x, eye.z);
    this.roadMeshes.update(eye.x, eye.z);
    this.vegetation.update(eye.x, eye.z);
    this.buildings.update(eye.x, eye.z);
    this.districts.update(eye.x, eye.z);
    // 遠くの町の配置を忘れる（道路の保持範囲 10km より少し広く）
    const now = performance.now();
    if (now - this.pruneT > 5000) {
      this.pruneT = now;
      this.towns.prune(eye.x, eye.z, 12000);
    }
    this.vegetation.setDaylight(0.35 + 0.65 * this.env.daylight);
    this.districts.setDaylight(0.35 + 0.65 * this.env.daylight);
    this.env.follow(this.camera.position);
    beforeRender?.();
    this.renderer.render(this.scene, this.camera);
  }

  private groundRay = new THREE.Raycaster();
  private groundTargets: THREE.Object3D[] = [];
  private groundTargetsT = -1;
  /**
   * 描いている面（地形と道路）の高さ。視点を地面より上に保つのに使う。描いていない所は高さ関数の値。
   * 道路の近くは地形を路面に合わせているので、高さ関数では切土の所で高く出すぎるため。
   */
  surfaceHeight(x: number, z: number): number {
    const now = performance.now();
    if (now - this.groundTargetsT > 500) {
      this.groundTargetsT = now;
      this.groundTargets = [];
      this.terrain.group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.visible && o.userData.level === 0) this.groundTargets.push(o);
      });
      this.roadMeshes.group.traverse((o) => {
        if (o instanceof THREE.Mesh) this.groundTargets.push(o);
      });
    }
    this.groundRay.set(new THREE.Vector3(x - this.originX, 4000, z - this.originZ), new THREE.Vector3(0, -1, 0));
    this.groundRay.far = 6000;
    const hit = this.groundRay.intersectObjects(this.groundTargets, false)[0];
    return hit ? hit.point.y : this.heights.height(x, z);
  }

  /** 世界座標の点が描画座標でどこになるか */
  toRender(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x - this.originX, y, z - this.originZ);
  }

  settled(): boolean {
    return this.roads.pending === 0 && this.terrain.settled() && this.roadMeshes.pendingBuild === 0;
  }

  stats() {
    const info = this.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      triangles: info.render.triangles,
      calls: info.render.calls,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      terrain: this.terrain.stats(),
      vegetation: { ...this.vegetation.stats },
      buildings: { ...this.buildings.stats },
      districts: { ...this.districts.stats, layoutMs: this.towns.districtMs.slice(-4) },
      roads: this.roadMeshes.stats(),
      roadsLoaded: this.roads.net.roads.size,
      roadBlocksPending: this.roads.pending,
      rebases: this.rebases,
      quality: this.quality,
    };
  }
}
