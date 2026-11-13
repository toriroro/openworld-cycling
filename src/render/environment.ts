// 空と時刻（モック仕様 5.5）。太陽の位置で空・光・霞の色を変える。海は y=0 の面。影は標準画質のみ。

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

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

export class Environment {
  readonly sky: Sky;
  readonly sun = new THREE.DirectionalLight("#ffffff", 3);
  readonly hemi = new THREE.HemisphereLight("#bcd4ee", "#5b5a44", 1.1);
  readonly water: THREE.Mesh;
  readonly fog: THREE.Fog;
  hour = 14.5;
  private shadows = true;
  private target = new THREE.Object3D();

  constructor(private scene: THREE.Scene) {
    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    scene.add(this.sky);
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
      new THREE.MeshStandardMaterial({ color: "#2b5d7c", roughness: 0.12, metalness: 0.05, envMapIntensity: 0.6 }),
    );
    this.water.name = "water";
    this.water.receiveShadow = false;
    scene.add(this.water);
    this.setHour(this.hour);
  }

  setShadows(on: boolean) {
    this.shadows = on;
    this.sun.castShadow = on;
  }

  setFar(far: number) {
    // 空の箱は描画範囲の内側に収める（箱の角が遠方の切り取りを越えないように）
    this.sky.scale.setScalar(far * 1.1);
    this.fog.far = far;
    this.fog.near = Math.min(1500, far * 0.08);
  }

  setHour(hour: number) {
    this.hour = ((hour % 24) + 24) % 24;
    const { dir, elevation } = sunDirection(this.hour);
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.25);
    const low = 1 - THREE.MathUtils.smoothstep(elevation, 0.05, 0.5);
    this.sun.intensity = 3.2 * THREE.MathUtils.smoothstep(elevation, -0.02, 0.3);
    this.sun.color.setRGB(1, 0.94 - 0.25 * low, 0.86 - 0.4 * low);
    this.hemi.intensity = 0.25 + 1.0 * day;
    this.fog.color.copy(C_FOG_NIGHT).lerp(C_FOG_DAY, day).lerp(C_FOG_LOW, low * day * 0.7);
    this.scene.background = this.fog.color;
    this.sun.castShadow = this.shadows && elevation > 0.02;
    this.sunDir.copy(dir);
  }

  private sunDir = new THREE.Vector3(0, 1, 0);

  /** カメラ（描画座標）に合わせて空・光・海を動かす */
  follow(cam: THREE.Vector3) {
    this.sky.position.copy(cam);
    this.target.position.set(cam.x, cam.y - 20, cam.z);
    this.sun.position.copy(this.target.position).addScaledVector(this.sunDir, 900);
    // 海は 1km 単位で動かして模様が動かないように
    this.water.position.set(Math.round(cam.x / 1024) * 1024, 0, Math.round(cam.z / 1024) * 1024);
  }
}

/** 地表の材質: 頂点色（sRGB）× 細かい模様の明るさ。模様は遠くで消す */
export function terrainMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec4 texel = texture2D( map, vMapUv );
          float lum = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
          float fade = smoothstep( 120.0, 700.0, length( vViewPosition ) );
          diffuseColor.rgb *= mix( clamp( lum * 2.4, 0.55, 1.45 ), 1.0, fade );
        #endif`,
      )
      .replace("#include <color_fragment>", "diffuseColor.rgb *= pow( vColor.rgb, vec3( 2.2 ) );");
  };
  m.customProgramCacheKey = () => "terrain-v1";
  return m;
}

export function loadTexture(loader: THREE.TextureLoader, name: string, color: boolean, anisotropy: number): THREE.Texture {
  const t = loader.load(`${import.meta.env.BASE_URL}assets/nature/${name}.jpg`);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}
