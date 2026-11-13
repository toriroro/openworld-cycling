// 自分の自転車とライダー。中身は src/render/cyclist/（形・色・姿勢）。sim の状態を読むだけ。

import { DEFAULT_OUTFIT, type Outfit } from "../shared/outfit.ts";
import { CyclistModel } from "./cyclist/cyclist.ts";
import type { Lod } from "./cyclist/road-bike.ts";

export class PlayerModel extends CyclistModel {
  constructor(outfit: Outfit = DEFAULT_OUTFIT, lod: Lod = "high") {
    super(outfit, lod);
    this.group.name = "player";
  }
}
