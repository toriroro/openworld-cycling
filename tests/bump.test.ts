// 車に当たった時のはね返りと車の停止、配達員・業者の車の配達（配達の草案 28 章）
import { describe, expect, it } from "vitest";
import { AutoPower } from "../src/sim/power.ts";
import { BUMP_S, Ride, YOSE_S } from "../src/sim/ride.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { Traffic, type Vehicle, YOSE_HIT } from "../src/sim/traffic/traffic.ts";
import type { Junction, Road } from "../src/shared/world/types.ts";

/** n×n の格子（一辺 200m、幅 10m） */
function grid(n: number) {
  const net = new RoadNetwork();
  const B = 200;
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
    const road = { id, cls: 1, width: 10, surface: "paved", origin: [a[0] * B, a[1] * B], points: pts, length: B, spans: [], name: id, kind: "main", start: jid(...a), end: jid(...b) } as unknown as Road;
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

describe("車に当たった時（配達の草案 28 章）", () => {
  it("自転車は 1 回跳ねて、言われた向きへ速くずれ、速さを落とす", () => {
    const net = grid(4);
    const ride = new Ride(net, { road: "h0_1", s: 20, dir: 1 }, new AutoPower(250));
    for (let i = 0; i < 120 * 10; i++) ride.step();
    const v0 = ride.speed;
    const off0 = ride.offset;
    ride.bump(1, 1.5);
    expect(ride.speed).toBeCloseTo(v0 * 0.45, 6);
    let peak = 0;
    for (let i = 0; i < Math.round((BUMP_S * 120) / 2); i++) ride.step();
    peak = ride.hopHeight;
    expect(peak).toBeGreaterThan(0.3);
    for (let i = 0; i < Math.round((BUMP_S * 120) / 2) + 2; i++) ride.step();
    expect(ride.hopHeight).toBe(0);
    // 跳ねている間に、ずらした量のほとんどを動く（ふだんの寄り方は 1 秒に 1.5 の割合）
    expect(ride.offset - off0).toBeGreaterThan(1.5 * 0.9);
  });

  it("当たった車は自転車と逆へ寄りながらゆっくり減速して止まり、しばらくして走り出す", () => {
    const net = grid(8);
    const t = new Traffic(net, 3);
    t.hour = 12;
    for (let i = 0; i < 30 * 20; i++) t.update(1 / 30, 700, 700, null);
    // いちばん速く走っていて、曲がっていない車
    const v = t.vehicles.filter((o) => o.speed > 6 && !o.turn).sort((a, b) => b.speed - a.speed)[0] as Vehicle;
    expect(v).toBeTruthy();
    const off0 = v.offset;
    const sp0 = v.speed;
    t.collide(v, 1);
    for (let i = 0; i < 15; i++) t.update(1 / 30, 700, 700, null);
    // 0.5 秒では急には止まらない（3m/s² ほど）
    expect(v.speed).toBeGreaterThan(sp0 - 3 * 0.5 - 0.3);
    expect(v.speed).toBeLessThan(sp0 - 0.5);
    let stopped = -1;
    for (let i = 0; i < 30 * 12 && stopped < 0; i++) {
      t.update(1 / 30, 700, 700, null);
      if (v.speed < 0.05) stopped = i;
    }
    expect(stopped).toBeGreaterThanOrEqual(0);
    if (!v.turn) expect(v.offset - off0).toBeGreaterThan(0.4);
    // 止まってから 4 秒ほどで走り出す
    for (let i = 0; i < 30 * 3; i++) t.update(1 / 30, 700, 700, null);
    expect(v.speed).toBeLessThan(0.1);
    for (let i = 0; i < 30 * 4; i++) t.update(1 / 30, 700, 700, null);
    expect(v.crash).toBeNull();
    expect(v.speed).toBeGreaterThan(0.3);
  });
});

describe("配達員と業者の車（配達の草案 28 章）", () => {
  it("配達員は業者の色で、道の左の端を自転車の速さで走る", () => {
    const net = grid(8);
    const t = new Traffic(net, 5);
    t.hour = 12;
    t.couriers = () => 4;
    t.paint = (_x, _z, type) => (type === "courier" ? "#123456" : null);
    for (let i = 0; i < 30 * 30; i++) t.update(1 / 30, 700, 700, null);
    const cs = t.vehicles.filter((v) => v.type === "courier");
    expect(cs.length).toBeGreaterThan(3);
    for (const c of cs) {
      expect(c.color).toBe("#123456");
      expect(c.speed).toBeLessThan(8);
      // 幅 10m の道の左の端（−5 + 0.3 + 0.5）
      if (!c.turn && !c.passing) expect(c.offset).toBeLessThan(-3.5);
    }
  });

  it("業者の色のバン・軽トラは、ときどき道の端に止まって荷を届け、また走り出す", () => {
    const net = grid(8);
    const t = new Traffic(net, 11);
    t.hour = 12;
    t.paint = (_x, _z, type) => (type === "van" || type === "keiTruck" ? "#aa2222" : null);
    const seen = new Map<number, { phase: number; offset: number; speed: number }>();
    const resumed = new Set<number>();
    for (let i = 0; i < 30 * 240; i++) {
      t.update(1 / 30, 700, 700, null);
      const now = new Set<number>();
      for (const { v, phase } of t.parcelStops()) {
        now.add(v.id);
        seen.set(v.id, { phase, offset: v.offset, speed: v.speed });
      }
      for (const id of seen.keys()) if (!now.has(id) && t.vehicles.some((v) => v.id === id)) resumed.add(id);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const s of seen.values()) {
      expect(s.speed).toBeLessThan(0.5);
      // 幅 10m の道の端（−5 + 車の幅の半分 + 0.1 のあたり）へ寄っている
      expect(s.offset).toBeLessThan(-3.2);
    }
    expect(resumed.size).toBeGreaterThan(0);
    expect(t.vehicles.filter((v) => v.delivers).length).toBeGreaterThan(0);
  });
});

describe("左右へ寄る・横（配達の草案 30 章）", () => {
  it("1 回押した分（0.8m）は 0.4 秒以内に動く（前は 2 秒以上かかった）", () => {
    const net = grid(4);
    const ride = new Ride(net, { road: "h0_1", s: 20, dir: 1 }, new AutoPower(200));
    for (let i = 0; i < 120 * 3; i++) ride.step();
    const o0 = ride.offset;
    ride.shiftLane(0.8);
    let t = 0;
    while (ride.offset - o0 < 0.79 && t < 3) {
      ride.step();
      t += 1 / 120;
    }
    expect(t).toBeLessThan(0.4);
  });

  it("横: 相手の方へ寄って戻る。左右位置の目標は変えない", () => {
    const net = grid(4);
    const ride = new Ride(net, { road: "h0_1", s: 20, dir: 1 }, new AutoPower(200));
    for (let i = 0; i < 120 * 3; i++) ride.step();
    const o0 = ride.offset;
    ride.yose(1);
    let peak = 0;
    for (let i = 0; i < Math.round(YOSE_S * 120) + 60; i++) {
      ride.step();
      peak = Math.max(peak, ride.offset - o0);
    }
    expect(peak).toBeGreaterThan(0.25);
    expect(Math.abs(ride.offset - o0)).toBeLessThan(0.02);
    expect(ride.laneShift).toBe(0);
  });

  it("横で押された配達員は、体力が 3 減って押された向きへ寄り、少し遅くなる。止まらない（落車しない）", () => {
    const net = grid(8);
    const t = new Traffic(net, 5);
    t.hour = 12;
    t.couriers = () => 4;
    for (let i = 0; i < 30 * 30; i++) t.update(1 / 30, 700, 700, null);
    const c = t.vehicles.filter((v) => v.type === "courier" && !v.turn && v.speed > 3)[0];
    expect(c).toBeTruthy();
    const off0 = c.offset;
    const sp0 = c.speed;
    expect(t.shove(c, 1)).toBe(100 - YOSE_HIT);
    expect(c.speed).toBeCloseTo(sp0 * 0.85, 6);
    for (let i = 0; i < 20; i++) t.update(1 / 30, 700, 700, null);
    if (!c.turn) expect(c.offset - off0).toBeGreaterThan(0.3);
    expect(c.crash).toBeNull();
    expect(c.speed).toBeGreaterThan(1);
    // 体力が 0 なら一般道で 7 割の速さ
    c.energy = 0;
    for (let i = 0; i < 30 * 20; i++) t.update(1 / 30, 700, 700, null);
    if (t.vehicles.includes(c)) expect(c.speed).toBeLessThan(13.9 * 0.42 * 1.1 * 0.7 + 0.3);
  });
});
