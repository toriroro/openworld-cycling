// 変換データを 2km 四方の頁に分けて書く（北海道の草案 20 章）。実行時は近くの頁だけ読む。
//
// 地形: pages/terrain/{px}_{pz}.bin … 10m 格子の 201 × 201 点（隣の頁と縁の点を共有）。
//       高さ Int16（0.1m）、水・土地利用・建物の込み具合・店の込み具合 Uint8 の 5 層。
//       overview.bin … 全体の 50m 格子（同じ 5 層）。頁を読む前・遠景・2D 地図に使う。
// 建物・走らない道・歩道: pages/{kind}/{px}_{pz}.bin … [Uint32 索引の長さ][索引の JSON][4 バイトにそろえる余白][Float32 の並び…]。
//       索引の位置は頁の中の位置（実行時に読み込んだ先の位置へずらす）。

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { HOKKAIDO_PAGE, type HokkaidoBuildingIndex, type HokkaidoSidewalkIndex, type HokkaidoStreetIndex } from "../../src/shared/world/hokkaido.ts";

export const PAGE = HOKKAIDO_PAGE;

export interface GridInfo {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
}

/** 頁の番号の範囲（格子の原点からの頁） */
export function pageRange(g: GridInfo) {
  const per = PAGE / g.step;
  return { per, npx: Math.ceil((g.nx - 1) / per), npz: Math.ceil((g.nz - 1) / per) };
}

/** 地形の頁と全体の縮図を書く。layers は [高さ Int16, 水, 土地利用, 込み具合, 店の込み具合] */
export function writeTerrainPages(dir: string, g: GridInfo, h: Int16Array, layers: Uint8Array[], overviewStep = 50) {
  rmSync(`${dir}/pages/terrain`, { recursive: true, force: true });
  mkdirSync(`${dir}/pages/terrain`, { recursive: true });
  const { per, npx, npz } = pageRange(g);
  const n = per + 1;
  let bytes = 0;
  for (let pz = 0; pz < npz; pz++)
    for (let px = 0; px < npx; px++) {
      const buf = new Uint8Array(n * n * (2 + layers.length));
      const hv = new Int16Array(buf.buffer, 0, n * n);
      for (let j = 0; j < n; j++) {
        const gj = Math.min(g.nz - 1, pz * per + j);
        for (let i = 0; i < n; i++) {
          const gi = Math.min(g.nx - 1, px * per + i);
          const k = gj * g.nx + gi;
          const o = j * n + i;
          hv[o] = h[k];
          for (let l = 0; l < layers.length; l++) buf[n * n * (2 + l) + o] = layers[l][k];
        }
      }
      writeFileSync(`${dir}/pages/terrain/${px}_${pz}.bin`, buf);
      bytes += buf.length;
    }
  // 縮図
  const s = Math.round(overviewStep / g.step);
  const onx = Math.floor((g.nx - 1) / s) + 1;
  const onz = Math.floor((g.nz - 1) / s) + 1;
  const ov = new Uint8Array(onx * onz * (2 + layers.length));
  const ohv = new Int16Array(ov.buffer, 0, onx * onz);
  for (let j = 0; j < onz; j++)
    for (let i = 0; i < onx; i++) {
      const k = j * s * g.nx + i * s;
      const o = j * onx + i;
      ohv[o] = h[k];
      for (let l = 0; l < layers.length; l++) ov[onx * onz * (2 + l) + o] = layers[l][k];
    }
  writeFileSync(`${dir}/overview.bin`, ov);
  return {
    pages: { size: PAGE, per, npx, npz },
    overview: { x0: g.x0, z0: g.z0, step: s * g.step, nx: onx, nz: onz },
    pagesMB: +(bytes / 1e6).toFixed(1),
    overviewMB: +(ov.length / 1e6).toFixed(1),
  };
}

/** 索引の JSON と Float32 の並びを 1 つの頁ファイルにする */
function container(index: unknown, arrays: Float32Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(index));
  const head = 4 + json.length;
  const pad = (4 - (head % 4)) % 4;
  let total = head + pad;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let off = head + pad;
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), off);
    off += a.byteLength;
  }
  return out;
}

/** 区画 "cx,cz" → 頁 "px_pz"（頁は格子の原点 g.x0, g.z0 から数える） */
function pageOfCell(key: string, cell: number, g: GridInfo): string {
  const [cx, cz] = key.split(",").map(Number);
  const px = Math.floor((cx * cell + cell / 2 - g.x0) / PAGE);
  const pz = Math.floor((cz * cell + cell / 2 - g.z0) / PAGE);
  return `${px}_${pz}`;
}

function groupCells<T>(cells: Record<string, T>, cell: number, g: GridInfo): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of Object.keys(cells)) {
    const p = pageOfCell(k, cell, g);
    const l = out.get(p) ?? [];
    l.push(k);
    out.set(p, l);
  }
  return out;
}

function writeAll(dir: string, kind: string, files: Map<string, Uint8Array>) {
  rmSync(`${dir}/pages/${kind}`, { recursive: true, force: true });
  mkdirSync(`${dir}/pages/${kind}`, { recursive: true });
  let bytes = 0;
  for (const [p, buf] of files) {
    writeFileSync(`${dir}/pages/${kind}/${p}.bin`, buf);
    bytes += buf.length;
  }
  return { pages: [...files.keys()], MB: +(bytes / 1e6).toFixed(1) };
}

export function writeBuildingPages(dir: string, g: GridInfo, data: Float32Array, index: HokkaidoBuildingIndex) {
  const files = new Map<string, Uint8Array>();
  for (const [p, keys] of groupCells(index.cells, index.cell, g)) {
    let n = 0;
    for (const k of keys) n += index.cells[k][1];
    const out = new Float32Array(n * index.rec);
    const cells: Record<string, [number, number]> = {};
    let o = 0;
    for (const k of keys) {
      const [start, count] = index.cells[k];
      out.set(data.subarray(start * index.rec, (start + count) * index.rec), o * index.rec);
      cells[k] = [o, count];
      o += count;
    }
    files.set(p, container({ cell: index.cell, rec: index.rec, cells }, [out]));
  }
  return writeAll(dir, "buildings", files);
}

export function writeStreetPages(dir: string, g: GridInfo, pts: Float32Array, index: HokkaidoStreetIndex) {
  const files = new Map<string, Uint8Array>();
  for (const [p, keys] of groupCells(index.pieces, index.cell, g)) {
    const parts: Float32Array[] = [];
    const pieces: HokkaidoStreetIndex["pieces"] = {};
    let o = 0;
    for (const k of keys)
      pieces[k] = index.pieces[k].map(([off, count, w, kind]) => {
        parts.push(pts.subarray(off * 2, (off + count) * 2));
        const r: [number, number, number, number] = [o, count, w, kind];
        o += count;
        return r;
      });
    const out = new Float32Array(o * 2);
    let q = 0;
    for (const a of parts) {
      out.set(a, q);
      q += a.length;
    }
    files.set(p, container({ cell: index.cell, kinds: index.kinds, pieces }, [out]));
  }
  return writeAll(dir, "streets", files);
}

export function writeSidewalkPages(dir: string, g: GridInfo, pts: Float32Array, trees: Float32Array, index: HokkaidoSidewalkIndex) {
  const files = new Map<string, Uint8Array>();
  const all = new Set([...Object.keys(index.sidewalks), ...Object.keys(index.trees)]);
  const keysOf = groupCells(Object.fromEntries([...all].map((k) => [k, 1])), index.cell, g);
  const TREE = 5;
  for (const [p, keys] of keysOf) {
    const sp: Float32Array[] = [];
    const tp: number[] = [];
    const sidewalks: HokkaidoSidewalkIndex["sidewalks"] = {};
    const treeIdx: HokkaidoSidewalkIndex["trees"] = {};
    let o = 0;
    for (const k of keys) {
      if (index.sidewalks[k])
        sidewalks[k] = index.sidewalks[k].map(([off, count]) => {
          sp.push(pts.subarray(off * index.rec, (off + count) * index.rec));
          const r: [number, number] = [o, count];
          o += count;
          return r;
        });
      if (index.trees[k])
        treeIdx[k] = index.trees[k].map((t) => {
          const n = tp.length / TREE;
          for (let i = 0; i < TREE; i++) tp.push(trees[t * TREE + i]);
          return n;
        });
    }
    const out = new Float32Array(o * index.rec);
    let q = 0;
    for (const a of sp) {
      out.set(a, q);
      q += a.length;
    }
    files.set(p, container({ cell: index.cell, rec: index.rec, sidewalks, trees: treeIdx, ptsLength: out.length }, [out, Float32Array.from(tp)]));
  }
  return writeAll(dir, "sidewalks", files);
}
