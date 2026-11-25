import { describe, expect, it } from "vitest";
import {
  advance,
  applicants,
  Arena,
  buyVehicle,
  closeDepot,
  createEconomy,
  crewPlan,
  DEPOT_OPEN,
  depotCheck,
  dismiss,
  estimate,
  hire,
  hireDelta,
  MONTH,
  nameChoices,
  OPEN_DELIVERED,
  OPEN_MONEY,
  openCheck,
  openCompany,
  openDepot,
  ownCompany,
  PRICE_MAX,
  recordPlayer,
  sanitizeEconomy,
  SELF,
  sellVehicle,
  setPrice,
  stepDay,
  territory,
  VEHICLES,
  windUp,
} from "../src/shared/economy.ts";
import { AddressBook, type AddressPoint } from "../src/shared/world/address.ts";
import { Market } from "../src/sim/market.ts";

/** 120m 四方の丁目を 30 × 30 並べた町（3.6km 四方、中心が原点。economy.test.ts と同じ） */
function town() {
  const pts: AddressPoint[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) pts.push({ name: `c${i}_${j}`, x: (i - 15) * 120 + 60, z: (j - 15) * 120 + 60 });
  const book = new AddressBook(pts);
  const rect = { x0: -1800, z0: -1800, x1: 1800, z1: 1800 };
  return new Arena(pts, rect, { x: 0, z: 0 }, (x, z) => book.at(x, z), 42, 40);
}

const arena = town();
const TODAY = 20_000;

/** 営業所の無い丁目（中心の近く） */
function freeChome(s: ReturnType<typeof createEconomy>) {
  const taken = new Set(s.companies.filter((c) => c.closed === null).flatMap((c) => c.depots));
  for (const n of ["c15_15", "c14_15", "c15_14", "c16_16", "c13_13", "c17_14"]) if (!taken.has(n)) return n;
  throw new Error("空いた丁目が無い");
}

function opened() {
  const s = createEconomy(arena, 7, TODAY);
  const chome = freeChome(s);
  const c = openCompany(arena, s, TODAY, chome, nameChoices(s, TODAY)[0], 100_000)!;
  return { s, c, chome };
}

describe("開業と経営（配達の草案 21 章、D4）", () => {
  it("開業の条件: 所持金と届けた数。ほかの業者の営業所の丁目には開けない", () => {
    const s = createEconomy(arena, 7, TODAY);
    const chome = freeChome(s);
    expect(openCheck(arena, s, chome, OPEN_MONEY - 1, OPEN_DELIVERED)).toMatch(/所持金/);
    expect(openCheck(arena, s, chome, OPEN_MONEY, OPEN_DELIVERED - 1)).toMatch(/届けた数/);
    expect(openCheck(arena, s, chome, OPEN_MONEY, OPEN_DELIVERED)).toBeNull();
    expect(openCheck(arena, s, "どこでもない", OPEN_MONEY, OPEN_DELIVERED)).toBe("配達の範囲の外");
    const other = s.companies.find((c) => c.closed === null)!;
    expect(openCheck(arena, s, other.depots[0], OPEN_MONEY, OPEN_DELIVERED)).toContain(other.name);
    // 名前は使われていない候補から
    const names = nameChoices(s, TODAY);
    expect(names).toHaveLength(3);
    for (const n of names) expect(s.companies.some((c) => c.closed === null && c.name === n)).toBe(false);
    expect(openCompany(arena, s, TODAY, chome, "自由な名前", 50_000)).toBeNull();
  });

  it("開業すると所持金が資金になり、営業所が 1 つ。経営中は「あなた（個人）」を並べない", () => {
    const { s, c, chome } = opened();
    // 開業の時の営業所は費用を取らない（25.3 の 63）
    expect(c.cash).toBe(100_000);
    expect(c.depots).toEqual([chome]);
    expect(ownCompany(s)).toBe(c);
    expect(s.player.company).toBe(c.id);
    const t = territory(arena, s, TODAY, new Map());
    expect(t.entities.some((e) => e.id === SELF)).toBe(false);
    // 経営者も従業員に数える
    expect(t.entities.find((e) => e.id === c.id)!.staff).toBe(1);
  });

  it("応募から雇う。乗り物は速い配達員から割り当て、運べる件数が増える", () => {
    const { s, c } = opened();
    const list = applicants(s, c, TODAY);
    expect(list).toHaveLength(3);
    expect(applicants(s, c, TODAY)).toEqual(list);
    for (const a of list) {
      expect(a.speed).toBeGreaterThanOrEqual(0.8);
      expect(a.speed).toBeLessThanOrEqual(1.25);
      expect(a.wage).toBeGreaterThanOrEqual(6000);
      expect(a.wage).toBeLessThanOrEqual(9500);
    }
    for (const a of list) expect(hire(s, c, TODAY, a.id)).toBe(true);
    expect(c.staff).toBe(3);
    expect(applicants(s, c, TODAY)).toHaveLength(0);
    expect(hire(s, c, TODAY, list[0].id)).toBe(false);
    const bare = crewPlan(c, TODAY);
    expect(bare.cap).toBeCloseTo(list.reduce((a, m) => a + 22 * m.speed, 0), 6);
    expect(bare.wages).toBe(list.reduce((a, m) => a + m.wage, 0));
    // 電動自転車 1 台は、いちばん速い配達員へ
    const cash = c.cash;
    expect(buyVehicle(c, "ebike")).toBe(true);
    expect(c.cash).toBe(cash - VEHICLES.ebike.price);
    const p = crewPlan(c, TODAY);
    const fastest = [...list].sort((a, b) => b.speed - a.speed)[0];
    expect(p.slots.find((x) => x.crew.id === fastest.id)!.vehicle).toBe("ebike");
    expect(p.cap).toBeGreaterThan(bare.cap);
    expect(p.reach).toBeGreaterThan(1);
    expect(p.vehicles).toBe(VEHICLES.ebike.daily);
    // 売ると半値
    expect(sellVehicle(c, "ebike")).toBe(true);
    expect(c.cash).toBe(cash - VEHICLES.ebike.price / 2);
    // 土地勘は勤めた日数で上がる（28 日で +20%）
    expect(crewPlan(c, TODAY + MONTH).cap).toBeCloseTo(bare.cap * 1.2, 6);
    // 辞めてもらった人は、同じ日の応募に戻らない
    expect(dismiss(c, list[1].id)).toBe(true);
    expect(c.staff).toBe(2);
    expect(applicants(s, c, TODAY)).toHaveLength(0);
    expect(applicants(s, c, TODAY + 1)).toHaveLength(3);
  });

  it("1 日の締め: 営業所の周りの注文を運び、売上と費用が資金に入る。自分の配達もシェアに入る。NPC のように勝手に人を増やさない", () => {
    const { s, c } = opened();
    for (const a of applicants(s, c, TODAY)) hire(s, c, TODAY, a.id);
    // 自分で届けた（期限内なら所属・経営の業者の信頼が少し上がる）
    const trust = c.trust;
    recordPlayer(s, TODAY, "c3_3", 700);
    expect(c.trust).toBeCloseTo(trust + 0.002, 9);
    const est = estimate(arena, s, c, TODAY);
    expect(est.served).toBeGreaterThan(0);
    const cash = c.cash;
    stepDay(arena, s);
    expect(s.day).toBe(TODAY);
    const l = c.ledger!.at(-1)!;
    expect(l.day).toBe(TODAY);
    expect(l.served).toBe(Math.round(est.served));
    expect(l.own).toBe(700);
    expect(l.ownCount).toBe(1);
    expect(l.wages).toBe(c.crew!.reduce((a, m) => a + m.wage, 0));
    expect(c.cash).toBe(Math.round(cash + est.revenue - est.cost));
    expect(c.cash).toBe(l.cash);
    expect(c.staff).toBe(3);
    // 値段を上げると取れる件数が減る
    const lo = estimate(arena, s, c, TODAY + 1).served;
    setPrice(c, 10_000);
    expect(c.price).toBe(PRICE_MAX);
    expect(estimate(arena, s, c, TODAY + 1).served).toBeLessThan(lo);
  });

  it("雇った時の今日の見込みの差は、雇ってから見積もった差と同じ", () => {
    const { s, c } = opened();
    const a = applicants(s, c, TODAY)[0];
    const before = estimate(arena, s, c, TODAY);
    const d = hireDelta(arena, s, c, TODAY, a);
    expect(d.cost).toBeGreaterThan(0);
    expect(hire(s, c, TODAY, a.id)).toBe(true);
    const after = estimate(arena, s, c, TODAY);
    expect(d.served).toBeCloseTo(after.served - before.served, 6);
    expect(d.revenue).toBeCloseTo(after.revenue - before.revenue, 6);
    expect(d.cost).toBeCloseTo(after.cost - before.cost, 6);
  });

  it("営業所を足す・閉じる。数の上限と資金", () => {
    const { s, c } = opened();
    const far = "c2_27";
    expect(depotCheck(arena, s, far, c)).toBeNull();
    const cash = c.cash;
    expect(openDepot(arena, s, c, far)).toBe(true);
    expect(c.cash).toBe(cash - DEPOT_OPEN);
    // 配達員が少ないうち（個人）は 4 か所まで（25.3 の 62）
    const free = () => arena.chomes.map((x) => x.name).find((n) => !depotCheck(arena, s, n, c))!;
    for (let i = 0; i < 2; i++) expect(openDepot(arena, s, c, free())).toBe(true);
    expect(c.depots).toHaveLength(4);
    expect(depotCheck(arena, s, "c27_2", c)).toMatch(/上限/);
    expect(closeDepot(c, far)).toBe(true);
    while (c.depots.length > 1) expect(closeDepot(c, c.depots[1])).toBe(true);
    // 最後の 1 つは閉じない
    expect(closeDepot(c, c.depots[0])).toBe(false);
  });

  it("配達員がいないと、シェア 0.5% 未満のまま 1 か月で廃業する。市場が知らせ、資金がプラスなら所持金に戻る", () => {
    const { s, c } = opened();
    const m = new Market(arena, 7, TODAY, s);
    expect(m.update(TODAY + MONTH + 1)).toBe(MONTH + 1);
    expect(c.closed).not.toBeNull();
    expect(c.reason).toMatch(/シェア/);
    expect(m.closed).toBe(c);
    expect(s.player.company).toBeNull();
    expect(windUp(s, c, s.day)).toBe(Math.max(0, c.cash));
    // 個人に戻ると「あなた（個人）」がまた並ぶ
    expect(m.now.entities.some((e) => e.id === SELF)).toBe(true);
  });

  it("畳むと乗り物を半値で売り、資金がマイナスなら 0 円", () => {
    const { s, c } = opened();
    buyVehicle(c, "ebike");
    const cash = c.cash;
    expect(windUp(s, c, TODAY)).toBe(cash + VEHICLES.ebike.price / 2);
    expect(c.closed).toBe(TODAY);
    expect(ownCompany(s)).toBeNull();
    const b = opened();
    b.c.cash = -5000;
    expect(windUp(b.s, b.c, TODAY)).toBe(0);
  });

  it("経営者が来ないと、1 か月で配達員が減り始め、2 か月で廃業する（17.5）", () => {
    const { s, c } = opened();
    c.cash = 1e9;
    for (let d = 0; d < 6; d++) for (const a of applicants(s, c, TODAY - d)) hire(s, c, TODAY - d, a.id);
    const n = c.staff;
    expect(n).toBeGreaterThan(10);
    advance(arena, s, TODAY + MONTH + 3);
    expect(c.closed).toBeNull();
    expect(c.staff).toBe(n - 3);
    advance(arena, s, TODAY + 2 * MONTH + 1);
    expect(c.closed).not.toBeNull();
    expect(c.reason).toMatch(/来なかった/);
  });

  it("保存して読み直すと同じ（配達員・乗り物・収支）", () => {
    const { s, c } = opened();
    for (const a of applicants(s, c, TODAY)) hire(s, c, TODAY, a.id);
    buyVehicle(c, "ebike");
    stepDay(arena, s);
    const back = sanitizeEconomy(JSON.parse(JSON.stringify(s)))!;
    expect(back).toEqual(s);
  });
});
