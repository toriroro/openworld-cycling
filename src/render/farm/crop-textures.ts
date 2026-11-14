// 作物の株の絵（板に貼る。透明の地に canvas で描く。外部の素材は使わない）。
// leaf = 葉の茂った株（じゃがいも・ビート・豆）、stalk = 穂のある茎の束（小麦）、rice = 細い葉の束（稲・牧草）、corn = 背の高い茎と葉（デントコーン）

import * as THREE from "three";

export type CropTuft = "leaf" | "stalk" | "rice" | "corn";
/** 板の幅と高さ (m) */
export const TUFT_SIZE: Record<CropTuft, [number, number]> = { leaf: [1.3, 0.5], stalk: [2.2, 0.85], rice: [2.0, 0.55], corn: [1.6, 2.2] };

export function cropTexture(kind: CropTuft, aniso: number): THREE.CanvasTexture {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const c = cv.getContext("2d")!;
  // 決まった乱数（毎回同じ絵）
  let s = kind.length * 977 + kind.charCodeAt(0) * 131;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  c.clearRect(0, 0, S, S);
  c.lineCap = "round";
  const blade = (x0: number, y0: number, x1: number, y1: number, w: number, col: string) => {
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(x0, y0);
    c.quadraticCurveTo((x0 + x1) / 2 + (rnd() - 0.5) * 14, (y0 + y1) / 2, x1, y1);
    c.stroke();
  };
  // 板の幅いっぱいに描く（隣の板と重なって、切れ目なく茂って見えるように）
  if (kind === "leaf") {
    for (let i = 0; i < 90; i++) {
      const x = rnd() * S, top = 0.25 + 0.35 * Math.sin((x / S) * Math.PI * 3 + 1) ** 2;
      const y = S - 4 - rnd() * S * (1 - top) * 0.9;
      const g = 70 + Math.floor(rnd() * 45);
      c.fillStyle = `rgb(${Math.floor(g * 0.62)},${g + 38},${Math.floor(g * 0.42)})`;
      c.beginPath();
      c.ellipse(x, y, 9 + rnd() * 8, 5 + rnd() * 4, (rnd() - 0.5) * 2, 0, Math.PI * 2);
      c.fill();
    }
  } else if (kind === "stalk") {
    for (let i = 0; i < 70; i++) {
      const x0 = rnd() * S, x1 = x0 + (rnd() - 0.5) * 16, y1 = 10 + rnd() * 30;
      const g = 185 + Math.floor(rnd() * 45);
      blade(x0, S, x1, y1 + 14, 1.6, `rgb(${g},${Math.floor(g * 0.86)},${Math.floor(g * 0.5)})`);
      c.fillStyle = `rgb(${Math.min(255, g + 18)},${Math.floor(g * 0.88)},${Math.floor(g * 0.46)})`;
      c.beginPath();
      c.ellipse(x1, y1 + 5, 2.6, 10, (x1 - x0) / 50, 0, Math.PI * 2);
      c.fill();
    }
  } else if (kind === "rice") {
    for (let i = 0; i < 110; i++) {
      const x0 = rnd() * S, x1 = x0 + (rnd() - 0.5) * 36, y1 = 8 + rnd() * 60;
      const g = 92 + Math.floor(rnd() * 44);
      blade(x0, S, x1, y1, 2, `rgb(${Math.floor(g * 0.68)},${g + 34},${Math.floor(g * 0.38)})`);
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const x0 = 16 + i * 24 + (rnd() - 0.5) * 8;
      blade(x0, S, x0 + (rnd() - 0.5) * 6, 8, 3.5, "#6d8c3d");
      for (let k = 0; k < 7; k++) {
        const y = S - 14 - k * 15, dir = k % 2 ? 1 : -1;
        const g = 95 + Math.floor(rnd() * 50);
        blade(x0, y, x0 + dir * (16 + rnd() * 12), y - 6 + rnd() * 16, 4, `rgb(${Math.floor(g * 0.56)},${g + 30},${Math.floor(g * 0.36)})`);
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}
