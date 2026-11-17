// OpenStreetMap の PBF（.osm.pbf）を読む（北海道の草案 15.1 の b）。ライブラリを足さず、Node.js の zlib と自作の protobuf の読み手だけで読む。
// 形式: https://wiki.openstreetmap.org/wiki/PBF_Format
// [4 バイトの長さ][BlobHeader][Blob] の繰り返し。Blob は zlib で圧縮された PrimitiveBlock（点・道・関係）。
// 64 ビットの整数（番号）は 2^53 を超えないので、数（number）で扱う（ビット演算を使わない）。

import { closeSync, openSync, readSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** protobuf の読み手 */
class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  get done() {
    return this.pos >= this.end;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }
  svarint(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }
  /** 鍵（フィールド番号と型） */
  key(): { field: number; wire: number } {
    const k = this.varint();
    return { field: Math.floor(k / 8), wire: k % 8 };
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  sub(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      // this.pos += this.varint() は、長さを読む前の位置に足してしまう
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`protobuf の型 ${wire}`);
  }
  /** 詰めた varint の並び */
  packed(signed: boolean): number[] {
    const r = this.sub();
    const out: number[] = [];
    while (!r.done) out.push(signed ? r.svarint() : r.varint());
    return out;
  }
}

const decoder = new TextDecoder();

export interface PbfNode {
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string> | null;
}
export interface PbfWay {
  id: number;
  refs: number[];
  tags: Record<string, string>;
}
export interface PbfRelation {
  id: number;
  members: { type: "node" | "way" | "relation"; ref: number; role: string }[];
  tags: Record<string, string>;
}

export interface PbfHandlers {
  node?: (n: PbfNode) => void;
  way?: (w: PbfWay) => void;
  relation?: (r: PbfRelation) => void;
  /** 点に札（tags）が要らなければ false（速くなる） */
  nodeTags?: boolean;
}

function tagsOf(st: string[], keys: number[], vals: number[]): Record<string, string> {
  const t: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) t[st[keys[i]]] = st[vals[i]];
  return t;
}

function readBlock(data: Uint8Array, h: PbfHandlers) {
  const r = new Reader(data);
  let st: string[] = [];
  const groups: Reader[] = [];
  let gran = 100;
  let latOff = 0;
  let lonOff = 0;
  while (!r.done) {
    const { field, wire } = r.key();
    if (field === 1) {
      const s = r.sub();
      st = [];
      while (!s.done) {
        const k = s.key();
        if (k.field === 1) st.push(decoder.decode(s.bytes()));
        else s.skip(k.wire);
      }
    } else if (field === 2) groups.push(r.sub());
    else if (field === 17) gran = r.varint();
    else if (field === 19) latOff = r.varint();
    else if (field === 20) lonOff = r.varint();
    else r.skip(wire);
  }
  const lat = (v: number) => 1e-9 * (latOff + gran * v);
  const lon = (v: number) => 1e-9 * (lonOff + gran * v);
  for (const g of groups) {
    while (!g.done) {
      const { field, wire } = g.key();
      if (field === 2 && h.node) {
        // DenseNodes
        const d = g.sub();
        let ids: number[] = [];
        let lats: number[] = [];
        let lons: number[] = [];
        let kv: number[] = [];
        while (!d.done) {
          const k = d.key();
          if (k.field === 1) ids = d.packed(true);
          else if (k.field === 8) lats = d.packed(true);
          else if (k.field === 9) lons = d.packed(true);
          else if (k.field === 10 && h.nodeTags) kv = d.packed(false);
          else d.skip(k.wire);
        }
        let id = 0;
        let la = 0;
        let lo = 0;
        let q = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i];
          la += lats[i];
          lo += lons[i];
          let tags: Record<string, string> | null = null;
          if (h.nodeTags && kv.length) {
            while (q < kv.length && kv[q] !== 0) {
              tags ??= {};
              tags[st[kv[q]]] = st[kv[q + 1]];
              q += 2;
            }
            q++;
          }
          h.node({ id, lat: lat(la), lon: lon(lo), tags });
        }
      } else if (field === 1 && h.node) {
        // Node（詰めていない形。まれ）
        const n = g.sub();
        let id = 0;
        let la = 0;
        let lo = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        while (!n.done) {
          const k = n.key();
          if (k.field === 1) id = n.svarint();
          else if (k.field === 2) keys = n.packed(false);
          else if (k.field === 3) vals = n.packed(false);
          else if (k.field === 8) la = n.svarint();
          else if (k.field === 9) lo = n.svarint();
          else n.skip(k.wire);
        }
        h.node({ id, lat: lat(la), lon: lon(lo), tags: keys.length ? tagsOf(st, keys, vals) : null });
      } else if (field === 3 && h.way) {
        const w = g.sub();
        let id = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        let refs: number[] = [];
        while (!w.done) {
          const k = w.key();
          if (k.field === 1) id = w.varint();
          else if (k.field === 2) keys = w.packed(false);
          else if (k.field === 3) vals = w.packed(false);
          else if (k.field === 8) refs = w.packed(true);
          else w.skip(k.wire);
        }
        for (let i = 1; i < refs.length; i++) refs[i] += refs[i - 1];
        h.way({ id, refs, tags: tagsOf(st, keys, vals) });
      } else if (field === 4 && h.relation) {
        const rl = g.sub();
        let id = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        let roles: number[] = [];
        let mem: number[] = [];
        let types: number[] = [];
        while (!rl.done) {
          const k = rl.key();
          if (k.field === 1) id = rl.varint();
          else if (k.field === 2) keys = rl.packed(false);
          else if (k.field === 3) vals = rl.packed(false);
          else if (k.field === 8) roles = rl.packed(false);
          else if (k.field === 9) mem = rl.packed(true);
          else if (k.field === 10) types = rl.packed(false);
          else rl.skip(k.wire);
        }
        let ref = 0;
        const members = mem.map((m, i) => {
          ref += m;
          return { type: (["node", "way", "relation"] as const)[types[i]], ref, role: st[roles[i]] };
        });
        h.relation({ id, members, tags: tagsOf(st, keys, vals) });
      } else g.skip(wire);
    }
  }
}

/** ファイルを先頭から順に読み、点・道・関係ごとに handlers を呼ぶ */
export function readPbf(path: string, h: PbfHandlers) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    let pos = 0;
    for (;;) {
      if (readSync(fd, head, 0, 4, pos) < 4) break;
      const hl = head.readUInt32BE(0);
      pos += 4;
      const hb = Buffer.alloc(hl);
      readSync(fd, hb, 0, hl, pos);
      pos += hl;
      const hr = new Reader(hb);
      let type = "";
      let size = 0;
      while (!hr.done) {
        const k = hr.key();
        if (k.field === 1) type = decoder.decode(hr.bytes());
        else if (k.field === 3) size = hr.varint();
        else hr.skip(k.wire);
      }
      const bb = Buffer.alloc(size);
      readSync(fd, bb, 0, size, pos);
      pos += size;
      if (type !== "OSMData") continue;
      const br = new Reader(bb);
      let data: Uint8Array | null = null;
      while (!br.done) {
        const k = br.key();
        if (k.field === 1) data = br.bytes();
        else if (k.field === 3) data = inflateSync(br.bytes());
        else br.skip(k.wire);
      }
      if (!data) throw new Error("対応していない圧縮（zlib か無圧縮だけ）");
      readBlock(data, h);
    }
  } finally {
    closeSync(fd);
  }
}
