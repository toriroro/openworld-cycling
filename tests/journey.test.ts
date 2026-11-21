// 閉じている間の旅（冒険の草案 4.2）: 描画なしで進める計算。開いている間に眺めて走った場合と同じ道を通るか、尽きたら終わるか、待つか。

import { describe, expect, it } from "vitest";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";
import type { Poi } from "../src/shared/world/types.ts";
import { AdventureLedger } from "../src/sim/adventure.ts";
import { DT } from "../src/sim/bicycle.ts";
import { JOURNEY_DT, JourneySim } from "../src/sim/journey.ts";
import { AutoPower } from "../src/sim/power.ts";
import { RiddenLog } from "../src/sim/ridden.ts";
import { Ride } from "../src/sim/ride.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { watchChoice } from "../src/sim/watch.ts";

const r = 14000;
const w = new World(WORLD_SEED);
const reg = w.region({ x0: ORIGIN.x - r, z0: ORIGIN.z - r, x1: ORIGIN.x + r, z1: ORIGIN.z + r });
const net = new RoadNetwork();
for (const road of reg.roads) net.addRoad(road);
for (const j of reg.junctions) net.addJunction(j);
for (const n of reg.nodes) net.nodes.set(n.id, n);
const pois: Poi[] = reg.pois;
const start = [...net.roads.values()].filter((x) => x.cls === 0 && x.start === ORIGIN.node).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? [...net.roads.values()].find((x) => x.cls === 0)!;

function setup(balance: number) {
  const ledger = new AdventureLedger(0);
  ledger.balance = balance;
  const ridden = new RiddenLog();
  const ride = new Ride(net, { road: start.id, s: 5, dir: 1 }, new AutoPower(180));
  ride.ridden = ridden;
  ride.adventure = ledger;
  return { ledger, ridden, ride };
}

/** 通った道路の列（続けて同じ物は 1 つ） */
const trail = (list: string[], id: string) => {
  if (list[list.length - 1] !== id) list.push(id);
};

describe("閉じている間の旅", () => {
  it("20 分ぶん進め、町・道筋・最高地点を残す。新しく走った分だけ冒険の距離が減る", () => {
    const { ledger, ride, ridden } = setup(20000);
    const sim = new JourneySim(ride, { net, ridden, ledger, route: "unridden", ensure: () => true, pois: () => pois }, 20 * 60, 0);
    let status = "running";
    const t0 = performance.now();
    while (status === "running") status = sim.run(5000);
    const ms = performance.now() - t0;
    expect(status).toBe("done");
    const log = sim.log;
    expect(log.seconds).toBeCloseTo(1200, 0);
    expect(log.distance).toBeGreaterThan(5000);
    expect(log.explored).toBeGreaterThan(log.distance * 0.8);
    expect(log.explored).toBeLessThanOrEqual(log.distance + 20);
    expect(ledger.balance).toBeCloseTo(20000 - log.explored, 6);
    expect(log.path.length).toBeGreaterThan(40);
    expect(log.towns.length).toBeGreaterThan(0);
    expect(Number.isFinite(log.maxElevation)).toBe(true);
    // 20 分を数秒以内で（1 時間で 3.6 万歩）
    expect(ms).toBeLessThan(5000);
  });

  it("開いている間に眺めて走った場合と同じ道を通る（1 歩の長さが違っても。1 時間）", () => {
    const a = setup(1e9);
    const sim = new JourneySim(a.ride, { net, ridden: a.ridden, ledger: a.ledger, route: "unridden", ensure: () => true, pois: () => [] }, 60 * 60, 0);
    const simTrail: string[] = [];
    while (!sim.done) {
      sim.run(1);
      trail(simTrail, a.ride.pos.road);
    }
    // 開いている間: 1/120 秒で、Game.updateWatching と同じ選び方
    const b = setup(1e9);
    const liveTrail: string[] = [];
    for (let t = 0; t < 60 * 60; t += DT) {
      const u = b.ride.upcoming;
      if (u && u.selected === null && !b.ride.plan) {
        const k = watchChoice(u, "unridden", b.ridden, net, b.ledger.balance);
        if (k !== u.defaultIndex) b.ride.choose(k);
      }
      b.ride.step(DT);
      trail(liveTrail, b.ride.pos.road);
    }
    const n = Math.min(simTrail.length, liveTrail.length) - 1;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(simTrail.slice(0, n)).toEqual(liveTrail.slice(0, n));
    expect(Math.abs(a.ride.odometer - b.ride.odometer) / b.ride.odometer).toBeLessThan(0.02);
    expect(JOURNEY_DT).toBeGreaterThan(DT);
  });

  it("冒険の距離が尽きたら終わる", () => {
    const { ledger, ride, ridden } = setup(800);
    const sim = new JourneySim(ride, { net, ridden, ledger, route: "unridden", ensure: () => true, pois: () => pois }, 3600, 0);
    let status = "running";
    while (status === "running") status = sim.run(5000);
    expect(sim.log.exhausted).toBe(true);
    expect(sim.elapsed).toBeLessThan(600);
    expect(sim.log.explored).toBeGreaterThan(790);
    expect(ledger.balance).toBeLessThan(10);
  });

  it("道路が読み込まれていなければ待つ（時間は進まない）", () => {
    const { ledger, ride, ridden } = setup(5000);
    let ready = false;
    const sim = new JourneySim(ride, { net, ridden, ledger, route: "unridden", ensure: () => ready, pois: () => [] }, 60, 0);
    expect(sim.run(100)).toBe("waiting");
    expect(sim.elapsed).toBe(0);
    ready = true;
    expect(sim.run(100)).toBe("running");
    expect(sim.elapsed).toBeCloseTo(10, 6);
  });

  it("前を通った喫茶店を残す", () => {
    // 起点の近くの喫茶店がある道路から、その手前を走る
    const cafe = pois.find((p) => p.kind === "cafe" && net.roads.get(p.road)!.length > p.s + 50 && p.s > 60)!;
    expect(cafe).toBeTruthy();
    const ledger = new AdventureLedger(0);
    ledger.balance = 1e6;
    const ridden = new RiddenLog();
    const ride = new Ride(net, { road: cafe.road, s: cafe.s - 50, dir: 1 }, new AutoPower(180));
    ride.ridden = ridden;
    const sim = new JourneySim(ride, { net, ridden, ledger, route: "follow", ensure: () => true, pois: () => pois }, 30, 0);
    while (!sim.done) sim.run(1000);
    expect(sim.log.cafes.map((c) => c.id)).toContain(cafe.id);
  });
});
