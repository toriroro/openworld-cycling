// 自分の車での配達（D7a。配達の草案 33 章）: 業者の車の割り当て、車の走り、自転車道を通らない、止めて歩いて渡す
import { describe, expect, it } from "vitest";
import { type Company, crewPlan, DRIVE_CARRY, driveCheck, sanitizeEconomy, sellVehicle, setDrive } from "../src/shared/economy.ts";
import { Delivery, HANDOVER_S, type DeliveryOrder } from "../src/shared/delivery.ts";
import { ManualPower } from "../src/sim/power.ts";
import { Ride } from "../src/sim/ride.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { planRoute } from "../src/sim/route-plan.ts";
import type { Junction, Road } from "../src/shared/world/types.ts";

function company(fleet: Company["fleet"], drive: Company["drive"] = null): Company {
  return {
    id: "p",
    name: "試し便",
    color: "#123456",
    depots: ["c"],
    staff: 2,
    cash: 1_000_000,
    trust: 1,
    price: 500,
    opened: 0,
    closed: null,
    profit: 0,
    negDays: 0,
    lowDays: 0,
    player: true,
    crew: [
      { id: "a", no: 1, speed: 1.2, wage: 7000, since: 0 },
      { id: "b", no: 2, speed: 1.0, wage: 7000, since: 0 },
    ],
    fleet,
    drive,
  } as unknown as Company;
}

describe("業者の車を自分で乗る（D7a）", () => {
  it("自分で乗っている車は配達員に割り当てない", () => {
    const c = company({ kei: 1 });
    expect(crewPlan(c, 10).slots.map((s) => s.vehicle)).toEqual(["kei", "own"]);
    expect(setDrive(c, "kei")).toBe(true);
    expect(crewPlan(c, 10).slots.map((s) => s.vehicle)).toEqual(["own", "own"]);
    // 2 台あれば 1 台は配達員へ
    c.fleet = { kei: 2 };
    expect(crewPlan(c, 10).slots.map((s) => s.vehicle)).toEqual(["kei", "own"]);
  });

  it("持っていない車には乗れない。乗っている最後の 1 台は売れない", () => {
    const c = company({ kei: 1 });
    expect(driveCheck(c, "van")).not.toBeNull();
    expect(setDrive(c, "van")).toBe(false);
    setDrive(c, "kei");
    expect(sellVehicle(c, "kei")).toBe(false);
    setDrive(c, null);
    expect(sellVehicle(c, "kei")).toBe(true);
    expect(DRIVE_CARRY.kei).toBe(3);
    expect(DRIVE_CARRY.van).toBe(4);
  });
});

/** 東西の道 2 本（自転車道と車道）が真ん中の接続点で分かれる形 */
function fork() {
  const net = new RoadNetwork();
  const mk = (id: string, kind: Road["kind"], from: [number, number], to: [number, number], cls: number) => {
    const n = 51;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pts[i * 3] = ((to[0] - from[0]) * i) / (n - 1);
      pts[i * 3 + 2] = ((to[1] - from[1]) * i) / (n - 1);
    }
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    net.addRoad({ id, cls, width: kind === "cycleway" ? 3 : 8, surface: "paved", origin: from, points: pts, length: len, spans: [], name: id, kind, start: "", end: "" } as unknown as Road);
    return len;
  };
  const l0 = mk("in", "main", [0, 0], [200, 0], 1);
  const l1 = mk("cyc", "cycleway", [200, 0], [400, 0], 4);
  const l2 = mk("car", "main", [200, 0], [300, 150], 1);
  mk("back", "main", [300, 150], [400, 0], 1);
  net.addJunction({ id: "j", x: 200, y: 0, z: 0, arms: [{ road: "in", s: l0, dir: -1 }, { road: "cyc", s: 0, dir: 1 }, { road: "car", s: 0, dir: 1 }] } as unknown as Junction);
  net.addJunction({ id: "k", x: 300, y: 0, z: 150, arms: [{ road: "car", s: l2, dir: -1 }, { road: "back", s: 0, dir: 1 }] } as unknown as Junction);
  net.addJunction({ id: "e", x: 400, y: 0, z: 0, arms: [{ road: "cyc", s: l1, dir: -1 }, { road: "back", s: Math.hypot(100, 150), dir: -1 }] } as unknown as Junction);
  return net;
}

describe("車の走り（D7a）", () => {
  it("目標の速さへ加速し、道の制限速度（一般道 50km/h）を超えない。ブレーキで止まる", () => {
    const net = fork();
    const power = new ManualPower();
    const ride = new Ride(net, { road: "in", s: 1, dir: 1 }, power);
    ride.car = { accel: 2.2, brake: 6 };
    ride.carTarget = 60 / 3.6;
    let t10 = 0;
    for (let i = 0; i < 120 * 12; i++) {
      ride.step();
      if (!t10 && ride.speed * 3.6 >= 40) t10 = ride.time;
    }
    expect(t10).toBeGreaterThan(4);
    expect(t10).toBeLessThan(7);
    expect(ride.speed * 3.6).toBeLessThanOrEqual(50.1);
    expect(ride.watts).toBe(0);
    power.brake = 1;
    let stopT = 0;
    while (ride.speed > 0 && stopT < 10) {
      ride.step();
      stopT += 1 / 120;
    }
    expect(stopT).toBeLessThan(3);
  });

  it("経路は自転車道を通らない（自転車なら近い自転車道を通る）", () => {
    const net = fork();
    const bike = planRoute(net, { road: "in", s: 10, dir: 1 }, 400, 0, "short", false)!;
    const car = planRoute(net, { road: "in", s: 10, dir: 1 }, 400, 0, "short", true)!;
    expect(bike.steps.some((s) => s.arm.road === "cyc")).toBe(true);
    expect(car.steps.some((s) => s.arm.road === "cyc")).toBe(false);
  });
});

describe("止めて歩いて渡す（D7a）", () => {
  it("車は歩く時間が長い（経った時間に足す）", () => {
    const o = { no: 1, kind: "meal", source: "app", pickup: { name: "店", x: 0, z: 0 }, dropoff: { name: "丁目", x: 100, z: 0 }, limit: 900, reward: 500, distance: 100, approach: 0, pickedAtStart: false } as unknown as DeliveryOrder;
    const bike = new Delivery(o, 0, 0);
    const car = new Delivery(o, 0, 0);
    bike.handoff(10, 0);
    car.handoff(10, 0, 30);
    const rb = bike.handoff(20, 0);
    const rc = car.handoff(20, 0, 30);
    if (typeof rb === "string" || typeof rc === "string") throw new Error("渡していない");
    expect(rc.elapsed - rb.elapsed).toBeCloseTo((30 - HANDOVER_S) * 2, 6);
  });

  it("保存: 持っている車にだけ乗っていることにする", () => {
    const st = (drive: string, fleet: Record<string, number>) => sanitizeEconomy({ v: 1, day: 1, companies: [{ id: "p", name: "試し便", color: "#123456", depots: ["c"], staff: 0, cash: 0, trust: 1, price: 500, opened: 0, closed: null, profit: 0, negDays: 0, lowDays: 0, player: true, crew: [], fleet, drive }], player: { company: "p" } } as never);
    expect(st("kei", { kei: 1 })?.companies[0]?.drive).toBe("kei");
    expect(st("kei", {})?.companies[0]?.drive).toBeUndefined();
    expect(st("truck", { truck: 1 })?.companies[0]?.drive).toBeUndefined();
  });
});
