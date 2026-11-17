// 上り・下りが別の線の道路（中央分離帯のある道路）がどれだけあるかを数える（北海道の草案 4.2、6 章 #2）。
//   npx tsx scripts/hokkaido/oneway-report.ts
// 一方通行の幹線・一般道の各点について、40m 以内に「向きが逆で、同じ名前（または両方とも名前なし）の一方通行」があれば対になっているとみなす。

import { readFileSync } from "node:fs";
import type { HokkaidoMeta } from "../../src/shared/world/hokkaido.ts";

const meta = JSON.parse(readFileSync("public/data/hokkaido/h0/world.json", "utf8")) as HokkaidoMeta;
const all = new Float32Array(readFileSync("public/data/hokkaido/h0/roads.bin").buffer.slice(0));
const one = meta.roads.filter((r) => r.oneway && r.cls <= 1);
const pts: { r: number; x: number; z: number; tx: number; tz: number }[] = [];
const grid = new Map<string, number[]>();
one.forEach((r, ri) => {
  for (let i = 0; i < r.count; i += 5) {
    const k = r.offset + i * 3;
    const j = r.offset + Math.min(r.count - 1, i + 1) * 3;
    const h = r.offset + Math.max(0, Math.min(r.count - 1, i + 1) - 1) * 3;
    const tx = all[j] - all[h];
    const tz = all[j + 2] - all[h + 2];
    const l = Math.hypot(tx, tz) || 1;
    const p = { r: ri, x: all[k] + r.origin[0], z: all[k + 2] + r.origin[1], tx: tx / l, tz: tz / l };
    const key = `${Math.floor(p.x / 50)},${Math.floor(p.z / 50)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(pts.length);
    pts.push(p);
  }
});
let paired = 0;
const pairedByRoad = new Map<number, number>();
for (const p of pts) {
  const cx = Math.floor(p.x / 50);
  const cz = Math.floor(p.z / 50);
  let ok = false;
  for (let a = -1; a <= 1 && !ok; a++)
    for (let b = -1; b <= 1 && !ok; b++)
      for (const qi of grid.get(`${cx + a},${cz + b}`) ?? []) {
        const q = pts[qi];
        if (q.r === p.r || one[q.r].name !== one[p.r].name) continue;
        if (p.tx * q.tx + p.tz * q.tz > -0.85) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d > 4 && d < 40) {
          ok = true;
          break;
        }
      }
  if (ok) {
    paired++;
    pairedByRoad.set(p.r, (pairedByRoad.get(p.r) ?? 0) + 1);
  }
}
const kmAll = one.reduce((a, r) => a + r.length, 0) / 1000;
const share = paired / pts.length;
console.log(`一方通行の幹線・一般道 ${one.length} 本 ${kmAll.toFixed(1)}km。そのうち逆向きの相手が 40m 以内にある点 ${(share * 100).toFixed(1)}%（約 ${(kmAll * share).toFixed(1)}km）`);
const names = new Map<string, number>();
for (const [ri, c] of pairedByRoad) names.set(one[ri].name || "(名前なし)", (names.get(one[ri].name || "(名前なし)") ?? 0) + c * 0.01);
console.log([...names].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, km]) => `${n} ${km.toFixed(1)}km`).join("、"));
