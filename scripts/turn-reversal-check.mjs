// 走っていて向きが逆になる所の確認（配達の草案 27 章）。地図で押した行き先（1.8km 先、4 方向）へ経路どおりに「急ぐ」で走り、
// 向きが逆になった所・U ターンを、その前 1.25 秒の状態と一緒に記録する。道幅の変わる所で線が行き過ぎて戻っていたのを見つけた。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/turn-reversal-check.mjs。結果は artifacts/ux27/reversal.json（ev が空なら逆向きは無い）
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.MAP_BASE || "http://localhost:5180";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear`);
await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
await page.waitForTimeout(3000);
const runs = [];
const dirs = [[1, 0.3], [1, -0.6], [1, 1], [-1, 0.2]];
for (const [ux, uz] of dirs) {
  const r = await page.evaluate(async ([ux, uz]) => {
    const gm = window.__dev.game;
    gm.timeScale = 3;
    const ride = gm.ride;
    const p0 = ride.pose();
    const l = Math.hypot(ux, uz);
    ride.setGoal(p0.x + (ux / l) * 1800, p0.z + (uz / l) * 1800);
    gm.setPace(3);
    const ev = [];
    let prev = ride.pose();
    let prevRoad = ride.pos.road;
    let u0 = ride.uTurns;
    const ring = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 70000 && ride.goal) {
      await new Promise((res) => setTimeout(res, 50));
      const q = ride.pose();
      const mx = q.x - prev.x, mz = q.z - prev.z;
      const moved = Math.hypot(mx, mz);
      const dot = q.dx * prev.dx + q.dz * prev.dz;
      const u = ride.upcoming;
      ring.push({ road: ride.pos.road, s: Math.round(ride.pos.s * 10) / 10, dir: ride.pos.dir, h: [Math.round(q.dx * 100) / 100, Math.round(q.dz * 100) / 100], turn: ride.turn ? { j: ride.turn.junction, d: Math.round(ride.turn.d), len: Math.round(ride.turn.length), to: ride.turn.to.road + (ride.turn.to.dir > 0 ? "+" : "-") + Math.round(ride.turn.to.s) } : null, up: u ? { j: u.junction.id, d: Math.round(u.distance), sel: u.selected, def: u.defaultIndex, byPlan: !!u.byPlan, ch: u.choices.map((c) => c.arm.road + (c.arm.dir > 0 ? "+" : "-") + Math.round(c.arm.s)) } : null, step0: ride.plan?.steps[0] ? ride.plan.steps[0].junction + ">" + ride.plan.steps[0].arm.road + (ride.plan.steps[0].arm.dir > 0 ? "+" : "-") : null, speed: Math.round(ride.speed) });
      if (ring.length > 40) ring.shift();
      if ((dot < -0.3 && moved > 0.3) || ride.uTurns !== u0) {
        const net = gm.roads.net;
        const road = net.roads.get(ride.pos.road);
        const js = net.junctionsOn(ride.pos.road).map((x) => ({ id: x.junction.id, s: Math.round(x.s), arms: x.junction.arms.map((a) => `${a.road}@${Math.round(a.s)}${a.dir > 0 ? "+" : "-"} w${net.roads.get(a.road)?.width}`) }));
        ev.push({ ring: ring.slice(-25), t: Math.round(ride.time), dot: Math.round(dot * 100) / 100, uTurn: ride.uTurns !== u0, from: prevRoad, road: ride.pos.road, s: Math.round(ride.pos.s), dir: ride.pos.dir, len: Math.round(road?.length ?? 0), w: road?.width, turn: !!ride.turn, plan: ride.plan?.steps.slice(0, 3).map((s) => `${s.junction}>${s.arm.road}${s.arm.dir > 0 ? "+" : "-"}`), js: js.slice(0, 4) });
        u0 = ride.uTurns;
      }
      prev = q;
      prevRoad = ride.pos.road;
    }
    const reached = !ride.goal;
    ride.setGoal(null);
    gm.setPace(0);
    return { dir: [ux, uz], reached, km: Math.round(ride.odometer) / 1000, ev: ev.slice(0, 6) };
  }, [ux, uz]);
  runs.push(r);
  console.log(JSON.stringify({ dir: r.dir, reached: r.reached, n: r.ev.length }));
}
mkdirSync("artifacts/ux27", { recursive: true });
writeFileSync("artifacts/ux27/reversal.json", JSON.stringify({ errors, runs }, null, 1));
await browser.close();
