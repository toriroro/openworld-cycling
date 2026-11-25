// 配達の草案 26 章: 受け渡しの円、曲がる回数の少ない経路、ペースの補助、車との接触

import { describe, expect, it } from "vitest";
import { Delivery, handoffZone, HANDOVER_S, inZone, ZONE_R, type DeliveryOrder } from "../src/shared/delivery.ts";
import { CAR_HIT, PACE_ASSIST, PACE_SPEED, paceWatts, Stamina } from "../src/shared/stamina.ts";
import { ManualPower } from "../src/sim/power.ts";
import { Ride } from "../src/sim/ride.ts";
import type { Junction, Road } from "../src/shared/world/types.ts";
import { equilibriumSpeed } from "../src/sim/bicycle.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { isTurn, planPath, planRoute, TURN_COST } from "../src/sim/route-plan.ts";
import { Traffic, type Vehicle } from "../src/sim/traffic/traffic.ts";

describe("受け渡しの円", () => {
  const spot = { x: 0, z: 0, dx: 1, dz: 0, width: 10 };

  it("建物の側の道の端から 1.5m 内側に置く", () => {
    // 東へ向かう道で、+z（南）が進む向きの右
    const south = handoffZone(spot, { x: 0, z: 30 });
    expect(south).toEqual({ x: 0, z: 3.5, r: ZONE_R });
    const north = handoffZone(spot, { x: 5, z: -30 });
    expect(north.x).toBe(0);
    expect(north.z).toBe(-3.5);
    // 狭い道では道の中心より外へ出さない
    expect(handoffZone({ ...spot, width: 2 }, { x: 0, z: 30 }).z).toBe(0);
  });

  it("円の中だけで受け渡しになり、受け取り → 渡すの順に進む", () => {
    const zone = handoffZone(spot, { x: 0, z: 30 });
    expect(inZone(zone, { x: 0, z: 3.5 + ZONE_R - 0.1 })).toBe(true);
    expect(inZone(zone, { x: 0, z: 3.5 + ZONE_R + 0.1 })).toBe(false);
    expect(inZone(zone, { x: ZONE_R - 0.1, z: 3.5 })).toBe(true);
    const o: DeliveryOrder = {
      no: 1,
      source: "app",
      kind: "meal",
      pickup: { name: "北1条西1丁目", x: 0, z: 0 },
      dropoff: { name: "北2条西1丁目", x: 0, z: 120 },
      pickedAtStart: false,
      distance: 120,
      approach: 0,
      limit: 600,
      reward: 400,
    };
    const d = new Delivery(o, 0, 0);
    expect(d.handoff(10, 50)).toBe("picked");
    expect(d.phase).toBe("dropoff");
    const r = d.handoff(100, 400);
    expect(r).not.toBe("picked");
    if (r === "picked") return;
    expect(r.elapsed).toBe(100 + HANDOVER_S * 2);
    expect(r.late).toBe(false);
    expect(r.reward).toBe(400);
    expect(r.ridden).toBe(400);
  });
});

/** 120m おきの n × n の格子。区画の 1 辺ごとに道路を 1 本、点は 4m ごと */
function grid(n: number) {
  const net = new RoadNetwork();
  const B = 120;
  const arms = new Map<string, Junction>();
  const jid = (i: number, k: number) => `j${i}_${k}`;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) arms.set(jid(i, k), { id: jid(i, k), x: i * B, y: 0, z: k * B, arms: [] } as unknown as Junction);
  const add = (id: string, a: [number, number], b: [number, number]) => {
    const steps = B / 4;
    const pts = new Float32Array((steps + 1) * 3);
    for (let t = 0; t <= steps; t++) {
      pts[t * 3] = ((b[0] - a[0]) * B * t) / steps;
      pts[t * 3 + 2] = ((b[1] - a[1]) * B * t) / steps;
    }
    const road = { id, cls: 1, width: 8, surface: "paved", origin: [a[0] * B, a[1] * B], points: pts, length: B, spans: [], name: id, kind: "main", start: jid(...a), end: jid(...b) } as unknown as Road;
    net.addRoad(road);
    arms.get(jid(...a))!.arms.push({ road: id, s: 0, dir: 1 });
    arms.get(jid(...b))!.arms.push({ road: id, s: B, dir: -1 });
  };
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      if (i + 1 < n) add(`h${i}_${k}`, [i, k], [i + 1, k]);
      if (k + 1 < n) add(`v${i}_${k}`, [i, k], [i, k + 1]);
    }
  for (const j of arms.values()) net.addJunction(j);
  return net;
}

describe("曲がる回数の少ない経路", () => {
  const net = grid(6);

  /** 経路の中で曲がる回数（行き先が接続点の上で、最後に選ぶ腕を 0m しか走らないなら数えない） */
  const turns = (from: { road: string; s: number; dir: 1 | -1 }, plan: NonNullable<ReturnType<typeof planRoute>>) => {
    let cur = from;
    let n = 0;
    const last = plan.steps[plan.steps.length - 1];
    const steps = last && last.arm.road === plan.goal.road && Math.abs(last.arm.s - plan.goal.s) < 1 ? plan.steps.slice(0, -1) : plan.steps;
    for (const st of steps) {
      const r = net.roads.get(cur.road)!;
      if (isTurn(net, cur.road, cur.dir > 0 ? r.length : 0, cur.dir, st.arm)) n++;
      cur = st.arm;
    }
    return n;
  };

  it("格子の斜め向こうへは、階段のようにではなく 1 回だけ曲がる", () => {
    const from = { road: "h0_0", s: 5, dir: 1 as const };
    const plan = planRoute(net, from, 4 * 120, 4 * 120)!;
    expect(plan).not.toBeNull();
    // 道のりは最短（曲がる重みは道のりに入れない）
    expect(plan.length).toBeCloseTo(8 * 120 - 5, 0);
    expect(turns(from, plan)).toBe(1);
  });

  it("曲がる重みより短くなるなら曲がる", () => {
    // まっすぐ東へ行ってから戻るより、すぐ曲がる方が TURN_COST より大きく短い
    const from = { road: "v0_0", s: 5, dir: 1 as const };
    const plan = planRoute(net, from, 2 * 120, 1 * 120)!;
    expect(turns(from, plan)).toBe(1);
    expect(TURN_COST).toBeLessThan(240);
  });

  it("経路の線は今の位置から行き先まで道路の上を通る", () => {
    const from = { road: "h0_0", s: 5, dir: 1 as const };
    const plan = planRoute(net, from, 4 * 120, 4 * 120)!;
    const path = planPath(net, from, plan);
    expect(path.slice(0, 2)).toEqual([5, 0]);
    expect(path[path.length - 2]).toBeCloseTo(480, 3);
    expect(path[path.length - 1]).toBeCloseTo(480, 3);
    // 点は格子の線の上（x か z が 120 の倍数）
    for (let i = 0; i < path.length; i += 2) expect(Math.min(path[i] % 120, path[i + 1] % 120)).toBeCloseTo(0, 3);
    let len = 0;
    for (let i = 2; i < path.length; i += 2) len += Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
    expect(len).toBeCloseTo(plan.length, 0);
  });
});

describe("ペースの補助と車に当たった時", () => {
  it("平らな道で ふつう 40km/h・急ぐ 50km/h ほど", () => {
    const kmh = (pace: 2 | 3) => equilibriumSpeed(paceWatts(pace, 200) * PACE_ASSIST[pace], 0) * 3.6;
    expect(kmh(2)).toBeGreaterThan(39.5);
    expect(kmh(2)).toBeLessThan(40.5);
    expect(kmh(3)).toBeGreaterThan(49.5);
    expect(kmh(3)).toBeLessThan(50.5);
  });

  it("ペースの速さまで押す力: 平らな道で ふつうは約 10 秒で 36km/h、落ち着く速さは 40km/h", () => {
    const net = grid(30);
    const power = new ManualPower();
    power.pace = 2;
    const ride = new Ride(net, { road: "h0_0", s: 1, dir: 1 }, power);
    ride.assist = PACE_ASSIST[2];
    ride.cruise = PACE_SPEED[2] / 3.6;
    let t36 = 0;
    for (let i = 0; i < 120 * 60; i++) {
      ride.step();
      if (!t36 && ride.speed * 3.6 >= 36) t36 = ride.time;
    }
    expect(t36).toBeGreaterThan(6);
    expect(t36).toBeLessThan(13);
    expect(ride.speed * 3.6).toBeGreaterThan(39.3);
    expect(ride.speed * 3.6).toBeLessThan(40.7);
    // 漕いだ出力（脚・体力の減り）はペースの出力のまま
    expect(ride.watts).toBeCloseTo(paceWatts(2, 200), 6);
  });

  it("車に当たると体力が量の 5% 減り、0 より下にはならない", () => {
    const st = new Stamina();
    st.hit(CAR_HIT);
    expect(st.energyShare).toBeCloseTo(0.95, 6);
    st.energy = 1000;
    st.hit(CAR_HIT);
    expect(st.energy).toBe(0);
  });

  it("車の箱（長さ・幅）に自転車の半分を足した中なら当たる。高さが 3m 以上違えば当たらない", () => {
    const t = new Traffic(new RoadNetwork(), 1, () => 0);
    // 東へ向かう長さ 4.4m・幅 1.7m の車
    t.vehicles.push({ id: 7, x: 100, y: 0, z: 50, dx: 1, dz: 0, length: 4.4, width: 1.7 } as unknown as Vehicle);
    const ids = (x: number, y: number, z: number) => t.contacts({ x, y, z }).map((v) => v.id);
    expect(ids(100, 0, 50)).toEqual([7]);
    expect(ids(100 + 2.2 + 0.85, 0, 50)).toEqual([7]);
    expect(ids(100 + 2.2 + 0.95, 0, 50)).toEqual([]);
    expect(ids(100, 0, 50 + 0.85 + 0.25)).toEqual([7]);
    expect(ids(100, 0, 50 + 0.85 + 0.35)).toEqual([]);
    expect(ids(100, 4, 50)).toEqual([]);
  });
});
