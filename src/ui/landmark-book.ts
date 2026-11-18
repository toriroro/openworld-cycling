// 名所帳（名所の草案 docs/history/specs/2026-11-18-landmarks-draft.md）: 名所の一覧。今いる所からの直線距離と方角、
// 行ったかどうか。名所を選ぶと行き先にする。行った名所からは走り始められる。文言は操作・状態・事実情報だけ。

import type { Stamp } from "../shared/save.ts";
import type { LandmarkData } from "../shared/world/landmarks.ts";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = "", parent?: HTMLElement) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};

const DIRS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/** (dx, dz) の方角（x = 東、z = 南） */
export function compass(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz);
  const i = Math.round((a / (Math.PI * 2)) * 8 + 8) % 8;
  return DIRS[i];
}

export interface LandmarkRow {
  lm: LandmarkData;
  /** 今いる所からの直線距離 (m) */
  distance: number;
  dir: string;
  stamp: Stamp | null;
  /** 今の行き先 */
  goal: boolean;
}

export class LandmarkBook {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private list: HTMLElement;
  onGoal: (lm: LandmarkData) => void = () => {};
  onStart: (st: Stamp) => void = () => {};

  constructor() {
    this.root = h("div", "stamp-book landmark-book hidden");
    document.body.appendChild(this.root);
    const head = h("div", "stamp-head", "", this.root);
    this.title = h("div", "stamp-title", "名所帳", head);
    const close = h("button", "btn", "閉じる", head);
    close.type = "button";
    close.addEventListener("click", () => this.close());
    this.list = h("div", "stamp-list", "", this.root);
  }

  get isOpen() {
    return !this.root.classList.contains("hidden");
  }

  open(rows: LandmarkRow[]) {
    const done = rows.filter((r) => r.stamp).length;
    this.title.textContent = `名所帳  ${done} / ${rows.length}`;
    this.list.replaceChildren();
    for (const r of [...rows].sort((a, b) => a.distance - b.distance)) {
      const item = h("div", `stamp-item${r.stamp ? " visited" : ""}${r.goal ? " goal" : ""}`, "", this.list);
      const text = h("div", "stamp-text", "", item);
      h("div", "stamp-name", r.lm.name, text);
      const km = r.distance < 950 ? `${Math.round(r.distance / 10) * 10} m` : `${(r.distance / 1000).toFixed(1)} km`;
      h("div", "stamp-meta", `${r.dir} ${km}  ${r.stamp ? `行った日 ${r.stamp.date}  ${r.stamp.visits} 回` : "まだ行っていない"}${r.goal ? "  行き先" : ""}`, text);
      const btns = h("div", "landmark-btns", "", item);
      const go = h("button", "btn", r.goal ? "行き先" : "行き先にする", btns);
      go.type = "button";
      go.disabled = r.goal;
      go.addEventListener("click", () => {
        this.close();
        this.onGoal(r.lm);
      });
      if (r.stamp) {
        const st = r.stamp;
        const from = h("button", "btn", "ここから走る", btns);
        from.type = "button";
        from.addEventListener("click", () => {
          this.close();
          this.onStart(st);
        });
      }
    }
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }
}
