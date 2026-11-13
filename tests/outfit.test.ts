import { describe, expect, it } from "vitest";
import { DEFAULT_OUTFIT, OUTFIT_VERSION, sanitizeOutfit, withOutfit } from "../src/shared/outfit.ts";

describe("自転車と装いの設定", () => {
  it("空や壊れた値からは既定値を作る", () => {
    for (const v of [undefined, null, 3, "x", [], {}, { bike: 1, rider: "a" }]) expect(sanitizeOutfit(v)).toEqual(DEFAULT_OUTFIT);
  });

  it("JSON を通しても同じ値に戻る", () => {
    const o = withOutfit(DEFAULT_OUTFIT, { bike: { frame: "aero", frameColor: "#2B4F8E" }, rider: { helmet: "aero", sockLength: "short" } });
    expect(o.bike.frameColor).toBe("#2b4f8e");
    expect(sanitizeOutfit(JSON.parse(JSON.stringify(o)))).toEqual(o);
  });

  it("知らない選択肢・色の形でない文字列は既定値に置き換え、読める項目は残す", () => {
    const o = sanitizeOutfit({ version: 99, bike: { frame: "tandem", frameColor: "red", wheels: "deep" }, rider: { skinColor: "#6e4630", extra: 1 } });
    expect(o.version).toBe(OUTFIT_VERSION);
    expect(o.bike.frame).toBe(DEFAULT_OUTFIT.bike.frame);
    expect(o.bike.frameColor).toBe(DEFAULT_OUTFIT.bike.frameColor);
    expect(o.bike.wheels).toBe("deep");
    expect(o.rider.skinColor).toBe("#6e4630");
    expect("extra" in o.rider).toBe(false);
  });

  it("withOutfit は元の設定を変えない", () => {
    const before = JSON.stringify(DEFAULT_OUTFIT);
    withOutfit(DEFAULT_OUTFIT, { rider: { jerseyPattern: "stripes" } });
    expect(JSON.stringify(DEFAULT_OUTFIT)).toBe(before);
  });
});
