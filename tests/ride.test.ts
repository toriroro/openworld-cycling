import { describe, expect, it } from "vitest";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";
import { AutoPower, ManualPower } from "../src/sim/power.ts";
import { LATERAL_ACCEL, Ride } from "../src/sim/ride.ts";
import { RoadNetwork, sampleRoad } from "../src/sim/road-network.ts";

function network(r = 14000) {
  const w = new World(WORLD_SEED);
  const reg = w.region({ x0: ORIGIN.x - r, z0: ORIGIN.z - r, x1: ORIGIN.x + r, z1: ORIGIN.z + r });
  const net = new RoadNetwork();
  for (const road of reg.roads) net.addRoad(road);
  for (const j of reg.junctions) net.addJunction(j);
  for (const n of reg.nodes) net.nodes.set(n.id, n);
  return net;
}

describe("道路網の上を走る", () => {
  const net = network();
  // 平野の幹線から出発する
  const startRoad = [...net.roads.values()].filter((r) => r.cls === 0 && r.start === ORIGIN.node).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? [...net.roads.values()].find((r) => r.cls === 0)!;

  it("一定の出力で接続点を越えて走り続け、カーブでは横加速度の上限を大きく超えない", () => {
    const ride = new Ride(net, { road: startRoad.id, s: 5, dir: 1 }, new AutoPower(220));
    let maxLat = 0;
    let roadsSeen = new Set<string>();
    let prev = ride.pose();
    let prevHeading = Math.atan2(prev.dz, prev.dx);
    for (let i = 0; i < 120 * 60 * 60 && ride.odometer < 15000; i++) {
      ride.step();
      roadsSeen.add(ride.pos.road);
      if (i % 12 === 0) {
        const p = ride.pose();
        const h = Math.atan2(p.dz, p.dx);
        let dh = h - prevHeading;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
        // 接続点をまたぐ瞬間（道路の切り替え）は除いて、横加速度 = v² × 曲率
        if (moved > 0.5 && moved < ride.speed * 0.2) maxLat = Math.max(maxLat, ride.speed * ride.speed * Math.abs(dh / moved));
        prev = p;
        prevHeading = h;
      }
    }
    expect(ride.odometer).toBeGreaterThanOrEqual(15000);
    expect(roadsSeen.size).toBeGreaterThan(2);
    // 先読みは 4m 刻みの3点なので少し余裕を見る
    expect(maxLat).toBeLessThan(LATERAL_ACCEL * 1.6);
  });

  it("接続点の手前で候補が出て、選んだ道へ進む", () => {
    const ride = new Ride(net, { road: startRoad.id, s: 5, dir: 1 }, new AutoPower(200));
    let checked = 0;
    for (let i = 0; i < 120 * 60 * 60 && checked < 3; i++) {
      ride.step();
      const u = ride.upcoming;
      if (u && u.choices.length >= 2 && u.selected === null && u.distance < 120) {
        // 既定でない候補を選ぶ
        const pick = (u.defaultIndex + 1) % u.choices.length;
        ride.choose(pick);
        const want = u.choices[pick].arm;
        const jid = u.junction.id;
        while (ride.upcoming && ride.upcoming.junction.id === jid) ride.step();
        expect(ride.pos.road).toBe(want.road);
        expect(ride.pos.dir).toBe(want.dir);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("手動: 漕がなければ平地で止まり、停止中は U ターンできる", () => {
    const flat = [...net.roads.values()].find((r) => r.cls === 0)!;
    const power = new ManualPower();
    const ride = new Ride(net, { road: flat.id, s: flat.length / 2, dir: 1 }, power);
    power.pedal = true;
    for (let i = 0; i < 120 * 20; i++) ride.step();
    expect(ride.speed).toBeGreaterThan(5);
    power.pedal = false;
    power.brake = 1;
    for (let i = 0; i < 120 * 20; i++) ride.step();
    expect(ride.speed).toBe(0);
    const dir = ride.pos.dir;
    expect(ride.uTurn()).toBe(true);
    expect(ride.pos.dir).toBe(-dir);
    // 左側通行: 向きを変えても進行方向の左にいる
    for (let i = 0; i < 600; i++) ride.step();
    const p = ride.pose();
    const c = sampleRoad(ride.road!, ride.pos.s);
    const rightX = -p.dz, rightZ = p.dx;
    expect((p.x - c.x) * rightX + (p.z - c.z) * rightZ).toBeLessThan(0);
  });
});

describe("行き先までの経路（モック仕様 6.3）", () => {
  const net = network(16000);
  it("起点から海岸・平野・山岳の地点へ、経路に沿って分岐を選んで着く", () => {
    const start = [...net.roads.values()].filter((r) => r.start === ORIGIN.node).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const ride = new Ride(net, { road: start.id, s: 5, dir: 1 }, new AutoPower(400));
    const visited: string[] = [];
    for (const [name, x, z] of [
      ["海岸", -40856, 20297],
      ["平野", -26695, 18331],
      ["山岳", -37662, -432],
    ] as const) {
      expect(ride.setGoal(x, z), name).toBe(true);
      let i = 0;
      // 2 時間ぶんまで（山へは 1,100m 登る）
      for (; i < 120 * 7200 && !ride.goalReached; i++) {
        ride.step();
        // 行き止まりで止まったら U ターン
        if (ride.speed === 0 && i % 120 === 0) ride.uTurn();
      }
      expect(ride.goalReached, name).toBe(true);
      const p = ride.pose();
      expect(Math.hypot(p.x - x, p.z - z), name).toBeLessThan(60);
      visited.push(name);
    }
    expect(visited).toEqual(["海岸", "平野", "山岳"]);
  });
});
