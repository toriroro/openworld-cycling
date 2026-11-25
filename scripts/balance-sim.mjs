// 経営の釣り合いの試算（配達の草案 25 章）。北海道の世界を 1 度読み、経済の状態を写して、数値の組（BALANCE と開業の資金）ごとに
// 開業から WEEKS 週を経済の計算だけで進める。経営者は自分では走らない。長距離の便は試さない。
//
// 決め方（24 章の bot より少し賢く）: 最初に 2 人（日給の安い人）。あふれが 1 日 10 件を超え、資金が日給の 15 日分あれば 1 人足す。
// 運んだ件数が運べる件数の 7 割未満の日が 3 日続いたら、日給のいちばん高い人に辞めてもらう（1 人は残す）。電動自転車は足さない。
// GROW=1 の時は、資金が GROW_CASH（既定 8 万円）を超え、営業所が上限より少なければ、自分の営業所から 800m 以上離れた注文の多い丁目に営業所を足し、2 人雇う。
//
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/balance-sim.mjs。結果は artifacts/balance/result.json。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/balance";
const WEEKS = Number(process.env.WEEKS || 12);
const GROW = process.env.GROW === "1";
const GROW_CASH = Number(process.env.GROW_CASH || 80_000);
mkdirSync(out, { recursive: true });

// 開業する所: 24 章で試した 2 か所と、大通に近い所
const PLACES = ["南5条東3丁目", "南7条西2丁目", "北4条西7丁目"];
// startCash: 開業した時の業者の資金。25 章で決める前は 3 万円 − 営業所 2 万円 = 1 万円、決めた後は 3 万円。
// A〜M は 25 章で比べた組で、決める前の数値（OLD）からの違いで書く。「今」は今の既定の数値（25.3 の 61〜63 を入れた後）。
const OLD = { depotCost: 6000, playerDepotMax: [2, 4, 8] };
const VARIANTS = [
  { key: "今", startCash: 30_000, tune: {} },
  { key: "前（25 章で決める前）", startCash: 10_000, tune: { ...OLD } },
  { key: "A 資金 3 万", startCash: 30_000, tune: { ...OLD } },
  { key: "B A+近くに NPC の営業所を置かない 600m", startCash: 30_000, tune: { ...OLD, playerDepotGap: 600 } },
  { key: "C B+NPC 1 社 40 人まで・7.5 割で減らす", startCash: 30_000, tune: { ...OLD, playerDepotGap: 600, npcStaffMax: 40, shrinkUtil: 0.75 } },
  { key: "D C+営業所の費用 3,000 円", startCash: 30_000, tune: { ...OLD, playerDepotGap: 600, npcStaffMax: 40, shrinkUtil: 0.75, depotCost: 3000 } },
  { key: "E C+人数の効きを平方根", startCash: 30_000, tune: { ...OLD, playerDepotGap: 600, npcStaffMax: 40, shrinkUtil: 0.75, staffRoot: 2 } },
  { key: "F D+廃業まで 6 週", startCash: 30_000, tune: { ...OLD, playerDepotGap: 600, npcStaffMax: 40, shrinkUtil: 0.75, depotCost: 3000, closeDays: 42 } },
  { key: "G A+営業所の費用 3,000 円", startCash: 30_000, tune: { ...OLD, depotCost: 3000 } },
  { key: "H G+個人の営業所 4 か所まで", startCash: 30_000, tune: { ...OLD, depotCost: 3000, playerDepotMax: [4, 6, 8] } },
  { key: "I H で資金 1 万（開業は今のまま）", startCash: 10_000, tune: { ...OLD, depotCost: 3000, playerDepotMax: [4, 6, 8] } },
  { key: "K 資金 3 万+個人の営業所 4 か所まで（費用は今の 6,000 円）", startCash: 30_000, tune: { ...OLD, playerDepotMax: [4, 6, 8] } },
  { key: "L 資金 3 万+営業所の費用 4,000 円+個人 3 か所まで", startCash: 30_000, tune: { ...OLD, depotCost: 4000, playerDepotMax: [3, 6, 8] } },
  { key: "M 資金 3 万+営業所の費用 4,000 円+個人 4 か所まで", startCash: 30_000, tune: { ...OLD, depotCost: 4000, playerDepotMax: [4, 6, 8] } },
  { key: "J H+NPC を近くに置かない・40 人まで", startCash: 30_000, tune: { ...OLD, depotCost: 3000, playerDepotMax: [4, 6, 8], playerDepotGap: 600, npcStaffMax: 40, shrinkUtil: 0.75 } },
].filter((v) => !process.env.ONLY || process.env.ONLY.split(",").includes(v.key[0]));

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.game.market, null, { timeout: 240000, polling: 250 });

const runs = await page.evaluate(
  async ({ VARIANTS, PLACES, WEEKS, GROW, GROW_CASH }) => {
    const E = await import("/src/shared/economy.ts");
    const m = window.__dev.game.market;
    const arena = m.arena;
    const s0 = JSON.parse(JSON.stringify(m.state));
    const defaults = { ...E.BALANCE };
    const out = [];
    for (const v of VARIANTS) {
      Object.assign(E.BALANCE, defaults, v.tune);
      for (const place of PLACES) {
        const s = JSON.parse(JSON.stringify(s0));
        // 試算の数値で 4 週ならしてから開業する（NPC の大きさが新しい数値に落ち着くように）
        E.advance(arena, s, s.day + 28);
        const today = s.day + 1;
        const name = E.nameChoices(s, today)[0];
        const c = E.openCompany(arena, s, today, place, name, E.OPEN_MONEY);
        if (!c) {
          out.push({ variant: v.key, place, error: E.depotCheck(arena, s, place, null) });
          continue;
        }
        c.cash = v.startCash;
        const npcBefore = s.companies.filter((x) => x.closed === null && !x.player).length;
        let idle = 0;
        let closed = null;
        const weekly = [];
        const events = [];
        const hire = (d) => {
          const apps = E.applicants(s, c, d).sort((a, b) => a.wage - b.wage);
          return apps.length && E.hire(s, c, d, apps[0].id);
        };
        let served = 0;
        let lost = 0;
        for (let d = today; d < today + WEEKS * 7; d++) {
          c.seen = d;
          if (c.staff < 2) hire(d);
          const est = E.estimate(arena, s, c, d);
          const wage = Math.min(...E.applicants(s, c, d).map((a) => a.wage), 9e9);
          if (est.lost > 10 && c.cash > wage * 15) hire(d);
          const cap = E.crewPlan(c, d).cap;
          idle = est.lost === 0 && est.served < cap * 0.7 ? idle + 1 : 0;
          if (idle >= 3 && c.staff > 1) {
            const top = [...c.crew].sort((a, b) => b.wage - a.wage)[0];
            E.dismiss(c, top.id);
            idle = 0;
          }
          if (GROW && c.cash > GROW_CASH && c.depots.length < E.depotMax(c.staff + 2)) {
            const at = (n) => arena.chomes[arena.index.get(n)];
            const mine = c.depots.map(at);
            const spot = arena.chomes
              .filter((x) => !E.depotCheck(arena, s, x.name, null) && mine.every((p) => Math.hypot(p.x - x.x, p.z - x.z) >= 800))
              .sort((a, b) => b.base - a.base)[0];
            if (spot && E.openDepot(arena, s, c, spot.name)) {
              hire(d);
              hire(d);
              events.push({ d: d - today, what: `営業所（${spot.name}）、配達員 ${c.staff} 人` });
            }
          }
          E.advance(arena, s, d);
          const l = c.ledger?.[c.ledger.length - 1];
          if (l && l.day === d) {
            served += l.served;
            lost += l.lost;
          }
          if (c.closed !== null) {
            closed = { day: d - today + 1, reason: c.reason };
            break;
          }
          if ((d - today) % 7 === 6) {
            weekly.push({ w: (d - today + 1) / 7, cash: c.cash, staff: c.staff, depots: c.depots.length, served: Math.round(served / 7), lost: Math.round(lost / 7), trust: Math.round(c.trust * 100) / 100 });
            served = 0;
            lost = 0;
          }
        }
        const act = s.companies.filter((x) => x.closed === null && !x.player);
        out.push({
          variant: v.key,
          place,
          closed,
          weekly,
          events,
          npc: { before: npcBefore, after: act.length, closedDuring: s.companies.filter((x) => !x.player && x.closed !== null && x.closed >= today).length, staff: act.reduce((a, x) => a + x.staff, 0), list: act.sort((a, b) => b.staff - a.staff).map((x) => `${x.staff}人/営${x.depots.length}`).join(" ") },
        });
      }
    }
    Object.assign(E.BALANCE, defaults);
    return out;
  },
  { VARIANTS, PLACES, WEEKS, GROW, GROW_CASH },
);

writeFileSync(`${out}/${GROW ? "grow" : "result"}.json`, JSON.stringify({ errors, weeks: WEEKS, runs }, null, 2));
for (const r of runs) {
  const last = r.weekly[r.weekly.length - 1];
  const w4 = r.weekly[3];
  console.log(
    [
      r.variant.padEnd(28),
      r.place.padEnd(10),
      r.closed ? `廃業 ${r.closed.day} 日` : "続く",
      w4 ? `4週 ${Math.round(w4.cash / 1000)}k ${w4.staff}人 ${w4.served}件` : "",
      r.events?.length ? `営業所 ${r.events.map((e) => e.d).join(",")} 日目` : "",
      last ? `${last.w}週 ${Math.round(last.cash / 1000)}k ${last.staff}人 営${last.depots} ${last.served}件 あふれ${last.lost} 信頼${last.trust}` : "",
      `NPC ${r.npc.before}→${r.npc.after} 社 ${r.npc.staff} 人`,
    ].join(" | "),
  );
}
console.log("errors", errors.length);
await browser.close();
