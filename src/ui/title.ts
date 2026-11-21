// 起動画面と操作の説明。文言は操作・状態・事実情報だけ（CLAUDE.md）。
// 起動画面: 続きから（保存があれば）・はじめから（記録を消す時は 2 回押す）・眺める。保存の事実（総距離・スタンプ・最後に走った日）を出す。

import type { SaveData } from "../shared/save.ts";
import { WORLD_LABELS, type WorldChoice, type WorldId } from "../world-choice.ts";
import { creditLine } from "./credit.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

const btn = (label: string, parent: HTMLElement, cls = "") => {
  const b = h("button", `btn ${cls}`.trim(), label, parent);
  b.type = "button";
  return b;
};

export type TitleChoice = "continue" | "new" | "new-adventure" | "watch";

export class TitleScreen {
  readonly root: HTMLElement;
  private info: HTMLElement;
  private buttons: HTMLElement;
  onChoose: (c: TitleChoice) => void = () => {};
  onHelp: () => void = () => {};
  /** 世界を選び直した（読み込み直しが要る） */
  onWorld: (id: WorldId) => void = () => {};

  constructor(world?: WorldChoice) {
    this.root = h("div", "title-screen hidden");
    document.body.appendChild(this.root);
    const panel = h("div", "title-panel", "", this.root);
    h("h1", "title-name", "openworld-cycling", panel);
    // 世界の選択（北海道の草案 2.1）。保存は世界ごとに分かれる
    const current = world?.id ?? "generated";
    const ws = h("div", "title-world", "", panel);
    for (const id of ["generated", "hokkaido"] as WorldId[]) {
      const b = btn(WORLD_LABELS[id], ws, id === current ? "current" : "");
      b.setAttribute("aria-pressed", String(id === current));
      if (id !== current) b.addEventListener("click", () => this.onWorld(id));
    }
    this.info = h("div", "title-info", "", panel);
    this.buttons = h("div", "title-buttons", "", panel);
    if (world?.attribution.length) panel.appendChild(creditLine(world, "title-credit"));
  }

  get visible() {
    return !this.root.classList.contains("hidden");
  }

  show(save: SaveData | null) {
    this.buttons.replaceChildren();
    this.info.replaceChildren();
    const hasProgress = !!save && (save.odometer > 0 || save.stamps.length > 0);
    if (save && hasProgress) {
      const row = (k: string, v: string) => {
        const r = h("div", "title-row", "", this.info);
        h("span", "title-key", k, r);
        h("span", "title-val", v, r);
      };
      row("総距離", `${(save.odometer / 1000).toFixed(1)} km`);
      row("獲得標高", `${Math.round(save.climb)} m`);
      row("スタンプ", `${save.stamps.length} 個`);
      if (save.adventure?.mode === "adventure") row("冒険の残り", `${(save.adventure.balance / 1000).toFixed(1)} km`);
      if (save.savedAt) row("最後に走った日", new Date(save.savedAt).toLocaleDateString("sv-SE"));
      btn("続きから", this.buttons, "primary").addEventListener("click", () => this.choose("continue"));
    }
    // はじめから: 押すと「自由」と「冒険」を選ぶ（冒険の草案 2 章）。記録がある時は、選ぶ方のボタンが記録を消す
    const fresh = btn("はじめから", this.buttons, hasProgress ? "" : "primary");
    fresh.addEventListener("click", () => {
      const pre = hasProgress ? "記録を消して" : "";
      const cls = hasProgress ? "danger" : "";
      const free = btn(`${pre}自由ではじめる（全部の道を走れる）`, this.buttons, cls);
      const adv = btn(`${pre}冒険ではじめる（運動の記録で広がる）`, this.buttons, cls);
      free.addEventListener("click", () => this.choose("new"));
      adv.addEventListener("click", () => this.choose("new-adventure"));
      fresh.replaceWith(free);
      free.after(adv);
    });
    btn("眺める", this.buttons).addEventListener("click", () => this.choose("watch"));
    btn("操作", this.buttons).addEventListener("click", () => this.onHelp());
    this.root.classList.remove("hidden");
  }

  private choose(c: TitleChoice) {
    this.root.classList.add("hidden");
    this.onChoose(c);
  }
}

/** 操作の説明（キーボードとタッチ） */
export class ControlsHelp {
  readonly root: HTMLElement;

  constructor() {
    this.root = h("div", "help-panel hidden");
    document.body.appendChild(this.root);
    const head = h("div", "help-head", "", this.root);
    h("div", "help-title", "操作", head);
    btn("閉じる", head).addEventListener("click", () => this.close());
    const table = h("dl", "help-table", "", this.root);
    const rows: [string, string][] = [
      ["漕ぐ", "Space を押している間 ／ タッチ: 右下の「漕ぐ」"],
      ["ブレーキ", "Shift ／ タッチ: 右下の「ブレーキ」"],
      ["分岐を選ぶ", "← ↑ → ／ 上に出る候補を押す"],
      ["U ターン（止まっている時）", "↓ ／ 右上の「Uターン」"],
      ["左右に寄る", "A・D ／ タッチ: 左下の「左へ」「右へ」"],
      ["後ろを見る", "Q（左）・R（右）"],
      ["視点を変える", "C ／ メニューの「視点」"],
      ["視点を回す", "画面をドラッグ（離して 3 秒で戻る）"],
      ["眺める（自動で走る）", "V ／ メニューの「眺める」"],
      ["地図", "M ／ 右下の小地図を押す。地図を押すと行き先"],
      ["一時停止", "P ／ メニューの「一時停止」"],
      ["喫茶店に寄る", "店の前で止まる"],
    ];
    for (const [k, v] of rows) {
      h("dt", "", k, table);
      h("dd", "", v, table);
    }
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open() {
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }
}
