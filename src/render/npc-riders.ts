// 近くの NPC の配達員を、プレイヤーと同じ人の形・自転車で描く（配達の草案 30 章）。
// 交通の箱の形（vehicle-shapes.ts の courier）はプレイヤーの形の横で浮いて見えたので、近い数人だけ置き換える。遠くは箱の形のまま。
// sim/traffic の状態を読むだけ。

import * as THREE from "three";
import { DEFAULT_OUTFIT, type Outfit } from "../shared/outfit.ts";
import type { Traffic, Vehicle } from "../sim/traffic/traffic.ts";
import { CyclistModel } from "./cyclist/cyclist.ts";

/** 置き換える人数と距離 (m)【初期値】 */
const SLOTS = 4;
const RANGE = 70;

const FRAMES = ["#2a2d30", "#8e9497", "#e9e7e0", "#2b4f8e", "#16191c"];
const SKINS = ["#b07850", "#c99a74", "#8d5a3a", "#d8b08c"];
const HELMETS = ["#e9e7e0", "#16191c", "#8e9497"];

function outfitFor(v: Vehicle): Outfit {
  const k = v.id;
  return {
    ...DEFAULT_OUTFIT,
    bike: { ...DEFAULT_OUTFIT.bike, frame: k % 3 === 0 ? "steel" : "climb", frameColor: FRAMES[k % FRAMES.length], accentColor: "#16191c", tireWall: "black", wheels: "low" },
    rider: {
      ...DEFAULT_OUTFIT.rider,
      jerseyPattern: "plain",
      jerseyColor: v.color,
      jerseyAccent: "#16191c",
      bibColor: "#1c1d20",
      helmetColor: HELMETS[(k >>> 2) % HELMETS.length],
      skinColor: SKINS[(k >>> 1) % SKINS.length],
      sockLength: "short",
      sockColor: "#1c1d20",
      shoeColor: "#2a2d30",
    },
  } as Outfit;
}

interface Slot {
  model: CyclistModel;
  id: number | null;
  distance: number;
}

export class NpcRiderView {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  /** 人の形で描いている配達員（交通の描画で箱の形を隠す） */
  readonly drawn = new Set<number>();

  constructor() {
    this.group.name = "npc-riders";
  }

  /** 描く。enabled でなければ全部隠す。cx, cz は自転車（プレイヤー）の位置 */
  update(traffic: Traffic, originX: number, originZ: number, cx: number, cz: number, dt: number, enabled: boolean) {
    this.drawn.clear();
    const near = enabled
      ? traffic.vehicles
          .filter((v) => v.type === "courier" && Math.abs(v.x - cx) < RANGE && Math.abs(v.z - cz) < RANGE)
          .map((v) => ({ v, d: Math.hypot(v.x - cx, v.z - cz) }))
          .filter((x) => x.d < RANGE)
          .sort((a, b) => a.d - b.d)
          .slice(0, SLOTS)
          .map((x) => x.v)
      : [];
    if (near.length && !this.slots.length) {
      // 人の形は使う時に作る（形の読み込みがあるので、配達の範囲に入るまで作らない）
      for (let i = 0; i < SLOTS; i++) {
        const model = new CyclistModel(DEFAULT_OUTFIT, "low");
        model.group.visible = false;
        this.group.add(model.group);
        this.slots.push({ model, id: null, distance: 0 });
      }
    }
    const want = new Set(near.map((v) => v.id));
    // 続けて描いている人は同じ形のまま（向きの追いかけが途切れないように）
    for (const s of this.slots) if (s.id !== null && !want.has(s.id)) s.id = null;
    for (const v of near) {
      let s = this.slots.find((x) => x.id === v.id);
      if (!s) {
        s = this.slots.find((x) => x.id === null);
        if (!s) continue;
        s.id = v.id;
        s.distance = 0;
        s.model.setOutfit(outfitFor(v));
        s.model.setCargo({ bag: v.color, rack: false });
      }
      s.distance += v.speed * dt;
      s.model.group.visible = true;
      s.model.update(dt, v.x - originX, v.y + 0.02, v.z - originZ, v.dx, v.dz, v.grade, v.speed, v.speed > 0.5 ? 140 : 0, s.distance, false);
      this.drawn.add(v.id);
    }
    for (const s of this.slots) if (s.id === null) s.model.group.visible = false;
  }
}
