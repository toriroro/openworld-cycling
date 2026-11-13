// 色の表で塗る材質。形状の頂点は slot（色の表の番号）を持ち、色・粗さ・金属感は表から引く。
// 設定の色を変える時は表を書き換えるだけで、形状も材質も作り直さない。
// ジャージの柄とソックスの長さは、骨で動かす前の位置（rest）で塗り分ける（画素ごとなので境目が角張らない）。

import * as THREE from "three";
import type { JerseyPattern, Outfit } from "../../shared/outfit.ts";

/** 色の表の番号。ライダーの GLB（scripts/build-cyclist.py）と同じ番号を使う。 */
export const SLOT = {
  FRAME: 0,
  ACCENT: 1,
  CARBON: 2,
  ALLOY: 3,
  STEEL: 4,
  RUBBER: 5,
  TIRE_WALL: 6,
  RIM: 7,
  TAPE: 8,
  SADDLE: 9,
  CHAIN: 10,
  BOTTLE: 11,
  DISC: 12,
  DECAL: 13,
  SOCK: 14,
  ZIP: 15,
  SKIN: 16,
  HAIR: 17,
  JERSEY: 18,
  JERSEY_ACCENT: 19,
  BIB: 20,
  LEG: 21,
  SHOE: 22,
  SOLE: 23,
  GLOVE: 24,
  HELMET: 25,
  HELMET_INNER: 26,
  LENS: 27,
  GLASSES_FRAME: 28,
  STRAP: 29,
  BIB_TRIM: 30,
  SHOE_DIAL: 31,
} as const;
export const SLOT_COUNT = 32;

const PATTERN_ID: Record<JerseyPattern, number> = { plain: 0, band: 1, shoulder: 2, stripes: 3 };

/** 設定によらない部品の色・粗さ・金属感 */
const FIXED: Partial<Record<number, [string, number, number]>> = {
  [SLOT.CARBON]: ["#1b2024", 0.42, 0.15],
  [SLOT.ALLOY]: ["#b4bcc0", 0.3, 0.4],
  [SLOT.STEEL]: ["#8d9396", 0.36, 0.4],
  [SLOT.RUBBER]: ["#1a1c1d", 0.92, 0],
  [SLOT.CHAIN]: ["#5f6467", 0.45, 0.35],
  [SLOT.BOTTLE]: ["#d9dcd6", 0.45, 0],
  [SLOT.DISC]: ["#b9bec0", 0.28, 0.65],
  [SLOT.DECAL]: ["#f2f0ea", 0.4, 0],
  [SLOT.ZIP]: ["#2a2d30", 0.5, 0.3],
  [SLOT.SOLE]: ["#1d2023", 0.6, 0.1],
  [SLOT.GLOVE]: ["#1c2024", 0.8, 0],
  [SLOT.HELMET_INNER]: ["#1d2124", 0.85, 0],
  [SLOT.GLASSES_FRAME]: ["#202326", 0.35, 0.1],
  [SLOT.STRAP]: ["#25292c", 0.7, 0],
  [SLOT.BIB_TRIM]: ["#2a2e31", 0.7, 0],
  [SLOT.SHOE_DIAL]: ["#2a2e31", 0.4, 0.2],
};

export const TIRE_WALL_COLORS = { black: "#1f2123", tan: "#a07d4e" } as const;

export class PaletteMaterial extends THREE.MeshStandardMaterial {
  private readonly colors = Array.from({ length: SLOT_COUNT }, () => new THREE.Color("#888888"));
  private readonly rm = Array.from({ length: SLOT_COUNT }, () => new THREE.Vector2(0.7, 0));
  private readonly extra = {
    uPalette: { value: this.colors },
    uRM: { value: this.rm },
    uPattern: { value: 0 },
    uSockTop: { value: 0.3 },
    uHelmet: { value: 0 },
    uHeadCenter: { value: new THREE.Vector3(0, 1.7, 0) },
  };

  constructor() {
    super({ color: "#ffffff", roughness: 1, metalness: 1 });
    this.name = "cyclist-palette";
    for (const [slot, [hex, r, m]] of Object.entries(FIXED) as [string, [string, number, number]][]) this.set(Number(slot), hex, r, m);
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.extra);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float slot;\nvarying float vSlot;\nvarying vec3 vRest;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSlot = slot;\nvRest = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vSlot;
varying vec3 vRest;
uniform vec3 uPalette[${SLOT_COUNT}];
uniform vec2 uRM[${SLOT_COUNT}];
uniform int uPattern;
uniform float uSockTop;
uniform int uHelmet;
uniform vec3 uHeadCenter;
bool inBand(float x, float a, float b) { return x > a && x < b; }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
int ps = int(vSlot + 0.5);
if (ps == ${SLOT.JERSEY}) {
  // 柄（rest は身長 1.78m の人体、Y が上、+X が左、+Z が前）
  float ax = abs(vRest.x);
  bool accent = false;
  if (uPattern == 1) accent = vRest.y > 1.27 && vRest.y < 1.36 && ax < 0.24;
  else if (uPattern == 2) accent = vRest.y > 1.395 - ax * 0.25 || ax > 0.215;
  else if (uPattern == 3) accent = ax < 0.2 && vRest.y < 1.43 && mod(vRest.x + 0.03, 0.1) < 0.03;
  if (accent) ps = ${SLOT.JERSEY_ACCENT};
  if (ax < 0.0045 && vRest.z > 0.0 && vRest.y > 1.06) ps = ${SLOT.ZIP};
} else if (ps == ${SLOT.LEG}) {
  ps = vRest.y < uSockTop ? ${SLOT.SOCK} : ${SLOT.SKIN};
} else if (ps == ${SLOT.SKIN}) {
  // 頭の皮膚に髪の生え際を塗る（髪の殻の縁が角張って見えないように）
  vec3 h = vRest - uHeadCenter;
  float hx = abs(h.x);
  if (h.y > -0.1 && hx < 0.1 && h.z < 0.13) {
    float line = h.z > 0.06 ? 0.036 : h.z > -0.03 ? mix(-0.05, 0.036, (h.z + 0.03) / 0.09) : mix(-0.088, -0.05, clamp((h.z + 0.07) / 0.04, 0.0, 1.0));
    bool ear = hx > 0.064 && h.z > -0.032 && h.z < 0.034 && h.y < 0.004;
    bool burn = hx > 0.06 && h.z > 0.026 && h.z < 0.048 && h.y > -0.072;
    if ((h.y > line && !ear) || burn) ps = ${SLOT.HAIR};
  }
} else if (ps == ${SLOT.HELMET}) {
  // 通気孔（頭の中心からの位置。y が上、z が前）
  vec3 h = vRest - uHeadCenter;
  float hx = abs(h.x);
  bool vent = false;
  if (uHelmet == 0) {
    bool band = inBand(hx, 0.008, 0.022) || inBand(hx, 0.036, 0.052) || inBand(hx, 0.066, 0.079);
    vent = band && h.y > 0.03 + hx * 0.25 && h.z > -0.115 && h.z < 0.1 && mod(h.z + 0.5, 0.072) > 0.014;
  } else {
    vent = (h.z > 0.085 && inBand(h.y, 0.022, 0.05) && (inBand(hx, 0.012, 0.03) || inBand(hx, 0.042, 0.06)))
      || (h.z < -0.13 && inBand(h.y, -0.02, 0.012) && inBand(hx, 0.014, 0.045));
  }
  if (vent) ps = ${SLOT.HELMET_INNER};
}
diffuseColor.rgb *= uPalette[ps];
float paletteRough = uRM[ps].x;
float paletteMetal = uRM[ps].y;`,
        )
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = paletteRough;")
        .replace("#include <metalnessmap_fragment>", "float metalnessFactor = paletteMetal;");
    };
  }

  override customProgramCacheKey() {
    return "cyclist-palette-v1";
  }

  set(slot: number, hex: string, roughness?: number, metalness?: number) {
    this.colors[slot].set(hex);
    if (roughness !== undefined) this.rm[slot].x = roughness;
    if (metalness !== undefined) this.rm[slot].y = metalness;
  }

  /** 設定の色を表に書く。形の差し替え（フレーム形など）は形状の側で行う。 */
  apply(o: Outfit) {
    const b = o.bike;
    const r = o.rider;
    // 塗装はつや、クロモリは少し金属感
    const metalPaint = b.frame === "steel" ? 0.35 : 0.2;
    this.set(SLOT.FRAME, b.frameColor, 0.3, metalPaint);
    this.set(SLOT.ACCENT, b.accentColor, 0.32, metalPaint);
    this.set(SLOT.RIM, b.rimColor, b.wheels === "low" ? 0.32 : 0.4, b.wheels === "low" ? 0.45 : 0.15);
    this.set(SLOT.TIRE_WALL, TIRE_WALL_COLORS[b.tireWall], 0.85, 0);
    this.set(SLOT.TAPE, b.tapeColor, 0.75, 0);
    this.set(SLOT.SADDLE, b.saddleColor, 0.55, 0);
    this.set(SLOT.SKIN, r.skinColor, 0.62, 0);
    this.set(SLOT.HAIR, r.hairColor, 0.7, 0);
    this.set(SLOT.JERSEY, r.jerseyColor, 0.82, 0);
    this.set(SLOT.JERSEY_ACCENT, r.jerseyAccent, 0.82, 0);
    this.set(SLOT.BIB, r.bibColor, 0.88, 0);
    this.set(SLOT.SHOE, r.shoeColor, 0.45, 0);
    this.set(SLOT.SOCK, r.sockColor, 0.9, 0);
    this.set(SLOT.HELMET, r.helmetColor, 0.3, 0.05);
    this.set(SLOT.LENS, r.lensColor, 0.14, 0.3);
    this.extra.uPattern.value = PATTERN_ID[r.jerseyPattern];
    this.extra.uSockTop.value = r.sockLength === "long" ? 0.33 : 0.17;
    this.extra.uHelmet.value = r.helmet === "aero" ? 1 : 0;
  }

  /** ヘルメットの通気孔の基準（GLB の rig.json の helmetCenter、three.js の座標） */
  setHeadCenter(x: number, y: number, z: number) {
    this.extra.uHeadCenter.value.set(x, y, z);
  }
}
