/* 网页版 invoke 垫片 —— 替代 @tauri-apps/api/core（由 vite.web.config.ts 别名注入）。
 *
 * 原生版每个业务命令都由 Rust 实现；这里逐个用浏览器 API 复刻同等语义：
 * - 业务接口：与 net.rs 一致，走 POST {base}/api/edge/request 信封
 *   （body 为 JSON 的 base64；status===1 取 data，否则抛 msg；401/403 抛 "401"）
 * - 会话：token 按线路 origin 存 localStorage（对应 session.rs 的 origin 绑定）
 * - 线路：固定线路写死；镜像线路从地址发布页解析 publish.js（对应 lines.rs）
 * - 严格模式下登录/带 token 请求只允许固定线路（对应 net.rs 的信任规则）
 * 上游与媒体 CDN 均已实测开放 CORS（Access-Control-Allow-Origin: *），浏览器可直连。
 */

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;

const DEFAULT_BASE = "https://huangguoai.com";
const FIXED_LINES = [
  { name: "固定线路 1", url: "https://huangguoai.com" },
  { name: "固定线路 2", url: "https://huangguoai.ai" },
];
const TRUSTED_AUTH_ORIGINS = new Set(FIXED_LINES.map((l) => l.url));
const PUBLISH_PAGE = "https://huangguoai.pages.dev/";
// 上游的 CORS 预检不返回 Access-Control-Allow-Headers，浏览器会拦下全部
// 信封请求（媒体 CDN 的简单 GET 不受影响）。网页版因此统一经自建的
// Cloudflare Worker 中转信封请求：Worker 补齐 CORS 头并转发到固定线路。
// 线路选择、token 分桶、严格模式判断仍按逻辑线路（cur）走，不受影响。
const WEB_PROXY = "https://hghub-proxy.liguohao770801114.workers.dev";
const UPDATE_REPO = "Minireel/HGhub";
const MIRROR_MAX = 60;

const LS = {
  base: "hghub.web.base",
  session: "hghub.web.session",
  strict: "hghub.web.strict",
  plogEnabled: "hghub.web.plog.enabled",
  plogBody: "hghub.web.plog.body",
};

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等场景下静默失败 */
  }
}
function lsDel(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ── 线路与会话状态 ─────────────────────────────────────── */

function getBase(): string {
  return lsGet(LS.base) || DEFAULT_BASE;
}

function normalizeBase(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  // 与原生版网络策略一致：拒绝本机 / 内网地址
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0"
  ) {
    return null;
  }
  return u.origin;
}

type Session = { origin: string; token: string; user: unknown };

function readSession(): Session {
  try {
    const raw = lsGet(LS.session);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Session>;
      return { origin: v.origin || "", token: v.token || "", user: v.user ?? null };
    }
  } catch {
    /* ignore */
  }
  return { origin: "", token: "", user: null };
}

function writeSession(s: Session) {
  lsSet(LS.session, JSON.stringify(s));
}

function sessionToken(origin: string): string | null {
  const s = readSession();
  return s.origin === origin && s.token ? s.token : null;
}

function sessionUser(origin: string): unknown {
  const s = readSession();
  return s.origin === origin && s.token ? s.user : null;
}

function clearSession() {
  lsDel(LS.session);
}

function strictSecurity(): boolean {
  return lsGet(LS.strict) !== "0";
}

/* ── 边缘信封（对应 net.rs edge + with_retry） ───────────── */

function b64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "401") return false;
  const m = /^HTTP (\d{3})\b/.exec(msg);
  if (m) {
    const s = Number(m[1]);
    return s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);
  }
  // fetch 的网络层失败（TypeError: Failed to fetch 等）视为可重试
  return e instanceof TypeError || /fetch|network|超时|timeout/i.test(msg);
}

async function withRetry<T>(retry: boolean, f: () => Promise<T>): Promise<T> {
  const attempts = retry ? 3 : 1;
  let last: unknown = new Error("network error");
  for (let i = 0; i < attempts; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      if (!isRetryableError(e)) throw e;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw last;
}

async function edge(
  origin: string,
  method: string,
  path: string,
  body: unknown,
  token: string | null,
  retry: boolean,
): Promise<unknown> {
  const cur = normalizeBase(origin);
  if (!cur) throw new Error("业务请求必须使用安全 HTTPS 线路");
  // 严格模式：镜像线路仅供游客浏览（与 net.rs 一致）
  if (
    strictSecurity() &&
    (token || path === "/api/account/loginByPassword" || path === "/api/account/registerByPassword") &&
    !TRUSTED_AUTH_ORIGINS.has(cur)
  ) {
    throw new Error("镜像线路仅供游客浏览；登录/注册请切换到固定线路");
  }
  const hasBody = body !== undefined && body !== null;
  const envelope = {
    method,
    path,
    body: hasBody ? b64EncodeUtf8(JSON.stringify(body)) : "",
    content_type: hasBody ? "application/json" : "",
  };
  return withRetry(retry, async () => {
    let resp: Response;
    try {
      resp = await fetch(`${WEB_PROXY}/api/edge/request`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(envelope),
      });
    } catch (e) {
      throw e instanceof Error ? e : new Error("请求失败，请检查网络");
    }
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 403) throw new Error("401");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);
    if (!text.trim()) return null;
    let value: Json;
    try {
      value = JSON.parse(text) as Json;
    } catch (err) {
      throw new Error(`${(err as Error).message}: ${text.slice(0, 160)}`);
    }
    if (value.status === 1) return value.data ?? null;
    const msg = typeof value.msg === "string" && value.msg ? value.msg : "接口返回失败";
    throw new Error(msg);
  });
}

function guestGet(path: string): Promise<unknown> {
  const origin = getBase();
  return edge(origin, "GET", path, null, sessionToken(origin), true);
}

function guestPost(path: string, body: unknown, retry: boolean): Promise<unknown> {
  const origin = getBase();
  return edge(origin, "POST", path, body, sessionToken(origin), retry);
}

async function authed(method: string, path: string, body?: unknown): Promise<unknown> {
  const origin = getBase();
  const token = sessionToken(origin);
  if (!token) throw new Error("请先登录");
  return edge(origin, method, path, body ?? null, token, false);
}

/* ── 播放地址字段回填（对应 api.rs normalize_play_info） ── */

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function normalizePlayInfo(info: unknown): void {
  if (!info || typeof info !== "object") return;
  const obj = info as Json;
  const streams = (obj.streams ?? {}) as Json;
  const main = nonEmpty(streams.main);
  const hevc = nonEmpty(streams.hevc);
  if (main && !nonEmpty(obj.video_url)) obj.video_url = main;
  if (hevc && !nonEmpty(obj.video_url_hevc)) obj.video_url_hevc = hevc;
}

function hasPlayUrl(info: unknown): boolean {
  return !!info && typeof info === "object" && !!nonEmpty((info as Json).video_url);
}

/* ── 镜像线路解析（对应 lines.rs） ──────────────────────── */

function stripLineComments(body: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      if (i < body.length) out += "\n";
    } else {
      out += c;
    }
  }
  return out;
}

function jsArray(src: string, decl: string): string[] {
  const at = src.indexOf(decl);
  if (at < 0) return [];
  const rest = src.slice(at);
  const open = rest.indexOf("[");
  if (open < 0) return [];
  const close = rest.indexOf("]", open);
  if (close < 0) return [];
  return stripLineComments(rest.slice(open + 1, close))
    .split(",")
    .map((raw) => raw.trim().replace(/^['"]+|['"]+$/g, "").trim())
    .filter((s) => s !== "");
}

function scriptSrc(html: string): string | null {
  const re = /src="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1].includes(".js")) return m[1];
  }
  return null;
}

function absoluteUrl(base: string, rel: string): string {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

async function fetchTextDirect(url: string, timeoutMs = 12000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function lineMirrors(): Promise<unknown> {
  const html = await fetchTextDirect(PUBLISH_PAGE);
  const jsRel = scriptSrc(html) || "publish.js";
  const jsUrl = absoluteUrl(PUBLISH_PAGE, jsRel);
  const js = await fetchTextDirect(jsUrl);
  const domains = jsArray(js, "var urls");
  const subs = jsArray(js, "var subdomains");
  if (domains.length === 0) throw new Error("地址发布页格式有变化：没找到镜像域名");
  const items: { url: string; host: string }[] = [];
  const seen = new Set<string>();
  outer: for (const rawDomain of domains) {
    const domain = rawDomain.replace(/\/+$/, "");
    if (!domain) continue;
    const hosts = subs.length === 0 ? [domain] : subs.map((s) => `${s}.${domain}`);
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      items.push({ url: `https://${host}`, host });
      if (items.length >= MIRROR_MAX) break outer;
    }
  }
  if (items.length === 0) throw new Error("地址发布页里没有可用的镜像地址");
  return { source: PUBLISH_PAGE, script: jsUrl, items };
}

async function probeOne(url: string): Promise<Json> {
  const target = `${url.replace(/\/+$/, "")}/`;
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(target, { signal: ctl.signal, mode: "no-cors" });
    const ms = Math.round(performance.now() - started);
    // no-cors 下状态不可见（opaque），能完成请求即视为可达
    const status = resp.type === "opaque" ? 200 : resp.status;
    return { url, ok: status < 400, status, ms };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    return { url, ok: false, ms, error: (e as Error).message || "请求失败" };
  } finally {
    clearTimeout(timer);
  }
}

async function lineProbe(urls: string[]): Promise<unknown> {
  const out: Json[] = [];
  for (let i = 0; i < urls.length; i += 6) {
    const chunk = urls.slice(i, i + 6);
    out.push(...(await Promise.all(chunk.map((u) => probeOne(u)))));
  }
  return out;
}

/* ── 更新检查（对应 api.rs check_update） ───────────────── */

function verParts(v: string): number[] {
  return v
    .trim()
    .replace(/^[vV]/, "")
    .split(/[.\-+]/)
    .map((s) => {
      const n = parseInt(s.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    });
}

function isNewer(latest: string, current: string): boolean {
  const a = verParts(latest);
  const b = verParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkUpdate(): Promise<unknown> {
  const current = __APP_VERSION__;
  const releasesUrl = `https://github.com/${UPDATE_REPO}/releases`;
  let resp: Response;
  try {
    resp = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch (e) {
    throw new Error((e as Error).message || "请求失败，请检查网络");
  }
  if (resp.status === 404) {
    return { current, latest: "", has_update: false, url: releasesUrl };
  }
  if (!resp.ok) throw new Error(`GitHub 返回 HTTP ${resp.status}`);
  const v = (await resp.json()) as Json;
  const tag = typeof v.tag_name === "string" ? v.tag_name : "";
  const notes = typeof v.body === "string" ? v.body : "";
  return {
    current,
    latest: tag.replace(/^[vV]/, ""),
    tag,
    has_update: tag !== "" && isNewer(tag, current),
    url: typeof v.html_url === "string" ? v.html_url : releasesUrl,
    name: typeof v.name === "string" ? v.name : "",
    published_at: typeof v.published_at === "string" ? v.published_at : "",
    notes: notes.slice(0, 800),
  };
}

/* ── 播放诊断日志（对应 playback_log.rs 的本地落盘） ────── */

function plogStatus(): Json {
  return { enabled: lsGet(LS.plogEnabled) === "1", path: null, error: null };
}

/* ── 命令表 ─────────────────────────────────────────────── */

const commands: Record<string, (args: Args) => Promise<unknown> | unknown> = {
  /* 基础 */
  debug_log: () => undefined,
  app_boot: () => {
    const origin = getBase();
    return {
      user: sessionUser(origin),
      logged_in: !!sessionToken(origin),
      base: origin,
      strict_security: strictSecurity(),
      cli_relaxed: false,
    };
  },
  security_set: (args) => {
    lsSet(LS.strict, args.strict ? "1" : "0");
    return strictSecurity();
  },
  net_diag: async () => {
    const cur = getBase();
    let host = "";
    try {
      host = new URL(cur).hostname;
    } catch {
      /* ignore */
    }
    const started = performance.now();
    let http: Json;
    try {
      const resp = await fetch(`${cur}/`, { mode: "no-cors" });
      void resp;
      http = { status: 200, ms: Math.round(performance.now() - started) };
    } catch (e) {
      http = { error: (e as Error).message || "请求失败", ms: Math.round(performance.now() - started) };
    }
    return {
      base: cur,
      host,
      dns: { error: "浏览器环境无法直查 DNS" },
      http,
      env: { HTTP_PROXY: null, HTTPS_PROXY: null, ALL_PROXY: null, NO_PROXY: null, HGHUB_PROXY: null },
    };
  },
  cache_clear: async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("hg-")).map((k) => caches.delete(k)));
    } catch {
      /* ignore */
    }
  },
  open_url: (args) => {
    const raw = String(args.url ?? "");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("链接无效");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只允许打开 http/https 链接");
    window.open(u.toString(), "_blank", "noopener");
  },
  set_orientation: async (args) => {
    try {
      const orientation = screen.orientation as unknown as {
        lock?: (o: string) => Promise<void>;
        unlock?: () => void;
      };
      if (args.landscape) await orientation.lock?.("landscape");
      else orientation.unlock?.();
    } catch {
      /* 浏览器要求全屏等条件，不满足时静默失败（原生版同样不阻断） */
    }
  },
  "plugin:app|exit": () => {
    window.close();
  },

  /* 线路 */
  line_state: () => ({
    base: getBase(),
    default: DEFAULT_BASE,
    fixed: FIXED_LINES,
  }),
  line_set: (args) => {
    const next = normalizeBase(String(args.url ?? ""));
    if (!next) throw new Error("线路地址无效（需要纯 HTTPS 站点地址，禁止内网）");
    const previous = getBase();
    lsSet(LS.base, next);
    if (previous !== next) clearSession();
    return next;
  },
  line_mirrors: () => lineMirrors(),
  line_probe: (args) => lineProbe(Array.isArray(args.urls) ? (args.urls as string[]) : []),

  /* 更新 */
  check_update: () => checkUpdate(),

  /* 账号 */
  api_login: async (args) => {
    const origin = getBase();
    const data = (await edge(
      origin,
      "POST",
      "/api/account/loginByPassword",
      { username: args.username, password: args.password },
      null,
      false,
    )) as Json | null;
    const token = data && typeof data.token === "string" ? data.token : null;
    if (!token) throw new Error("登录返回缺少 token");
    const user = data?.user ?? null;
    if (getBase() !== origin) throw new Error("登录期间线路已变化，请重新登录");
    writeSession({ origin, token, user });
    return { user };
  },
  api_register: async (args) => {
    const origin = getBase();
    const body: Json = {
      username: args.username,
      password: args.password,
      confirm_password: args.password,
    };
    const email = typeof args.email === "string" ? args.email.trim() : "";
    if (email) body.email = email;
    const data = (await edge(origin, "POST", "/api/account/registerByPassword", body, null, false)) as Json | null;
    const token = data && typeof data.token === "string" ? data.token : null;
    if (!token) throw new Error("注册返回缺少 token");
    const user = data?.user ?? null;
    if (getBase() !== origin) throw new Error("注册期间线路已变化，请重新登录");
    writeSession({ origin, token, user });
    return { user };
  },
  api_logout: async () => {
    const origin = getBase();
    try {
      await edge(origin, "POST", "/api/account/logout", null, sessionToken(origin), false);
    } catch {
      /* 与原生版一致：退出接口失败也照常清本地会话 */
    }
    clearSession();
    return { ok: true };
  },
  api_me: async () => {
    const origin = getBase();
    const me = await edge(origin, "GET", "/api/account/me", null, sessionToken(origin), true);
    if (getBase() !== origin) throw new Error("读取账号期间线路已变化");
    const token = sessionToken(origin);
    if (token) writeSession({ origin, token, user: me });
    return me;
  },

  /* 列表与内容（GET 也带 token，与原生版一致） */
  api_feed: (args) => guestGet(`/api/videos?page=${args.page}&size=${args.size}`),
  api_category: (args) =>
    guestGet(`/api/videos/category/${args.cate}?page=${args.page}&size=${args.size}`),
  api_rank: (args) => {
    const kind = args.kind === "recommend" || args.kind === "potential" ? args.kind : "hot";
    return guestGet(`/api/ranks/${kind}`);
  },
  api_search: (args) => {
    const encoded = encodeURIComponent(String(args.q ?? ""));
    return guestGet(`/api/search?q=${encoded}&page=${args.page}&size=${args.size}`);
  },
  api_posts: (args) => guestGet(`/api/posts?page=${args.page}&size=${args.size}`),
  api_post: (args) => guestGet(`/api/posts/${args.id}`),
  api_video: (args) => guestGet(`/api/videos/${args.id}`),

  api_play: async (args) => {
    const { id, ep } = args;
    let primary: unknown = null;
    let primaryError: unknown = null;
    try {
      primary = await guestPost(`/api/videos/${id}/episodes/${ep}/playback`, {}, true);
      normalizePlayInfo(primary);
    } catch (e) {
      primaryError = e;
    }
    if (!primaryError && hasPlayUrl(primary)) return primary;
    try {
      const legacy = await guestGet(`/api/videos/${id}/play?ep=${ep}&page_texts=0`);
      normalizePlayInfo(legacy);
      if (hasPlayUrl(legacy) || primaryError) return legacy;
      return primary;
    } catch {
      if (!primaryError) return primary;
      throw primaryError;
    }
  },

  /* 评论与互动 */
  api_comments: (args) =>
    guestGet(`/api/videos/${args.id}/comments?ep=${args.ep}&page=${args.page}&size=${args.size}`),
  api_comment_send: (args) => {
    const body: Json = { text: args.text };
    const replyId = typeof args.replyId === "number" ? args.replyId : 0;
    if (replyId > 0) {
      body.reply_id = replyId;
      return authed("POST", `/api/videos/${args.id}/comments`, body);
    }
    return authed("POST", `/api/videos/${args.id}/comments?ep=${args.ep}`, body);
  },
  api_like: (args) => authed(args.on ? "POST" : "DELETE", `/api/videos/${args.id}/like?ep=${args.ep}`),
  api_collect: (args) => authed(args.on ? "POST" : "DELETE", `/api/videos/${args.id}/collect`),
  api_follow: (args) => authed(args.on ? "POST" : "DELETE", `/api/users/${args.uid}/follow`),
  api_post_like: (args) => authed(args.on ? "POST" : "DELETE", `/api/posts/${args.id}/like`),
  api_post_collect: (args) => authed(args.on ? "POST" : "DELETE", `/api/posts/${args.id}/collect`),
  api_post_comments: (args) =>
    guestGet(`/api/posts/${args.id}/comments?page=${args.page}&size=${args.size}`),

  /* 播放诊断日志 */
  playback_log_status: () => plogStatus(),
  playback_log_set: (args) => {
    lsSet(LS.plogEnabled, args.enabled ? "1" : "0");
    return plogStatus();
  },
  playback_log_write: (args) => {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (entries.length === 0) return;
    const prev = lsGet(LS.plogBody) || "";
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    let next = prev + lines;
    // 与原生版一样有界：超出约 512KB 时丢弃最旧的部分
    if (next.length > 512 * 1024) next = next.slice(next.length - 384 * 1024);
    lsSet(LS.plogBody, next);
  },
  playback_log_read: () => lsGet(LS.plogBody) || "",
};

/* ── @tauri-apps/api/core 兼容导出 ──────────────────────── */

export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  const handler = commands[cmd];
  if (!handler) throw new Error(`网页版未实现的命令：${cmd}`);
  return (await handler(args ?? {})) as T;
}

export async function addPluginListener(
  _plugin: string,
  _event: string,
  _callback: (payload: unknown) => void,
): Promise<{ unregister: () => Promise<void> }> {
  // 安卓物理返回键在浏览器里没有对应事件，网页版忽略该监听。
  return { unregister: async () => {} };
}

export function convertFileSrc(filePath: string): string {
  return filePath;
}
