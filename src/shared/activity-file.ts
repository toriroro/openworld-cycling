// 運動の記録のファイルを読む（冒険の草案 3.1）: FIT・GPX・TCX と、それらを入れた .zip（Garmin Connect の書き出し）。
// 読むのは種目・開始・距離・時間の合計だけ。位置の列はその場で距離にして捨て、返さない（草案 0 章の 6）。
// DOM・Node に依存しない（.zip の展開はブラウザと Node の両方にある DecompressionStream）。ライブラリを使わない。

import type { ActivitySummary, Sport } from "../sim/adventure.ts";

/** 1 つのファイルの大きさの上限（バイト） */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const FIT_EPOCH = 631065600;

// ---------- FIT ----------

/** FIT の sport・sub_sport → 種目 */
export function fitSport(sport: number | undefined, sub: number | undefined): Sport | null {
  switch (sport) {
    case 1:
      return "run";
    case 2:
      // 屋内の自転車（6 indoor_cycling、58 virtual_activity）
      return sub === 6 || sub === 58 ? "ride-indoor" : "ride";
    case 5:
      return "swim";
    case 11:
    case 17:
      return "walk";
    case undefined:
      return null;
    default:
      return "other";
  }
}

interface FitDef {
  global: number;
  little: boolean;
  fields: { num: number; size: number; type: number }[];
  /** 開発者のフィールドの合計の大きさ（読まずに飛ばす） */
  devSize: number;
}

/**
 * FIT の活動ファイルから、session ごとの合計を読む。
 * 通常のヘッダ・圧縮した時刻のヘッダ・開発者のフィールド・big endian に対応する。読む値は数のフィールドだけ
 */
export function readFitActivities(bytes: Uint8Array, file = ""): ActivitySummary[] {
  if (bytes.length < 14) throw new Error("FIT として短すぎる");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = v.getUint8(0);
  if (String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") throw new Error("FIT の印が無い");
  const dataSize = v.getUint32(4, true);
  const end = Math.min(bytes.length, headerSize + dataSize);
  const defs = new Map<number, FitDef>();
  const sessions: Map<number, number>[] = [];
  let fileId: Map<number, number> | null = null;
  // 記録だけで session の無いファイルのため
  let firstTs = NaN;
  let lastTs = NaN;
  let lastDist = NaN;
  let sportMsg: Map<number, number> | null = null;
  let o = headerSize;
  while (o < end) {
    const h = v.getUint8(o++);
    let local: number;
    let compressedTs = false;
    if (h & 0x80) {
      // 圧縮した時刻のヘッダ: 局所の番号はビット 5〜6
      local = (h >> 5) & 0x3;
      compressedTs = true;
    } else local = h & 0x0f;
    if (!compressedTs && h & 0x40) {
      const hasDev = (h & 0x20) !== 0;
      o++;
      const little = v.getUint8(o++) === 0;
      const global = v.getUint16(o, little);
      o += 2;
      const n = v.getUint8(o++);
      const fields = [];
      for (let i = 0; i < n; i++) {
        fields.push({ num: v.getUint8(o), size: v.getUint8(o + 1), type: v.getUint8(o + 2) });
        o += 3;
      }
      let devSize = 0;
      if (hasDev) {
        const nd = v.getUint8(o++);
        for (let i = 0; i < nd; i++) {
          devSize += v.getUint8(o + 1);
          o += 3;
        }
      }
      defs.set(local, { global, little, fields, devSize });
      continue;
    }
    const d = defs.get(local);
    if (!d) throw new Error(`FIT の定義の無いメッセージ（${local}）`);
    const values = new Map<number, number>();
    for (const f of d.fields) {
      if (o + f.size > end) throw new Error("FIT が途中で切れている");
      const signed = (f.type & 0x1f) === 1 || (f.type & 0x1f) === 3 || (f.type & 0x1f) === 5;
      // 数のフィールドだけ読む（配列・文字列は飛ばす）
      if (f.size === 1 && f.type !== 0x07 && f.type !== 0x0d) values.set(f.num, signed ? v.getInt8(o) : v.getUint8(o));
      else if (f.size === 2 && ((f.type & 0x1f) === 3 || (f.type & 0x1f) === 4 || (f.type & 0x1f) === 11)) values.set(f.num, signed ? v.getInt16(o, d.little) : v.getUint16(o, d.little));
      else if (f.size === 4 && ((f.type & 0x1f) === 5 || (f.type & 0x1f) === 6 || (f.type & 0x1f) === 12)) values.set(f.num, signed ? v.getInt32(o, d.little) : v.getUint32(o, d.little));
      o += f.size;
    }
    o += d.devSize;
    if (d.global === 0) fileId = values;
    else if (d.global === 18) sessions.push(values);
    else if (d.global === 12) sportMsg = values;
    else if (d.global === 20) {
      const ts = values.get(253);
      if (ts !== undefined && ts !== 0xffffffff) {
        if (Number.isNaN(firstTs)) firstTs = ts;
        lastTs = ts;
      }
      const dist = values.get(5);
      if (dist !== undefined && dist !== 0xffffffff) lastDist = dist / 100;
    }
  }
  const own = fileId?.get(1) === 255 && fileId?.get(2) === 1;
  const valid = (x: number | undefined, invalid: number) => (x === undefined || x === invalid ? undefined : x);
  if (sessions.length) {
    return sessions.map((s) => {
      const start = valid(s.get(2), 0xffffffff) ?? valid(s.get(253), 0xffffffff) ?? 0;
      const timer = valid(s.get(8), 0xffffffff) ?? valid(s.get(7), 0xffffffff) ?? 0;
      return {
        sport: fitSport(valid(s.get(5), 0xff), valid(s.get(6), 0xff)),
        start: start + FIT_EPOCH,
        distance: (valid(s.get(9), 0xffffffff) ?? 0) / 100,
        seconds: timer / 1000,
        source: "fit" as const,
        own,
        file,
      };
    });
  }
  if (Number.isNaN(firstTs)) return [];
  return [
    {
      sport: sportMsg ? fitSport(valid(sportMsg.get(0), 0xff), valid(sportMsg.get(1), 0xff)) : null,
      start: firstTs + FIT_EPOCH,
      distance: Number.isNaN(lastDist) ? 0 : lastDist,
      seconds: lastTs - firstTs,
      source: "fit",
      own,
      file,
    },
  ];
}

// ---------- GPX ----------

const R_EARTH = 6371008.8;
const RAD = Math.PI / 180;

/** 2 点の大円の距離 (m) */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 文字の種目（GPX の type、TCX の Sport、Strava・Garmin・Apple の書き方） → 種目 */
export function textSport(t: string | null | undefined): Sport | null {
  if (!t) return null;
  const s = t.toLowerCase();
  if (/virtual|indoor/.test(s) && /ride|cycl|bik/.test(s)) return "ride-indoor";
  if (/run/.test(s)) return "run";
  if (/walk|hik/.test(s)) return "walk";
  if (/cycl|bik|ride/.test(s)) return "ride";
  if (/swim/.test(s)) return "swim";
  // Garmin の数字の種目（1 ランなど）
  if (/^\d+$/.test(s)) return fitSport(Number(s), undefined);
  return "other";
}

/** 点の間がこれより長い所は止まっていたとみなし、時間に入れない (s) */
const GPX_PAUSE_S = 30;

export function readGpx(text: string, file = ""): ActivitySummary[] {
  if (!/<gpx[\s>]/i.test(text)) throw new Error("GPX の印が無い");
  const out: ActivitySummary[] = [];
  const tracks = text.match(/<trk[\s>][\s\S]*?<\/trk>/gi) ?? [];
  for (const trk of tracks) {
    const type = /<type>\s*([^<]*?)\s*<\/type>/i.exec(trk.split(/<trkseg/i)[0])?.[1] ?? null;
    let distance = 0;
    let seconds = 0;
    let start = NaN;
    let prev: { lat: number; lon: number; t: number } | null = null;
    // 区間（trkseg）の間はつながない
    for (const seg of trk.match(/<trkseg[\s>][\s\S]*?<\/trkseg>/gi) ?? []) {
      prev = null;
      const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>|<trkpt\b([^>]*)\/>/gi;
      for (let m = re.exec(seg); m; m = re.exec(seg)) {
        const attrs = m[1] ?? m[3] ?? "";
        const lat = Number(/lat\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
        const lon = Number(/lon\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
        const time = /<time>\s*([^<]+?)\s*<\/time>/i.exec(m[2] ?? "")?.[1];
        const t = time ? Date.parse(time) / 1000 : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (Number.isFinite(t) && Number.isNaN(start)) start = t;
        if (prev) {
          distance += haversine(prev.lat, prev.lon, lat, lon);
          const dt = t - prev.t;
          if (Number.isFinite(dt) && dt > 0 && dt <= GPX_PAUSE_S) seconds += dt;
        }
        prev = { lat, lon, t };
      }
    }
    if (Number.isNaN(start)) continue;
    out.push({ sport: textSport(type), start, distance, seconds, source: "gpx", file });
  }
  return out;
}

// ---------- TCX ----------

export function readTcx(text: string, file = ""): ActivitySummary[] {
  if (!/<TrainingCenterDatabase[\s>]/i.test(text)) throw new Error("TCX の印が無い");
  const out: ActivitySummary[] = [];
  for (const act of text.match(/<Activity\b[\s\S]*?<\/Activity>/gi) ?? []) {
    const sport = /<Activity\b[^>]*Sport\s*=\s*["']([^"']+)["']/i.exec(act)?.[1] ?? null;
    let distance = 0;
    let seconds = 0;
    let start = NaN;
    for (const lap of act.match(/<Lap\b[\s\S]*?<\/Lap>/gi) ?? []) {
      const ls = /<Lap\b[^>]*StartTime\s*=\s*["']([^"']+)["']/i.exec(lap)?.[1];
      const t = ls ? Date.parse(ls) / 1000 : NaN;
      if (Number.isFinite(t) && (Number.isNaN(start) || t < start)) start = t;
      // 周回の合計は Track より前に書かれる（Track の中の DistanceMeters は点ごとの累計）
      const head = lap.split(/<Track[\s>]/i)[0];
      distance += Number(/<DistanceMeters>\s*([\d.]+)\s*<\/DistanceMeters>/i.exec(head)?.[1] ?? 0);
      seconds += Number(/<TotalTimeSeconds>\s*([\d.]+)\s*<\/TotalTimeSeconds>/i.exec(head)?.[1] ?? 0);
    }
    if (Number.isNaN(start)) continue;
    out.push({ sport: textSport(sport), start, distance, seconds, source: "tcx", file });
  }
  return out;
}

// ---------- ZIP ----------

/** .zip の中のファイル（名前と中身）。保存（0）と deflate（8）だけ */
export async function readZip(bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array }[]> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 中央ディレクトリの終わりの印を後ろから探す
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の終わりの印が無い");
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const out: { name: string; bytes: Uint8Array }[] = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error("zip の目次が壊れている");
    const method = v.getUint16(o + 10, true);
    const csize = v.getUint32(o + 20, true);
    const usize = v.getUint32(o + 24, true);
    const nlen = v.getUint16(o + 28, true);
    const xlen = v.getUint16(o + 30, true);
    const clen = v.getUint16(o + 32, true);
    const local = v.getUint32(o + 42, true);
    const name = dec.decode(bytes.subarray(o + 46, o + 46 + nlen));
    o += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || usize > MAX_FILE_BYTES) continue;
    const ln = v.getUint16(local + 26, true);
    const lx = v.getUint16(local + 28, true);
    const data = bytes.subarray(local + 30 + ln + lx, local + 30 + ln + lx + csize);
    if (method === 0) out.push({ name, bytes: data.slice() });
    else if (method === 8) out.push({ name, bytes: await inflateRaw(data) });
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- まとめ ----------

/** ファイル 1 つ（名前と中身）から記録を読む。読めない時は例外 */
export async function readActivityFile(name: string, bytes: Uint8Array, depth = 0): Promise<ActivitySummary[]> {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("ファイルが大きすぎる");
  const lower = name.toLowerCase();
  const isZip = lower.endsWith(".zip") || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (isZip) {
    if (depth > 1) return [];
    const out: ActivitySummary[] = [];
    for (const f of await readZip(bytes)) {
      if (!/\.(fit|gpx|tcx|zip)$/i.test(f.name)) continue;
      try {
        out.push(...(await readActivityFile(f.name, f.bytes, depth + 1)));
      } catch {
        /* 読めないファイルは飛ばす */
      }
    }
    return out;
  }
  if (lower.endsWith(".fit") || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === ".FIT") return readFitActivities(bytes, name);
  const text = new TextDecoder().decode(bytes);
  if (lower.endsWith(".gpx") || /<gpx[\s>]/i.test(text.slice(0, 2000))) return readGpx(text, name);
  if (lower.endsWith(".tcx") || /<TrainingCenterDatabase/i.test(text.slice(0, 2000))) return readTcx(text, name);
  throw new Error("FIT・GPX・TCX・zip のどれでもない");
}
