// ゲーム内の世界地図（モック仕様 7.4）。M1 の 2D 地図に、走った道・現在地・行き先・立ち寄った店を重ねる。
// 地図を押すと行き先を指定する。「ワープ」を押してから地図を押すと、押した所の近くの走る道へ移る。開いている間だけ地図用の Worker を動かす。

import type { WorldChoice } from "../world-choice.ts";
import { creditLine } from "./credit.ts";
import { type GameMapLayer, WorldMap } from "./world-map.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

export class MapOverlay {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private info: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private warpBtn: HTMLButtonElement;
  /** 次に地図を押した所へワープする（地図を閉じると戻る） */
  warping = false;
  map: WorldMap | null = null;
  onClose: () => void = () => {};
  onClearGoal: () => void = () => {};

  constructor(
    private seed: number,
    private world?: WorldChoice,
  ) {
    this.root = h("div", "map-overlay hidden");
    document.body.appendChild(this.root);
    this.canvas = h("canvas", "map-canvas", "", this.root);
    // 出典（北海道の世界。地図を出している間は見える所に置く。北海道の草案 3.1・3.2）
    if (world?.attribution.length) this.root.appendChild(creditLine(world, "map-credit"));
    const bar = h("div", "map-bar", "", this.root);
    this.info = h("div", "map-info", "", bar);
    this.clearBtn = h("button", "btn", "行き先を消す", bar);
    this.clearBtn.type = "button";
    this.clearBtn.addEventListener("click", () => this.onClearGoal());
    this.warpBtn = h("button", "btn", "ワープ", bar);
    this.warpBtn.type = "button";
    this.warpBtn.setAttribute("aria-pressed", "false");
    this.warpBtn.addEventListener("click", () => this.setWarping(!this.warping));
    const zin = h("button", "btn", "＋", bar);
    zin.type = "button";
    zin.setAttribute("aria-label", "拡大");
    zin.addEventListener("click", () => this.zoom(0.5));
    const zout = h("button", "btn", "－", bar);
    zout.type = "button";
    zout.setAttribute("aria-label", "縮小");
    zout.addEventListener("click", () => this.zoom(2));
    const close = h("button", "btn", "閉じる", bar);
    close.type = "button";
    close.addEventListener("click", () => this.close());
  }

  get isOpen() {
    return this.map !== null;
  }

  open(x: number, z: number, layer: GameMapLayer) {
    if (this.map) return;
    this.root.classList.remove("hidden");
    this.map = new WorldMap(this.canvas, { seed: this.seed, world: this.world?.id === "hokkaido" ? "hokkaido" : undefined, x, z, mpp: 10, game: layer });
  }

  close() {
    if (!this.map) return;
    this.map.destroy();
    this.map = null;
    this.setWarping(false);
    this.root.classList.add("hidden");
    this.onClose();
  }

  private zoom(f: number) {
    const m = this.map;
    if (m) m.setView(m.cx, m.cz, m.mpp * f);
  }

  setWarping(on: boolean) {
    this.warping = on;
    this.warpBtn.classList.toggle("active", on);
    this.warpBtn.setAttribute("aria-pressed", String(on));
  }

  /** 行き先までの直線距離と、行き先があるか（ワープの間はワープの操作を出す） */
  setInfo(text: string, hasGoal: boolean, note = "") {
    if (note) text = note;
    else if (this.warping) text = "地図を押すと、その近くの走る道へワープ";
    if (this.info.textContent !== text) this.info.textContent = text;
    this.clearBtn.disabled = !hasGoal;
  }
}
