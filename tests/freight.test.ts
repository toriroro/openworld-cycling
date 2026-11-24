import { describe, expect, it } from "vitest";
import { applicants, Arena, buyVehicle, CARRIER_FACTOR, CARRIER_PRICE, type Contract, createEconomy, crewPlan, giveCarrier, hire, MONTH, nameChoices, openCompany, sanitizeEconomy, sellVehicle, vehicleCheck, VEHICLES, windUp } from "../src/shared/economy.ts";
import {
  addTruck,
  canRenew,
  contractEnd,
  contractMax,
  cycleMs,
  type FreightDest,
  freightCheck,
  freightOffers,
  removeTruck,
  renewContract,
  runFreight,
  takeContract,
  tonsFactor,
  truckCheck,
  truckFor,
  truckState,
} from "../src/shared/freight.ts";
import { AddressBook, type AddressPoint } from "../src/shared/world/address.ts";
import { DAY_MS, dayStartMs, worldDay } from "../src/shared/world/weather.ts";
import { Market } from "../src/sim/market.ts";

/** 120m 四方の丁目を 30 × 30 並べた町（company.test.ts と同じ） */
function town() {
  const pts: AddressPoint[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) pts.push({ name: `c${i}_${j}`, x: (i - 15) * 120 + 60, z: (j - 15) * 120 + 60 });
  const book = new AddressBook(pts);
  return new Arena(pts, { x0: -1800, z0: -1800, x1: 1800, z1: 1800 }, { x: 0, z: 0 }, (x, z) => book.at(x, z), 42, 40);
}

const arena = town();
const TODAY = 20_000;
const T0 = dayStartMs(TODAY) + 3_600_000;
const DESTS: FreightDest[] = [
  { town: "千歳市", x: 24612, z: 26514, km: 41, min: 64 },
  { town: "江別市", x: 15132, z: -4876, km: 19.2, min: 32 },
];

/** 2 トンに積める荷にする（荷の量の検査は別の it で） */
const fit = (k: Contract) => {
  k.tons = Math.min(k.tons, 2);
  return k;
};

/** 開業して、配達員を 8 人（中堅）雇い、トラックを 2 台買った業者 */
function setup(staffDays = 3) {
  const s = createEconomy(arena, 7, TODAY);
  const taken = new Set(s.companies.filter((c) => c.closed === null).flatMap((c) => c.depots));
  const chome = ["c15_15", "c14_15", "c15_14", "c16_16"].find((n) => !taken.has(n))!;
  const c = openCompany(arena, s, TODAY, chome, nameChoices(s, TODAY)[0], 1e8)!;
  for (let d = 0; d < staffDays; d++) for (const a of applicants(s, c, TODAY - d)) hire(s, c, TODAY - d, a.id);
  buyVehicle(c, "truck");
  buyVehicle(c, "truck");
  return { s, c };
}

describe("長距離の便（配達の草案 22 章、D5）", () => {
  it("始める条件は中堅から。申し込みは世界の日と種で決まり、契約の数に上限がある", () => {
    const { s, c } = setup(1);
    expect(c.staff).toBe(3);
    expect(freightCheck(c)).toMatch(/中堅/);
    const offers = freightOffers(s, c, TODAY, DESTS);
    expect(offers).toHaveLength(3);
    expect(freightOffers(s, c, TODAY, DESTS)).toEqual(offers);
    expect(takeContract(s, c, TODAY, T0, DESTS, offers[0].id)).toBeNull();
    for (const a of applicants(s, c, TODAY - 1)) hire(s, c, TODAY - 1, a.id);
    for (const a of applicants(s, c, TODAY - 2)) hire(s, c, TODAY - 2, a.id);
    expect(c.staff).toBeGreaterThanOrEqual(7);
    expect(contractMax(c.staff)).toBe(2);
    for (const o of offers) {
      expect(o.loads).toBeGreaterThanOrEqual(1);
      expect(o.loads).toBeLessThanOrEqual(3);
      // 運賃は 1 往復の分数 × 220 円 × 荷の量の倍率 × 0.85〜1.15
      const base = 220 * (2 * o.min + 40) * tonsFactor(o.tons);
      expect(o.rate).toBeGreaterThanOrEqual(Math.floor((base * 0.85) / 100) * 100);
      expect(o.rate).toBeLessThanOrEqual(Math.ceil((base * 1.15) / 100) * 100);
    }
    expect(takeContract(s, c, TODAY, T0, DESTS, offers[0].id)).not.toBeNull();
    expect(takeContract(s, c, TODAY, T0, DESTS, offers[1].id)).not.toBeNull();
    expect(freightCheck(c)).toMatch(/上限/);
    expect(takeContract(s, c, TODAY, T0, DESTS, offers[2].id)).toBeNull();
    // 契約した申し込みは出ない
    expect(freightOffers(s, c, TODAY, DESTS).map((o) => o.id)).toEqual([offers[2].id]);
  });

  it("トラックを付けると、遅い配達員から運転手に回り、町の配達から外れる。付けたトラックは売れない", () => {
    const { s, c } = setup();
    const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    const before = crewPlan(c, TODAY);
    expect(addTruck(c, k, T0)).toBe(true);
    const after = crewPlan(c, TODAY);
    const slowest = [...c.crew!].sort((a, b) => a.speed - b.speed || b.no - a.no)[0];
    expect(after.drivers.map((m) => m.id)).toEqual([slowest.id]);
    expect(after.slots.some((sl) => sl.crew.id === slowest.id)).toBe(false);
    expect(after.cap).toBeLessThan(before.cap);
    // 給料は運転手も払う。トラックの 1 日の費用
    expect(after.wages).toBe(before.wages);
    expect(after.vehicles).toBe(2 * VEHICLES.truck.daily);
    expect(addTruck(c, k, T0)).toBe(true);
    expect(truckCheck(c, k)).toMatch(/トラック/);
    expect(sellVehicle(c, "truck")).toBe(false);
    expect(removeTruck(k)).toBe(true);
    expect(sellVehicle(c, "truck")).toBe(true);
  });

  it("荷が出るとトラックが積んで走り、着くと運賃が入る。燃料は出る時に払う", () => {
    const { s, c } = setup();
    const o = freightOffers(s, c, TODAY, [DESTS[1]])[0];
    const k = fit(takeContract(s, c, TODAY, T0, [DESTS[1]], o.id)!);
    addTruck(c, k, T0);
    const cash = c.cash;
    runFreight(s, T0 + 1000);
    // 最初の荷はすぐ出て、積んで 20 分後に出発
    expect(k.next).toBe(1);
    expect(k.pending).toHaveLength(1);
    expect(c.cash).toBe(cash - Math.round(40 * k.km * 2));
    expect(truckState(k.runs[0], T0 + 1000).leg).toBe("home");
    expect(truckState(k.runs[0], k.runs[0].out + 60_000).leg).toBe("out");
    const t = k.pending[0];
    runFreight(s, t.arrive + 1);
    expect(k.pending).toHaveLength(0);
    expect(k.sum.trips).toBe(1);
    expect(c.cash).toBe(cash - Math.round(40 * k.km * 2) + t.pay);
    expect(truckState(k.runs[0], t.arrive + 25 * 60_000).leg).toBe("back");
    expect(c.freight!.at(-1)!.trips).toBe(1);
  });

  it("トラックが足りないと遅れ、世界の 1 日待たせた荷は落とす。付けなければ全部落とす", () => {
    const { s, c } = setup();
    const offers = freightOffers(s, c, TODAY, [DESTS[0]]);
    const big = offers.find((o) => o.loads === 3) ?? offers[0];
    big.loads = 3;
    const k = fit(takeContract(s, c, TODAY, T0, [DESTS[0]], big.id)!);
    k.loads = 3;
    k.total = 3 * MONTH;
    // 千歳の 1 往復（約 2 時間 48 分）は、3 便の間隔（約 1 時間 9 分）より長い
    expect(cycleMs(k.min)).toBeGreaterThan(DAY_MS / 3);
    const trust = c.trust;
    const cash = c.cash;
    runFreight(s, T0 + 3 * DAY_MS);
    expect(k.sum.trips).toBe(0);
    expect(k.sum.dropped).toBeGreaterThanOrEqual(6);
    // 落とした荷は運賃の半分を違約金で払う
    expect(c.cash).toBe(cash - k.sum.dropped * Math.round(k.rate * 0.5));
    expect(c.trust).toBeLessThan(trust);
    addTruck(c, k, T0 + 3 * DAY_MS);
    runFreight(s, T0 + 6 * DAY_MS);
    expect(k.sum.trips).toBeGreaterThan(0);
    expect(k.sum.late + k.sum.dropped).toBeGreaterThan(0);
  });

  it("少しずつ進めても、まとめて進めても結果が同じ（閉じていた間）", () => {
    const run = (steps: number) => {
      const { s, c } = setup();
      const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
      addTruck(c, k, T0);
      addTruck(c, k, T0);
      const end = T0 + 5 * DAY_MS;
      for (let i = 1; i <= steps; i++) runFreight(s, T0 + ((end - T0) * i) / steps);
      return { cash: c.cash, sum: k.sum, trust: c.trust, freight: c.freight };
    };
    const a = run(1);
    const b = run(97);
    expect(b.cash).toBe(a.cash);
    expect(b.sum).toEqual(a.sum);
    expect(b.trust).toBeCloseTo(a.trust, 9);
    expect(a.sum.trips).toBeGreaterThanOrEqual(4);
  });

  it("市場: 閉じていた間を日ごとに締め、便の結果が収支に入る。留守の間の便をまとめる", () => {
    const { s, c } = setup();
    const m = new Market(arena, 7, TODAY, s, T0);
    const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    addTruck(c, k, T0);
    m.update(TODAY, T0 + 60_000);
    // 現実で 10 時間（世界の約 3 日）閉じていた
    const now = T0 + 10 * 3_600_000;
    m.update(worldDay(now).day, now);
    expect(m.away).not.toBeNull();
    expect(m.away!.trips).toBe(k.sum.trips);
    expect(m.away!.trips).toBeGreaterThan(0);
    const rows = c.ledger!.filter((l) => l.day >= TODAY);
    expect(rows.length).toBe(worldDay(now).day - TODAY);
    const inLedger = rows.reduce((a, l) => a + l.trips, 0) + (c.freight ?? []).reduce((a, f) => a + f.trips, 0);
    expect(inLedger).toBe(k.sum.trips);
    expect(rows.reduce((a, l) => a + l.fsales, 0) + (c.freight ?? []).reduce((a, f) => a + f.sales, 0)).toBe(k.sum.sales);
  });

  it("契約は世界の 1 か月で切れる。更新は終わりの 1 週だけ", () => {
    const { s, c } = setup();
    const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    addTruck(c, k, T0);
    addTruck(c, k, T0);
    expect(contractEnd(k)).toBeCloseTo(T0 + MONTH * DAY_MS, 0);
    expect(canRenew(k, T0 + DAY_MS)).toBe(false);
    expect(renewContract(k, T0 + DAY_MS)).toBe(false);
    expect(canRenew(k, T0 + 22 * DAY_MS)).toBe(true);
    // 更新しないと、荷が全部出て、走っている便が着いたら契約が外れる
    const r = runFreight(s, T0 + MONTH * DAY_MS + DAY_MS);
    expect(c.contracts).toHaveLength(0);
    expect(r!.ended).toHaveLength(1);
    expect(k.sum.trips + k.sum.dropped).toBe(k.loads * MONTH);
    // 更新すると 1 か月延びる
    const k2 = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    expect(renewContract(k2, T0 + 25 * DAY_MS)).toBe(true);
    expect(contractEnd(k2)).toBeCloseTo(T0 + 2 * MONTH * DAY_MS, 0);
  });

  it("配達員が減って運転手が足りなくなるとトラックを外す。畳むとトラックも半値で売る", () => {
    const { s, c } = setup();
    const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    addTruck(c, k, T0);
    addTruck(c, k, T0);
    c.crew = c.crew!.slice(0, 1);
    c.staff = 1;
    runFreight(s, T0 + 1000);
    expect(k.runs).toHaveLength(1);
    const cash = c.cash;
    expect(windUp(s, c, TODAY)).toBe(cash + VEHICLES.truck.price);
    expect(c.contracts).toHaveLength(0);
  });

  it("保存して読み直すと同じ（契約・走っている便・便の日ごとの結果）", () => {
    const { s, c } = setup();
    const k = fit(takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!);
    addTruck(c, k, T0);
    runFreight(s, T0 + DAY_MS / 2);
    const back = sanitizeEconomy(JSON.parse(JSON.stringify(s)))!;
    expect(back).toEqual(s);
  });

  it("車の段: 荷の量を積める段のトラックだけ付く。燃料は段で違う。10 トンは大手から", () => {
    const { s, c } = setup();
    const k = takeContract(s, c, TODAY, T0, DESTS, freightOffers(s, c, TODAY, DESTS)[0].id)!;
    k.tons = 3;
    expect(truckFor(3)).toBe("t3");
    expect(truckFor(5)).toBe("t10");
    expect(truckCheck(c, k)).toMatch(/3 トン/);
    expect(addTruck(c, k, T0)).toBe(false);
    expect(buyVehicle(c, "t3")).toBe(true);
    expect(addTruck(c, k, T0)).toBe(true);
    expect(k.runs[0].v).toBe("t3");
    const cash = c.cash;
    runFreight(s, T0 + 1000);
    expect(c.cash).toBe(cash - Math.round(VEHICLES.t3.fuel! * k.km * 2));
    // 3 トンは便に付けているので売れない。2 トンは売れる
    expect(sellVehicle(c, "t3")).toBe(false);
    expect(sellVehicle(c, "truck")).toBe(true);
    // 10 トンは大手（配達員 25 人）から
    expect(vehicleCheck(c, "t10")).toMatch(/大手/);
    expect(buyVehicle(c, "t10")).toBe(false);
    // 荷の量が多いほど運賃が高い
    expect(tonsFactor(8)).toBeGreaterThan(tonsFactor(2));
    expect(tonsFactor(2)).toBe(1);
  });

  it("配達員のリアキャリア: 自転車の配達員の件数が 1.15 倍。軽自動車は町の乗り物", () => {
    const { c } = setup(1);
    const before = crewPlan(c, TODAY);
    const m = c.crew![0];
    const cash = c.cash;
    expect(giveCarrier(c, m.id)).toBe(true);
    expect(giveCarrier(c, m.id)).toBe(false);
    expect(c.cash).toBe(cash - CARRIER_PRICE);
    const after = crewPlan(c, TODAY);
    const a = before.slots.find((x) => x.crew.id === m.id)!;
    const b = after.slots.find((x) => x.crew.id === m.id)!;
    expect(b.cap).toBeCloseTo(a.cap * CARRIER_FACTOR, 6);
    // 軽自動車に乗るとキャリアは効かない
    buyVehicle(c, "kei");
    buyVehicle(c, "kei");
    buyVehicle(c, "kei");
    const kei = crewPlan(c, TODAY).slots.find((x) => x.crew.id === m.id)!;
    expect(kei.vehicle).toBe("kei");
    expect(kei.cap).toBeCloseTo(VEHICLES.kei.cap * m.speed, 6);
    const back = sanitizeEconomy(JSON.parse(JSON.stringify({ v: 1, seed: 1, day: 0, companies: [c], history: [], player: { company: c.id, days: [] } })))!;
    expect(back.companies[0].crew!.find((x) => x.id === m.id)!.carrier).toBe(true);
    expect(back.companies[0].fleet!.kei).toBe(3);
  });
});
