import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 网页版构建（iOS Safari / 安卓浏览器 / 桌面浏览器通用）：
 * - 把 @tauri-apps/api 的 core 与 window 换成本仓库的网页垫片（src/web/）
 * - Service Worker（public/hg-sw.js）复刻原生版的本地媒体协议
 * 与原生构建（vite.config.ts）互不影响；用法见 WEB.md。
 */
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const web = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** 仓库根目录的 app-icon 是二进制文件、不在 public/ 里；构建时复制进产物根
 * （index.html 的 apple-touch-icon 与 manifest 都按根路径引用它们）。 */
function copyRootIcons(): Plugin {
  return {
    name: "hghub-copy-root-icons",
    closeBundle() {
      const out = web("./dist-web");
      copyFileSync(web("./app-icon.png"), `${out}/app-icon.png`);
      copyFileSync(web("./app-icon.svg"), `${out}/app-icon.svg`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyRootIcons()],
  base: process.env.VITE_BASE || "/",
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: web("./src/web/tauri-core.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: web("./src/web/tauri-window.ts") },
    ],
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist-web",
  },
  server: {
    port: 1421,
    strictPort: true,
  },
});
