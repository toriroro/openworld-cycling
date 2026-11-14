// Worker の入口。中身は auth.ts（このモジュールはハンドラ以外を export できない）。
import { handle, type Env } from "./auth.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, Date.now());
  },
};
