// 冒険の乗り方（冒険の草案）: 帳簿と換算、運動の記録のファイルの読み取り、未走行の道でだけ減って尽きたら手前で止まる走行。

import { describe, expect, it } from "vitest";
import { ORIGIN, WORLD_SEED } from "../src/shared/world/constants.ts";
import { World } from "../src/shared/world/world.ts";
import { AdventureLedger, type ActivitySummary, START_BALANCE } from "../src/sim/adventure.ts";
import { AutoPower } from "../src/sim/power.ts";
import { Ride } from "../src/sim/ride.ts";
import { RoadNetwork } from "../src/sim/road-network.ts";
import { watchChoice } from "../src/sim/watch.ts";
import { encodeActivityFit } from "../src/shared/fit.ts";
import { fitCrc } from "../src/shared/fit.ts";
import { haversine, readActivityFile, readFitActivities, readGpx, readTcx, readZip, textSport } from "../src/shared/activity-file.ts";

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0) / 1000;
const run = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({ sport: "run", start: NOW - 3600, distance: 5000, seconds: 1800, source: "fit", ...over });

describe("冒険の距離の帳簿", () => {
  it("最初は 20km。ラン 5km で 50km 増える", () => {
    const l = new AdventureLedger(NOW - 86400);
    expect(l.balance).toBe(START_BALANCE);
    expect(l.add(run(), NOW)).toBe(50000);
    expect(l.balance).toBe(70000);
    expect(l.imports.length).toBe(1);
  });

  it("取り込まない記録: 自分の書き出し・種目なし・距離なし・7 日より前・先の日時・速すぎ・取り込み済み", () => {
    const l = new AdventureLedger(NOW - 86400);
    l.add(run(), NOW);
    const r = (a: ActivitySummary) => {
      const v = l.evaluate(a, NOW);
      return v.ok ? "ok" : v.reason;
    };
    expect(r(run({ own: true, start: NOW - 100 }))).toBe("own");
    expect(r(run({ sport: null, start: NOW - 100 }))).toBe("no-sport");
    expect(r(run({ distance: 0, start: NOW - 100 }))).toBe("no-distance");
    expect(r(run({ start: NOW - 86400 - 8 * 86400 }))).toBe("old");
    expect(r(run({ start: NOW - 86400 - 6 * 86400 }))).toBe("ok");
    expect(r(run({ start: NOW + 3600 }))).toBe("future");
    // 5km を 10 分（30km/h）のラン
    expect(r(run({ start: NOW - 100, seconds: 600 }))).toBe("fast");
    // Strava と Garmin から同じ記録（開始が 90 秒ずれた）
    expect(r(run({ start: NOW - 3600 + 90 }))).toBe("duplicate");
    // 同じ時刻でも種目が違えば別
    expect(r(run({ sport: "walk", start: NOW - 3600, seconds: 3600 }))).toBe("ok");
  });

  it("同じ取り込みの中の重複は、後の方を取り込まない", () => {
    const l = new AdventureLedger(NOW);
    const a = run();
    const b = run({ start: a.start + 30 });
    expect(l.evaluate(a, NOW, [a, b]).ok).toBe(true);
    expect(l.evaluate(b, NOW, [a, b]).ok).toBe(false);
  });

  it("種目ごとの倍率", () => {
    const l = new AdventureLedger(NOW);
    const credit = (sport: ActivitySummary["sport"], distance: number, seconds: number) => {
      const v = l.evaluate(run({ sport, distance, seconds }), NOW);
      return v.ok ? v.credit : -1;
    };
    expect(credit("walk", 3000, 2400)).toBe(18000);
    expect(credit("ride", 40000, 5400)).toBe(80000);
    expect(credit("swim", 1000, 1500)).toBe(40000);
    expect(credit("other", 1000, 600)).toBe(3000);
  });

  it("使う量は残りまで。保存して戻す", () => {
    const l = new AdventureLedger(NOW);
    l.spend(5000);
    expect(l.balance).toBe(15000);
    l.spend(99999);
    expect(l.balance).toBe(0);
    expect(l.spent).toBe(START_BALANCE);
    l.add(run(), NOW);
    const back = AdventureLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())))!;
    expect(back.balance).toBe(50000);
    expect(back.imports).toEqual(l.imports);
    expect(AdventureLedger.fromJSON({ mode: "x" })).toBeNull();
  });
});

// ---------- ファイル ----------

/** テスト用の FIT を組み立てる: 定義・データ・圧縮した時刻のヘッダ・開発者のフィールド・big endian を混ぜる */
function buildFit(opts: { manufacturer: number; sport: number; sub: number; start: number; distance: number; timer: number; noSession?: boolean }): Uint8Array {
  const b: number[] = [];
  const u16 = (x: number, big = false) => (big ? b.push((x >> 8) & 255, x & 255) : b.push(x & 255, (x >> 8) & 255));
  const u32 = (x: number, big = false) => (big ? b.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255) : b.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255));
  const ts = opts.start - 631065600;
  // file_id（局所 0、little）: type, manufacturer, product, 文字列の製品名（16 バイト。飛ばす）
  b.push(0x40, 0, 0);
  u16(0);
  b.push(4, 0, 1, 0x00, 1, 2, 0x84, 2, 2, 0x84, 8, 16, 0x07);
  b.push(0x00, 4);
  u16(opts.manufacturer);
  u16(1234);
  for (let i = 0; i < 16; i++) b.push(i < 5 ? 65 + i : 0);
  // record（局所 1、big endian、開発者のフィールド 1 つ 3 バイト）: timestamp, distance
  b.push(0x61, 0, 1);
  u16(20, true);
  b.push(2, 253, 4, 0x86, 5, 4, 0x86);
  b.push(1, 7, 3, 0);
  b.push(0x01);
  u32(ts, true);
  u32(Math.round(opts.distance * 50), true);
  b.push(9, 9, 9);
  // 圧縮した時刻のヘッダの record（局所 2: 距離だけ）
  b.push(0x42, 0, 0);
  u16(20);
  b.push(1, 5, 4, 0x86);
  b.push(0x80 | (2 << 5) | 5);
  u32(Math.round(opts.distance * 100));
  if (!opts.noSession) {
    // session（局所 3、little）: start_time, sport, sub_sport, total_elapsed, total_timer, total_distance
    b.push(0x43, 0, 0);
    u16(18);
    b.push(6, 2, 4, 0x86, 5, 1, 0x00, 6, 1, 0x00, 7, 4, 0x86, 8, 4, 0x86, 9, 4, 0x86);
    b.push(0x03);
    u32(ts);
    b.push(opts.sport, opts.sub);
    u32(opts.timer * 1000 + 60000);
    u32(opts.timer * 1000);
    u32(Math.round(opts.distance * 100));
  }
  const data = new Uint8Array(b);
  const out = new Uint8Array(14 + data.length + 2);
  const v = new DataView(out.buffer);
  v.setUint8(0, 14);
  v.setUint8(1, 0x20);
  v.setUint16(2, 2132, true);
  v.setUint32(4, data.length, true);
  out.set([0x2e, 0x46, 0x49, 0x54], 8);
  v.setUint16(12, fitCrc(out.subarray(0, 12)), true);
  out.set(data, 14);
  v.setUint16(14 + data.length, fitCrc(out.subarray(0, 14 + data.length)), true);
  return out;
}

describe("FIT の読み取り", () => {
  it("session の合計（ほかの機器の書き方: 文字列・big endian・開発者のフィールド・圧縮した時刻のヘッダ）", () => {
    const [a] = readFitActivities(buildFit({ manufacturer: 1, sport: 1, sub: 0, start: NOW - 3600, distance: 10012.5, timer: 3000 }));
    expect(a).toMatchObject({ sport: "run", start: NOW - 3600, distance: 10012.5, seconds: 3000, own: false });
  });

  it("屋内の自転車・ウォーキング・ハイキング", () => {
    expect(readFitActivities(buildFit({ manufacturer: 1, sport: 2, sub: 58, start: NOW, distance: 1, timer: 1 }))[0].sport).toBe("ride-indoor");
    expect(readFitActivities(buildFit({ manufacturer: 1, sport: 2, sub: 7, start: NOW, distance: 1, timer: 1 }))[0].sport).toBe("ride");
    expect(readFitActivities(buildFit({ manufacturer: 1, sport: 11, sub: 0, start: NOW, distance: 1, timer: 1 }))[0].sport).toBe("walk");
    expect(readFitActivities(buildFit({ manufacturer: 1, sport: 17, sub: 0, start: NOW, distance: 1, timer: 1 }))[0].sport).toBe("walk");
  });

  it("session が無ければ record の最後の距離と時刻", () => {
    const [a] = readFitActivities(buildFit({ manufacturer: 1, sport: 1, sub: 0, start: NOW, distance: 4200, timer: 1, noSession: true }));
    expect(a.distance).toBe(4200);
    expect(a.sport).toBeNull();
  });

  it("このアプリが書き出した FIT は own", () => {
    const bytes = encodeActivityFit({
      samples: [0, 1, 2].map((i) => ({ t: NOW + i, distance: i * 8, speed: 8, power: 200, cadence: 90, heartRate: 130, altitude: 10, grade: 0, lat: null, lon: null })),
      ascent: 0,
      created: NOW,
      utcOffsetMin: 540,
    });
    const [a] = readFitActivities(bytes);
    expect(a.own).toBe(true);
    expect(a.sport).toBe("ride-indoor");
  });

  it("FIT でない物は例外", () => {
    expect(() => readFitActivities(new Uint8Array(20))).toThrow();
  });
});

describe("GPX・TCX の読み取り", () => {
  // 北へ 0.001 度ずつ（約 111.2m）、10 秒おき。途中で 2 分止まる
  const pts = (n: number, gapAt: number) => {
    let t = Date.UTC(2026, 10, 21, 0, 0, 0);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i === gapAt) t += 120000;
      out.push(`<trkpt lat="${(43 + i * 0.001).toFixed(6)}" lon="141.35"><ele>10</ele><time>${new Date(t).toISOString()}</time></trkpt>`);
      t += 10000;
    }
    return out.join("\n");
  };

  it("GPX: 距離は点の間の大円の距離の和、時間は止まっていた所を除く、種目は type", () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>朝</name><type>running</type><trkseg>${pts(21, 10)}</trkseg></trk></gpx>`;
    const [a] = readGpx(gpx);
    expect(a.sport).toBe("run");
    expect(a.distance).toBeCloseTo(20 * haversine(43, 141.35, 43.001, 141.35), 3);
    expect(a.distance).toBeGreaterThan(2200);
    expect(a.distance).toBeLessThan(2250);
    expect(a.seconds).toBe(190);
    expect(a.start).toBe(Date.UTC(2026, 10, 21, 0, 0, 0) / 1000);
    // 種目の無い GPX は null（取り込む時に選ぶ）
    expect(readGpx(gpx.replace(/<type>.*<\/type>/, ""))[0].sport).toBeNull();
  });

  it("文字の種目", () => {
    expect(textSport("Running")).toBe("run");
    expect(textSport("VirtualRide")).toBe("ride-indoor");
    expect(textSport("Biking")).toBe("ride");
    expect(textSport("hiking")).toBe("walk");
    expect(textSport("1")).toBe("run");
    expect(textSport("Other")).toBe("other");
  });

  it("TCX: 周回の合計（Track の中の点ごとの距離は足さない）", () => {
    const lap = (start: string, d: number, s: number) =>
      `<Lap StartTime="${start}"><TotalTimeSeconds>${s}</TotalTimeSeconds><DistanceMeters>${d}</DistanceMeters><Track><Trackpoint><DistanceMeters>99999</DistanceMeters></Trackpoint></Track></Lap>`;
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="x"><Activities><Activity Sport="Running"><Id>2026-11-21T00:00:00Z</Id>${lap("2026-11-21T00:00:00Z", 1000, 300)}${lap("2026-11-21T00:05:00Z", 1500.5, 420)}</Activity></Activities></TrainingCenterDatabase>`;
    const [a] = readTcx(tcx);
    expect(a).toMatchObject({ sport: "run", distance: 2500.5, seconds: 720, start: Date.UTC(2026, 10, 21) / 1000 });
  });
});

/** テスト用の zip（1 つ目は保存、2 つ目は deflate） */
async function buildZip(files: { name: string; bytes: Uint8Array; deflate: boolean }[]): Promise<Uint8Array> {
  const parts: number[] = [];
  const central: number[] = [];
  const enc = new TextEncoder();
  const u16 = (a: number[], x: number) => a.push(x & 255, (x >> 8) & 255);
  const u32 = (a: number[], x: number) => a.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255);
  for (const f of files) {
    const data = f.deflate ? new Uint8Array(await new Response(new Blob([new Uint8Array(f.bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()) : f.bytes;
    const name = enc.encode(f.name);
    const offset = parts.length;
    u32(parts, 0x04034b50);
    u16(parts, 20);
    u16(parts, 0);
    u16(parts, f.deflate ? 8 : 0);
    u32(parts, 0);
    u32(parts, 0); // CRC32（読む側は見ない）
    u32(parts, data.length);
    u32(parts, f.bytes.length);
    u16(parts, name.length);
    u16(parts, 0);
    parts.push(...name, ...data);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, f.deflate ? 8 : 0);
    u32(central, 0);
    u32(central, 0);
    u32(central, data.length);
    u32(central, f.bytes.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }
  const cdOffset = parts.length;
  const eocd: number[] = [];
  u32(eocd, 0x06054b50);
  u16(eocd, 0);
  u16(eocd, 0);
  u16(eocd, files.length);
  u16(eocd, files.length);
  u32(eocd, central.length);
  u32(eocd, cdOffset);
  u16(eocd, 0);
  return new Uint8Array([...parts, ...central, ...eocd]);
}

describe("zip", () => {
  it("Garmin Connect の書き出しのような zip の中の FIT と、deflate した GPX を読む", async () => {
    const fit = buildFit({ manufacturer: 1, sport: 1, sub: 0, start: NOW - 3600, distance: 8000, timer: 2400 });
    const gpx = new TextEncoder().encode(
      `<gpx><trk><type>walking</type><trkseg><trkpt lat="43" lon="141"><time>2026-11-21T00:00:00Z</time></trkpt><trkpt lat="43.01" lon="141"><time>2026-11-21T00:00:10Z</time></trkpt></trkseg></trk></gpx>`,
    );
    const zip = await buildZip([
      { name: "12345_ACTIVITY.fit", bytes: fit, deflate: false },
      { name: "walk.gpx", bytes: gpx, deflate: true },
      { name: "readme.txt", bytes: new TextEncoder().encode("x"), deflate: false },
    ]);
    expect((await readZip(zip)).map((f) => f.name)).toEqual(["12345_ACTIVITY.fit", "walk.gpx", "readme.txt"]);
    const acts = await readActivityFile("export.zip", zip);
    expect(acts.map((a) => a.sport)).toEqual(["run", "walk"]);
    expect(acts[0].distance).toBe(8000);
  });

  it("どれでもないファイルは例外", async () => {
    await expect(readActivityFile("a.txt", new TextEncoder().encode("hello"))).rejects.toThrow();
  });
});

// ---------- 走行 ----------

function network(r = 5000) {
  const w = new World(WORLD_SEED);
  const reg = w.region({ x0: ORIGIN.x - r, z0: ORIGIN.z - r, x1: ORIGIN.x + r, z1: ORIGIN.z + r });
  const net = new RoadNetwork();
  for (const road of reg.roads) net.addRoad(road);
  for (const j of reg.junctions) net.addJunction(j);
  for (const n of reg.nodes) net.nodes.set(n.id, n);
  return net;
}

describe("冒険の走行", () => {
  const net = network();
  const start = [...net.roads.values()].filter((r) => r.cls === 0 && r.length > 600).sort((a, b) => (a.id < b.id ? -1 : 1))[0];

  it("未走行の道で減り、尽きたら手前で止まる。足すとまた進む。走った道を戻る時は減らない", () => {
    const ledger = new AdventureLedger(NOW);
    ledger.balance = 60;
    const ride = new Ride(net, { road: start.id, s: 100, dir: 1 }, new AutoPower(250));
    ride.adventure = ledger;
    for (let i = 0; i < 120 * 60; i++) ride.step();
    expect(ride.speed).toBe(0);
    expect(ride.blocked).toBe(true);
    expect(ledger.balance).toBeLessThan(0.6);
    expect(ride.odometer).toBeGreaterThan(55);
    expect(ride.odometer).toBeLessThan(61);
    // 止まる時はブレーキで減速した（速いまま急に止まらない）
    ledger.balance += 200;
    for (let i = 0; i < 120 * 120; i++) ride.step();
    expect(ride.blocked).toBe(true);
    expect(ride.odometer).toBeGreaterThan(250);
    expect(ride.odometer).toBeLessThan(262);
    const spent = ledger.spent;
    // U ターンして走った道を戻る: 減らない・止まらない
    expect(ride.uTurn()).toBe(true);
    const odo = ride.odometer;
    let maxSpeed = 0;
    for (let i = 0; i < 120 * 40; i++) {
      ride.step();
      maxSpeed = Math.max(maxSpeed, ride.speed);
    }
    expect(ride.odometer - odo, `最高 ${maxSpeed.toFixed(1)} m/s、勾配 ${ride.grade.toFixed(3)}`).toBeGreaterThan(150);
    expect(ledger.spent).toBeCloseTo(spent, 6);
    expect(ride.blocked).toBe(false);
  });

  it("冒険でなければ止まらない", () => {
    const ride = new Ride(net, { road: start.id, s: 100, dir: 1 }, new AutoPower(250));
    for (let i = 0; i < 120 * 30; i++) ride.step();
    expect(ride.odometer).toBeGreaterThan(200);
    expect(ride.blocked).toBe(false);
  });

  it("眺める乗り方: 冒険の距離がほとんど無ければ走った道を選ぶ", () => {
    // 接続点の手前まで走って候補を出す
    const ride = new Ride(net, { road: start.id, s: 5, dir: 1 }, new AutoPower(250));
    let u = ride.upcoming;
    for (let i = 0; i < 120 * 600 && !(u && u.choices.length >= 2); i++) {
      ride.step();
      u = ride.upcoming;
    }
    expect(u && u.choices.length >= 2).toBe(true);
    // 既定でない候補の先だけを走ったことにする
    const other = u!.choices.findIndex((_, i) => i !== u!.defaultIndex);
    const c = u!.choices[other];
    for (let d = 0; d <= 400; d += 5) ride.ridden.mark(c.arm.road, c.arm.s + c.arm.dir * d);
    expect(watchChoice(u!, "unridden", ride.ridden, net, 50)).toBe(other);
    expect(watchChoice(u!, "unridden", ride.ridden, net, null)).not.toBe(other);
  });
});
