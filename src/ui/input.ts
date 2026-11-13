// 入力（モック仕様 6.4）。キーと画面のボタン。ボタンはポインターイベントで扱う（概要仕様 9.5 #8）。
// 状態（押している間）と、1回きりの操作（押した時）に分けて渡す。

export type Action =
  | "choose-left"
  | "choose-straight"
  | "choose-right"
  | "lane-left"
  | "lane-right"
  | "camera"
  | "map"
  | "watch"
  | "pause"
  | "u-turn";

export class Input {
  pedalKey = false;
  brakeKey = false;
  pedalTouch = false;
  brakeTouch = false;
  private queue: Action[] = [];
  /** 最後に操作した時刻（眺める乗り方で HUD を消すため） */
  lastActivity = performance.now();

  constructor() {
    addEventListener("keydown", (e) => {
      if (e.repeat && e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT")) return;
      this.lastActivity = performance.now();
      switch (e.code) {
        case "Space":
          this.pedalKey = true;
          e.preventDefault();
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.brakeKey = true;
          break;
        case "ArrowLeft":
          this.queue.push("choose-left");
          e.preventDefault();
          break;
        case "ArrowUp":
          this.queue.push("choose-straight");
          e.preventDefault();
          break;
        case "ArrowRight":
          this.queue.push("choose-right");
          e.preventDefault();
          break;
        case "ArrowDown":
          this.queue.push("u-turn");
          e.preventDefault();
          break;
        case "KeyA":
          this.queue.push("lane-left");
          break;
        case "KeyD":
          this.queue.push("lane-right");
          break;
        case "KeyC":
          this.queue.push("camera");
          break;
        case "KeyM":
          this.queue.push("map");
          break;
        case "KeyV":
          this.queue.push("watch");
          break;
        case "KeyP":
        case "Escape":
          this.queue.push("pause");
          break;
      }
    });
    addEventListener("keyup", (e) => {
      if (e.code === "Space") this.pedalKey = false;
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.brakeKey = false;
    });
    // ウィンドウを離れたら押しっぱなしを解く
    addEventListener("blur", () => {
      this.pedalKey = this.brakeKey = this.pedalTouch = this.brakeTouch = false;
    });
    addEventListener("pointerdown", () => (this.lastActivity = performance.now()));
  }

  get pedal() {
    return this.pedalKey || this.pedalTouch;
  }
  get brake() {
    return this.brakeKey || this.brakeTouch;
  }

  push(a: Action) {
    this.lastActivity = performance.now();
    this.queue.push(a);
  }

  take(): Action[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  /** 押している間だけ有効なボタン */
  bindHold(el: HTMLElement, set: (on: boolean) => void) {
    const on = (e: PointerEvent) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("down");
      this.lastActivity = performance.now();
      set(true);
    };
    const off = () => {
      el.classList.remove("down");
      set(false);
    };
    el.addEventListener("pointerdown", on);
    el.addEventListener("pointerup", off);
    el.addEventListener("pointercancel", off);
    el.addEventListener("lostpointercapture", off);
  }

  /** 押した時に1回 */
  bindTap(el: HTMLElement, action: Action) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.push(action);
    });
  }
}
