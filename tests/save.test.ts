import { describe, expect, it } from "vitest";
import { DEFAULT_OUTFIT } from "../src/shared/outfit.ts";
import { DEFAULT_SETTINGS, parseSave, SAVE_VERSION, type SaveData } from "../src/shared/save.ts";
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
