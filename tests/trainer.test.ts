// トレーナー連携（トレーナー連携の草案）: バイト列の解析・組み立て、勾配のなめらかさと送る間隔、仮想トレーナーでの接続から切断まで。
// バイト列は FTMS・Cycling Power・Heart Rate の仕様の並びを手で書いたもの（組み立ての関数を通さない）。

import { describe, expect, it } from "vitest";
import type { Road } from "../src/shared/world/types.ts";
import {
  BLE,
  encodeIndoorBikeData,
  encodeSimulation,
  parseControlPointResponse,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
  supportsSimulation,
} from "../src/sim/trainer/ble-codec.ts";
import { GradeSchedule, smoothedGrade, trainerGrade } from "../src/sim/trainer/grade.ts";
import { TrainerLink } from "../src/sim/trainer/link.ts";
import { TrainerPower } from "../src/sim/trainer/trainer-power.ts";
import { VirtualDevice } from "../src/sim/trainer/virtual.ts";
import { sampleRoad } from "../src/sim/road-network.ts";

const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("バイト列の解析", () => {
  it("Indoor Bike Data: 速度・ケイデンス・出力（ビット 0 が 0 なら速度がある）", () => {
    const r = parseIndoorBikeData(dv([0x44, 0x00, 0x10, 0x27, 0xb4, 0x00, 0xc8, 0x00]));
    expect(r).toEqual({ speedKmh: 100, cadence: 90, watts: 200 });
  });

  it("Indoor Bike Data: 間の項目（距離・負荷の段・消費エネルギー）を飛ばして出力と心拍を読む", () => {
    // More Data・ケイデンス・総距離・負荷の段・出力・消費エネルギー・心拍
    const r = parseIndoorBikeData(dv([0x75, 0x03, 0xaa, 0x00, 0x10, 0x20, 0x00, 0x05, 0x00, 0xfa, 0x00, 0x64, 0x00, 0x10, 0x00, 0x05, 0x8c]));
    expect(r).toEqual({ cadence: 85, watts: 250, heartRate: 140 });
  });

  it("Indoor Bike Data: 短すぎる通知でも投げない", () => {
    expect(parseIndoorBikeData(dv([0x40, 0x00, 0xc8]))).toEqual({});
    expect(parseIndoorBikeData(dv([0x40]))).toEqual({});
  });

  it("Cycling Power: 出力と、クランクの回転の差からケイデンス", () => {
    const a = parseCyclingPower(dv([0x20, 0x00, 0xc8, 0x00, 0x0a, 0x00, 0x00, 0x04]), null);
    expect(a.reading.watts).toBe(200);
    // 1 回転に 683/1024 秒 → 約 90rpm
    const b = parseCyclingPower(dv([0x20, 0x00, 0xd2, 0x00, 0x0b, 0x00, 0xab, 0x06]), a.crank);
    expect(b.reading.watts).toBe(210);
    expect(b.reading.cadence).toBeCloseTo(89.96, 1);
  });

  it("Cycling Power: 左右のバランス・トルク・車輪の項目を飛ばす。回転の数と時刻の一周", () => {
    const first = parseCyclingPower(dv([0x35, 0x00, 0x2c, 0x01, 0x32, 0x10, 0x00, 1, 2, 3, 4, 5, 6, 0xff, 0xff, 0xe8, 0xfd]), null);
    expect(first.reading.watts).toBe(300);
    // 65535 → 1 回転（2 回転）、時刻 65000 → 1000（1536/1024 秒）
    const next = parseCyclingPower(dv([0x35, 0x00, 0x2c, 0x01, 0x32, 0x10, 0x00, 1, 2, 3, 4, 5, 6, 0x01, 0x00, 0xe8, 0x03]), first.crank);
    expect(next.reading.cadence).toBeCloseTo(80, 1);
  });

  it("Cycling Power: 回転が 3 回続けて増えなければケイデンス 0", () => {
    let st = parseCyclingPower(dv([0x20, 0x00, 0, 0, 0x0a, 0x00, 0x00, 0x04]), null).crank;
    st = parseCyclingPower(dv([0x20, 0x00, 0, 0, 0x0b, 0x00, 0x00, 0x08]), st).crank;
    expect(st!.cadence).toBeCloseTo(60, 5);
    for (let i = 0; i < 2; i++) st = parseCyclingPower(dv([0x20, 0x00, 0, 0, 0x0b, 0x00, 0x00, 0x08]), st).crank;
    expect(st!.cadence).toBeCloseTo(60, 5);
    st = parseCyclingPower(dv([0x20, 0x00, 0, 0, 0x0b, 0x00, 0x00, 0x08]), st).crank;
    expect(st!.cadence).toBe(0);
  });

  it("Heart Rate: 8 ビットと 16 ビット", () => {
    expect(parseHeartRate(dv([0x00, 72]))).toEqual({ heartRate: 72 });
    expect(parseHeartRate(dv([0x01, 0x96, 0x00]))).toEqual({ heartRate: 150 });
    expect(parseHeartRate(dv([0x01, 0x96]))).toEqual({});
  });

  it("Fitness Machine Feature: 目標の設定のビット 13 でシミュレーションの値に対応", () => {
    expect(supportsSimulation(dv([0x02, 0x40, 0, 0, 0x00, 0x20, 0, 0]))).toBe(true);
    expect(supportsSimulation(dv([0x02, 0x40, 0, 0, 0x0c, 0x00, 0, 0]))).toBe(false);
  });

  it("制御の応答", () => {
    expect(parseControlPointResponse(dv([0x80, 0x11, 0x01]))).toEqual({ op: 0x11, ok: true, result: 1 });
    expect(parseControlPointResponse(dv([0x80, 0x00, 0x05]))?.ok).toBe(false);
    expect(parseControlPointResponse(dv([0x11, 0x00, 0x01]))).toBeNull();
  });
});

describe("シミュレーションの値の組み立て", () => {
  it("勾配 5%・転がり抵抗 0.004・空気抵抗 0.51", () => {
    expect([...encodeSimulation({ grade: 0.05, crr: 0.004, cw: 0.51, wind: 0 })]).toEqual([0x11, 0x00, 0x00, 0xf4, 0x01, 0x28, 0x33]);
  });
  it("下り −3.5%・向かい風 2m/s・範囲の外は丸める", () => {
    expect([...encodeSimulation({ grade: -0.035, crr: 0.011, cw: 0.51, wind: 2 })]).toEqual([0x11, 0xd0, 0x07, 0xa2, 0xfe, 0x6e, 0x33]);
    const big = encodeSimulation({ grade: 5, crr: 1, cw: 9, wind: 0 });
    expect([big[3], big[4], big[5], big[6]]).toEqual([0xff, 0x7f, 0xff, 0xff]);
  });
});

/** x の向きにまっすぐ 200m、平均 5% の上りに ±0.3m の凸凹（4m おき）が乗った道 */
function bumpyRoad(): Road {
  const n = 101;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = i * 2;
    pts[i * 3 + 1] = i * 2 * 0.05 + (i % 2 ? 0.3 : -0.3);
    pts[i * 3 + 2] = 0;
  }
  return { id: "t", cls: 1, width: 6, surface: "paved", origin: [0, 0], points: pts, length: 200, spans: [], name: "", kind: "main", start: "a", end: "b" } as unknown as Road;
}

describe("送る勾配", () => {
  const road = bumpyRoad();

  it("前後 15m の平均で、細かい凸凹を消す", () => {
    let rawMin = Infinity;
    let rawMax = -Infinity;
    let min = Infinity;
    let max = -Infinity;
    for (let s = 20; s <= 180; s += 0.5) {
      const raw = sampleRoad(road, s).grade;
      rawMin = Math.min(rawMin, raw);
      rawMax = Math.max(rawMax, raw);
      const g = smoothedGrade(road, s, 1);
      min = Math.min(min, g);
      max = Math.max(max, g);
    }
    expect(rawMax - rawMin).toBeGreaterThan(0.5);
    expect(min).toBeGreaterThan(0.025);
    expect(max).toBeLessThan(0.075);
    expect(smoothedGrade(road, 100, -1)).toBeCloseTo(-smoothedGrade(road, 100, 1), 9);
  });

  it("道路の端では窓を狭める", () => {
    expect(Number.isFinite(smoothedGrade(road, 0, 1))).toBe(true);
    expect(Number.isFinite(smoothedGrade(road, 200, 1))).toBe(true);
  });

  it("効きを掛けて −10%〜+20% に収める", () => {
    expect(trainerGrade(0.08, 0.5)).toBeCloseTo(0.04, 9);
    expect(trainerGrade(-0.3, 1)).toBe(-0.1);
    expect(trainerGrade(0.5, 1)).toBe(0.2);
    expect(trainerGrade(0.1, 0)).toBe(0);
  });

  it("変化が 0.1% 以上なら最短 0.5 秒、無くても 5 秒ごとに送る", () => {
    const s = new GradeSchedule();
    expect(s.shouldSend(0, 0.02)).toBe(true);
    s.markSent(0, 0.02);
    expect(s.shouldSend(300, 0.03)).toBe(false);
    expect(s.shouldSend(500, 0.03)).toBe(true);
    expect(s.shouldSend(500, 0.0205)).toBe(false);
    expect(s.shouldSend(4999, 0.02)).toBe(false);
    expect(s.shouldSend(5000, 0.02)).toBe(true);
  });
});

describe("トレーナーの入力元", () => {
  it("3 秒受けなければ出力 0。ブレーキ中は 0。表示は 3 秒の平均", () => {
    let t = 0;
    const p = new TrainerPower(() => t);
    expect(p.read().watts).toBe(0);
    p.feed(200);
    t = 1000;
    p.feed(300);
    expect(p.read().watts).toBe(300);
    expect(p.average).toBe(250);
    p.brake = 1;
    expect(p.read()).toEqual({ watts: 0, brake: 1 });
    p.brake = 0;
    t = 3999;
    expect(p.read().watts).toBe(300);
    t = 4001;
    expect(p.read().watts).toBe(0);
    expect(p.signal).toBe(false);
  });
});

describe("仮想トレーナーでつなぐ", () => {
  it("FTMS: 出力・ケイデンスを受け、制御を取って勾配を送る", async () => {
    let t = 0;
    const link = new TrainerLink(() => t);
    const dev = new VirtualDevice("trainer", "仮想トレーナー", 0);
    dev.watts = 230;
    expect(await link.attach("trainer", dev)).toBe(true);
    expect(link.info("trainer")).toMatchObject({ state: "connected", kind: "ftms", control: true });
    dev.emit();
    expect(link.power.read().watts).toBe(230);
    expect(link.cadenceRpm).toBe(85);
    link.update({ grade: 0.03, crr: 0.004, cw: 0.51 });
    await flush();
    expect(dev.grade).toBeCloseTo(0.03, 4);
    // 0.5 秒たたないうちの変化は送らない
    t = 200;
    link.update({ grade: 0.04, crr: 0.004, cw: 0.51 });
    await flush();
    expect(dev.received.length).toBe(1);
    t = 600;
    link.update({ grade: 0.04, crr: 0.004, cw: 0.51 });
    await flush();
    expect(dev.grade).toBeCloseTo(0.04, 4);
    // 路面が変わったら（転がり抵抗）すぐ送る
    t = 700;
    link.update({ grade: 0.04, crr: 0.011, cw: 0.51 });
    await flush();
    expect(dev.received.at(-1)?.crr).toBeCloseTo(0.011, 4);
    expect(link.sentLog.length).toBe(3);
    link.detach("trainer");
    expect(dev.connected).toBe(false);
  });

  it("切れたら出力 0 になり、つなぎ直して勾配を送り直す", async () => {
    let t = 0;
    const link = new TrainerLink(() => t);
    const dev = new VirtualDevice("trainer", "仮想トレーナー", 0);
    await link.attach("trainer", dev);
    dev.emit();
    link.update({ grade: 0.05, crr: 0.004, cw: 0.51 });
    await flush();
    dev.failConnects = 1;
    dev.drop();
    expect(link.info("trainer")?.state).toBe("reconnecting");
    t = 3500;
    expect(link.power.read().watts).toBe(0);
    // 2 秒後の 1 回目は失敗、その 5 秒後につながる
    t = 2100;
    link.update(null);
    await flush();
    expect(link.info("trainer")?.state).toBe("reconnecting");
    t = 7200;
    link.update(null);
    await flush();
    expect(link.info("trainer")?.state).toBe("connected");
    const before = dev.received.length;
    link.update({ grade: 0.05, crr: 0.004, cw: 0.51 });
    await flush();
    expect(dev.received.length).toBe(before + 1);
  });

  it("制御を断る機器でも、出力は読める（勾配は送らない）", async () => {
    let t = 0;
    const link = new TrainerLink(() => t);
    const dev = new VirtualDevice("trainer", "仮想トレーナー", 0);
    dev.refuseControl = true;
    expect(await link.attach("trainer", dev)).toBe(true);
    expect(link.info("trainer")?.control).toBe(false);
    dev.emit();
    expect(link.power.read().watts).toBe(200);
    link.update({ grade: 0.05, crr: 0.004, cw: 0.51 });
    await flush();
    expect(dev.received.length).toBe(0);
  });

  it("心拍計: トレーナーと別につなぐ", async () => {
    let t = 0;
    const link = new TrainerLink(() => t);
    const hr = new VirtualDevice("heart", "仮想心拍計", 0);
    hr.watts = 150;
    expect(await link.attach("heart", hr)).toBe(true);
    hr.emit();
    expect(link.heartRate).toBe(140);
    t = 6000;
    expect(link.heartRate).toBeNull();
  });

  it("最初の接続に失敗したら外す", async () => {
    const link = new TrainerLink(() => 0);
    const dev = new VirtualDevice("trainer", "仮想トレーナー", 0);
    dev.failConnects = 1;
    expect(await link.attach("trainer", dev)).toBe(false);
    expect(link.info("trainer")).toBeNull();
  });

  it("仮想トレーナーの通知は実機と同じ並び", () => {
    const b = encodeIndoorBikeData({ speedKmh: 30, cadence: 90, watts: 250, heartRate: 130 });
    expect(parseIndoorBikeData(new DataView(b.buffer))).toEqual({ speedKmh: 30, cadence: 90, watts: 250, heartRate: 130 });
    expect(BLE.ftms).toBe("00001826-0000-1000-8000-00805f9b34fb");
  });
});
