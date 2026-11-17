// 出典の表示（北海道の草案 3.1・3.2）。OSM は名前と ODbL への案内、国土地理院は出典と加工したことを書く。
// 文言は事実だけ（CLAUDE.md）。リンクは platform 層を通して開く（概要仕様 9.5 #5）。

import { platform } from "../platform/index.ts";
import type { WorldChoice } from "../world-choice.ts";

/** 1 行の出典（項目ごとに押すと元のページを開く） */
export function creditLine(world: WorldChoice, cls: string): HTMLElement {
  const root = document.createElement("div");
  root.className = cls;
  world.attribution.forEach((a, i) => {
    if (i) root.append("・");
    const link = document.createElement("a");
    link.href = a.url;
    link.textContent = a.text;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      platform.openExternal(a.url);
    });
    root.appendChild(link);
  });
  return root;
}
