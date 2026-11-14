import { describe, expect, it } from "vitest";
import { parseSave } from "../src/shared/save.ts";
import { CLOUDY_AT, DAY_MS, FOG_AT, weatherAt, worldHour } from "../src/shared/world/weather.ts";

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);

describe("世界の時計（概要仕様 3.7）", () => {
  it("1 日は実時間 4 時間で、0〜24 時を回る", () => {
    expect(DAY_MS).toBe(4 * 3600e3);
    const h0 = worldHour(T0);
    expect(h0).toBeGreaterThanOrEqual(0);
    expect(h0).toBeLessThan(24);
    // 実時間 10 分 = 世界の 1 時間
    expect(worldHour(T0 + 10 * 60e3)).toBeCloseTo((h0 + 1) % 24, 9);
    expect(worldHour(T0 + DAY_MS)).toBeCloseTo(h0, 9);
    expect(worldHour(-1)).toBeGreaterThan(23.99);
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
