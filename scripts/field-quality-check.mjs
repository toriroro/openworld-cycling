// 町の見た目の点検（ビジュアルの品質）: 場所ごとに半径 R の中で、次を数える。
//  1. 道の切れ目: 走る道の中心線と両端の近く（2m ごと）で、描いている路面（road の名前のメッシュの上向きの三角形）が無い点。
//     走らない道（real-streets の車の道の面）も中心線で同じく数える。
//  2. 立つ物の重なり: 住所の看板・道路標識・案内標識・矢羽根・電柱・街灯・街路樹の幹・自販機・置き看板を、
//     柱と板の箱（水平の向き付きの長方形と高さの範囲）にして、ほかの物と食い込む組を数える。
//  3. 浮いた家: 建物の外形の 4 隅で、描いている地形の高さと建物の土台の差。
//  4. 歩く人の足元: 足元の高さと、その点の描いている面（路面・歩道・地形）の差（箱の人形とリアルな人）。
// 開発サーバーが動いている前提（MAP_BASE、既定 5180）。node scripts/field-quality-check.mjs。結果は artifacts/field/。
// ONLY=odori,susukino で場所を絞る。TAG=-after で結果の名前を分ける。SHOTS=n で重なりの上位 n 件を撮る。

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.MAP_BASE || "http://localhost:5180";
const out = process.env.OUT || "artifacts/field";
const tag = process.env.TAG || "";
const R = Number(process.env.R || 260);
const SHOTS = Number(process.env.SHOTS ?? 3);
mkdirSync(out, { recursive: true });
// 配達の範囲（大通の周り）の中の場所。x, z は世界座標
const PLACES = [
  ["odori", 240, 40],
  ["susukino", 150, 900],
  ["kita", 300, -1300],
  ["higashi", 1300, 0],
  ["nishi", -1200, 300],
  // 配達の範囲の端（住宅街・坂）
  ["sw", -1800, 1900],
  ["se", 1800, 1900],
  ["nw", -1800, -1800],
];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const result = { R, places: {} };
for (const [name, x, z] of PLACES.filter(([n]) => !only || only.has(n))) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=11&weather=clear&x=${x}&z=${z}`);
  await page.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled && window.__dev.game.ride?.road, null, { timeout: 240000, polling: 250 });
  await page.evaluate(() => {
    const v = window.__dev.view;
    v._f = v.frame.bind(v);
    v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb));
  });
  // 住所の看板・自販機・歩く人が出るまで少し走らせてから止める
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__dev.setPaused(true));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async (R) => {
    const THREE = await import("/node_modules/.vite/deps/three.js");
    const d = window.__dev;
    const v = d.view;
    const gm = d.game;
    const p = d.rideInfo();
    const local = v.world.local;
    v.scene.updateMatrixWorld(true);

    // ---- 描いている上向きの三角形を 2m の格子に入れる（名前ごと） ----
    const G = 2;
    const tris = { road: new Map(), street: new Map(), walk: new Map() };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const put = (grid, t) => {
      const [ax, , az, bx, , bz, cx, , cz] = t;
      for (let i = Math.floor(Math.min(ax, bx, cx) / G); i <= Math.floor(Math.max(ax, bx, cx) / G); i++)
        for (let j = Math.floor(Math.min(az, bz, cz) / G); j <= Math.floor(Math.max(az, bz, cz) / G); j++) {
          const k = i * 1e6 + j;
          (grid.get(k) ?? grid.set(k, []).get(k)).push(t);
        }
    };
    v.scene.traverseVisible((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      let kind = null;
      if (o.name === "road") kind = "road";
      else if (o.name === "real-streets") kind = "street";
      else if (/sidewalk|districts|district:/.test(o.name)) kind = "walk";
      if (!kind) return;
      const g = o.geometry;
      const pos = g.getAttribute("position");
      if (!pos) return;
      const idx = g.index;
      const n = idx ? idx.count / 3 : pos.count / 3;
      const groups = g.groups ?? [];
      const matOf = (t) => {
        for (const q of groups) if (t * 3 >= q.start && t * 3 < q.start + q.count) return q.materialIndex;
        return 0;
      };
      for (let t = 0; t < n; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld);
        e1.subVectors(b, a);
        e2.subVectors(c, a);
        e1.cross(e2);
        const len = e1.length();
        if (len < 1e-8 || Math.abs(e1.y) / len < 0.7) continue;
        const ox = v.originX, oz = v.originZ;
        if (Math.hypot(a.x + ox - p.x, a.z + oz - p.z) > R + 80) continue;
        const tri = [a.x + ox, a.y, a.z + oz, b.x + ox, b.y, b.z + oz, c.x + ox, c.y, c.z + oz];
        // 走らない道の材質: 0 車の道・1 小道・2 歩道
        put(kind === "street" && matOf(t) === 2 ? tris.walk : tris[kind], tri);
      }
    });
    /** (x, z) の上の三角形の高さの並び */
    const heightsAt = (grid, x, z) => {
      const res = [];
      for (const t of grid.get(Math.floor(x / G) * 1e6 + Math.floor(z / G)) ?? []) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
        const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(den) < 1e-12) continue;
        const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
        const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        res.push(w0 * ay + w1 * by + w2 * cy);
      }
      return res;
    };

    // ---- 1. 道の切れ目 ----
    const gaps = [];
    let samples = 0;
    for (const road of d.roads.net.roads.values()) {
      const P = road.points, n = P.length / 3, hw = road.width / 2;
      const ox = road.origin[0], oz = road.origin[1];
      for (let i = 0; i + 1 < n; i++) {
        const ax = P[i * 3] + ox, az = P[i * 3 + 2] + oz, ay = P[i * 3 + 1];
        const bx = P[i * 3 + 3] + ox, bz = P[i * 3 + 5] + oz, by = P[i * 3 + 4];
        if (Math.hypot(ax - p.x, az - p.z) > R) continue;
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-6) continue;
        const tx = (bx - ax) / L, tz = (bz - az) / L;
        const steps = Math.max(1, Math.round(L / 2));
        for (let s = 0; s < steps; s++) {
          const u = (s + 0.5) / steps;
          const cx = ax + (bx - ax) * u, cz = az + (bz - az) * u, cy = ay + (by - ay) * u;
          const sAt = (i + u) * (road.length / (n - 1));
          if (road.spans.some((q) => q.kind === "tunnel" && sAt >= q.from - 2 && sAt <= q.to + 2)) continue;
          for (const off of [0, hw - 0.6, -(hw - 0.6)]) {
            const x = cx + tz * off, z = cz - tx * off;
            if (Math.hypot(x - p.x, z - p.z) > R) continue;
            samples++;
            const hs = heightsAt(tris.road, x, z);
            if (hs.some((h) => Math.abs(h - cy) < 0.6)) continue;
            gaps.push({ road: road.id, x: +x.toFixed(1), z: +z.toFixed(1), y: +cy.toFixed(2), off: +off.toFixed(1), near: hs.length ? +Math.min(...hs.map((h) => Math.abs(h - cy))).toFixed(2) : null });
          }
        }
      }
    }
    // 走らない道（車の道）の中心線
    const streetGaps = [];
    let streetSamples = 0;
    const S = local?.streets;
    if (S) {
      const C = S.index.cell;
      const pts = S.pts;
      const seen = new Set();
      for (let i = Math.floor((p.x - R) / C); i <= Math.floor((p.x + R) / C); i++)
        for (let j = Math.floor((p.z - R) / C); j <= Math.floor((p.z + R) / C); j++) {
          for (const pc of S.cell(i, j) ?? []) {
            const [o, n, w10, kind] = pc;
            if (seen.has(o)) continue;
            seen.add(o);
            if (S.index.kinds[kind] !== "street") continue;
            for (let k = 0; k + 1 < n; k++) {
              const ax = pts[(o + k) * 2], az = pts[(o + k) * 2 + 1], bx = pts[(o + k + 1) * 2], bz = pts[(o + k + 1) * 2 + 1];
              if (Math.hypot(ax - p.x, az - p.z) > R) continue;
              const L = Math.hypot(bx - ax, bz - az);
              const steps = Math.max(1, Math.round(L / 2));
              for (let s = 0; s < steps; s++) {
                const u = (s + 0.5) / steps;
                const x = ax + (bx - ax) * u, z = az + (bz - az) * u;
                if (Math.hypot(x - p.x, z - p.z) > R) continue;
                streetSamples++;
                if (heightsAt(tris.street, x, z).length || heightsAt(tris.road, x, z).length) continue;
                streetGaps.push({ x: +x.toFixed(1), z: +z.toFixed(1), w: w10 / 10, kind: S.index.kinds[kind] });
              }
            }
          }
        }
    }
    const cluster = (list, cell = 6) => {
      const m = new Map();
      for (const f of list) {
        const k = `${Math.round(f.x / cell)},${Math.round(f.z / cell)}`;
        const c = m.get(k) ?? m.set(k, { ...f, n: 0 }).get(k);
        c.n++;
      }
      return [...m.values()].sort((p, q) => q.n - p.n);
    };

    // ---- 2. 立つ物の重なり ----
    // 部品: { cx, cz, ux, uz（長い辺の向き）, hu, hv（半分の長さ）, y0, y1 }
    const items = [];
    const part = (cx, cz, ux, uz, hu, hv, y0, y1) => ({ cx, cz, ux, uz, hu, hv, y0, y1 });
    const post = (x, z, r, y, h) => part(x, z, 1, 0, r, r, y, y + h);
    const add = (kind, x, z, parts, extra = {}) => items.push({ kind, x, z, parts, ...extra });
    const ground = (x, z) => v.heights.height(x, z);
    // 住所の看板
    for (const s of gm.signList ?? []) {
      const ux = s.nz, uz = -s.nx; // 板は表の向きに直角
      add("addr", s.x, s.z, [post(s.x, s.z, 0.05, s.y, 2.7), part(s.x, s.z, ux, uz, 0.83, 0.02, s.y + 2.7, s.y + 3.39)], { label: s.label });
    }
    const SW = local?.sidewalks;
    // 描く側と同じ決め方（同じ所の標識を 1 本の柱にまとめる・標識に近い街路樹を植えない）
    const { stackRegulation } = await import("/src/render/real-signs.ts");
    const { treesBlockedBySigns } = await import("/src/render/real-streets.ts");
    if (SW) {
      const C = SW.index.cell;
      const D = SW.signs;
      const cellKeys = [];
      for (let i = Math.floor((p.x - R) / C) - 1; i <= Math.floor((p.x + R) / C) + 1; i++)
        for (let j = Math.floor((p.z - R) / C) - 1; j <= Math.floor((p.z + R) / C) + 1; j++) cellKeys.push(`${i},${j}`);
      const blockedTrees = treesBlockedBySigns(SW, cellKeys);
      const T = { 1: "stop", 2: "crosswalk", 3: "oneway", 4: "noEntry", 5: "speed", 6: "guide", 7: "yabane" };
      for (let i = Math.floor((p.x - R) / C); i <= Math.floor((p.x + R) / C); i++)
        for (let j = Math.floor((p.z - R) / C); j <= Math.floor((p.z + R) / C); j++) {
          const stack = stackRegulation(D, SW.index.signs[`${i},${j}`] ?? []);
          for (const t of SW.index.signs[`${i},${j}`] ?? []) {
            const o = t * 8;
            const type = D[o + 5];
            const kind = T[type];
            if (!kind) continue;
            const x = D[o], z = D[o + 2];
            if (Math.hypot(x - p.x, z - p.z) > R) continue;
            const y = Number.isNaN(D[o + 1]) ? ground(x, z) : D[o + 1];
            const fx = D[o + 3], fz = D[o + 4];
            if (kind === "guide") {
              const ax = fz, az = -fx, reach = D[o + 7];
              add("guide", x, z, [post(x, z, 0.11, y, 7.5), part(x + ax * reach, z + az * reach, ax, az, 1.8, 0.05, y + 5.15, y + 6.95)]);
            } else if (kind === "yabane") {
              add("yabane", x, z, [post(x, z, 0.04, y, 5.6)]);
            } else {
              const w = kind === "stop" ? 0.4 : kind === "oneway" ? 0.45 : 0.3;
              const st = stack.get(t);
              const yc = st ? st.y : kind === "stop" ? 2.25 : kind === "oneway" ? 2.0 : kind === "crosswalk" ? 2.35 : 2.3;
              const [ux, uz] = kind === "oneway" ? [fx, fz] : [-fz, fx];
              const sx = st ? D[st.at * 8] : x, sz = st ? D[st.at * 8 + 2] : z;
              const parts = [part(sx, sz, ux, uz, w, 0.03, y + yc - w, y + yc + w)];
              if (!st || st.post) parts.push(post(sx, sz, 0.03, y, 2.95));
              // 同じ柱の板どうしは 1 つの物として数える（柱を共有するので食い込みではない）
              add("sign", sx, sz, parts, { type: kind, post: st ? st.at : t });
            }
          }
          for (const [o0, n] of SW.index.poles[`${i},${j}`] ?? []) {
            const D2 = SW.poles;
            for (let k = o0; k < o0 + n; k++) {
              const o = k * 6;
              const flags = D2[o + 5];
              if (flags & 4) continue;
              const x = D2[o], z = D2[o + 2];
              if (Math.hypot(x - p.x, z - p.z) > R) continue;
              const y = Number.isNaN(D2[o + 1]) ? ground(x, z) : D2[o + 1];
              if (flags & 8) add("light", x, z, [post(x, z, 0.09, y, 9)]);
              else add("pole", x, z, [post(x, z, 0.17, y, 10.2)]);
            }
          }
          for (const t of SW.index.trees[`${i},${j}`] ?? []) {
            if (blockedTrees.has(t)) continue;
            const o = t * 5;
            const x = SW.trees[o], z = SW.trees[o + 2];
            if (Math.hypot(x - p.x, z - p.z) > R) continue;
            const y = SW.trees[o + 1];
            add("tree", x, z, [post(x, z, 0.15, Number.isNaN(y) ? ground(x, z) : y, 2.2)]);
          }
        }
    }
    // 自販機・置き看板は描く側と同じく、木を避けてずらした所（RestStopView.clear）
    for (const st0 of gm.restStops ?? []) {
      const st = v.restStops.clear(st0);
      if (Math.hypot(st.x - p.x, st.z - p.z) > R) continue;
      const ux = -st.fz, uz = st.fx;
      add(st.kind === "vending" ? "vending" : "standSign", st.x, st.z, [part(st.x, st.z, ux, uz, st.kind === "vending" ? 0.5 : 0.3, 0.35, st.y, st.y + (st.kind === "vending" ? 1.85 : 1.0))], { name: st.name });
    }
    // 向き付きの長方形の食い込み（分離軸）。margin だけ詰めて、触れるだけの物は数えない
    const overlap2 = (A, B) => {
      if (A.y1 <= B.y0 || B.y1 <= A.y0) return false;
      const axes = [[A.ux, A.uz], [-A.uz, A.ux], [B.ux, B.uz], [-B.uz, B.ux]];
      const dx = B.cx - A.cx, dz = B.cz - A.cz;
      for (const [ax, az] of axes) {
        const ra = A.hu * Math.abs(A.ux * ax + A.uz * az) + A.hv * Math.abs(-A.uz * ax + A.ux * az);
        const rb = B.hu * Math.abs(B.ux * ax + B.uz * az) + B.hv * Math.abs(-B.uz * ax + B.ux * az);
        if (Math.abs(dx * ax + dz * az) >= ra + rb - 0.01) return false;
      }
      return true;
    };
    const pairs = [];
    const IG = 4;
    const igrid = new Map();
    items.forEach((it, i) => {
      const k = Math.floor(it.x / IG) * 1e6 + Math.floor(it.z / IG);
      (igrid.get(k) ?? igrid.set(k, []).get(k)).push(i);
    });
    items.forEach((A, i) => {
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (const jx of igrid.get((Math.floor(A.x / IG) + di) * 1e6 + Math.floor(A.z / IG) + dj) ?? []) {
            if (jx <= i) continue;
            const B = items[jx];
            if (A.post !== undefined && A.post === B.post) continue;
            if (A.parts.some((pa) => B.parts.some((pb) => overlap2(pa, pb))))
              pairs.push({ a: A.kind, b: B.kind, x: +((A.x + B.x) / 2).toFixed(1), z: +((A.z + B.z) / 2).toFixed(1), d: +Math.hypot(A.x - B.x, A.z - B.z).toFixed(2), la: A.label ?? A.type ?? A.name, lb: B.label ?? B.type ?? B.name });
          }
    });
    const byPair = {};
    for (const q of pairs) {
      const k = [q.a, q.b].sort().join("-");
      byPair[k] = (byPair[k] ?? 0) + 1;
    }
    const kinds = {};
    for (const it of items) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;

    // ---- 3. 浮いた家 ----
    const floats = [];
    let nb = 0;
    const B = local?.buildings;
    if (B) {
      const D = B.data, C = B.index.cell;
      const probe = (pts) => d.groundAt(pts);
      const cand = [];
      for (let i = Math.floor((p.x - R) / C); i <= Math.floor((p.x + R) / C); i++)
        for (let j = Math.floor((p.z - R) / C); j <= Math.floor((p.z + R) / C); j++) {
          const c = B.cell(i, j);
          if (!c) continue;
          for (let k = c[0]; k < c[0] + c[1]; k++) {
            const o = k * 16;
            const bx = D[o], bz = D[o + 1];
            if (Math.hypot(bx - p.x, bz - p.z) > R) continue;
            const an = D[o + 5];
            const ax = Math.cos(an), az = Math.sin(an);
            const hw = D[o + 2] / 2, hd = D[o + 3] / 2;
            const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [bx + ax * s * hw - az * t * hd, bz + az * s * hw + ax * t * hd]);
            cand.push({ bx, bz, base: D[o + 6], corners });
          }
        }
      nb = cand.length;
      const hs = probe(cand.flatMap((q) => q.corners));
      cand.forEach((q, i) => {
        let gap = -Infinity;
        for (let k = 0; k < 4; k++) {
          const g = hs[i * 4 + k];
          if (g === null) continue;
          gap = Math.max(gap, q.base - g);
        }
        if (gap > 0.3) floats.push({ x: Math.round(q.bx), z: Math.round(q.bz), base: +q.base.toFixed(2), gap: +gap.toFixed(2) });
      });
      floats.sort((p, q) => q.gap - p.gap);
    }

    // ---- 4. 歩く人の足元 ----
    const pv = v.pedestrians;
    const feet = [];
    const body = pv.group.children.find((m) => m.name === "pedestrian-body");
    if (body) {
      const m = new THREE.Matrix4(), q = new THREE.Vector3();
      const list = [];
      for (let i = 0; i < body.count; i++) {
        body.getMatrixAt(i, m);
        q.setFromMatrixPosition(m);
        list.push([q.x + v.originX, q.y, q.z + v.originZ]);
      }
      // リアルな形で描く近くの人（町の見た目の草案 3 章）
      for (const p of pv.realList ?? []) list.push([p.x, p.y, p.z]);
      const gh = d.groundAt(list.map(([x, , z]) => [x, z]));
      list.forEach(([x, y, z], i) => {
        // 三角形を集めた範囲の外は見ない
        if (Math.hypot(x - p.x, z - p.z) > R) return;
        const tops = [...heightsAt(tris.road, x, z), ...heightsAt(tris.street, x, z), ...heightsAt(tris.walk, x, z)];
        if (gh[i] !== null) tops.push(gh[i]);
        // 足元より下で一番高い面（無ければ一番近い面）
        const below = tops.filter((h) => h <= y + 0.05);
        const surf = below.length ? Math.max(...below) : tops.length ? Math.min(...tops) : null;
        if (surf === null) return;
        feet.push({ x: +x.toFixed(1), z: +z.toFixed(1), y: +y.toFixed(2), d: +(y - surf).toFixed(2), tops: tops.map((h) => +h.toFixed(2)) });
      });
    }
    const feetBad = feet.filter((f) => Math.abs(f.d) > 0.12).sort((p, q) => Math.abs(q.d) - Math.abs(p.d));

    return {
      pos: { x: Math.round(p.x), y: +p.y.toFixed(1), z: Math.round(p.z) },
      roadGaps: { samples, points: gaps.length, clusters: cluster(gaps).slice(0, 30) },
      streetGaps: { samples: streetSamples, points: streetGaps.length, clusters: cluster(streetGaps).slice(0, 30) },
      overlaps: { items: kinds, pairs: pairs.length, byPair, list: pairs.slice(0, 60) },
      buildings: { n: nb, floating03: floats.length, floating1: floats.filter((f) => f.gap > 1).length, worst: floats.slice(0, 10) },
      walkers: { n: feet.length, off12: feetBad.length, floating: feetBad.filter((f) => f.d > 0).length, sunk: feetBad.filter((f) => f.d < 0).length, worst: feetBad.slice(0, 10) },
    };
  }, R);
  // 上位の重なり・切れ目を撮る
  const shots = [];
  const targets = [
    ...r.overlaps.list.slice(0, SHOTS).map((q, k) => ({ ...q, y: r.pos.y, file: `ov${k}`, far: 7, up: 2.5, ty: 2.4 })),
    ...r.roadGaps.clusters.slice(0, SHOTS).map((q, k) => ({ ...q, file: `gap${k}`, far: 12, up: 6, ty: 0 })),
    ...r.streetGaps.clusters.slice(0, SHOTS).map((q, k) => ({ ...q, y: r.pos.y, file: `sgap${k}`, far: 12, up: 8, ty: 0 })),
    ...r.buildings.worst.slice(0, Math.min(1, SHOTS)).map((q, k) => ({ ...q, y: q.base, file: `float${k}`, far: 26, up: 6, ty: 2 })),
  ];
  for (const t of targets) {
    const file = `${out}/${name}${tag}-${t.file}.png`;
    const gy = await page.evaluate((t) => window.__dev.groundAt([[t.x, t.z]])[0] ?? t.y, t);
    await page.evaluate(({ t, gy }) => (window.__dev.view._cam = { e: { x: t.x + t.far * 0.7, y: gy + t.up, z: t.z + t.far * 0.7 }, t: { x: t.x, y: gy + t.ty, z: t.z }, fov: 60 }), { t, gy });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: file });
    shots.push(file);
  }
  result.places[name] = { ...r, shots, errors };
  console.log(
    name,
    JSON.stringify({
      roadGaps: [r.roadGaps.samples, r.roadGaps.points, r.roadGaps.clusters.length],
      streetGaps: [r.streetGaps.samples, r.streetGaps.points, r.streetGaps.clusters.length],
      overlaps: r.overlaps.byPair,
      items: r.overlaps.items,
      buildings: [r.buildings.n, r.buildings.floating03, r.buildings.floating1, r.buildings.worst[0]?.gap],
      walkers: [r.walkers.n, r.walkers.floating, r.walkers.sunk, r.walkers.worst[0]?.d],
      errors: errors.length,
    }),
  );
  await page.close();
}
writeFileSync(`${out}/results${tag}.json`, JSON.stringify(result, null, 2));
await browser.close();
