// 道路にはみ出している壁などの点検（北海道の草案 30 章）。
// 描いているメッシュの、ほぼ縦の三角形（法線の上下成分 0.35 未満）のうち、走る道の路面の内側（端から 0.3m より内）で、
// 路面から 0.2〜2.5m の高さにかかる物を数える（走ると当たる高さ）。車・ライダー・地形・インスタンスの木は除く。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/hokkaido-wall-check.mjs。ONLY=名前,名前、R=半径（既定 500m）。
// 合わせて、走らない道（車の通る道）の平らな路面が走る道の路面の内側に載っている所も数える（mesh の名前の後ろに ":flat"。北海道の草案 31 章）。
// 結果は OUT（既定 artifacts/hokkaido/walls）の results*.json と、塊ごとの画面写真（上位 SHOTS 件、既定 6）。TAG で名前の後ろに付ける文字。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/hokkaido/walls";
const tag = process.env.TAG ? `-${process.env.TAG}` : "";
const R = Number(process.env.R || 500);
const SHOTS = Number(process.env.SHOTS ?? 6);
mkdirSync(out, { recursive: true });
const PLACES = [
  ["odori", 240, 40],
  ["susukino", 150, 900],
  ["kotoni", -4300, -2300],
  ["hassamu-bridge", -5340, -3687],
  ["teine", -8400, -3800],
  ["toyohira", 2600, 2800],
  ["maruyama", -2600, 300],
  ["moiwa", -2300, 4200],
  ["jozankei", -15093, 10137],
  ["farm", 9752, -11952],
  ["ebetsu", 15166, -4861],
  ["kita", 300, -3500],
  ["higashi", 3000, -2000],
  ["shiroishi", 6000, 1500],
  ["nishi", -6000, 500],
  ["minami", 1500, 6000],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const result = { R, places: {} };
for (const [name, x, z] of PLACES.filter(([n]) => !only || only.has(n))) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear&x=${x}&z=${z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    const v = window.__dev.view;
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
    window.__dev.setPaused(true);
  });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async (R) => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const d = window.__dev;
    const v = d.view;
    const p = d.rideInfo();
    // 走る道の路面の索引（16m の格子に、線分を幅の分広げて入れる）
    const C = 16;
    const grid = new Map();
    for (const road of d.roads.net.roads.values()) {
      const P = road.points, n = P.length / 3, hw = road.width / 2;
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 3] + road.origin[0], az = P[i * 3 + 2] + road.origin[1];
        const bx = P[i * 3 + 3] + road.origin[0], bz = P[i * 3 + 5] + road.origin[1];
        if (Math.hypot(ax - p.x, az - p.z) > R + 50) continue;
        const seg = [ax, az, P[i * 3 + 1], bx, bz, P[i * 3 + 4], hw, road.id];
        for (let cx = Math.floor((Math.min(ax, bx) - hw) / C); cx <= Math.floor((Math.max(ax, bx) + hw) / C); cx++)
          for (let cz = Math.floor((Math.min(az, bz) - hw) / C); cz <= Math.floor((Math.max(az, bz) + hw) / C); cz++) {
            const k = cx * 100000 + cz;
            (grid.get(k) ?? grid.set(k, []).get(k)).push(seg);
          }
      }
    }
    /** 路面の内側（端から 0.3m より内）なら [路面の高さ, 道路] */
    const onRoad = (x, z) => {
      for (const s of grid.get(Math.floor(x / C) * 100000 + Math.floor(z / C)) ?? []) {
        const [ax, az, ay, bx, bz, by, hw, id] = s;
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) < hw - 0.3) return [ay + (by - ay) * t, id];
      }
      return null;
    };
    const skip = /^(traffic|player|cyclist|rider|terrain|sky|vegetation)/;
    const found = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    v.scene.updateMatrixWorld(true);
    v.scene.traverseVisible((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      let q = o;
      const path = [];
      while (q) {
        if (q.name) path.push(q.name);
        q = q.parent;
      }
      const name = path.reverse().join("/");
      if (path.some((n) => skip.test(n))) return;
      const g = o.geometry;
      const pos = g.getAttribute("position");
      if (!pos) return;
      const idx = g.index;
      const tri = idx ? idx.count / 3 : pos.count / 3;
      const m = o.matrixWorld;
      // 走らない道の車の道の面（材質 0）の範囲
      const carGroup = o.name === "real-streets" ? (g.groups ?? []).find((q) => q.materialIndex === 0) : null;
      for (let t = 0; t < tri; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        e1.cross(e2);
        const len = e1.length();
        if (len < 1e-6) continue;
        if (Math.abs(e1.y) / len > 0.9) {
          if (!carGroup || t * 3 < carGroup.start || t * 3 >= carGroup.start + carGroup.count) continue;
          const fx = (a.x + b.x + c.x) / 3 + v.originX, fz = (a.z + b.z + c.z) / 3 + v.originZ;
          if (Math.hypot(fx - p.x, fz - p.z) > R) continue;
          const fr = onRoad(fx, fz);
          if (fr) found.push({ x: +fx.toFixed(1), z: +fz.toFixed(1), y: +fr[0].toFixed(2), lo: 0, hi: 0, road: fr[1], mesh: name + ":flat", area: len / 2 });
          continue;
        }
        if (Math.abs(e1.y) / len > 0.35) continue;
        const cx = (a.x + b.x + c.x) / 3 + v.originX, cz = (a.z + b.z + c.z) / 3 + v.originZ;
        if (Math.hypot(cx - p.x, cz - p.z) > R) continue;
        const sr = onRoad(cx, cz);
        if (!sr) continue;
        const lo = Math.min(a.y, b.y, c.y) - sr[0], hi = Math.max(a.y, b.y, c.y) - sr[0];
        if (hi < 0.2 || lo > 2.5) continue;
        found.push({ x: +cx.toFixed(1), z: +cz.toFixed(1), y: +sr[0].toFixed(2), lo: +lo.toFixed(2), hi: +hi.toFixed(2), road: sr[1], mesh: name, area: len / 2 });
      }
    });
    // 10m の塊ごとにまとめる
    const clusters = new Map();
    for (const f of found) {
      const k = `${f.mesh.split("/").slice(0, 2).join("/")}|${Math.round(f.x / 10)},${Math.round(f.z / 10)}`;
      const cl = clusters.get(k) ?? clusters.set(k, { mesh: f.mesh, x: f.x, z: f.z, y: f.y, road: f.road, n: 0, area: 0, hi: 0 }).get(k);
      cl.n++;
      cl.area += f.area;
      cl.hi = Math.max(cl.hi, f.hi);
    }
    const list = [...clusters.values()].map((c) => ({ ...c, area: +c.area.toFixed(2) })).sort((p, q) => q.area - p.area);
    const byMesh = {};
    for (const c of list) {
      const k = c.mesh.split("/").slice(0, 2).join("/");
      byMesh[k] = byMesh[k] ?? { clusters: 0, area: 0 };
      byMesh[k].clusters++;
      byMesh[k].area = +(byMesh[k].area + c.area).toFixed(2);
    }
    return { pos: { x: Math.round(p.x), z: Math.round(p.z) }, triangles: found.length, clusters: list.length, byMesh, top: list.slice(0, 40) };
  }, R);
  // 上位の塊を撮る（塊の 14m 手前・高さ 4m から）
  const shots = [];
  for (const [k, c] of r.top.slice(0, SHOTS).entries()) {
    const file = `${out}/${name}${tag}-${k}.png`;
    await page.evaluate((c) => (window.__dev.view._cam = { e: { x: c.x + 10, y: c.y + 4, z: c.z + 10 }, t: { x: c.x, y: c.y + 0.8, z: c.z }, fov: 60 }), c);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  result.places[name] = { ...r, shots, errors };
  console.log(name, JSON.stringify({ triangles: r.triangles, clusters: r.clusters, byMesh: r.byMesh }));
  await page.close();
}
writeFileSync(`${out}/results${tag}.json`, JSON.stringify(result, null, 2));
await browser.close();
