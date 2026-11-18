// 3D の描画をまとめる。地形・道路・空、原点の置き直し（モック仕様 5.2）、画質2段階（5.6）。
// sim の状態は読むだけで書き換えない。

import * as THREE from "three";
import { Terrain, type TerrainLike } from "../shared/world/terrain.ts";
import { generatedWorld, type WorldChoice } from "../world-choice.ts";
import type { RoadClient } from "../workers/road-client.ts";
import { Environment, loadTexture, terrainMaterial } from "./environment.ts";
import { createGravelTexture } from "./gravel-texture.ts";
import { RoadMeshes } from "./road-meshes.ts";
import { RANGES_LIGHT, RANGES_STANDARD, TerrainStreamer } from "./terrain-streamer.ts";
import { Vegetation } from "./vegetation.ts";
import { BuildingMeshes } from "./buildings.ts";
import { DistrictMeshes } from "./district/meshes.ts";
import { Towns } from "./towns.ts";
import { TrafficView } from "./traffic/traffic-view.ts";
import { RealBuildings } from "./real-buildings.ts";
import { RealStreets } from "./real-streets.ts";
import { CityClient } from "./city-client.ts";
import { LandmarkView } from "./landmarks/landmark-view.ts";
import { loadLandmarks } from "../workers/hokkaido-load.ts";

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
  readonly heights: TerrainLike;
  /** どちらの世界か（北海道の草案 2.2） */
  readonly world: WorldChoice;
  /** 町・集落の建物と喫茶店の配置 */
  readonly towns: Towns;
  readonly buildings: BuildingMeshes;
  /** 町の街区（区画道路・歩道・敷地・電柱・街路樹） */
  readonly districts: DistrictMeshes;
  /** 北海道の世界の建物（OSM の外形。無ければ null） */
  readonly realBuildings: RealBuildings | null = null;
  /** 北海道の世界の走らない道（見た目だけ。無ければ null） */
  readonly realStreets: RealStreets | null = null;
  /** 北海道の世界の名所の模型（読めるまで null。名所の草案） */
  landmarks: LandmarkView | null = null;
  /** 車とバス停（sim/traffic を読んで描く） */
  readonly trafficView = new TrafficView();
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
    world?: WorldChoice,
  ) {
    this.world = world ?? generatedWorld(seed);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.8, 30000);
    this.heights = this.world.local?.terrain ?? new Terrain(seed);
    this.env = new Environment(this.scene);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const loader = new THREE.TextureLoader();
    const ground = loadTexture(loader, "aerial_grass_rock_Diffuse", true, aniso);
    const terrainMat = terrainMaterial(ground, seed);
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
    // トンネルの照明（北海道の世界）
    const lamp = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const patch = paved.clone();
    patch.polygonOffsetFactor = -2;
    patch.polygonOffsetUnits = -4;
    this.materials.push(terrainMat, paved, gravel, structure, patch, lamp);

    this.terrain = new TerrainStreamer(seed, terrainMat, roads, world);
    this.roadMeshes = new RoadMeshes(roads, this.heights, { paved, gravel, structure, patch, lamp });
    this.vegetation = new Vegetation(this.terrain);
    this.towns = new Towns(seed, roads, this.heights, this.world.id === "generated");
    this.terrain.towns = this.towns;
    this.buildings = new BuildingMeshes(this.towns, aniso);
    this.districts = new DistrictMeshes(this.towns, paved, structure, aniso);
    this.materials.push(...this.districts.materials);
    const hs = this.world.local?.streets;
    const hbData = this.world.local?.buildings ?? null;
    // 建物・走らない道の形は Worker で作る（北海道の草案 18 章）
    const city = this.world.local && (hs || hbData) ? new CityClient(this.world.base, seed, { buildings: hbData, streets: hs ?? null, terrain: this.world.local.terrain }) : null;
    if (hs && city) {
      const pathMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      this.materials.push(pathMat);
      const rs = new RealStreets(
        hs,
        this.heights,
        { paved, path: pathMat, walk: this.districts.walkMaterial, tree: this.districts.treeMaterial, treeGeo: this.districts.treeGeometry },
        city,
        this.world.local?.sidewalks ?? null,
      );
      this.realStreets = rs;
      this.terrain.extraRoads = (r, margin, stride) => rs.pack(r, margin, stride);
      this.scene.add(rs.group);
    }
    const hb = hbData;
    if (hb && city) {
      const rb = new RealBuildings(hb, this.buildings, city);
      this.realBuildings = rb;
      this.towns.extraLots = (r) => rb.lotsIn(r);
      this.scene.add(rb.group);
    }
    const local = this.world.local;
    if (local)
      void loadLandmarks(this.world.base).then((file) => {
        if (!file) return;
        const lv = new LandmarkView(file, local, this.heights, { geometry: this.districts.treeGeometry, material: this.districts.treeMaterial });
        lv.setQuality(this.quality === "light");
        lv.setOrigin(this.originX, this.originZ);
        this.materials.push(...lv.materials);
        this.landmarks = lv;
        this.scene.add(lv.group);
        // 模型で置き換える OSM の建物を描かない
        if (city && this.realBuildings) {
          city.setExcluded(lv.replacedOutlines());
          this.realBuildings.refresh();
        }
      });
    this.scene.add(this.terrain.group, this.roadMeshes.group, this.vegetation.group, this.buildings.group, this.districts.group, this.trafficView.group);
    this.setQuality(matchMedia("(pointer: coarse)").matches ? "light" : "standard");
  }

  setQuality(q: Quality) {
    this.quality = q;
    const light = q === "light";
    const dpr = Math.min(window.devicePixelRatio || 1, light ? 1.5 : 2);
    this.renderer.setPixelRatio(light ? dpr * 0.75 : dpr);
    this.renderer.shadowMap.enabled = !light;
    this.env.setShadows(!light);
    this.env.setQuality(light);
    this.terrain.ranges = light ? RANGES_LIGHT : RANGES_STANDARD;
    this.terrain.vegDensity = light ? 0.5 : 1;
    this.vegetation?.setQuality(light);
    this.buildings?.setQuality(light);
    this.districts?.setQuality(light);
    this.trafficView?.setQuality(light);
    this.realBuildings?.setQuality(light);
    this.realStreets?.setQuality(light);
    this.landmarks?.setQuality(light);
    this.roadMeshes.range = light ? 900 : 1600;
    this.roadMeshes.detailRange = light ? 250 : 400;
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
      this.realBuildings?.setOrigin(this.originX, this.originZ);
      this.realStreets?.setOrigin(this.originX, this.originZ);
      this.landmarks?.setOrigin(this.originX, this.originZ);
      this.rebases++;
    }
    this.camera.position.set(eye.x - this.originX, eye.y, eye.z - this.originZ);
    this.camera.lookAt(target.x - this.originX, target.y, target.z - this.originZ);
    if ((fov !== undefined && Math.abs(this.camera.fov - fov) > 0.01) || this.camera.near !== this.nearPlane) {
      if (fov !== undefined) this.camera.fov = fov;
      this.camera.near = this.nearPlane;
      this.camera.updateProjectionMatrix();
    }
    this.roads.update(eye.x, eye.z);
    this.updatePages(eye.x, eye.z);
    this.terrain.update(eye.x, eye.z);
    this.roadMeshes.update(eye.x, eye.z);
    this.vegetation.update(eye.x, eye.z);
    this.buildings.update(eye.x, eye.z);
    this.districts.update(eye.x, eye.z);
    this.realBuildings?.update(eye.x, eye.z);
    this.realStreets?.update(eye.x, eye.z);
    this.landmarks?.update(eye.x, eye.z);
    // 遠くの町の配置を忘れる（道路の保持範囲 10km より少し広く）
    const now = performance.now();
    if (now - this.pruneT > 5000) {
      this.pruneT = now;
      this.towns.prune(eye.x, eye.z, 12000);
    }
    this.vegetation.setDaylight(this.env.light);
    this.districts.setDaylight(this.env.light);
    this.env.follow(this.camera.position, eye.x, eye.z);
    beforeRender?.();
    this.renderer.render(this.scene, this.camera);
  }

  /** カメラの近い面 (m)。一人称では手元が映るように手前にする（game.ts が決める） */
  nearPlane = 0.8;

  /**
   * 描いている面（地形と道路）の高さ。視点を地面より上に保つのに使う。描いていない所は高さ関数の値。
   * 道路の近くは地形を路面に合わせているので、高さ関数では切土の所で高く出すぎるため。
   * 地形は近景のタイルの格子から、路面は道路の中心線と幅から求めて高い方を使う（どちらも光線を当てない。
   * 道路のメッシュへの光線は札幌で 1 フレームに 40ms を超えた。北海道の草案 18・23 章）。
   */

  surfaceHeight(x: number, z: number): number {
    // トンネルの中（北海道の世界）は路面の高さ。内壁の外へ少しはみ出した視点も山の上へ押し上げない
    const tunnel = this.roads.tunnelAt(x, z, 3);
    if (tunnel !== null) return tunnel;
    // 近景のタイルの格子から（光線を当てない。北海道の草案 23 章）
    const ground = this.terrain.heightAt(x, z) ?? this.heights.height(x, z);
    const road = this.roads.surfaceAt(x, z);
    return road === null ? ground : Math.max(ground, road);
  }

  /** 世界座標の点が描画座標でどこになるか */
  toRender(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x - this.originX, y, z - this.originZ);
  }

  /** 北海道の世界: 視点の 500m 四方が変わるたびに、周りの頁（地形・建物・道・歩道）を読む（北海道の草案 20 章） */
  private pagesAt = "";
  private pagesPending = 0;
  private updatePages(x: number, z: number) {
    const local = this.world.local;
    if (!local) return;
    const k = `${Math.round(x / 500)},${Math.round(z / 500)}`;
    if (k === this.pagesAt) return;
    this.pagesAt = k;
    this.pagesPending++;
    void local.ensureAround(x, z).finally(() => this.pagesPending--);
  }

  settled(): boolean {
    return this.pagesPending === 0 && this.roads.pending === 0 && this.terrain.settled() && this.roadMeshes.pendingBuild === 0 && (this.realBuildings?.pending ?? 0) === 0 && (this.realStreets?.pending ?? 0) === 0 && (this.landmarks?.pending ?? 0) === 0;
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
      traffic: { ...this.trafficView.stats },
      realBuildings: this.realBuildings?.stats() ?? null,
      realStreets: this.realStreets ? { ...this.realStreets.stats } : null,
      landmarks: this.landmarks ? { ...this.landmarks.stats } : null,
      roads: this.roadMeshes.stats(),
      roadsLoaded: this.roads.net.roads.size,
      roadBlocksPending: this.roads.pending,
      rebases: this.rebases,
      quality: this.quality,
    };
  }
}
