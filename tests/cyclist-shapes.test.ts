import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { loft, revolve, sweep, tube, v3 } from "../src/render/cyclist/shapes.ts";

/** 閉じた形の符号付き体積。面が外向きなら正 */
function signedVolume(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position");
  const idx = g.index!;
  let vol = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    vol += a.dot(b.clone().cross(c)) / 6;
  }
  return vol;
}

/** 頂点の法線が面の向きとそろっているか（そろっていない三角形の割合） */
function flippedShare(g: THREE.BufferGeometry) {
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const idx = g.index!;
  let bad = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    nn.fromBufferAttribute(n, idx.getX(i));
    if (face.dot(nn) < 0) bad++;
  }
  return bad / (idx.count / 3);
}

describe("自転車の形状の道具", () => {
  const cases: [string, THREE.BufferGeometry][] = [
    ["前向きの管", tube(v3(0, 0, 0), v3(0, 0, 1), 0, { r0: 0.1, seg: 8 })],
    ["下向きの楕円の管", tube(v3(0, 1, 0), v3(0, 0, 0.2), 0, { r0: 0.02, aspect: 1.9, seg: 6 })],
    ["曲がった管", sweep([v3(0, 0, 0), v3(0, -0.4, 0.3), v3(0.05, -0.9, 0.2), v3(0.1, -1.1, 0)], 0, { r0: 0.05, r1: 0.04, aspect: 1.9, seg: 6, samples: 10 })],
    ["断面の連続", loft([0, 1, 2].map((i) => [0, 1, 2, 3, 4, 5].map((j) => v3(Math.cos((j / 6) * Math.PI * 2) * 0.1, Math.sin((j / 6) * Math.PI * 2) * 0.1 + i * 0.02, i * 0.1))), 0)],
  ];
  for (const [name, g] of cases)
    it(`${name}は面が外向き`, () => {
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(flippedShare(g)).toBeLessThan(0.02);
    });

  it("回転体の面は外向き", () => {
    const g = revolve([[0.001, -0.1], [0.2, -0.1], [0.2, 0.1], [0.001, 0.1]], 0, 24);
    expect(flippedShare(g)).toBeLessThan(0.02);
  });
});
