// 端末間の一致: 同じ範囲を Node と各ブラウザで生成し、道路の点列のハッシュを比べる（モック仕様 4.10）。
// node scripts/cross-engine.mjs   （開発サーバー 5180 が動いている前提）
import { chromium, firefox, webkit } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const query = process.env.QUERY || "seed=6&x=-32500&z=11250&size=16000";
const nodeOut = execFileSync(process.execPath, ["--import", "tsx", "scripts/world-hash-node.ts", query], { encoding: "utf8" });
const results = [{ engine: `Node.js ${process.version}`, ...JSON.parse(nodeOut) }];
const targets = [
  ["Chrome (V8)", () => chromium.launch({ channel: "chrome" })],
  ["Edge (V8)", () => chromium.launch({ channel: "msedge" })],
  ["Firefox (SpiderMonkey)", () => firefox.launch()],
  ["WebKit (JavaScriptCore)", () => webkit.launch()],
];
for (const [name, launch] of targets) {
  let browser;
  try {
    browser = await launch();
  } catch (e) {
    results.push({ engine: name, error: String(e.message).split("\n")[0] });
    continue;
  }
  const page = await browser.newPage();
  await page.goto(`${base}/tools/world-hash.html?${query}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 300000 });
  results.push({ engine: name, ...(await page.evaluate(() => window.__result)) });
  await browser.close();
}
const ref = results[0].hash;
const refRivers = results[0].rivers;
for (const r of results)
  console.log(
    `${r.engine.padEnd(26)} ${r.error ? "起動できない: " + r.error : `${r.hash} ${r.hash === ref ? "一致" : "不一致"} 道路 ${r.roads}  川 ${r.rivers} ${r.rivers === refRivers ? "一致" : "不一致"}  ${r.ms}ms`}`,
  );
mkdirSync("artifacts/cross-engine", { recursive: true });
const file = `artifacts/cross-engine/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ query, results }, null, 2));
console.log(`保存: ${file}`);
