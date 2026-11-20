// 走行の記録を FIT ファイルにする（トレーナー連携の草案 6.2）。
// 北海道の世界の記録だけ、世界座標を緯度・経度に戻して入れる（2026-11-21 決定、草案 11 章の 5）。

import { encodeActivityFit, type FitSample } from "./shared/fit.ts";
import { unproject } from "./shared/geo/projection.ts";
import type { RideRecorder } from "./sim/trainer/recorder.ts";

export function recorderToFit(rec: RideRecorder, created = Date.now()): Uint8Array {
  const geo = rec.world === "hokkaido";
  const samples: FitSample[] = rec.samples().map((s) => {
    const ll = geo ? unproject(s.x, s.z) : null;
    return {
      t: s.t,
      distance: s.distance,
      speed: s.speed,
      power: s.power,
      cadence: s.cadence,
      heartRate: s.heartRate,
      altitude: s.altitude,
      grade: s.grade,
      lat: ll?.lat ?? null,
      lon: ll?.lon ?? null,
    };
  });
  return encodeActivityFit({ samples, ascent: rec.ascent, created: Math.floor(created / 1000), utcOffsetMin: -new Date(created).getTimezoneOffset() });
}

/** ファイルの名前（記録の始まりの日時。端末の時刻で） */
export function fitFileName(rec: RideRecorder): string {
  const d = new Date((rec.startedAt ?? Date.now() / 1000) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `openworld-cycling-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.fit`;
}
