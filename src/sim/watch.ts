// 眺める乗り方の進路（モック仕様 7.2）: 道なり / 未走行の道を優先。描画に依存しない。

import type { RiddenLog } from "./ridden.ts";
import type { RoadNetwork } from "./road-network.ts";
import type { Upcoming } from "./ride.ts";

export type WatchRoute = "follow" | "unridden";

/** 先の何 m までの走った割合で比べるか */
const LOOK = 400;

/**
 * 候補のうちどれへ進むか。follow は既定（いちばん直進に近い道）、
 * unridden は腕の先 400m のうち走っていない区間がいちばん長い候補（同じなら既定、次に直進に近い方）。
 */
export function watchChoice(u: Upcoming, route: WatchRoute, ridden: RiddenLog, net: RoadNetwork, budget: number | null = null): number {
  if (u.choices.length < 2) return u.defaultIndex;
  // 冒険の距離がほとんど無い時（冒険の草案 2.1）: 走った道を選ぶ（走った区間がいちばん長い候補）
  if (budget !== null && budget < LOOK) return pickRidden(u, ridden, net);
  if (route === "follow") return u.defaultIndex;
  let best = u.defaultIndex;
  let bestScore = -Infinity;
  u.choices.forEach((c, i) => {
    const r = net.roads.get(c.arm.road);
    if (!r) return;
    let fresh = 0;
    let n = 0;
    for (let d = 10; d <= LOOK; d += 10) {
      const s = c.arm.s + c.arm.dir * d;
      if (s < 0 || s > r.length) break;
      n++;
      if (!ridden.has(r.id, s)) fresh++;
    }
    // 行き止まりに近い短い道は少し避ける
    const short = c.distance < 200 && !net.nodes.has(c.arm.dir > 0 ? r.end : r.start) ? 5 : 0;
    const score = fresh - short + (i === u.defaultIndex ? 0.5 : 0) - Math.abs(c.angle) * 0.1 + (n === 0 ? -10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** 腕の先 LOOK m のうち走った区間がいちばん長い候補（同じなら既定、次に直進に近い方） */
function pickRidden(u: Upcoming, ridden: RiddenLog, net: RoadNetwork): number {
  let best = u.defaultIndex;
  let bestScore = -Infinity;
  u.choices.forEach((c, i) => {
    const r = net.roads.get(c.arm.road);
    if (!r) return;
    let known = 0;
    for (let d = 10; d <= LOOK; d += 10) {
      const s = c.arm.s + c.arm.dir * d;
      if (s < 0 || s > r.length) break;
      if (ridden.has(r.id, s)) known++;
      else break;
    }
    const score = known + (i === u.defaultIndex ? 0.5 : 0) - Math.abs(c.angle) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
