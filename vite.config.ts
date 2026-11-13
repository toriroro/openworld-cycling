import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // iOS 16 の WebView でも読めるように変換する（モック仕様 3.1【固定】、概要仕様 9.5 #2）
  build: {
    target: ["es2022", "safari16"],
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        map: resolve(import.meta.dirname, "map.html"),
      },
    },
  },
  worker: { format: "es" },
});
