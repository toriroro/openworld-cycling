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
import { PedestrianView } from "./pedestrians.ts";
import { HandoffView } from "./handoff-marks.ts";
import { AddressSignView } from "./address-signs.ts";
import { RestStopView } from "./rest-stops.ts";
import { NpcRiderView } from "./npc-riders.ts";
import { CutWallView } from "./cut-walls.ts";
import { RealBuildings } from "./real-buildings.ts";
import { RealStreets } from "./real-streets.ts";
import { RealPoles } from "./real-poles.ts";
import { RealSigns } from "./real-signs.ts";
import { CityClient } from "./city-client.ts";
import { LandmarkView } from "./landmarks/landmark-view.ts";
import { loadLandmarks } from "../workers/hokkaido-load.ts";
import { crowdFactor } from "../sim/pedestrians.ts";
import { heightOnRun, type SidewalkRun, sidewalkHeightAt, sidewalkRunAt } from "../sim/walk-surface.ts";

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
  /** 電柱・電線と街灯（北海道の世界。北海道の草案 26 章） */
  readonly realPoles: RealPoles | null = null;
  /** 道路標識（北海道の世界。北海道の草案 27 章） */
  readonly realSigns: RealSigns | null = null;
  /** 北海道の世界の名所の模型（読めるまで null。名所の草案） */
  landmarks: LandmarkView | null = null;
  /** 車とバス停（sim/traffic を読んで描く） */
  readonly trafficView = new TrafficView();
  /** 歩く人・頼み事の印・家の旗（配達の草案 16 章） */
  readonly pedestrians = new PedestrianView();
  /** 受け渡しの所の光の柱と円（配達の草案 26 章） */
  readonly handoff = new HandoffView();
  /** 交差点の住所の看板（配達の草案 27 章） */
  readonly addressSigns = new AddressSignView();
  /** 体力を戻す所（自販機・チェーンの店の看板。配達の草案 28 章） */
  readonly restStops = new RestStopView();
  /** 近くの NPC の配達員を人の形で（配達の草案 30 章） */
  readonly npcRiders = new NpcRiderView();
  /** 掘割の擁壁とアンダーパスの天井（北海道の世界。配達の草案 31 章） */
  readonly cutWalls = new CutWallView();
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
    const sw = this.world.local?.sidewalks;
    if (sw) {
      const ht = this.world.local!.terrain;
      const rp = new RealPoles(sw, this.heights, (x, z) => ht.hasPage(x, z));
      this.realPoles = rp;
      this.materials.push(rp.material);
      this.scene.add(rp.group);
      const rsg = new RealSigns(sw, this.heights, (x, z) => ht.hasPage(x, z), aniso);
      this.realSigns = rsg;
      this.materials.push(rsg.material, rsg.guideMaterial);
      this.scene.add(rsg.group);
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
    this.scene.add(this.terrain.group, this.roadMeshes.group, this.vegetation.group, this.buildings.group, this.districts.group, this.trafficView.group, this.pedestrians.group, this.handoff.group, this.addressSigns.group, this.restStops.group, this.npcRiders.group, this.cutWalls.group);
    // 自販機・置き看板は街路樹の幹を避ける（ビジュアルの点検 2026-11-26）
    this.restStops.avoid = (x, z) => this.streetTreeNear(x, z, 0.8);
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
    this.pedestrians?.setQuality(light);
    this.restStops?.setQuality(light);
    this.cutWalls?.setQuality(light);
    this.realBuildings?.setQuality(light);
    this.realStreets?.setQuality(light);
    this.realPoles?.setQuality(light);
    this.realSigns?.setQuality(light);
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
      this.realPoles?.setOrigin(this.originX, this.originZ);
      this.realSigns?.setOrigin(this.originX, this.originZ);
      this.landmarks?.setOrigin(this.originX, this.originZ);
      this.rebases++;
    }
    this.pedestrians.eye.x = eye.x;
    this.pedestrians.eye.z = eye.z;
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
    this.realPoles?.update(eye.x, eye.z);
    this.realSigns?.update(eye.x, eye.z);
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

  /** 歩く人の区切りごとの、足元の歩道の帯（無ければ null） */
  /** 歩く人の区切りごとの、足元の歩道の帯（無ければ null）と、それを探した所 */
  private walkRuns = new Map<number, { run: SidewalkRun | null; x: number; z: number }>();

  /**
   * 歩く人の足元の高さ（walkersNear の ground）。幹線の歩道の上なら歩道の上面、そうでなければ描いている地面。
   * 地面が道の中心から 0.8m より離れていれば（橋の脇・盛土・切土の脇）立つ所が無いとして null。
   * 区切りごとに乗っている歩道の帯を覚え、毎回その帯の上で高さを求める（横断歩道の手前で下げた歩道にも合う）。
   * 帯から外れたら（帯の継ぎ目・交差点の口）、前に探した所から 0.25m 動くたびに探し直す（帯ごとの外接の箱で先に除くので軽い）。
   * 前は最初に乗った帯だけを使い、歩道の無い所から歩き始めた人は歩道に 0.4m 埋まっていた（2026-11-26）
   */
  walkHeight(x: number, z: number, roadY: number, key: number): number | null {
    const sw = this.world.local?.sidewalks;
    if (sw) {
      let c = this.walkRuns.get(key);
      let h: number | null = c?.run ? heightOnRun(sw.pts, c.run, x, z) : null;
      if (h === null && (!c || (x - c.x) ** 2 + (z - c.z) ** 2 > 0.0625) && sw.hasPage(x, z)) {
        c = { run: sidewalkRunAt(sw, x, z), x, z };
        if (this.walkRuns.size > 20000) this.walkRuns.clear();
        this.walkRuns.set(key, c);
        if (c.run) h = heightOnRun(sw.pts, c.run, x, z);
      }
      if (h !== null) return h;
    }
    const g = this.terrain.heightAt(x, z);
    if (g === null) return roadY;
    return Math.abs(g - roadY) > 0.8 ? null : g;
  }

  /** 歩く人の区切りごとの、歩道の真ん中の位置と幅（歩道が無ければ null） */
  private walkLanes = new Map<number, { center: number; width: number } | null>();

  /**
   * 歩く所の横の位置（walkersNear の lane）。道の脇（端から 0.6・1.2・2m）に幹線の歩道があれば、その真ん中の道の中心からの距離と幅。
   * 区切りごとに最初に見た所で決めて覚える。前は道の端から一定の距離で、狭い歩道では外側の縁を出入りして高さが跳ねた（2026-11-26）
   */
  walkLane(key: number, x: number, z: number, nx: number, nz: number, half: number): { center: number; width: number } | null {
    const sw = this.world.local?.sidewalks;
    if (!sw) return null;
    const got = this.walkLanes.get(key);
    if (got !== undefined) return got;
    if (!sw.hasPage(x, z)) return null;
    let res: { center: number; width: number } | null = null;
    const P = sw.pts;
    for (const d of [0.6, 1.2, 2]) {
      const qx = x + nx * (half + d), qz = z + nz * (half + d);
      const run = sidewalkRunAt(sw, qx, qz);
      if (!run) continue;
      // 一番近い点の内側・外側の縁を、歩く側の向きへ写す
      let best = -1, bd = Infinity;
      for (let k = 0; k < run[1]; k++) {
        const a = (run[0] + k) * 5;
        const dd = ((P[a] + P[a + 2]) / 2 - qx) ** 2 + ((P[a + 1] + P[a + 3]) / 2 - qz) ** 2;
        if (dd < bd) { bd = dd; best = a; }
      }
      const di = (P[best] - x) * nx + (P[best + 1] - z) * nz;
      const dout = (P[best + 2] - x) * nx + (P[best + 3] - z) * nz;
      const lo = Math.min(di, dout), hi = Math.max(di, dout);
      if (hi - lo < 0.6 || lo < 0) continue;
      res = { center: (lo + hi) / 2, width: hi - lo };
      break;
    }
    if (this.walkLanes.size > 20000) this.walkLanes.clear();
    this.walkLanes.set(key, res);
    return res;
  }

  /** 足元の歩道の高さ（0.5m の格子ごとに覚える。歩道が無ければ NaN） */
  private walkCells = new Map<number, number>();

  /**
   * 道の高さで置いた人（荷を届ける運転手・頼み事の人など）の足元を、歩道の上面か描いている面（地形・路面）に合わせる。
   * 今の高さから 1m より離れる時は（橋の上など）そのまま
   */
  settleFeet(people: { x: number; y: number; z: number }[]) {
    const sw = this.world.local?.sidewalks;
    for (const p of people) {
      let h = NaN;
      if (sw) {
        const key = Math.round(p.x * 2) * 1e6 + Math.round(p.z * 2);
        let c = this.walkCells.get(key);
        if (c === undefined && sw.hasPage(p.x, p.z)) {
          c = sidewalkHeightAt(sw, p.x, p.z) ?? NaN;
          if (this.walkCells.size > 20000) this.walkCells.clear();
          this.walkCells.set(key, c);
        }
        if (c !== undefined) h = c;
      }
      if (Number.isNaN(h)) h = this.surfaceHeight(p.x, p.z);
      if (Math.abs(h - p.y) <= 1) p.y = h;
    }
  }

  /** (x, z) から r m 以内に街路樹の幹があるか（北海道の世界の歩道の木） */
  streetTreeNear(x: number, z: number, r: number): boolean {
    const sw = this.world.local?.sidewalks;
    if (!sw) return false;
    const C = sw.index.cell, T = sw.trees;
    for (let i = Math.floor((x - r) / C); i <= Math.floor((x + r) / C); i++)
      for (let j = Math.floor((z - r) / C); j <= Math.floor((z + r) / C); j++)
        for (const t of sw.index.trees[`${i},${j}`] ?? []) if ((T[t * 5] - x) ** 2 + (T[t * 5 + 2] - z) ** 2 < r * r) return true;
    return false;
  }

  /** 場所ごとの人の多さの倍率（込み具合の分かる世界だけ。生成の世界は 1） */
  crowdAt(x: number, z: number): number {
    const h = this.heights as TerrainLike & { commercialCoverage?(x: number, z: number): number; coverage?(x: number, z: number): number };
    if (!h.commercialCoverage || !h.coverage) return 1;
    return crowdFactor(h.commercialCoverage(x, z), h.coverage(x, z));
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
      realPoles: this.realPoles ? { ...this.realPoles.stats } : null,
      realSigns: this.realSigns ? { ...this.realSigns.stats } : null,
      landmarks: this.landmarks ? { ...this.landmarks.stats } : null,
      roads: this.roadMeshes.stats(),
      roadsLoaded: this.roads.net.roads.size,
      roadBlocksPending: this.roads.pending,
      rebases: this.rebases,
      quality: this.quality,
    };
  }
}
