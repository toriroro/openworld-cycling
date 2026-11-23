import { describe, expect, it } from "vitest";
import { AddressBook, type AddressPoint, gridIndex, parseAddressName } from "../src/shared/world/address.ts";
import { Delivery, DROP_RANGE, HANDOVER_S, makeOrder, orderLimit, PICKUP_RANGE, stoppedAt } from "../src/shared/delivery.ts";

/** 札幌の碁盤に似せた丁目の点: 1 丁目 120m・1 条 140m、傾きなし。北が −z、東が +x */
function grid(): AddressPoint[] {
  const out: AddressPoint[] = [];
  for (let n = -6; n <= 6; n++)
    for (let e = -8; e <= 4; e++) {
      if (e === 0) continue;
      const ns = n > 0 ? "北" : n < 0 ? "南" : "大通";
      const ew = e > 0 ? "東" : "西";
      const name = n === 0 ? `大通${ew}${Math.abs(e)}丁目` : `${ns}${Math.abs(n)}条${ew}${Math.abs(e)}丁目`;
      out.push({ name, x: (e - Math.sign(e) * 0.5) * 120, z: -n * 140, ...parseAddressName(name)! });
    }
  return out;
}

describe("住所", () => {
  it("碁盤の住所を読む", () => {
    expect(parseAddressName("北3条西4丁目")).toEqual({ ns: "北", jo: 3, ew: "西", chome: 4 });
    expect(parseAddressName("南12条東2丁目")).toEqual({ ns: "南", jo: 12, ew: "東", chome: 2 });
    expect(parseAddressName("大通西6丁目")).toEqual({ ns: "大通", jo: 0, ew: "西", chome: 6 });
    expect(parseAddressName("宮の森1条10丁目")).toBeNull();
    expect(parseAddressName("中島公園")).toBeNull();
    expect(gridIndex({ name: "", x: 0, z: 0, ...parseAddressName("南2条西3丁目")! })).toEqual({ n: -2, e: -3 });
  });

  it("位置の住所はいちばん近い丁目の点", () => {
    const book = new AddressBook(grid());
    const p = book.byName.get("北3条西4丁目")!;
    expect(book.at(p.x + 40, p.z - 50)).toBe(p);
    expect(book.at(p.x + 80, p.z)?.name).toBe("北3条西3丁目");
    expect(book.at(99999, 99999)).toBeNull();
  });
});

describe("注文", () => {
  const pts = grid();
  const book = new AddressBook(pts);

  it("受け取りと届け先の距離が範囲に入り、同じ種なら同じ注文", () => {
    for (let no = 1; no <= 30; no++) {
      const o = makeOrder(pts, 0, 0, no, 12345)!;
      expect(o).not.toBeNull();
      expect(o.approach).toBeGreaterThanOrEqual(PICKUP_RANGE[0]);
      expect(o.approach).toBeLessThanOrEqual(PICKUP_RANGE[1]);
      expect(o.distance).toBeGreaterThanOrEqual(DROP_RANGE[0]);
      expect(o.distance).toBeLessThanOrEqual(DROP_RANGE[1]);
      expect(o.pickup).not.toBe(o.dropoff);
      expect(o.limit).toBe(orderLimit(o.approach, o.distance));
      expect(makeOrder(pts, 0, 0, no, 12345)).toEqual(o);
    }
  });

  it("候補が無ければ null", () => {
    expect(makeOrder(pts, 50000, 50000, 1, 1)).toBeNull();
  });

  it("止まった所の左右に丁目があれば着いた。走っている間は着かない", () => {
    const t = book.byName.get("北1条西2丁目")!;
    // 丁目の点の 60m 東の、南北の道を北へ走っている（左が西 = その丁目）
    const pose = { x: t.x + 62, z: t.z, dx: 0, dz: -1 };
    expect(stoppedAt(book, t, pose, 0)).toBe(true);
    expect(stoppedAt(book, t, pose, 3)).toBe(false);
    // 2 本離れた道では着かない
    expect(stoppedAt(book, t, { ...pose, x: t.x + 62 + 120 }, 0)).toBe(false);
  });

  it("受け取ってから届けると結果が出る。遅れると報酬が減る", () => {
    const o = makeOrder(pts, 0, 0, 3, 99)!;
    const run = (arriveAt: number) => {
      const d = new Delivery(o, 100, 0);
      const side = (p: AddressPoint) => ({ x: p.x + 62, z: p.z, dx: 0, dz: -1 });
      expect(d.update(book, side(o.dropoff), 0, 120, 0)).toBeNull(); // 受け取る前に届け先へ行っても何も起きない
      expect(d.update(book, side(o.pickup), 0, 130, 500)).toBe("picked");
      const r = d.update(book, side(o.dropoff), 0, arriveAt, 2000);
      if (!r || r === "picked") throw new Error("届かない");
      return r;
    };
    const ok = run(100 + 60);
    expect(ok.late).toBe(false);
    expect(ok.reward).toBe(o.reward);
    expect(ok.elapsed).toBe(60 + 2 * HANDOVER_S);
    expect(ok.ridden).toBe(2000);
    const late = run(100 + o.limit + 1);
    expect(late.late).toBe(true);
    expect(late.reward).toBeLessThan(o.reward);
  });
});
