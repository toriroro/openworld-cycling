// 計測の表示（?perf=1 の時だけ。北海道の草案 29 章）。スマホの実機でフレーム時間と描画量を読むため。
// 直近 10 秒のフレーム間隔（中央・95%・最大）、1 フレームの三角形と描画命令、画質、描画の画素数、JS のメモリ（取れる端末だけ）。

import * as THREE from "three";
import type { Game } from "../game.ts";
import type { WorldView } from "../render/world-view.ts";

export function startPerfOverlay(view: WorldView, game: Game) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:8px;top:96px;z-index:50;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none";
  document.body.appendChild(el);
  const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const buf = new THREE.Vector2();
  const man = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n));
  setInterval(() => {
    // 直近 10 秒のフレーム間隔
    const all = game.frameDt;
    const recent: number[] = [];
    let sum = 0;
    for (let i = all.length - 1; i >= 0 && sum < 10000; i--) {
      recent.push(all[i]);
      sum += all[i];
    }
    recent.sort((a, b) => a - b);
    const s = view.stats();
    const size = view.renderer.getDrawingBufferSize(buf);
    const lines = [
      recent.length ? `フレーム 中央 ${pct(recent, 0.5).toFixed(1)}ms・95% ${pct(recent, 0.95).toFixed(1)}ms・最大 ${recent[recent.length - 1].toFixed(0)}ms` : "フレーム -",
      `三角形 ${man(s.triangles)}・描画命令 ${s.calls}`,
      `画質 ${s.quality === "light" ? "軽量" : "標準"}・描画 ${size.x}×${size.y}`,
    ];
    if (s.heapMB !== null) lines.push(`メモリ ${s.heapMB.toFixed(0)}MB`);
    el.textContent = lines.join("\n");
  }, 1000);
}
