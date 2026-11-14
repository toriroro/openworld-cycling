// 空と時刻と天候（モック仕様 5.5、概要仕様 3.7）。太陽の位置と雲・霧の量で空・光・霞の色を変える。海は y=0 の面。影は標準画質のみ。

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { fieldSeed, fieldShader } from "./farm/fields.ts";
import { SkyDome } from "./sky-dome.ts";

export interface SunState {
  dir: THREE.Vector3;
  elevation: number;
}

/** 時刻（時、0〜24）から太陽の向き。6 時に東、12 時に南、18 時に西（表示用の近似） */
export function sunDirection(hour: number): SunState {
  const t = (hour - 6) / 12;
  const el = Math.sin(Math.PI * t) * THREE.MathUtils.degToRad(58) - (t < 0 || t > 1 ? 0.25 : 0);
  const az = Math.PI * t; // 東(+x) → 南(+z) → 西(−x)
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  return { dir, elevation: el };
}

const C_FOG_DAY = new THREE.Color("#b9cddd");
const C_FOG_LOW = new THREE.Color("#d9b998");
const C_FOG_NIGHT = new THREE.Color("#1b2430");
const C_FOG_OVERCAST = new THREE.Color("#a9b0b6");
const C_FOG_MIST = new THREE.Color("#c4c9cc");
const C_HEMI_DAY = new THREE.Color("#bcd4ee");
const C_HEMI_OVERCAST = new THREE.Color("#c3c7cb");
const C_HEMI_NIGHT = new THREE.Color("#46557a");
const C_GROUND_DAY = new THREE.Color("#5b5a44");
const C_GROUND_NIGHT = new THREE.Color("#23241f");
const C_MOON = new THREE.Color("#a9bcff");
const C_CLOUD_NIGHT = new THREE.Color(0.035, 0.042, 0.06);
const C_WHITE = new THREE.Color(1, 1, 1);

const smooth = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

/** 雲の模様が風で流れる量 (m/ms)。天候の模様（shared/world/weather.ts）と同じ向き */
const DOME_WIND_X = 5 / 1000;
const DOME_WIND_Z = 1.5 / 1000;
const DOME_WIND_PERIOD = 4 * 3600 * 1000;

export class Environment {
  readonly sky: Sky;
  readonly dome = new SkyDome();
  readonly sun = new THREE.DirectionalLight("#ffffff", 3);
  readonly hemi = new THREE.HemisphereLight("#bcd4ee", "#5b5a44", 1.1);
  readonly water: THREE.Mesh;
  readonly fog: THREE.Fog;
  hour = 14.5;
  /** 昼の明るさ 0〜1 */
  daylight = 1;
  /** 光を受けない材質（板の木など）に掛ける明るさ。昼夜と曇りで変わる */
  light = 1;
  /** いま描いている雲の量と霧の濃さ（目標へゆっくり近づける） */
  cloud = 0.3;
  mist = 0;
  private targetCloud = 0.3;
  private targetMist = 0;
  private shadows = true;
  private target = new THREE.Object3D();
  private fogBaseFar = 24000;
  private tmp = new THREE.Color();
  private sunColor = new THREE.Color();
  private sunDir = new THREE.Vector3(0, 1, 0);

  constructor(private scene: THREE.Scene) {
    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    scene.add(this.sky, this.dome.mesh);
    this.fog = new THREE.Fog(C_FOG_DAY.clone(), 1500, 24000);
    scene.fog = this.fog;
    this.sun.target = this.target;
    scene.add(this.sun, this.target, this.hemi);
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -160;
    sc.right = 160;
    sc.top = 160;
    sc.bottom = -160;
    sc.near = 10;
    sc.far = 2000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    const wg = new THREE.PlaneGeometry(80000, 80000, 1, 1);
    wg.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(
      wg,
      new THREE.MeshStandardMaterial({ color: "#3f7f9f", roughness: 0.22, metalness: 0.1 }),
    );
    this.water.name = "water";
    this.water.receiveShadow = false;
    scene.add(this.water);
    this.apply();
  }

  setShadows(on: boolean) {
    this.shadows = on;
    this.apply();
  }

  setQuality(light: boolean) {
    this.dome.setQuality(light);
  }

  setFar(far: number) {
    // 空の箱は描画範囲の内側に収める（箱の角が遠方の切り取りを越えないように）
    this.sky.scale.setScalar(far * 1.1);
    // 雲の半球は地形より奥、遠方の切り取り（far × 1.3）より手前
    this.dome.mesh.scale.setScalar(far * 1.2);
    this.fogBaseFar = far;
    this.apply();
  }

  setHour(hour: number) {
    const h = ((hour % 24) + 24) % 24;
    if (h === this.hour) return;
    this.hour = h;
    this.apply();
  }

  /** 天候の目標。snap なら すぐに切り替える（場所を移した時、設定を変えた時） */
  setWeather(cloud: number, mist: number, snap = false) {
    this.targetCloud = cloud;
    this.targetMist = mist;
    if (snap) {
      this.cloud = cloud;
      this.mist = mist;
      this.apply();
    }
  }

  /** 世界の時刻 (Unix ミリ秒)。雲の模様を風で流すのに使う */
  setClock(ms: number) {
    const r = ms - Math.floor(ms / DOME_WIND_PERIOD) * DOME_WIND_PERIOD;
    this.dome.material.uniforms.uWind.value.set(-DOME_WIND_X * r, -DOME_WIND_Z * r);
  }

  /** 毎フレーム: 天候を目標へ近づける（およそ 20 秒で切り替わる） */
  step(dt: number) {
    const dc = this.targetCloud - this.cloud;
    const dm = this.targetMist - this.mist;
    if (Math.abs(dc) < 1e-4 && Math.abs(dm) < 1e-4) return;
    const k = 1 - Math.exp(-dt / 7);
    this.cloud += dc * k;
    this.mist += dm * k;
    this.apply();
  }

  /** 時刻と天候から、空・光・霞の色を決める */
  private apply() {
    const { dir, elevation: el } = sunDirection(this.hour);
    const day = smooth(el, -0.12, 0.25);
    const low = 1 - smooth(el, 0.05, 0.5);
    const night = 1 - smooth(el, -0.2, 0.02);
    const oc = smooth(this.cloud, 0.55, 0.95);
    const mist = this.mist;
    // 日差しを遮る量
    const dim = Math.max(oc, mist * 0.9);
    this.daylight = day;
    this.light = 0.22 + 0.78 * day * (1 - 0.3 * dim);

    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(dir);
    su.rayleigh.value = 1.4 * (1 - 0.5 * oc);
    su.turbidity.value = 4 + 8 * dim;

    // 日の光。日が沈んだら月の光（向きは太陽の反対側の上）
    const sunColor = this.sunColor.setRGB(1, 0.94 - 0.25 * low, 0.86 - 0.4 * low);
    if (el > -0.02) {
      this.sunDir.copy(dir);
      this.sun.intensity = 3.2 * smooth(el, -0.02, 0.3) * (1 - 0.88 * dim);
      this.sun.color.copy(sunColor);
    } else {
      this.sunDir.set(-dir.x, 0.75, -dir.z).normalize();
      this.sun.intensity = 0.8 * night * (1 - 0.7 * dim);
      this.sun.color.copy(C_MOON);
    }
    this.sun.castShadow = this.shadows && el > 0.02 && dim < 0.6;

    this.hemi.color.copy(C_HEMI_NIGHT).lerp(C_HEMI_DAY, day).lerp(C_HEMI_OVERCAST, dim * day);
    this.hemi.groundColor.copy(C_GROUND_NIGHT).lerp(C_GROUND_DAY, day);
    this.hemi.intensity = 0.45 + 0.85 * day + 1.3 * dim * day;

    // 霞の色と距離
    const fc = this.fog.color.copy(C_FOG_NIGHT).lerp(C_FOG_DAY, day).lerp(C_FOG_LOW, low * day * 0.7 * (1 - dim));
    fc.lerp(this.tmp.copy(C_FOG_OVERCAST).multiplyScalar(0.12 + 0.88 * day), oc * 0.85);
    fc.lerp(this.tmp.copy(C_FOG_MIST).multiplyScalar(0.1 + 0.9 * day), mist);
    this.scene.background = fc;
    const baseFar = this.fogBaseFar * (1 - 0.4 * oc);
    this.fog.far = Math.exp(lerp(Math.log(baseFar), Math.log(650), mist));
    this.fog.near = lerp(Math.min(1500, this.fogBaseFar * 0.08) * (1 - 0.5 * oc), 15, mist);

    // 雲と星
    const du = this.dome.material.uniforms;
    du.uCover.value = this.cloud;
    du.uVeil.value = smooth(mist, 0.25, 0.9);
    du.uNight.value = night;
    du.uSunDir.value.copy(dir);
    // 日が高い時の雲は白に寄せる（日の色のままだと茶色く見える）
    const lit = (du.uLit.value as THREE.Color).copy(C_CLOUD_NIGHT).lerp(this.tmp.copy(sunColor).lerp(C_WHITE, 0.7 * (1 - low)).multiplyScalar(1.3), day);
    lit.multiplyScalar(1 - 0.45 * oc);
    (du.uShade.value as THREE.Color)
      .copy(lit)
      .multiplyScalar(0.6)
      .lerp(this.tmp.copy(C_FOG_OVERCAST).lerp(C_HEMI_DAY, 0.6 * (1 - oc)).multiplyScalar(0.55 * (0.08 + 0.92 * day)), 0.5);
    (du.uFog.value as THREE.Color).copy(fc);
    // 霧の時は地平線のあたりを霞の色で埋める（霧に沈んだ遠くの山と空の境目を消す）
    du.uHorizon.value = Math.max(0.55 + 0.45 * oc, smooth(mist, 0.1, 0.6));
  }

  /** カメラ（描画座標）に合わせて空・光・海を動かす。worldX, worldZ はカメラの世界座標 */
  follow(cam: THREE.Vector3, worldX = cam.x, worldZ = cam.z) {
    this.sky.position.copy(cam);
    this.dome.mesh.position.copy(cam);
    // 雲の模様の位置は世界座標から（80km ごとに折り返して精度を保つ）
    this.dome.material.uniforms.uCamXZ.value.set(worldX % 80000, worldZ % 80000);
    this.target.position.set(cam.x, cam.y - 20, cam.z);
    this.sun.position.copy(this.target.position).addScaledVector(this.sunDir, 900);
    // 海は 1km 単位で動かして模様が動かないように
    this.water.position.set(Math.round(cam.x / 1024) * 1024, 0, Math.round(cam.z / 1024) * 1024);
  }
}

/**
 * 地表の材質: 頂点色（sRGB）× 細かい模様の明るさ。模様は遠くで消す。
 * 農地（頂点の field の重みが大きい所）は、区画と作物の色を材質の中で描く（render/farm/fields.ts）。
 */
export function terrainMaterial(detail: THREE.Texture, seed: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 field;\nvarying vec4 vField;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvField = field;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec4 vField;\n${fieldShader(fieldSeed(seed))}`)
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec4 texel = texture2D( map, vMapUv );
          float lum = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
          float fade = smoothstep( 120.0, 700.0, length( vViewPosition ) );
          diffuseColor.rgb *= mix( clamp( lum * 2.4, 0.55, 1.45 ), 1.0, fade );
        #endif`,
      )
      .replace(
        "#include <color_fragment>",
        `vec3 groundColor = pow( vColor.rgb, vec3( 2.2 ) );
        float farmW = smoothstep( 0.42, 0.58, vField.z );
        if ( farmW > 0.0 ) {
          // 農地の区画は作物の色、農地でない区画（平地の林）は林床の暗い緑
          if ( blockOpen( vField.xy ) > 0.5 ) groundColor = mix( groundColor, farmColor( vField.xy, vField.w, length( vViewPosition ) ), farmW );
          else groundColor = mix( groundColor, vec3( 0.045, 0.085, 0.03 ), farmW * 0.55 );
        }
        diffuseColor.rgb *= groundColor;`,
      );
  };
  m.customProgramCacheKey = () => `terrain-v5-${seed}`;
  return m;
}

export function loadTexture(loader: THREE.TextureLoader, name: string, color: boolean, anisotropy: number): THREE.Texture {
  const t = loader.load(`${import.meta.env.BASE_URL}assets/nature/${name}.jpg`);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}
