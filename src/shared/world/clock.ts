// 計測用の時計。Node・Web Worker・ブラウザ・Cloudflare Worker のどれでも動くように globalThis から取る。
const perf = (globalThis as { performance?: { now(): number } }).performance;

export function now(): number {
  return perf ? perf.now() : Date.now();
}
