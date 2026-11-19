// 画面の点に何が描かれているかを調べる（光線を当てて、当たった物の名前・位置・面の向き）。
// node scripts/hokkaido-pick.mjs '<カメラの JSON {e,t,fov}>' x,y x,y ...（画面 1440×900 の画素）。MAP_BASE・AT=x,z
import { chromium } from "@playwright/test";
const base = process.env.MAP_BASE || "http://localhost:5180";
const [ax, az] = (process.env.AT || "0,0").split(",").map(Number);
const cam = JSON.parse(process.argv[2]);
const pts = process.argv.slice(3).map((s) => s.split(",").map(Number));
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(`${base}/?world=hokkaido&fresh=1&notitle=1&time=10&weather=clear&x=${ax}&z=${az}`);
await p.waitForFunction(() => window.__dev?.state().ready && window.__dev.state().settled, null, { timeout: 240000, polling: 250 });
await p.evaluate(() => { const v = window.__dev.view; v._f = v.frame.bind(v); v.frame = (e, t, f, cb) => (v._cam ? v._f(v._cam.e, v._cam.t, v._cam.fov ?? 45, cb) : v._f(e, t, f, cb)); window.__dev.setPaused(true); });
await p.evaluate((cam) => (window.__dev.view._cam = cam), cam);
await p.waitForTimeout(3000);
if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
const r = await p.evaluate(async (pts) => {
  const THREE = await import("/node_modules/.vite/deps/three.js");
  const v = window.__dev.view;
  const rc = new THREE.Raycaster();
  return pts.map(([px, py]) => {
    rc.setFromCamera(new THREE.Vector2((px / 1440) * 2 - 1, -(py / 900) * 2 + 1), v.camera);
    const h = rc.intersectObjects(v.scene.children, true).filter((h) => h.object.visible)[0];
    if (!h) return { px, py, hit: null };
    let n = h.object; const path = [];
    while (n) { if (n.name) path.push(n.name); n = n.parent; }
    const mat = Array.isArray(h.object.material) ? h.object.material[h.face?.materialIndex ?? 0] : h.object.material;
    return { px, py, d: +h.distance.toFixed(1), path: path.join("<"), mat: mat?.name || mat?.type, wx: +(h.point.x + v.originX).toFixed(1), y: +h.point.y.toFixed(2), wz: +(h.point.z + v.originZ).toFixed(1), nrm: h.face ? [h.face.normal.x, h.face.normal.y, h.face.normal.z].map((a) => +a.toFixed(2)) : null };
  });
}, pts);
console.log(JSON.stringify(r, null, 1));
await b.close();
