// テスト用の FIT の読み取り（src/shared/fit.ts とは別に、FIT のファイルの形の決まりだけから書いた）。
// ヘッダ・CRC・定義メッセージ・データメッセージを読み、メッセージごとにフィールド番号 → 生の値を返す。

export interface FitMessage {
  global: number;
  fields: Map<number, number>;
}

export interface FitFile {
  headerSize: number;
  protocol: number;
  profile: number;
  dataSize: number;
  headerCrcOk: boolean;
  fileCrcOk: boolean;
  messages: FitMessage[];
}

function crc16(bytes: Uint8Array): number {
  // CRC-16/ARC（多項式 0xA001 の反転）をビットごとに計算する（書く側の 4 ビットの表とは別の作り方）
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export function decodeFit(bytes: Uint8Array): FitFile {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = v.getUint8(0);
  const dataSize = v.getUint32(4, true);
  const sig = String.fromCharCode(...bytes.subarray(8, 12));
  if (sig !== ".FIT") throw new Error(`印が違う: ${sig}`);
  if (headerSize + dataSize + 2 !== bytes.length) throw new Error(`長さが合わない: ${headerSize}+${dataSize}+2 != ${bytes.length}`);
  const headerCrcOk = headerSize < 14 || v.getUint16(12, true) === crc16(bytes.subarray(0, 12));
  const fileCrcOk = v.getUint16(headerSize + dataSize, true) === crc16(bytes.subarray(0, headerSize + dataSize));
  const defs = new Map<number, { global: number; little: boolean; fields: { num: number; size: number; type: number }[] }>();
  const messages: FitMessage[] = [];
  let o = headerSize;
  const end = headerSize + dataSize;
  while (o < end) {
    const h = v.getUint8(o++);
    if (h & 0x80) throw new Error("圧縮した時刻のヘッダは使っていないはず");
    const local = h & 0x0f;
    if (h & 0x40) {
      if (h & 0x20) throw new Error("開発者のフィールドは使っていないはず");
      o++; // 予約
      const little = v.getUint8(o++) === 0;
      const global = v.getUint16(o, little);
      o += 2;
      const n = v.getUint8(o++);
      const fields = [];
      for (let i = 0; i < n; i++) {
        fields.push({ num: v.getUint8(o), size: v.getUint8(o + 1), type: v.getUint8(o + 2) });
        o += 3;
      }
      defs.set(local, { global, little, fields });
    } else {
      const d = defs.get(local);
      if (!d) throw new Error(`定義の無い局所の番号 ${local}`);
      const fields = new Map<number, number>();
      for (const f of d.fields) {
        const signed = f.type === 0x83 || f.type === 0x85 || f.type === 0x01;
        let x: number;
        if (f.size === 1) x = signed ? v.getInt8(o) : v.getUint8(o);
        else if (f.size === 2) x = signed ? v.getInt16(o, d.little) : v.getUint16(o, d.little);
        else if (f.size === 4) x = signed ? v.getInt32(o, d.little) : v.getUint32(o, d.little);
        else throw new Error(`大きさ ${f.size} は使っていないはず`);
        // 型の番号の下位 5 ビットと大きさが合っているか
        const expect: Record<number, number> = { 0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x8c: 4 };
        if (expect[f.type] !== f.size) throw new Error(`型 ${f.type} と大きさ ${f.size} が合わない`);
        fields.set(f.num, x);
        o += f.size;
      }
      messages.push({ global: d.global, fields });
    }
  }
  return { headerSize, protocol: v.getUint8(1), profile: v.getUint16(2, true), dataSize, headerCrcOk, fileCrcOk, messages };
}
