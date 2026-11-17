// 画面をドラッグして視点を回す（マウスでも指でも、ポインターイベントで扱う。概要仕様 9.5 #8）。
// 後方・ドローンの視点ではライダーを中心にぐるりと回り、一人称では見る向きを変える。
// 離しても回した向きのまま（2026-11-17 ユーザー）。視点を選び直すと reset() で元の向きに戻す。

/** 回す角度の範囲 */
const PITCH_MIN = -0.35;
const PITCH_MAX = 1.1;
/** 1px あたりの角度 */
const YAW_PER_PX = 0.007;
const PITCH_PER_PX = 0.005;

export class OrbitDrag {
  /** 左回りが正（ライダーの上から見て） */
  yaw = 0;
  /** 上へ回ると正 */
  pitch = 0;
  private pointer: number | null = null;
  private last = { x: 0, y: 0 };
  enabled = true;

  constructor(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      if (!this.enabled || this.pointer !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      this.pointer = e.pointerId;
      this.last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.pointer) return;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * YAW_PER_PX;
      this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch + dy * PITCH_PER_PX));
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      // 一周以上回していても、角度は -π..π にそろえておく
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
  }

  get dragging() {
    return this.pointer !== null;
  }

  /** 回しているか（0 に戻りきっていない） */
  get active() {
    return Math.abs(this.yaw) > 1e-3 || Math.abs(this.pitch) > 1e-3;
  }

  /** 毎フレーム呼ぶ（今は何もしない。離した後も向きを保つ） */
  update(_dt: number) {}

  reset() {
    this.yaw = 0;
    this.pitch = 0;
  }
}

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 視点を回す。pivot（ライダー）を中心に eye を回し、見る点をライダーへ寄せる。
 * firstPerson なら eye はそのままで、見る向きだけ回す。
 */
export function orbitView(eye: P3, target: P3, pivot: P3, yaw: number, pitch: number, firstPerson: boolean): { eye: P3; target: P3 } {
  const rotate = (o: P3, v: P3) => {
    // 鉛直軸まわりに yaw、そのあと水平の軸まわりに pitch
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let x = v.x * c + v.z * s;
    let z = -v.x * s + v.z * c;
    let y = v.y;
    const h = Math.hypot(x, z);
    if (h > 1e-6) {
      const el = Math.atan2(y, h);
      const e2 = Math.max(-1.2, Math.min(1.45, el + pitch));
      const len = Math.hypot(h, y);
      const nh = Math.cos(e2) * len;
      y = Math.sin(e2) * len;
      x *= nh / h;
      z *= nh / h;
    }
    return { x: o.x + x, y: o.y + y, z: o.z + z };
  };
  if (firstPerson) {
    const t = rotate(eye, { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z });
    return { eye, target: t };
  }
  const e = rotate(pivot, { x: eye.x - pivot.x, y: eye.y - pivot.y, z: eye.z - pivot.z });
  // 回すほど見る点をライダーへ寄せる
  const w = Math.min(1, (Math.abs(yaw) + Math.abs(pitch)) / 0.6);
  const t = { x: target.x + (pivot.x - target.x) * w, y: target.y + (pivot.y - target.y) * w, z: target.z + (pivot.z - target.z) * w };
  return { eye: e, target: t };
}
