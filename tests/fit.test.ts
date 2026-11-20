// 走行の記録と FIT の書き出し（トレーナー連携の草案 6章）。
// 読み取りは tests/fit-decode.ts（書く側とは別に、ファイルの形の決まりだけから書いた物）。

import { describe, expect, it } from "vitest";
import { encodeActivityFit, FIT_EPOCH, fitCrc, type FitSample, MESG, SPORT_CYCLING, SUB_SPORT_VIRTUAL } from "../src/shared/fit.ts";
import { project, PROJ_ORIGIN } from "../src/shared/geo/projection.ts";
import { MAX_SAMPLES, type RecordInput, RideRecorder } from "../src/sim/trainer/recorder.ts";
import { fitFileName, recorderToFit } from "../src/ride-export.ts";
import { decodeFit } from "./fit-decode.ts";

const T0 = Date.UTC(2026, 10, 21, 1, 0, 0) / 1000;

function samples(n: number, opts: { gapAt?: number; pos?: boolean } = {}): FitSample[] {
  const out: FitSample[] = [];
  let t = T0;
  for (let i = 0; i < n; i++) {
    if (i === opts.gapAt) t += 60;
    out.push({
      t,
      distance: i * 8.5,
      speed: 8.5,
      power: 200 + (i % 10) * 5,
      cadence: i < 3 ? null : 88,
      heartRate: 120 + (i % 5),
      altitude: 100 + i * 0.4,
      grade: 0.047,
      lat: opts.pos ? 43.06 + i * 1e-5 : null,
      lon: opts.pos ? 141.35 : null,
    });
    t += 1;
  }
  return out;
}

const ofType = (f: ReturnType<typeof decodeFit>, g: number) => f.messages.filter((m) => m.global === g);

describe("FIT の CRC", () => {
  it("CRC-16/ARC の検査値（\"123456789\" → 0xBB3D）", () => {
    expect(fitCrc(new TextEncoder().encode("123456789"))).toBe(0xbb3d);
  });
});

describe("FIT の書き出し", () => {
  it("ヘッダ・CRC・メッセージの並び", () => {
    const f = decodeFit(encodeActivityFit({ samples: samples(30), ascent: 12, created: T0 + 40, utcOffsetMin: 540 }));
    expect(f.headerSize).toBe(14);
    expect(f.protocol).toBe(0x20);
    expect(f.headerCrcOk).toBe(true);
    expect(f.fileCrcOk).toBe(true);
    const order = f.messages.map((m) => m.global);
    expect(order[0]).toBe(MESG.fileId);
    expect(order.at(-1)).toBe(MESG.activity);
    expect(ofType(f, MESG.record).length).toBe(30);
    expect(ofType(f, MESG.lap).length).toBe(1);
    expect(ofType(f, MESG.session).length).toBe(1);
    const id = ofType(f, MESG.fileId)[0].fields;
    expect(id.get(0)).toBe(4); // activity
    expect(id.get(4)).toBe(T0 + 40 - FIT_EPOCH);
  });

  it("record の値（尺度とずれ）、無い値は無効値", () => {
    const f = decodeFit(encodeActivityFit({ samples: samples(30), ascent: 12, created: T0, utcOffsetMin: 540 }));
    const r = ofType(f, MESG.record);
    const a = r[10].fields;
    expect(a.get(253)).toBe(T0 + 10 - FIT_EPOCH);
    expect(a.get(2)! / 5 - 500).toBeCloseTo(104, 1); // altitude
    expect(a.get(3)).toBe(120); // heart_rate
    expect(a.get(4)).toBe(88); // cadence
    expect(a.get(5)! / 100).toBeCloseTo(85, 2); // distance
    expect(a.get(6)! / 1000).toBeCloseTo(8.5, 3); // speed
    expect(a.get(7)).toBe(200); // power
    expect(a.get(9)! / 100).toBeCloseTo(4.7, 2); // grade (%)
    expect(r[0].fields.get(4)).toBe(0xff); // ケイデンスが無い
    // 位置が無い記録には position のフィールドを定義しない
    expect(a.has(0)).toBe(false);
  });

  it("session・lap・activity: 自転車の仮想の走行、合計", () => {
    const f = decodeFit(encodeActivityFit({ samples: samples(61), ascent: 24, created: T0, utcOffsetMin: 540 }));
    const s = ofType(f, MESG.session)[0].fields;
    expect(s.get(5)).toBe(SPORT_CYCLING);
    expect(s.get(6)).toBe(SUB_SPORT_VIRTUAL);
    expect(s.get(7)! / 1000).toBe(60); // total_elapsed_time
    expect(s.get(8)! / 1000).toBe(60); // total_timer_time
    expect(s.get(9)! / 100).toBeCloseTo(510, 1);
    expect(s.get(14)! / 1000).toBeCloseTo(8.5, 2);
    expect(s.get(18)).toBe(88); // avg_cadence（無い・0 を除く）
    expect(s.get(21)).toBe(245); // max_power
    expect(s.get(22)).toBe(24); // total_ascent
    expect(s.get(26)).toBe(1); // num_laps
    const lap = ofType(f, MESG.lap)[0].fields;
    expect(lap.get(25)).toBe(SPORT_CYCLING);
    expect(lap.get(39)).toBe(SUB_SPORT_VIRTUAL);
    const act = ofType(f, MESG.activity)[0].fields;
    expect(act.get(1)).toBe(1);
    expect(act.get(5)! - act.get(253)!).toBe(540 * 60);
  });

  it("間の空いた所でタイマーを止めて始める。タイマーの時間に入れない", () => {
    const f = decodeFit(encodeActivityFit({ samples: samples(40, { gapAt: 20 }), ascent: 0, created: T0, utcOffsetMin: 0 }));
    const ev = ofType(f, MESG.event).map((m) => m.fields.get(1));
    expect(ev).toEqual([0, 4, 0, 4]);
    const s = ofType(f, MESG.session)[0].fields;
    expect(s.get(7)! / 1000).toBe(39 + 60);
    expect(s.get(8)! / 1000).toBe(38);
    // 時刻は増えるだけ
    const ts = f.messages.filter((m) => m.fields.has(253)).map((m) => m.fields.get(253)!);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
  });

  it("位置（semicircles）", () => {
    const f = decodeFit(encodeActivityFit({ samples: samples(5, { pos: true }), ascent: 0, created: T0, utcOffsetMin: 0 }));
    const a = ofType(f, MESG.record)[2].fields;
    expect((a.get(0)! * 180) / 2 ** 31).toBeCloseTo(43.06002, 6);
    expect((a.get(1)! * 180) / 2 ** 31).toBeCloseTo(141.35, 6);
  });

  it("記録が無ければ書かない", () => {
    expect(() => encodeActivityFit({ samples: [], ascent: 0, created: T0, utcOffsetMin: 0 })).toThrow();
  });
});

function input(i: number, over: Partial<RecordInput> = {}): RecordInput {
  return { now: T0 * 1000 + i * 1000, odometer: 1000 + i * 7, climb: 50 + i * 0.2, speed: 7, power: 210, cadence: 90, heartRate: 130, altitude: 300, grade: 0.03, x: 100 + i * 7, z: 0, ...over };
}

describe("走行の記録", () => {
  it("1 秒に 1 回だけ残し、道のり・獲得標高は始めてからの差", () => {
    const r = new RideRecorder("generated");
    for (let i = 0; i < 10; i++) {
      r.record(input(i));
      r.record({ ...input(i), now: input(i).now + 500, odometer: input(i).odometer + 3.5, climb: input(i).climb + 0.1 });
    }
    expect(r.length).toBe(10);
    expect(r.totalDistance).toBeCloseTo(9 * 7 + 3.5, 6);
    expect(r.ascent).toBeCloseTo(9 * 0.2 + 0.1, 6);
    expect(r.samples()[0].t).toBe(T0);
    expect(r.timerSeconds).toBe(9);
  });

  it("記録しない間に進んだ道のりは数えない。総距離が 0 に戻っても数えない", () => {
    const r = new RideRecorder("generated");
    r.record(input(0));
    r.record(input(1));
    r.gap();
    r.record(input(5, { odometer: 5000 }));
    r.record(input(6, { odometer: 5007 }));
    expect(r.totalDistance).toBeCloseTo(14, 6);
    r.record(input(7, { odometer: 3 }));
    expect(r.totalDistance).toBeCloseTo(14, 6);
  });

  it("保存して戻す。壊れた物は null", () => {
    const r = new RideRecorder("hokkaido");
    for (let i = 0; i < 5; i++) r.record(input(i, { cadence: i ? 90 : null }));
    const back = RideRecorder.fromJSON(JSON.parse(JSON.stringify(r.toJSON())))!;
    expect(back.world).toBe("hokkaido");
    expect(back.samples()).toEqual(r.samples());
    expect(back.ascent).toBeCloseTo(r.ascent, 1);
    // 戻した後も同じ秒は残さない
    expect(back.record(input(4))).toBe(false);
    expect(back.record(input(5))).toBe(true);
    expect(RideRecorder.fromJSON({ v: 1, world: "x", cols: { t: [1], d: [] } })).toBeNull();
    expect(RideRecorder.fromJSON("x")).toBeNull();
  });

  it("上限を超えたら残さない", () => {
    const r = new RideRecorder("generated");
    for (let i = 0; i < MAX_SAMPLES + 5; i++) r.record(input(i));
    expect(r.length).toBe(MAX_SAMPLES);
    expect(r.full).toBe(true);
  });

  it("北海道の記録は緯度・経度を入れ、生成の世界は入れない", () => {
    const at = project(43.0596, 141.353);
    const h = new RideRecorder("hokkaido");
    const g = new RideRecorder("generated");
    for (let i = 0; i < 5; i++) {
      h.record(input(i, { x: at.x, z: at.z }));
      g.record(input(i, { x: at.x, z: at.z }));
    }
    const rh = ofType(decodeFit(recorderToFit(h, T0 * 1000)), MESG.record)[0].fields;
    expect((rh.get(0)! * 180) / 2 ** 31).toBeCloseTo(43.0596, 5);
    expect((rh.get(1)! * 180) / 2 ** 31).toBeCloseTo(141.353, 5);
    const rg = ofType(decodeFit(recorderToFit(g, T0 * 1000)), MESG.record)[0].fields;
    expect(rg.has(0)).toBe(false);
    expect(PROJ_ORIGIN.lat).toBe(43.06);
    expect(fitFileName(h)).toMatch(/^openworld-cycling-\d{8}-\d{4}\.fit$/);
  });
});
