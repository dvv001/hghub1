# HGhub 网页版（iOS 网页版）

同一套前端代码的浏览器版本：不需要安装 App，iPhone / 安卓 / 桌面浏览器
打开网址即可使用，也可以「添加到主屏幕」当 App 用。原生版（Tauri）不受影响，
两边共用 `src/` 下的全部界面与业务代码。

## 它是怎么跑起来的

原生版有两件事是浏览器做不到的，网页版各换了一种实现：

| 原生版 | 网页版 |
| --- | --- |
| Rust 命令（`invoke`）发业务请求、存会话 | `src/web/tauri-core.ts` 在浏览器内复刻同一套命令：仍走上游 `/api/edge/request` 信封，会话 token 按线路存 localStorage |
| Rust 自定义协议 `hg://localhost` 解密封面、改写 HLS | 自建 Cloudflare Worker 的 `/img`、`/hls`、`/seg` 三个端点：Worker 取源后做 AES 解密与播放列表改写，规则与 `src-tauri/src/media.rs` 对齐（早期用过 Service Worker 方案，因浏览器兼容问题弃用，`public/hg-sw.js` 仅留作参考） |

跨域现状（2026-11 实测）：媒体 CDN 的简单 GET 都带
`Access-Control-Allow-Origin: *`，浏览器可直读；但业务接口的 CORS
预检不返回 `Access-Control-Allow-Headers`，浏览器会拦下全部信封请求。
因此网页版的信封请求统一经一个自建的 Cloudflare Worker 中转
（`hghub-proxy.*.workers.dev`，代码见仓库外单独保存）：Worker 补齐
CORS 头、带浏览器请求头转发到固定线路。哪天上游修好预检，把
`src/web/tauri-core.ts` 里的 `WEB_PROXY` 改回直连即可；原生版不受影响。

构建时靠两个开关与原生版区分（普通 `pnpm build` 永远走原生路径）：

- 环境变量 `VITE_HGWEB=1`：前端把媒体前缀从 `hg://localhost`
  切到 Cloudflare Worker 的媒体端点（见 `src/api.ts`）。
- `vite.web.config.ts`：把 `@tauri-apps/api/core` 与
  `@tauri-apps/api/window` 别名到 `src/web/` 下的网页垫片。

## 本地构建与预览

```bash
pnpm install --frozen-lockfile
pnpm web:build     # 产物在 dist-web/
pnpm web:preview   # 本地预览（需要 http(s)，不能用 file:// 打开）
pnpm web:dev       # 开发模式
```

部署到子路径时设置 `VITE_BASE`，例如 GitHub Pages 项目站点：

```bash
VITE_BASE=/hghub1/ pnpm web:build
```

## 部署

任意静态托管都可以（产物就是 `dist-web/` 一包静态文件）：

- **GitHub Pages**：仓库已带 `.github/workflows/web-pages.yml`，
  在 Settings → Pages 把 Source 选成「GitHub Actions」后，
  每次推送到 `main`（或手动 Run workflow）都会自动构建并发布，
  地址形如 `https://<账号>.github.io/<仓库名>/`。
- **Cloudflare Pages / Netlify / 自己的服务器**：把 `dist-web/` 整个目录
  传上去即可；构建命令 `VITE_BASE=/ pnpm web:build`（根路径部署时）。

## iPhone 上使用

1. Safari 打开部署好的网址，等首页封面出来。
2. 点分享按钮 →「添加到主屏幕」，桌面上会出现 HGhub 图标，
   点开就是全屏的 App 界面。
3. 登录、切线路都在应用内完成，与原生版一样；严格模式下登录仍只允许
   固定线路，镜像线路仅供游客浏览。

## 与原生版的差异

- 没有原生窗口边框、安卓物理返回键、iOS 原生改朝向等系统能力
  （垫片里是无害空实现，界面在移动端本来也不用它们）。
- 网络自检（net_diag）只能给出浏览器能拿到的信息，没有 DNS 明细。
- 播放诊断日志存在浏览器 localStorage 里，不落盘成文件。
- 上游可用性、CORS 策略、线路存活都取决于上游现状，网页版不额外兜底。
