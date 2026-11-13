// 未舗装路の砂利の模様をコードで描く（外部素材を使わない）。
// 1枚が 2m 四方。大小の小石と、細かい粒の明暗。継ぎ目が出ないよう端をまたぐ小石は反対側にも描く。
// 毎回同じ見た目にするため乱数は種つきの線形合同法。

import * as THREE from "three";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createGravelTexture(size = 512, anisotropy = 4): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rnd = lcg(20261113);
  // 下地: 締まった土の明暗
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 150 + (rnd() - 0.5) * 26;
    img.data[i * 4] = v * 1.0;
    img.data[i * 4 + 1] = v * 0.93;
    img.data[i * 4 + 2] = v * 0.8;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // 大きなむらは描かない（2m ごとの繰り返しが縞に見えるため）。むらは道路側の頂点色（gravel-profile）で付ける
  // 小石: 小さいものを多く、大きいものを少し
  const stones = [
    [5200, 0.8, 2.2],
    [900, 2.2, 4.5],
    [90, 4.5, 8],
  ];
  for (const [count, rMin, rMax] of stones) {
    for (let k = 0; k < count; k++) {
      const x = rnd() * size, y = rnd() * size;
      const r = rMin + (rMax - rMin) * rnd() ** 2;
      const tone = 95 + rnd() * 120;
      const warm = rnd() * 18;
      const ry = r * (0.6 + rnd() * 0.4);
      const rot = rnd() * Math.PI;
      for (const ox of [-size, 0, size])
        for (const oy of [-size, 0, size]) {
          const px = x + ox, py = y + oy;
          if (px < -10 || py < -10 || px > size + 10 || py > size + 10) continue;
          // 影
          g.fillStyle = "rgba(40,34,26,0.35)";
          g.beginPath();
          g.ellipse(px + r * 0.25, py + r * 0.3, r, ry, rot, 0, Math.PI * 2);
          g.fill();
          // 石
          g.fillStyle = `rgb(${tone + warm},${tone + warm * 0.5},${tone - warm * 0.3})`;
          g.beginPath();
          g.ellipse(px, py, r, ry, rot, 0, Math.PI * 2);
          g.fill();
          // 上の明るい面
          g.fillStyle = "rgba(255,250,240,0.22)";
          g.beginPath();
          g.ellipse(px - r * 0.25, py - r * 0.25, r * 0.5, ry * 0.5, rot, 0, Math.PI * 2);
          g.fill();
        }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  return t;
}
