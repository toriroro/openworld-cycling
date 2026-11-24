import { describe, expect, it } from "vitest";
import { parseSave } from "../src/shared/save.ts";
import { CLOUDY_AT, DAY_MS, FOG_AT, GAME_SPEED, MONTH_DAYS, weatherAt, worldDay, worldHour } from "../src/shared/world/weather.ts";

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);

describe("世界の時計（概要仕様 3.7）", () => {
  it("現実の 1 日 = 世界の 1 週間。世界の 1 日は約 3 時間 26 分で、0〜24 時を回る（配達の草案 17 章）", () => {
    expect(GAME_SPEED).toBe(7);
    expect(DAY_MS * 7).toBe(24 * 3600e3);
    const h0 = worldHour(T0);
    expect(h0).toBeGreaterThanOrEqual(0);
    expect(h0).toBeLessThan(24);
    // 実時間 60 分 = 世界の 7 時間
    expect(worldHour(T0 + 60 * 60e3)).toBeCloseTo((h0 + 7) % 24, 6);
    expect(worldHour(T0 + DAY_MS)).toBeCloseTo(h0, 6);
    expect(worldHour(-1 - 9 * 3600e3)).toBeGreaterThan(23.99);
  });

  it("日本時間の 0 時に世界は月曜 0 時。現実の 1 日で月曜から日曜まで、1 か月 = 現実の 4 日", () => {
    // 2026-11-24 0:00 JST = 2026-11-23 15:00 UTC
    const midnight = Date.UTC(2026, 10, 23, 15, 0, 0);
    expect(worldHour(midnight)).toBeCloseTo(0, 6);
    expect(worldDay(midnight).weekday).toBe("月");
    expect(worldDay(midnight + 1).weekday).toBe("月");
    expect(worldDay(midnight - 1).weekday).toBe("日");
    expect(worldDay(midnight + 3 * DAY_MS + 1).weekday).toBe("木");
    expect(worldDay(midnight + 24 * 3600e3 - 1).weekday).toBe("日");
    expect(worldDay(midnight + 24 * 3600e3).day - worldDay(midnight).day).toBe(7);
    expect(MONTH_DAYS * DAY_MS).toBe(4 * 24 * 3600e3);
    // 正午 JST は世界の木曜 12 時
    const noon = midnight + 12 * 3600e3;
    expect(worldDay(noon).weekday).toBe("木");
    expect(worldHour(noon)).toBeCloseTo(12, 6);
  });
});

describe("天候（概要仕様 3.7）", () => {
  it("同じ場所・同じ時刻なら同じ。分け方は値の境目どおり", () => {
    for (let i = 0; i < 200; i++) {
      const x = -50000 + i * 517, z = 30000 - i * 263, ms = T0 + i * 7.7e6;
      const a = weatherAt(x, z, ms);
      expect(weatherAt(x, z, ms)).toEqual(a);
      expect(a.cloud).toBeGreaterThanOrEqual(0);
      expect(a.cloud).toBeLessThanOrEqual(1);
      expect(a.fog).toBeGreaterThanOrEqual(0);
      expect(a.fog).toBeLessThanOrEqual(1);
      expect(a.kind).toBe(a.fog >= FOG_AT ? "fog" : a.cloud >= CLOUDY_AT ? "cloudy" : "clear");
    }
  });

  it("晴れ・曇り・霧がどれも出る。霧は昼より朝に多い", () => {
    const c = { clear: 0, cloudy: 0, fog: 0 };
    let fogMorning = 0, fogNoon = 0, nMorning = 0, nNoon = 0;
    for (let i = 0; i < 30; i++)
      for (let j = 0; j < 30; j++)
        for (let k = 0; k < 24; k++) {
          const ms = T0 + k * 2.3 * 3600e3 + i * 977 + j * 13;
          const w = weatherAt(-60000 + i * 3100, -60000 + j * 2900, ms);
          c[w.kind]++;
          const h = worldHour(ms);
          if (h >= 4 && h < 8) (nMorning++, w.kind === "fog" && fogMorning++);
          if (h >= 12 && h < 16) (nNoon++, w.kind === "fog" && fogNoon++);
        }
    const n = c.clear + c.cloudy + c.fog;
    expect(c.clear / n).toBeGreaterThan(0.35);
    expect(c.cloudy / n).toBeGreaterThan(0.2);
    expect(c.fog / n).toBeGreaterThan(0.05);
    expect(c.fog / n).toBeLessThan(0.25);
    expect(fogMorning / nMorning).toBeGreaterThan((fogNoon / nNoon) * 3);
  });

  it("場所と時刻で少しずつしか変わらない（100m・1 分で雲の量の差が小さい）", () => {
    for (let i = 0; i < 300; i++) {
      const x = i * 1733 - 200000, z = i * -911, ms = T0 + i * 3.1e6;
      const a = weatherAt(x, z, ms);
      expect(Math.abs(weatherAt(x + 100, z, ms).cloud - a.cloud)).toBeLessThan(0.05);
      expect(Math.abs(weatherAt(x, z, ms + 60e3).cloud - a.cloud)).toBeLessThan(0.05);
    }
  });
});

describe("保存の設定", () => {
  it("時刻と天候の設定。前の版の保存（項目なし）は世界の時計・世界の天候", () => {
    const old = parseSave(JSON.stringify({ version: 1, settings: { hour: 9 } }))!;
    expect(old.settings.clock).toBe("world");
    expect(old.settings.weather).toBe("world");
    expect(old.settings.hour).toBe(9);
    const s = parseSave(JSON.stringify({ version: 1, settings: { clock: "fixed", hour: 6.5, weather: "fog" } }))!;
    expect(s.settings).toMatchObject({ clock: "fixed", hour: 6.5, weather: "fog" });
    expect(parseSave(JSON.stringify({ version: 1, settings: { clock: "x", weather: "rain" } }))!.settings).toMatchObject({ clock: "world", weather: "world" });
  });
});
