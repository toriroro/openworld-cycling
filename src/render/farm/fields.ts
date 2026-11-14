// 農地（田・畑・牧草地）の区画と作物。見た目だけ（生成器・保存データには入らない）。DOM と Three.js を使わない。
// - 世界に固定した格子（東西 240m × 南北 120m の区画）。区画を東西に何枚かの圃場へ切り、圃場ごとに作物を決める
// - 同じ決め方を、地形の材質（GLSL、fieldShader）と、防風林・牧草ロールの配置（TS、fieldAt）の両方で使う。
//   ハッシュは src/shared/world/hash.ts と同じ式を GLSL の uint で書いたもの
// - どこが農地か（重み）と、田・畑・牧草地のどれに寄るか（kind）は、地形タイルの頂点ごとに決める（farmMacro、terrain-tile.ts）

import { hash } from "../../shared/world/hash.ts";

/** 区画の大きさ (m)。u = 東西、v = 南北 */
export const BLOCK_U = 240;
export const BLOCK_V = 120;
/** 区画番号の周期（材質へ渡す座標を小さく保つ） */
export const FIELD_WRAP = 1024;

export const CROP_PADDY = 0;
export const CROP_WHEAT = 1;
export const CROP_POTATO = 2;
export const CROP_BEET = 3;
export const CROP_BEAN = 4;
export const CROP_SOIL = 5;
export const CROP_PASTURE = 6;
/** 刈り取った牧草地（牧草ロールが並ぶ） */
export const CROP_MOWN = 7;
export const CROP_CORN = 8;
export const CROP_BUCKWHEAT = 9;

/** 作物の色（sRGB）。夏 */
export const CROP_COLORS = ["#6d9a3c", "#c8b266", "#4f7a36", "#3f6c3b", "#6b8a40", "#6e5944", "#7ea646", "#a4b45c", "#456f30", "#b9c59c"];
/** 畝の間隔 (m) と濃淡の強さ（0 = 畝なし） */
export const ROWS: [number, number][] = [[0.6, 0.05], [0.5, 0.04], [1.5, 0.22], [1.2, 0.18], [1.3, 0.16], [1.6, 0.12], [0, 0], [7, 0.1], [1.5, 0.14], [0.8, 0.05]];

export const fieldSeed = (seed: number) => (Math.imul(seed | 0, 2654435761) ^ 0x5f1e1d) | 0;
const unit = (h: number) => (h >>> 8) / 16777216;
const wrap = (n: number) => ((n % FIELD_WRAP) + FIELD_WRAP) % FIELD_WRAP;

/** 帯（0 = 田、1 = 畑、2 = 牧草地）と圃場の枚数。kind は 0〜1（区画ごとに少しずらして、帯の境を区画の縁に沿わせる） */
function zoneOf(seed: number, bu: number, bv: number, kind: number): { zone: 0 | 1 | 2; n: number } {
  const k = kind + (unit(hash(seed, bu, bv, 0)) - 0.5) * 0.16;
  const zone = k < 0.33 ? 0 : k < 0.66 ? 1 : 2;
  const t = unit(hash(seed, bu, bv, 1));
  return { zone, n: zone === 0 ? 8 : zone === 1 ? 2 + Math.floor(t * 3) : 1 + Math.floor(t * 2) };
}

function cropOf(zone: 0 | 1 | 2, r: number): number {
  if (zone === 0) return r < 0.84 ? CROP_PADDY : r < 0.92 ? CROP_BEAN : r < 0.97 ? CROP_WHEAT : CROP_SOIL;
  if (zone === 1) return r < 0.24 ? CROP_WHEAT : r < 0.42 ? CROP_POTATO : r < 0.56 ? CROP_BEET : r < 0.68 ? CROP_BEAN : r < 0.8 ? CROP_SOIL : r < 0.92 ? CROP_PASTURE : r < 0.96 ? CROP_CORN : CROP_BUCKWHEAT;
  return r < 0.45 ? CROP_PASTURE : r < 0.72 ? CROP_MOWN : r < 0.86 ? CROP_CORN : r < 0.93 ? CROP_SOIL : CROP_WHEAT;
}

/** 区画が農地か（そうでなければ林・草地）のしきい値。粗い格子の乱数（0〜4095）を重み 60 で補間した値と比べる。大きいほど林が増える */
const OPEN_MIN = Math.round(60 * 4096 * 0.37);

/**
 * 区画が農地か。東西 3 区画 × 南北 5 区画（720m × 600m）の粗い格子の乱数を、区画の中心で補間して決める。
 * 整数だけで計算するので、GLSL（blockOpen）と必ず同じ結果になる。bu・bv は周期に畳んだ区画番号
 */
export function blockOpen(seed: number, bu: number, bv: number): boolean {
  const cu = Math.floor(bu / 3), ru = bu - cu * 3, cv = Math.floor(bv / 5), rv = bv - cv * 5;
  const c = (a: number, b: number) => hash(seed, a, b, 80) >>> 20;
  const sum = (c(cu, cv) * (5 - 2 * ru) + c(cu + 1, cv) * (2 * ru + 1)) * (9 - 2 * rv) + (c(cu, cv + 1) * (5 - 2 * ru) + c(cu + 1, cv + 1) * (2 * ru + 1)) * (2 * rv + 1);
  return sum > OPEN_MIN;
}

/** 世界座標の点の区画が農地か */
export function openAt(seed: number, x: number, z: number): boolean {
  return blockOpen(seed, wrap(Math.floor(x / BLOCK_U)), wrap(Math.floor(z / BLOCK_V)));
}

export interface FieldInfo {
  crop: number;
  /** 圃場の縁（畦・農道）までの距離 (m) */
  edge: number;
  /** 区画番号（周期の中）と圃場の番号 */
  bu: number;
  bv: number;
  strip: number;
}

/** 世界座標の点の圃場 */
export function fieldAt(seed: number, x: number, z: number, kind: number): FieldInfo {
  const fu = x / BLOCK_U, fv = z / BLOCK_V;
  const iu = Math.floor(fu), iv = Math.floor(fv);
  const bu = wrap(iu), bv = wrap(iv);
  const px = fu - iu, pz = fv - iv;
  const { zone, n } = zoneOf(seed, bu, bv, kind);
  const strip = Math.min(n - 1, Math.floor(px * n));
  const sp = px * n - strip;
  const crop = cropOf(zone, unit(hash(seed, bu, bv, strip + 2)));
  const edge = Math.min(Math.min(sp, 1 - sp) * (BLOCK_U / n), Math.min(pz, 1 - pz) * BLOCK_V);
  return { crop, edge, bu, bv, strip };
}

/** 区画の西の縁（x = iu × BLOCK_U の線、農道）に防風林があるか。iu・iv は区画番号（周期に畳む前でよい） */
export function windbreakAt(seed: number, iu: number, iv: number): boolean {
  // 南北に 3 区画ずつ続ける
  return hash(seed, wrap(iu), wrap(Math.floor(iv / 3)), 90) % 5 === 0;
}

/** 地形タイルの頂点へ持たせる座標（区画の単位。タイルの中で連続、区画番号は周期に畳む） */
export function fieldCoord(x0: number, z0: number, lx: number, lz: number, out: Float32Array, o: number) {
  const iu = Math.floor(x0 / BLOCK_U), iv = Math.floor(z0 / BLOCK_V);
  out[o] = wrap(iu) + (x0 - iu * BLOCK_U + lx) / BLOCK_U;
  out[o + 1] = wrap(iv) + (z0 - iv * BLOCK_V + lz) / BLOCK_V;
}

const lin = (hexColor: string) => {
  const n = Number.parseInt(hexColor.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => ((c / 255) ** 2.2).toFixed(4)).join(", ");
};

/** hash() の最初の段（種だけで決まる）。GLSL へ定数で渡す */
function seedStage(seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 地形の材質へ足す GLSL（フラグメント）。farmColor(uv, kind, dist) が圃場の色（線形）を返す。
 * uv は fieldCoord の座標、dist は視点からの距離 (m)。fieldAt と同じ決め方。
 */
export function fieldShader(seed: number): string {
  const colors = CROP_COLORS.map((c, i) => `  ${i ? "else " : ""}if ( crop == ${i} ) { col = vec3( ${lin(c)} ); row = vec2( ${ROWS[i][0].toFixed(2)}, ${ROWS[i][1].toFixed(2)} ); }`).join("\n");
  return `
uint ffmix( uint h ) { h ^= h >> 16; h *= 0x85ebca6bu; h ^= h >> 13; h *= 0xc2b2ae35u; h ^= h >> 16; return h; }
uint fhash( uint a, uint b, uint c ) {
  uint h = ${seedStage(seed)}u;
  h = ffmix( h ^ ( a * 0x27d4eb2du ) );
  h = ffmix( h ^ ( b * 0x165667b1u ) );
  h = ffmix( h ^ ( c * 0x61c88647u ) );
  return h;
}
float funit( uint h ) { return float( h >> 8 ) / 16777216.0; }
uint fcoarse( uint a, uint b ) { return fhash( a, b, 80u ) >> 20; }
// 区画が農地か（fields.ts の blockOpen と同じ整数の計算）
float blockOpen( vec2 uv ) {
  uint bu = uint( floor( uv.x ) ) % ${FIELD_WRAP}u, bv = uint( floor( uv.y ) ) % ${FIELD_WRAP}u;
  uint cu = bu / 3u, ru = bu - cu * 3u, cv = bv / 5u, rv = bv - cv * 5u;
  uint sum = ( fcoarse( cu, cv ) * ( 5u - 2u * ru ) + fcoarse( cu + 1u, cv ) * ( 2u * ru + 1u ) ) * ( 9u - 2u * rv )
    + ( fcoarse( cu, cv + 1u ) * ( 5u - 2u * ru ) + fcoarse( cu + 1u, cv + 1u ) * ( 2u * ru + 1u ) ) * ( 2u * rv + 1u );
  return sum > ${OPEN_MIN}u ? 1.0 : 0.0;
}
vec3 farmColor( vec2 uv, float kind, float dist ) {
  vec2 b = floor( uv );
  vec2 p = uv - b;
  uint bu = uint( b.x ) % ${FIELD_WRAP}u, bv = uint( b.y ) % ${FIELD_WRAP}u;
  float k = kind + ( funit( fhash( bu, bv, 0u ) ) - 0.5 ) * 0.16;
  int zone = k < 0.33 ? 0 : ( k < 0.66 ? 1 : 2 );
  float t = funit( fhash( bu, bv, 1u ) );
  float n = zone == 0 ? 8.0 : ( zone == 1 ? 2.0 + floor( t * 3.0 ) : 1.0 + floor( t * 2.0 ) );
  float s = min( n - 1.0, floor( p.x * n ) );
  float sp = p.x * n - s;
  float r = funit( fhash( bu, bv, uint( s ) + 2u ) );
  int crop;
  if ( zone == 0 ) crop = r < 0.84 ? 0 : ( r < 0.92 ? 4 : ( r < 0.97 ? 1 : 5 ) );
  else if ( zone == 1 ) crop = r < 0.24 ? 1 : ( r < 0.42 ? 2 : ( r < 0.56 ? 3 : ( r < 0.68 ? 4 : ( r < 0.8 ? 5 : ( r < 0.92 ? 6 : ( r < 0.96 ? 8 : 9 ) ) ) ) ) );
  else crop = r < 0.45 ? 6 : ( r < 0.72 ? 7 : ( r < 0.86 ? 8 : ( r < 0.93 ? 5 : 1 ) ) );
  vec3 col = vec3( 0.2 );
  vec2 row = vec2( 0.0 );
${colors}
  // 圃場ごとの明るさの差
  col *= 0.88 + 0.24 * funit( fhash( bu, bv, uint( s ) + 40u ) );
  float xm = p.x * ${BLOCK_U.toFixed(1)}, zm = p.y * ${BLOCK_V.toFixed(1)};
  // 畝（南北に通る）。遠くでは消す。刈り跡（間隔 7m）は遠くまで残す
  if ( row.y > 0.0 ) {
    float fade = row.x > 4.0 ? 1.0 - smoothstep( 500.0, 1800.0, dist ) : 1.0 - smoothstep( 40.0, 200.0, dist );
    // 近くでは畝の間の土を見せる（畑の作物）
    float near = row.x > 4.0 ? 0.0 : 1.0 - smoothstep( 8.0, 60.0, dist );
    float wave = sin( xm * 6.2832 / row.x );
    col *= 1.0 + row.y * fade * ( 1.0 + 1.2 * near ) * wave;
    if ( crop >= 2 && crop <= 4 || crop == 8 ) col = mix( col, vec3( ${lin("#5d4a38")} ), near * smoothstep( 0.35, 0.9, -wave ) * 0.75 );
  }
  // 近くの細かいむら（株の濃淡）
  float grain = sin( xm * 7.1 + sin( zm * 5.3 ) * 1.7 ) * sin( zm * 6.3 + sin( xm * 4.7 ) * 1.9 );
  col *= 1.0 + 0.1 * grain * ( 1.0 - smoothstep( 6.0, 45.0, dist ) );
  // 大きなむら（生育の差）
  col *= 0.95 + 0.1 * sin( xm * 0.11 + zm * 0.07 + r * 40.0 ) * sin( zm * 0.09 - xm * 0.05 );
  // 畦（圃場の縁）、農道（区画の東西の縁）、排水路沿いの草（区画の南北の縁）
  float aa = max( fwidth( uv.x ) * ${BLOCK_U.toFixed(1)}, 0.25 );
  float de = min( sp, 1.0 - sp ) * ( ${BLOCK_U.toFixed(1)} / n );
  float du = min( p.x, 1.0 - p.x ) * ${BLOCK_U.toFixed(1)};
  float dv = min( p.y, 1.0 - p.y ) * ${BLOCK_V.toFixed(1)};
  vec3 ridge = zone == 0 ? vec3( ${lin("#7f9050")} ) : vec3( ${lin("#5e7a3c")} );
  col = mix( ridge, col, smoothstep( 0.5, 0.5 + aa, de ) );
  col = mix( ridge * 0.9, col, smoothstep( 1.2, 1.2 + aa, dv ) );
  col = mix( vec3( ${lin("#9d9580")} ), col, smoothstep( 1.7, 1.7 + aa, du ) );
  return col;
}
`;
}
