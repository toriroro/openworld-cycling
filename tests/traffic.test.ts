import { describe, expect, it } from "vitest";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";
import { DT } from "../src/sim/bicycle.ts";
import { AutoPower } from "../src/sim/power.ts";
import { Ride } from "../src/sim/ride.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { busStopsOn } from "../src/sim/traffic/bus-stops.ts";
import { type Rider, Traffic } from "../src/sim/traffic/traffic.ts";
import { hourFactor } from "../src/sim/traffic/vehicle-types.ts";

function network(r = 9000) {
  const w = new World(WORLD_SEED);
  const reg = w.region({ x0: ORIGIN.x - r, z0: ORIGIN.z - r, x1: ORIGIN.x + r, z1: ORIGIN.z + r });
  const net = new RoadNetwork();
  for (const road of reg.roads) net.addRoad(road);
  for (const j of reg.junctions) net.addJunction(j);
  for (const n of reg.nodes) net.nodes.set(n.id, n);
  return net;
}

function riderOf(ride: Ride): Rider {
  const p = ride.pose();
  return { x: p.x, z: p.z, dx: p.dx, dz: p.dz, speed: ride.speed, pos: { ...ride.pos }, offset: ride.offset };
}

describe("交通（都市と交通の草案 6 章）", () => {
  const net = network();
  const startRoad = [...net.roads.values()].filter((r) => r.cls === 0).sort((a, b) => (a.id < b.id ? -1 : 1))[0];

  it("自転車の周りに車が出て、道路の上を動き続ける。自転車と重なる回数は少ない", () => {
    const ride = new Ride(net, { road: startRoad.id, s: 5, dir: 1 }, new AutoPower(150));
    const traffic = new Traffic(net, 7);
    traffic.hour = 12;
    const moved = new Map<number, number>();
    let maxCount = 0;
    let frames = 0;
    // 20 分（描画 1 フレーム = 1/30 秒、走行は 120Hz）
    for (let f = 0; f < 30 * 60 * 20; f++) {
      for (let k = 0; k < 4; k++) ride.step(DT);
      const r = riderOf(ride);
      traffic.update(1 / 30, r.x, r.z, r);
      maxCount = Math.max(maxCount, traffic.vehicles.length);
      for (const v of traffic.vehicles) {
        expect(Number.isFinite(v.x + v.z + v.y + v.speed + v.offset)).toBe(true);
        moved.set(v.id, (moved.get(v.id) ?? 0) + v.speed / 30);
        // 道路の幅の外へ出ない
        const road = net.roads.get(v.pos.road)!;
        if (!v.turn) expect(Math.abs(v.offset)).toBeLessThanOrEqual(road.width / 2);
      }
      frames++;
    }
    expect(maxCount).toBeGreaterThan(3);
    expect(maxCount).toBeLessThanOrEqual(40);
    // ほとんどの車は動いている
    const movers = [...moved.values()].filter((d) => d > 50).length;
    expect(movers).toBeGreaterThan(moved.size * 0.5);
    expect(traffic.stats.spawned).toBeGreaterThan(5);
    console.log("交通", { frames, maxCount, ...traffic.stats, odometer: Math.round(ride.odometer) });
    // 後ろから来た車は自転車を追い越す
    expect(traffic.stats.passes).toBeGreaterThan(0);
    expect(traffic.stats.overlaps).toBeLessThanOrEqual(2);
  }, 120000);

  it("同じ種なら同じ動き（Math.random を使わない）", () => {
    const run = () => {
      const ride = new Ride(net, { road: startRoad.id, s: 5, dir: 1 }, new AutoPower(150));
      const t = new Traffic(net, 3);
      for (let f = 0; f < 30 * 60; f++) {
        for (let k = 0; k < 4; k++) ride.step(DT);
        const r = riderOf(ride);
        t.update(1 / 30, r.x, r.z, r);
      }
      return t.vehicles.map((v) => [v.type, v.pos.road, v.pos.s.toFixed(3)].join());
    };
    expect(run()).toEqual(run());
  }, 60000);

  it("交通量: なしでは出ない。夜は昼より少ない", () => {
    const ride = new Ride(net, { road: startRoad.id, s: 5, dir: 1 }, new AutoPower(150));
    const r = riderOf(ride);
    const off = new Traffic(net, 1);
    off.level = "off";
    off.update(0.6, r.x, r.z, r);
    expect(off.vehicles.length).toBe(0);
    expect(hourFactor(3)).toBeLessThan(hourFactor(12) / 3);
    expect(hourFactor(8)).toBeGreaterThan(hourFactor(12));
  });

  it("バス停は幹線・一般道だけに、両側に置かれ、同じ道路なら同じ", () => {
    let total = 0;
    for (const road of net.roads.values()) {
      const a = busStopsOn(road, net.nodes.values());
      expect(a).toEqual(busStopsOn(road, net.nodes.values()));
      if (road.cls > 1) expect(a.length).toBe(0);
      for (const st of a) {
        expect(st.s).toBeGreaterThan(0);
        expect(st.s).toBeLessThan(road.length);
      }
      total += a.length;
    }
    expect(total).toBeGreaterThan(10);
  });
});
