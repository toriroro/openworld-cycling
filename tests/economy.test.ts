import { describe, expect, it } from "vitest";
import { advance, allocate, Arena, CATCHUP_FULL, createEconomy, MONTH, recordPlayer, sanitizeEconomy, SELF, stepDay, territory } from "../src/shared/economy.ts";
import { AddressBook, type AddressPoint } from "../src/shared/world/address.ts";
import { Market } from "../src/sim/market.ts";

/** 120m 四方の丁目を 30 × 30 並べた町（3.6km 四方、中心が原点） */
function town() {
  const pts: AddressPoint[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) pts.push({ name: `c${i}_${j}`, x: (i - 15) * 120 + 60, z: (j - 15) * 120 + 60 });
  const book = new AddressBook(pts);
  const rect = { x0: -1800, z0: -1800, x1: 1800, z1: 1800 };
  return { pts, arena: new Arena(pts, rect, { x: 0, z: 0 }, (x, z) => book.at(x, z), 42, 40) };
}

describe("経済の場（配達の草案 18 章）", () => {
  const { arena } = town();
  const TODAY = 20_000;

  it("丁目の面積は升で数え、町の中心ほど注文が多い", () => {
    expect(arena.chomes).toHaveLength(900);
    const total = arena.chomes.reduce((s, c) => s + c.area, 0);
    expect(total).toBeCloseTo(3600 * 3600, -3);
    const mid = arena.chomes[arena.index.get("c15_15")!];
    const edge = arena.chomes[arena.index.get("c0_0")!];
    expect(mid.area).toBeCloseTo(120 * 120, -2);
    expect(mid.base).toBeGreaterThan(edge.base);
  });

  it("同じ種なら同じ経済。始めから 8 社と 1 か月分の記録がある", () => {
    const a = createEconomy(arena, 7, TODAY);
    const b = createEconomy(arena, 7, TODAY);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.day).toBe(TODAY - 1);
    expect(a.history).toHaveLength(MONTH);
    const open = a.companies.filter((c) => c.closed === null);
    expect(open.length).toBeGreaterThanOrEqual(7);
    expect(new Set(open.map((c) => c.name)).size).toBe(open.length);
    for (const c of open) expect(c.depots.length).toBeGreaterThan(0);
  });

  it("注文は取りやすさの比で分かれ、運べない分はあふれる", () => {
    const snaps = [
      { id: "a", depots: ["c15_15"], staff: 50, trust: 1, price: 520, policy: "fast" as const },
      { id: "b", depots: ["c2_2"], staff: 1, trust: 1, price: 520, policy: "fast" as const },
    ];
    const al = allocate(arena, snaps, TODAY, 1);
    const ci = arena.index.get("c15_15")!;
    const ce = arena.index.get("c2_2")!;
    // 営業所の近くはその業者がほとんど取る
    expect(al.served[ci * 2]).toBeGreaterThan(al.served[ci * 2 + 1] * 5);
    // 配達員 1 人の業者は 22 件しか運べない
    expect(al.total[1]).toBeLessThanOrEqual(22 + 1e-9);
    expect(al.lost[1]).toBeGreaterThan(0);
    expect(al.served[ce * 2 + 1]).toBeGreaterThan(0);
    expect(al.revenue[0]).toBeCloseTo(al.total[0] * 520, 6);
  });

  it("縄張り: 丁目ごとに直近 1 か月の件数が最多の業者が持つ。売上は 1 週 ≤ 1 か月", () => {
    const s = createEconomy(arena, 7, TODAY);
    const t = territory(arena, s, TODAY, new Map());
    const owned = t.entities.reduce((n, e) => n + e.chomes, 0);
    expect(owned).toBeGreaterThan(800);
    for (const e of t.entities) expect(e.salesWeek).toBeLessThanOrEqual(e.salesMonth);
    // 同じ条件の 2 社なら、それぞれの営業所の周りをそれぞれが持つ
    const two = createEconomy(arena, 7, TODAY);
    const snap = (id: string, depot: string) => ({ id, depots: [depot], staff: 10, trust: 1, price: 520, policy: "fast" as const });
    two.companies = two.companies.slice(0, 2);
    two.companies[0].depots = ["c5_15"];
    two.companies[1].depots = ["c24_15"];
    two.history = two.history.map((h) => ({ day: h.day, snaps: [snap(two.companies[0].id, "c5_15"), snap(two.companies[1].id, "c24_15")] }));
    const t2 = territory(arena, two, TODAY, new Map());
    const ownerName = (n: string) => t2.entities[t2.owner[arena.index.get(n)!]].id;
    expect(ownerName("c5_15")).toBe(two.companies[0].id);
    expect(ownerName("c6_16")).toBe(two.companies[0].id);
    expect(ownerName("c24_15")).toBe(two.companies[1].id);
    expect(ownerName("c23_14")).toBe(two.companies[1].id);
  });

  it("プレイヤーの配達は所属の業者の件数に入る。個人でも 1 か所に多く届ければその丁目を持つ", () => {
    const s = createEconomy(arena, 7, TODAY);
    const name = "c0_29";
    for (let i = 0; i < 400; i++) recordPlayer(s, TODAY, name, 500);
    let t = territory(arena, s, TODAY, new Map());
    expect(t.entities[t.owner[arena.index.get(name)!]].id).toBe(SELF);
    const self = t.entities.find((e) => e.id === SELF)!;
    expect(self.salesWeek).toBe(400 * 500);
    // 所属すると、その業者の件数になる
    const co = s.companies.find((c) => c.closed === null)!;
    s.player.company = co.id;
    for (let i = 0; i < 800; i++) recordPlayer(s, TODAY, name, 500);
    t = territory(arena, s, TODAY, new Map());
    expect(t.entities[t.owner[arena.index.get(name)!]].id).toBe(co.id);
    expect(t.entities.find((e) => e.id === co.id)!.staff).toBe(co.staff + 1);
  });

  it("資金がマイナスのまま 1 か月で廃業し、業者が減ると新しい業者が開業する", () => {
    const s = createEconomy(arena, 7, TODAY);
    const victim = s.companies.find((c) => c.closed === null)!;
    victim.cash = -1e12;
    let day = 0;
    for (let i = 0; i < MONTH; i++) {
      stepDay(arena, s);
      day = s.day;
    }
    expect(victim.closed).toBe(day);
    advance(arena, s, s.day + 60);
    const open = s.companies.filter((c) => c.closed === null).length;
    expect(open).toBeGreaterThanOrEqual(7);
    expect(open).toBeLessThanOrEqual(12);
  });

  it("長く閉じていた分は、上限より前を営業所・配達員を変えずに進める", () => {
    const s = createEconomy(arena, 7, TODAY);
    const before = JSON.stringify(s.companies.map((c) => [c.depots, c.staff]));
    // 上限より前の日だけ進める（凍結）
    for (let i = 0; i < 20; i++) stepDay(arena, s, true);
    expect(JSON.stringify(s.companies.filter((c) => c.closed === null).map((c) => [c.depots, c.staff]))).toBe(before);
    const t0 = performance.now();
    const n = advance(arena, s, s.day + 200);
    expect(n).toBe(200);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(s.history).toHaveLength(MONTH);
    expect(CATCHUP_FULL).toBe(7);
  });

  it("保存して読み直すと同じ。市場は読み直した経済から同じ縄張りを出す", () => {
    const s = createEconomy(arena, 7, TODAY);
    recordPlayer(s, TODAY, "c3_3", 640);
    const back = sanitizeEconomy(JSON.parse(JSON.stringify(s)))!;
    expect(back).toEqual(s);
    expect(sanitizeEconomy({ v: 2 })).toBeNull();
    const m1 = new Market(arena, 7, TODAY, s);
    const m2 = new Market(arena, 7, TODAY, back);
    expect(Array.from(m2.now.owner)).toEqual(Array.from(m1.now.owner));
    // 日が変わると進めて、昨日との差を出せる
    expect(m1.update(TODAY + 2)).toBe(2);
    expect(m1.changedSinceYesterday()).toBeGreaterThanOrEqual(0);
    expect(m1.record(TODAY + 2, "c3_3", 500)).toBe(true);
    expect(m1.record(TODAY + 2, "どこでもない", 500)).toBe(false);
  });
});
