// どちらの世界で走るか（北海道の草案 2.1・2.2）。生成の世界と北海道の世界で、データの読み先・保存・起点・出典を分ける。

import { SAVE_KEY } from "./shared/save.ts";
import { GENERATOR_VERSION, ORIGIN } from "./shared/world/constants.ts";
import { HOKKAIDO_BASE, HOKKAIDO_GENERATOR, type HokkaidoWorld } from "./shared/world/hokkaido.ts";
import { loadHokkaidoWorld } from "./workers/hokkaido-load.ts";

export type WorldId = "generated" | "hokkaido";

/** 最後に選んだ世界を覚える保存の鍵 */
export const WORLD_KEY = "world";

export interface WorldChoice {
  id: WorldId;
  /** 植生・名前などの乱数（北海道の世界では地形・道路に使わない） */
  seed: number;
  /** 北海道の変換データの置き場 */
  base: string;
  /** 保存の鍵（世界ごとに分ける。道路の識別子が世界ごとに別物なので） */
  saveKey: string;
  /** はじめからの起点 */
  origin: { x: number; z: number };
  /** 保存データの generator（続きからの位置を使ってよいかの照合） */
  generator: number;
  /** 画面に出す名前 */
  label: string;
  /** メインスレッドで使う北海道の世界（高さ・道路の読み込みが Worker なしでもできるように） */
  local: HokkaidoWorld | null;
  /** 出典（画面に出す。北海道の草案 3.1・3.2） */
  attribution: { text: string; url: string }[];
}

export const WORLD_LABELS: Record<WorldId, string> = { generated: "生成の世界", hokkaido: "北海道（札幌）" };

export function generatedWorld(seed: number): WorldChoice {
  return { id: "generated", seed, base: "", saveKey: SAVE_KEY, origin: { x: ORIGIN.x, z: ORIGIN.z }, generator: GENERATOR_VERSION, label: WORLD_LABELS.generated, local: null, attribution: [] };
}

/** 北海道の世界（変換データを読む。読めなければ例外） */
export async function hokkaidoWorld(seed: number, base = HOKKAIDO_BASE): Promise<WorldChoice> {
  const local = await loadHokkaidoWorld(base, seed, true);
  // 起点の周りの頁を先に読む（続きからの位置は、描く側が動いた先で読む）
  await local.ensureAround(240, 40);
  return {
    id: "hokkaido",
    seed,
    base,
    saveKey: `${SAVE_KEY}-hokkaido`,
    // 大通公園の東の端（北緯 43.0596 度・東経 141.3530 度）
    origin: { x: 240, z: 40 },
    generator: HOKKAIDO_GENERATOR,
    label: WORLD_LABELS.hokkaido,
    local,
    attribution: [
      { text: "地図データ © OpenStreetMap contributors（ODbL）", url: "https://www.openstreetmap.org/copyright" },
      { text: "標高 国土地理院 標高タイルを加工して作成", url: "https://maps.gsi.go.jp/development/ichiran.html" },
      { text: "建物 3D都市モデル（Project PLATEAU）札幌市／国土交通省（CC BY 4.0）を加工して作成", url: "https://www.geospatial.jp/ckan/dataset/plateau-01100-sapporo-shi-2020" },
    ],
  };
}

/** Worker の init に足す項目 */
export function workerInit(w: WorldChoice | undefined): { world?: "hokkaido"; base?: string } {
  return w?.id === "hokkaido" ? { world: "hokkaido", base: w.base } : {};
}
