import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents } from "./playbackDiagnostics";
import { registerHgSw } from "./web/register-sw";

/* 网页版：注册提供虚拟媒体协议的 Service Worker（原生构建不走这里） */
if (import.meta.env.VITE_HGWEB === "1") registerHgSw();

installPlaybackPageEvents();
void initPlaybackLog();

/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
