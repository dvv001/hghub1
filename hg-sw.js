/* HGhub 网页版 Service Worker —— 虚拟媒体协议层
 *
 * 原生版（Tauri）靠 Rust 注册的自定义协议 `hg://localhost` 做三件事：
 *   /img  封面下载 + AES-128-CBC 解密（站点封面是密文）
 *   /hls  拉取 m3u8 并把分片 / key 地址改写回本地协议（绕 CORS 与防盗链）
 *   /seg  分片 / key / mp4 透传；子播放列表继续改写
 * 网页版没有 Rust，这一层改由本 SW 在浏览器内实现：前端把 LOCAL 前缀
 * 指向 `<站点根>/hg`，SW 拦截这三个路径并按同样规则处理。
 * 逻辑与 src-tauri/src/media.rs 对齐（解密 key/iv、播放列表改写规则一致）。
 */

const IMG_KEY = new TextEncoder().encode("f5d965df75336270");
const IMG_IV = new TextEncoder().encode("97b60394abc2fbe1");
const IMG_CACHE_NAME = "hg-img-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = /\/hg\/(img|hls|seg)$/.exec(url.pathname);
  if (!match) return;
  const route = match[1];
  const target = url.searchParams.get("u") || "";
  const prefix = url.origin + url.pathname.slice(0, url.pathname.length - route.length - 1); // …/hg
  if (!target || !/^https?:\/\//i.test(target)) {
    event.respondWith(new Response("missing or invalid u", { status: 400, headers: { "Content-Type": "text/plain" } }));
    return;
  }
  if (route === "img") event.respondWith(handleImg(target));
  else if (route === "hls") event.respondWith(handleHls(target, prefix));
  else event.respondWith(handleSeg(target, prefix, event.request.headers.get("Range")));
});

/* ── 工具 ─────────────────────────────────────────────── */

const enc = (s) => encodeURIComponent(s);

function absolutize(base, target) {
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}

function imageKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif"; // GIF8
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp"; // RIFF…WEBP
  return null;
}

function respond(status, ctype, body, cache) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": ctype,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cache,
    },
  });
}

async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { ctype: resp.headers.get("Content-Type"), bytes: new Uint8Array(await resp.arrayBuffer()) };
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

/* ── 封面：AES-128-CBC 解密（WebCrypto 自带 PKCS#7 去填充） ── */

let keyPromise = null;
function aesKey() {
  if (!keyPromise) keyPromise = crypto.subtle.importKey("raw", IMG_KEY, { name: "AES-CBC" }, false, ["decrypt"]);
  return keyPromise;
}

async function handleImg(target) {
  try {
    const cache = await caches.open(IMG_CACHE_NAME);
    const hit = await cache.match(target);
    if (hit) return hit;
    const { bytes } = await fetchBytes(target);
    let plain = bytes;
    let kind = imageKind(plain);
    if (!kind) {
      const key = await aesKey();
      const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: IMG_IV }, key, bytes);
      plain = new Uint8Array(out);
      kind = imageKind(plain) || "image/jpeg";
    }
    const resp = respond(200, kind, plain, "public, max-age=86400");
    cache.put(target, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    return respond(502, "text/plain", String((e && e.message) || e), "no-store");
  }
}

/* ── HLS：播放列表改写（与 media.rs rewrite_playlist 对齐） ── */

/** 属性列表里的引号内可含逗号，不能直接 split(',')。 */
function hlsAttributes(line) {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const tag = line.slice(0, idx);
  const rest = line.slice(idx + 1);
  const attrs = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      attrs.push(rest.slice(start, i));
      start = i + 1;
    }
  }
  attrs.push(rest.slice(start));
  return [tag, attrs];
}

function mapUriAttributes(line, rewrite) {
  const parsed = hlsAttributes(line);
  if (!parsed) return line;
  const [tag, attrs] = parsed;
  const mapped = attrs.map((attribute) => {
    const eq = attribute.indexOf("=");
    if (eq >= 0 && attribute.slice(0, eq).trim() === "URI") {
      const value = attribute.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        return `${attribute.slice(0, eq)}="${rewrite(value.slice(1, -1))}"`;
      }
    }
    return attribute;
  });
  return `${tag}:${mapped.join(",")}`;
}

function rewritePlaylist(playlistUrl, text, prefix) {
  const out = [];
  const clean = text.replace(/^\uFEFF/, "");
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) {
      out.push("");
      continue;
    }
    if (line.startsWith("#")) {
      // 禁用可派生 URL 的内容引导；DATERANGE 只保留时间线/SCTE-35 元数据。
      if (line.startsWith("#EXT-X-CONTENT-STEERING:")) continue;
      if (line.startsWith("#EXT-X-DATERANGE:")) {
        const parsed = hlsAttributes(line);
        if (parsed) {
          const [tag, attrs] = parsed;
          const safe = attrs.filter((attribute) => {
            const key = (attribute.split("=")[0] || "").trim().toUpperCase();
            return !key.includes("URI") && key !== "X-ASSET-LIST";
          });
          out.push(`${tag}:${safe.join(",")}`);
        }
        continue;
      }
      if (line.includes('URI="')) {
        const absolute = mapUriAttributes(line, (uri) => absolutize(playlistUrl, uri));
        out.push(mapUriAttributes(absolute, (uri) => `${prefix}/seg?u=${enc(uri)}`));
      } else {
        out.push(line);
      }
    } else {
      out.push(`${prefix}/seg?u=${enc(absolutize(playlistUrl, line))}`);
    }
  }
  return out.join("\n") + "\n";
}

async function handleHls(target, prefix) {
  try {
    const text = await fetchText(target);
    if (!text.replace(/^\uFEFF/, "").startsWith("#EXTM3U")) {
      return respond(502, "text/plain", "响应不是 HLS 播放列表", "no-store");
    }
    return respond(200, "application/vnd.apple.mpegurl", rewritePlaylist(target, text, prefix), "no-store");
  } catch (e) {
    return respond(502, "text/plain", String((e && e.message) || e), "no-store");
  }
}

async function handleSeg(target, prefix, range) {
  try {
    // 带 Range 的请求（mp4 拖动等）直接透传上游响应，保留 206 语义。
    if (range) {
      const resp = await fetch(target, { headers: { Range: range } });
      return resp;
    }
    const { ctype, bytes } = await fetchBytes(target);
    const looksPlaylist =
      (ctype && ctype.toLowerCase().includes("mpegurl")) ||
      (bytes.length >= 7 && new TextDecoder().decode(bytes.slice(0, 7)) === "#EXTM3U") ||
      (bytes.length >= 10 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf &&
        new TextDecoder().decode(bytes.slice(3, 10)) === "#EXTM3U");
    if (looksPlaylist) {
      const text = new TextDecoder().decode(bytes);
      return respond(200, "application/vnd.apple.mpegurl", rewritePlaylist(target, text, prefix), "public, max-age=3600");
    }
    let mime = ctype;
    if (!mime) {
      const p = target.split("?")[0].toLowerCase();
      if (p.endsWith(".ts")) mime = "video/mp2t";
      else if (p.endsWith(".m4s") || p.endsWith(".mp4")) mime = "video/mp4";
      else mime = "application/octet-stream";
    }
    return respond(200, mime, bytes, "public, max-age=3600");
  } catch (e) {
    return respond(502, "text/plain", String((e && e.message) || e), "no-store");
  }
}
