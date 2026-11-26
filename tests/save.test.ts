import { describe, expect, it } from "vitest";
import { DEFAULT_OUTFIT } from "../src/shared/outfit.ts";
import { DEFAULT_SETTINGS, parseSave, SAVE_VERSION, type SaveData, START_MONEY } from "../src/shared/save.ts";
import { RiddenLog } from "../src/sim/ridden.ts";
import { POWER_MAX } from "../src/sim/power.ts";

describe("保存データ（モック仕様 7.3）", () => {
  const data: SaveData = {
    version: SAVE_VERSION,
    generator: 4,
    savedAt: "2026-11-13T10:00:00.000Z",
    pos: { road: "n_-9_2~n_-8_2", s: 123.4, dir: -1, x: -32400, z: 11260 },
    odometer: 12345,
    climb: 210,
    time: 3600,
    ridden: { a: [0, 3, 7, 7] },
    stamps: [{ poi: "c_1", name: "喫茶 葛", date: "2026-11-13", visits: 2, x: 1, z: 2, elevation: 120, road: "a", s: 30 }],
    settings: { ...DEFAULT_SETTINGS, power: 220, muted: true },
    outfit: DEFAULT_OUTFIT,
    watching: true,
    adventure: { mode: "adventure", since: 1795000000, balance: 12345.6, spent: 7654.4, imports: [{ id: "fit:run:1795000100", sport: "run", start: 1795000100, distance: 5000, seconds: 1800, credit: 50000, source: "fit" }], journey: { startedAt: 1795001000, lastSimulated: 1795002000 }, lastJourney: null },
    work: { money: 2340, delivered: 5, onTime: 4, stamina: { legs: 9000, energy: 800000 }, guide: "route", routeStyle: "flat", app: false, regulars: { "3011": 4, "77": 1 }, economy: null, gear: "carrier", bike: { tire: 0.5, chain: 0.75, brake: 1 }, car: { kei: { fuel: 12.5, tire: 0.9, oil: 1, brake: 0.8 } }, carMods: { van: { shelf: true, winter: false, paint: "#c8323f" } } },
  };

  it("書いて読むと同じ", () => {
    expect(parseSave(JSON.stringify(data))).toEqual(data);
  });

  it("壊れたデータ・空は null、足りない項目は既定値", () => {
    expect(parseSave(null)).toBeNull();
    expect(parseSave("{")).toBeNull();
    expect(parseSave("[]")).toBeNull();
    const p = parseSave(JSON.stringify({ version: 1, settings: { power: 9999, quality: "ultra" }, stamps: [{ poi: 1 }, data.stamps[0]] }))!;
    expect(p.pos).toBeNull();
    expect(p.odometer).toBe(0);
    expect(p.settings.power).toBe(POWER_MAX);
    expect(p.settings.sway).toBe(300);
    expect(p.settings.quality).toBeNull();
    expect(p.stamps).toHaveLength(1);
    expect(p.outfit).toEqual(DEFAULT_OUTFIT);
    expect(p.work).toBeNull();
    // 仕事の記録の壊れた項目は既定値
    const w = parseSave(JSON.stringify({ version: 1, work: { money: "x", guide: "auto", routeStyle: 3, stamina: { legs: 1 } } }))!.work!;
    expect(w.money).toBe(START_MONEY);
    expect(w.guide).toBe("none");
    expect(w.routeStyle).toBe("short");
    expect(w.stamina).toBeNull();
    expect(w.app).toBe(true);
    expect(w.regulars).toEqual({});
    // 店ごとの件数は数の正しい物だけ残す
    const r = parseSave(JSON.stringify({ version: 1, work: { regulars: { a: 2.4, b: -1, c: "3", d: 0 } } }))!.work!;
    expect(r.regulars).toEqual({ a: 2 });
  });
});

describe("走った区間", () => {
  it("10m の区切りで記録し、保存して戻すと同じ", () => {
    const log = new RiddenLog();
    for (let s = 0; s < 45; s += 0.3) log.mark("a", s);
    log.mark("a", 105);
    log.mark("b", 12);
    expect(log.runs("a")).toEqual([
      [0, 50],
      [100, 110],
    ]);
    const back = RiddenLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
    expect(back.runs("a")).toEqual(log.runs("a"));
    expect(back.has("b", 15)).toBe(true);
    expect(back.has("b", 25)).toBe(false);
    expect(log.fraction("a", 120)).toBeCloseTo(0.5);
  });
});
