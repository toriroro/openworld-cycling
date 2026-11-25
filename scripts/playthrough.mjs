// 一人用を通しで試す（配達の草案 24 章）。人の手の代わりに、ふつうのプレイヤーらしい決め方で進めて、段ごとにかかる時間とお金を測る。
//
// A. アルバイト: 北海道の世界をはじめから。案内は「経路を自動で引く」、ペースは「ふつう」。配達アプリの知らせを受けて、実際に走って届ける。
//    体力が 3 割を切ったら近くの喫茶店で食事。時計は 6 倍（走った時間は世界の中の秒で数えるので、等倍で遊んだ時の時間になる）。
// B. 経営: 開業の条件（所持金・届けた数）に届いたことにして開業し、世界の日を 1 日ずつ進める（描かずに経済の計算だけ。画面のコードと同じモジュール）。
//    毎日: あふれた注文が多ければ応募から速い人を雇う、余裕があれば電動自転車、人が増えたら営業所を足す、中堅になったら長距離の便を 1 本。
//    経営者は自分では走らない。12 週（現実の 12 日）分。
//
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/playthrough.mjs。結果は artifacts/playthrough。
// DELIVERIES（既定 10）、WEEKS（既定 12）、PART=A|B|AB（既定 AB）。CAUTIOUS=1 で「資金が日給の 15 日分ある時だけ雇う」（3 人までの先払いをしない）。ADAPT=0 で人が余っても辞めてもらわない。OPEN_AT=丁目 で開業の丁目。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/playthrough";
const N = Number(process.env.DELIVERIES || 10);
const WEEKS = Number(process.env.WEEKS || 12);
const PART = process.env.PART || "AB";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const g = (fn, arg) => page.evaluate(fn, arg);
const snap = (name) => page.screenshot({ path: `${out}/${name}.png` });
const result = { errors };
const save = () => writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));

await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.deliveryArea && window.__dev.game.market, null, { timeout: 240000, polling: 250 });

// ---------------- A. アルバイト ----------------
if (PART.includes("A")) {
  await page.click(".menu-btn");
  await page.selectOption("label.menu-row:has-text('配達の案内') select", "route");
  await page.click(".menu-btn");
  await g(() => {
    const gm = window.__dev.game;
    gm.timeScale = 6;
    gm.appOn = true;
  });
  const st = () =>
    g(() => {
      const gm = window.__dev.game;
      return { t: gm.ride.time, money: gm.money, delivered: gm.delivered, onTime: gm.onTime, energy: gm.stamina.energyShare, legs: gm.stamina.legsShare, odo: gm.ride.odometer };
    });
  const s0 = await st();
  const deliveries = [];
  const meals = [];
  const stops = [];
  const wall0 = Date.now();
  while (deliveries.length < N && Date.now() - wall0 < 50 * 60_000) {
    const before = await st();
    // 知らせを待つ（来なければ 5 分（壁の時計）で打ち切り）
    const got = await page.waitForSelector(".offer-card:not(.hidden)", { timeout: 300000 }).catch(() => null);
    if (!got) break;
    const offer = await g(() => document.querySelector(".offer-card").innerText);
    const blocked = await g(() => document.querySelector(".offer-card .delivery-primary").disabled);
    if (blocked) {
      await page.locator(".offer-card").getByRole("button", { name: "見送る" }).click();
      continue;
    }
    await page.locator(".offer-card").getByRole("button", { name: "受ける", exact: true }).click();
    const accepted = await st();
    const done = await page.waitForFunction(() => window.__dev.game.deliveryPanel.isOpen && window.__dev.game.deliveries.length === 0, null, { timeout: 15 * 60_000, polling: 500 }).catch(() => null);
    if (!done) {
      result.stuck = { offer, state: await st(), goal: await g(() => window.__dev.game.ride.goal) };
      await snap("A-stuck");
      break;
    }
    const after = await st();
    const panel = await g(() => document.querySelector(".delivery-panel").innerText);
    if (deliveries.length === 0) await snap("A-1-first-result");
    deliveries.push({
      wait: Math.round(accepted.t - before.t),
      ride: Math.round(after.t - accepted.t),
      reward: after.money - accepted.money,
      late: after.onTime === accepted.onTime,
      km: Math.round((after.odo - accepted.odo) / 100) / 10,
      energyUsed: Math.round((accepted.energy - after.energy) * 1000) / 10,
      offer: offer.split("\n").slice(0, 6).join(" / "),
    });
    await g(() => window.__dev.game.deliveryPanel.hide());
    // 届けた所が名所・喫茶店の前だと、止まった画面（「出発」）が出て、出発するまで知らせが来ない。人なら押すので押す
    const stopAt = await g(() => {
      const gm = window.__dev.game;
      const st = gm.stop ? gm.stop.cafe?.poi?.name ?? gm.stop.landmark?.name ?? "止まった" : null;
      if (st) gm.depart();
      return st;
    });
    if (stopAt) stops.push({ after: deliveries.length, at: stopAt });
    // 体力が 3 割を切ったら近くの喫茶店で食事
    if (after.energy < 0.3) {
      const m0 = await st();
      const cafe = await g(() => window.__dev.cafes(2500).sort((a, b) => a.d - b.d)[0]);
      if (cafe) {
        await g(({ x, z }) => {
          const gm = window.__dev.game;
          gm.appOn = false;
          gm.ride.setGoal(x, z);
          gm.setPace(2);
        }, cafe);
        await page.waitForFunction(() => window.__dev.game.ride.goalReached, null, { timeout: 10 * 60_000 }).catch(() => {});
        await g(() => {
          window.__dev.game.setPace(0);
          window.__dev.game.input.brakeKey = true;
        });
        const stopped = await page.waitForFunction(() => window.__dev.game.stop !== null, null, { timeout: 60000 }).then(() => true).catch(() => false);
        await g(() => (window.__dev.game.input.brakeKey = false));
        if (stopped) await page.getByRole("button", { name: /^食事/ }).click().catch(() => {});
        await page.waitForTimeout(300);
        await g(() => {
          window.__dev.game.depart();
          window.__dev.game.appOn = true;
        });
        const m1 = await st();
        meals.push({ cafe: cafe.name, km: Math.round(cafe.d / 100) / 10, spent: m0.money - m1.money, time: Math.round(m1.t - m0.t), energyAfter: Math.round(m1.energy * 100) });
      }
    }
    result.A = { deliveries, meals, stops };
    save();
  }
  const s1 = await st();
  const n = deliveries.length;
  const sum = (f) => deliveries.reduce((a, d) => a + f(d), 0);
  const hours = (s1.t - s0.t) / 3600;
  const net = s1.money - s0.money;
  const perHour = net / Math.max(1e-6, hours);
  // 開業の条件（所持金 3 万円・届けた数 30 件）までの見込み（今のペースのまま）
  const need = Math.max((30_000 - s0.money) / Math.max(1, net / Math.max(1, n)), 30);
  result.A = {
    deliveries,
    meals,
    stops,
    summary: {
      n,
      hours: Math.round(hours * 100) / 100,
      net,
      perHour: Math.round(perHour),
      avgReward: Math.round(sum((d) => d.reward) / Math.max(1, n)),
      avgRideMin: Math.round((sum((d) => d.ride) / Math.max(1, n) / 60) * 10) / 10,
      avgWaitS: Math.round(sum((d) => d.wait) / Math.max(1, n)),
      late: deliveries.filter((d) => d.late).length,
      km: Math.round((s1.odo - s0.odo) / 100) / 10,
      foodSpent: meals.reduce((a, m) => a + m.spent, 0),
      toOpen: { deliveries: Math.ceil(need), hours: Math.round((need * (hours / Math.max(1, n))) * 10) / 10 },
    },
    wallMin: Math.round((Date.now() - wall0) / 600) / 100,
  };
  await snap("A-2-after");
  save();
  await g(() => {
    window.__dev.game.timeScale = 1;
    window.__dev.game.appOn = false;
  });
}

// ---------------- B. 経営 ----------------
if (PART.includes("B")) {
  // 開業する所: 大通から 0.9〜1.3km、営業所の無い丁目で注文の多い所（D4・D5 の確認と同じ選び方）
  result.B = await g(async ({ WEEKS, process_env_min3, OPEN_AT, ADAPT }) => {
    const E = await import("/src/shared/economy.ts");
    const F = await import("/src/shared/freight.ts");
    const W = await import("/src/shared/world/weather.ts");
    const gm = window.__dev.game;
    const m = gm.market;
    const s = m.state;
    const arena = m.arena;
    const today = s.day + 1;
    const taken = new Set(s.companies.filter((c) => c.closed === null).flatMap((c) => c.depots));
    const c0 = gm.addresses.byName.get("大通西4丁目");
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const cand = (OPEN_AT && arena.chomes.find((c) => c.name === OPEN_AT && !taken.has(c.name))) || arena.chomes.filter((c) => !taken.has(c.name) && dist(c, c0) > 900 && dist(c, c0) < 1300).sort((a, b) => b.base - a.base)[0];
    const name = E.nameChoices(s, today)[0];
    const c = E.openCompany(arena, s, today, cand.name, name, E.OPEN_MONEY);
    s.player.company = c.id;
    const log = [];
    const weekly = [];
    const events = [];
    const destsFrom = new Map();
    const dests = async (from) => {
      if (destsFrom.has(from)) return destsFrom.get(from);
      const i = arena.index.get(from);
      const p = arena.chomes[i];
      const towns = gm.roads.world.local.meta.nodes.filter((n) => n.kind === "town" && n.name !== "札幌市" && !n.name.endsWith("区"));
      const routes = await Promise.all(towns.map((t) => gm.roads.truckRoute(p.x, p.z, t.x, t.z)));
      const outd = [];
      routes.forEach((r, j) => r && outd.push({ town: towns[j].name, x: towns[j].x, z: towns[j].z, km: Math.round(r.m / 100) / 10, min: Math.round(r.s / 60) }));
      destsFrom.set(from, outd);
      return outd;
    };
    const rank = (key) => {
      const ents = [...m.now.entities].sort((a, b) => b[key] - a[key]);
      return ents.findIndex((e) => e.id === c.id) + 1;
    };
    let idle = 0;
    for (let d = today; d < today + WEEKS * 7; d++) {
      const noon = W.dayStartMs(d) + W.DAY_MS / 2;
      m.update(d, noon);
      if (c.closed !== null) {
        events.push({ d: d - today, what: `廃業（${c.reason}）` });
        break;
      }
      // 雇う: あふれた注文が 1 日 15 件を超え、資金が日給の 15 日分あれば、応募でいちばん速い人
      const est = E.estimate(arena, s, c, d);
      const apps = E.applicants(s, c, d).sort((a, b) => b.speed - a.speed);
      // （3 人までは資金によらず雇う。慎重に雇わない決め方では 1 か月で廃業したため。24 章）
      // 配達員 0 人の業者には注文が来ない（あふれも 0）ので、0 人の時は「あふれ」を見ずに決める
      const min3 = c.staff < (process_env_min3 ? 3 : 1);
      if (apps.length && (min3 || (est.lost > 15 && c.cash > apps[0].wage * 15))) {
        if (E.hire(s, c, d, apps[0].id)) events.push({ d: d - today, what: `雇う（速さ ${apps[0].speed}・日給 ${apps[0].wage}）` });
      }
      // 人が余っている（あふれ 0、運んだ件数が運べる件数の 7 割未満）の日が 3 日続いたら、日給のいちばん高い人に辞めてもらう（2 人までは残す）
      const capNow = E.crewPlan(c, d).cap;
      idle = ADAPT && est.lost === 0 && est.served < capNow * 0.7 ? idle + 1 : 0;
      if (idle >= 3 && c.staff > 2) {
        const top = [...c.crew].sort((a, b) => b.wage - a.wage)[0];
        if (E.dismiss(c, top.id)) events.push({ d: d - today, what: `辞めてもらう（日給 ${top.wage}）` });
        idle = 0;
      }
      // 電動自転車: 自前の自転車の人がいて、資金が値段の 3 倍あれば
      const plan = E.crewPlan(c, d);
      if (plan.slots.some((x) => x.vehicle === "own") && c.cash > E.VEHICLES.ebike.price * 3 && E.buyVehicle(c, "ebike")) events.push({ d: d - today, what: "電動自転車を買う" });
      // 営業所: 配達員が営業所の数 × 5 人を超え、資金が開く費用の 10 倍あれば、営業所の無い丁目で注文の多い所
      if (c.staff > c.depots.length * 5 && c.depots.length < E.depotMax(c.staff) && c.cash > E.DEPOT_OPEN * 10) {
        const near = arena.chomes.filter((x) => !E.depotCheck(arena, s, x.name, c)).sort((a, b) => b.base - a.base)[0];
        if (near && E.openDepot(arena, s, c, near.name)) events.push({ d: d - today, what: `営業所を開く（${near.name}）` });
      }
      // 長距離の便: 中堅になり、資金が 150 万円あれば、2 トンで運べる申し込みのうち見込みの利益が最大の物を 1 本
      if (!F.freightCheck(c) && (c.contracts ?? []).length === 0 && c.cash > 1_500_000) {
        const ds = await dests(c.depots[0]);
        const offers = F.freightOffers(s, c, d, ds).filter((o) => o.tons <= 2);
        const best = offers.map((o) => ({ o, e: F.contractEstimate(o, F.trucksNeeded(o), 7000) })).sort((a, b) => b.e.profit - a.e.profit)[0];
        if (best && best.e.profit > 0) {
          const k = F.takeContract(s, c, d, noon, ds, best.o.id);
          if (k) {
            const need = F.trucksNeeded(best.o);
            for (let i = 0; i < need; i++) if (E.buyVehicle(c, "truck")) F.addTruck(c, k, noon);
            events.push({ d: d - today, what: `便の契約（${k.town}・${k.tons} トン・1 日 ${k.loads} 便・トラック ${k.runs.length} 台）` });
          }
        }
      }
      log.push({ d: d - today, cash: c.cash, staff: c.staff, depots: c.depots.length, served: Math.round(est.served), lost: Math.round(est.lost), revenue: Math.round(est.revenue), cost: Math.round(est.cost) });
      if ((d - today) % 7 === 6) {
        const me = m.now.entities.find((e) => e.id === c.id);
        weekly.push({
          week: (d - today + 1) / 7,
          cash: c.cash,
          staff: c.staff,
          kind: E.kindOf(c.staff),
          depots: c.depots.length,
          chomes: me?.chomes ?? 0,
          ha: Math.round((me?.area ?? 0) / 1000) / 10,
          salesWeek: me?.salesWeek ?? 0,
          rankArea: rank("area"),
          rankSales: rank("salesWeek"),
          companies: m.now.entities.length,
          contracts: (c.contracts ?? []).map((k) => `${k.town} ${k.sum.trips} 便 ${k.sum.sales} 円`),
          // 業者の並び（商圏面積の順）: 名前・人数・営業所・丁目
          others: s.companies.filter((x) => x.closed === null).sort((a, b) => b.staff - a.staff).map((x) => `${x.name}${x.player ? "（自分）" : ""} ${x.staff} 人 営業所 ${x.depots.length}`),
        });
      }
    }
    return { open: { chome: cand.name, name, cash: c.cash }, weekly, events, log };
  }, { WEEKS, process_env_min3: process.env.CAUTIOUS !== "1", OPEN_AT: process.env.OPEN_AT || "", ADAPT: process.env.ADAPT !== "0" });
  save();
  await g(() => window.__dev.game.toggleMap());
  await page.waitForTimeout(2500);
  await snap("B-map");
}

save();
console.log(JSON.stringify({ errors, A: result.A?.summary, stuck: result.stuck, B: result.B && { open: result.B.open, weekly: result.B.weekly, events: result.B.events.slice(0, 40) } }, null, 2));
await browser.close();
