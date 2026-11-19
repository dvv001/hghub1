# NexusAI v20 — 鲜艳科幻分层重构版 (iOS PWA)

版本：`v20`（Service Worker 缓存名 `nexusai-v20`）  
定位：基于 `v19` 全量代码包完成 Bug 修复、去补丁化分层重构与鲜艳科幻主题视觉升级，100% 保留原有功能并无缝兼容原有 `localStorage` 配置。

## 分层目录结构

```text
nexusai-v20/
├── index.html                    # 纯净语义外壳（无内联样式补丁、无 Tailwind CDN 依赖）
├── manifest.webmanifest          # 完整 PWA 清单（含 PNG 192/512 + SVG 图标与科幻主题色）
├── sw.js                         # 精准缓存策略（nexusai-v20，离线外壳 + GitHub 网络优先）
├── icon.svg / icon-180/192/512.png
├── css/
│   └── app.css                   # 鲜艳科幻设计系统 + iOS Safe Area 安全区适配
├── js/
│   ├── store.js                  # Layer 1: 状态、常量、工具函数与 localStorage 持久化
│   ├── audio.js                  # Layer 4: Web Audio 实时科幻工作流音效引擎
│   ├── transport.js              # Layer 2: OpenAI/Anthropic/推理模型、Kitesurf、MCP、GitHub 传输层
│   ├── engine.js                 # Layer 3: Claw-Code Trident 压缩、工具循环、流水线调度与报告导出
│   ├── topology.js               # Layer 5: 5-Plane 8足 IK 机械蛛全息拓扑与能量数据包渲染
│   └── ui.js                     # Layer 6: 视图渲染、扩展库分段子标签、弹窗与事件委托
└── worker/
    └── hghub-proxy-nexus-tv.js   # Cloudflare Worker 中继（原样保留）
```

## 核心 Bug 修复清单

1. **Temperature = 0 被吞掉**：修复 `0 || 0.3` 误判，改用 `Number.isFinite()` 校验，支持确定性输出。
2. **流水线重入与卡死**：在 `prefetchMcpTools` / Kitesurf 预抓前即锁定 `isExecuting` 与 `AbortController`，支持预抓阶段随时中止，并用 `try/finally` 与空节点守卫防止按钮状态永久卡死。
3. **并行分叉模式 (`parallel_fork`) 扩展库串味**：修复中间节点传入 `forAgentId=null` 导致所有技能/MCP/指令混入全部节点的 Bug，改为按节点独立构建上下文。
4. **推理模型与 Anthropic 协议补全**：非流式模式补齐 `message.reasoning_content` 与 Anthropic `thinking` 多块解析；SSE 流式补齐 `thinking` 增量及 Anthropic `input_tokens + output_tokens` 统计。
5. **全量 XSS 与 DOM 破坏防护**：统一对智能体名、职责、System Prompt（防 `</textarea>` 逃逸）、编队名、日志与扩展库条目进行 HTML 转义。
6. **全息拓扑省电与溢出修复**：切页或后台时真正 `cancelAnimationFrame` 暂停循环（不再 60fps 空转耗电）；实际渲染并回收 `activePackets` 消除内存泄漏；标题裁剪防遮挡「详情」按钮，字条文字加 `maxWidth` 防溢出。
7. **iOS PWA 安全区、离线与下载修复**：全面适配 `env(safe-area-inset-top/bottom)`；移除在线 Tailwind CDN 实现 100% 离线秒开；修复 `sw.js` 缓存策略与 `manifest.webmanifest` PNG 图标缺失；延迟 `URL.revokeObjectURL` 提升 iOS Safari 导出下载可靠性。

## 部署说明

1. 将本目录下除 `worker/` 外的全部文件（含 `css/`、`js/` 目录）直接覆盖上传至 GitHub Pages 的 `nexus/` 目录。
2. 已有手机浏览器中的 API Key、编队（`nexusai_squads`）、技能（`nexusai_skills`）、MCP 与指令配置全部自动沿用，无需重新填写。
3. `sw.js` 缓存名已升级为 `nexusai-v20`，手机端刷新或重启 PWA 即可自动拉取新版。
