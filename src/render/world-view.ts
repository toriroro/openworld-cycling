// 3D の描画をまとめる。地形・道路・空、原点の置き直し（モック仕様 5.2）、画質2段階（5.6）。
// sim の状態は読むだけで書き換えない。

import * as THREE from "three";
import { Terrain } from "../shared/world/terrain.ts";
import type { RoadClient } from "../workers/road-client.ts";
import { Environment, loadTexture, terrainMaterial } from "./environment.ts";
import { createGravelTexture } from "./gravel-texture.ts";
import { RoadMeshes } from "./road-meshes.ts";
import { RANGES_LIGHT, RANGES_STANDARD, TerrainStreamer } from "./terrain-streamer.ts";

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
  readonly heights: Terrain;
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
      color: "#9a9a96",
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
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.materials.push(terrainMat, paved, gravel, structure);

    this.terrain = new TerrainStreamer(seed, terrainMat, roads);
    this.roadMeshes = new RoadMeshes(roads, this.heights, { paved, gravel, structure });
    this.scene.add(this.terrain.group, this.roadMeshes.group);
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
  frame(eye: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) {
    if (Math.abs(eye.x - this.originX) > REBASE_DISTANCE || Math.abs(eye.z - this.originZ) > REBASE_DISTANCE) {
      this.originX = Math.round(eye.x / REBASE_UNIT) * REBASE_UNIT;
      this.originZ = Math.round(eye.z / REBASE_UNIT) * REBASE_UNIT;
      this.terrain.setOrigin(this.originX, this.originZ);
      this.roadMeshes.setOrigin(this.originX, this.originZ);
      this.rebases++;
    }
    this.camera.position.set(eye.x - this.originX, eye.y, eye.z - this.originZ);
    this.camera.lookAt(target.x - this.originX, target.y, target.z - this.originZ);
    this.roads.update(eye.x, eye.z);
    this.terrain.update(eye.x, eye.z);
    this.roadMeshes.update(eye.x, eye.z);
    this.env.follow(this.camera.position);
    this.renderer.render(this.scene, this.camera);
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
      roads: this.roadMeshes.stats(),
      roadsLoaded: this.roads.net.roads.size,
      roadBlocksPending: this.roads.pending,
      rebases: this.rebases,
      quality: this.quality,
    };
  }
}
