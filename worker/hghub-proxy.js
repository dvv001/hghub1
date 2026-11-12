/* HGhub 网页版的 Cloudflare Worker（部署在账号自有的 Workers 上，名为 hghub-proxy）。
 *
 * 为什么需要它：上游业务接口的 CORS 预检不返回 Access-Control-Allow-Headers，
 * 浏览器会拦下全部信封请求；媒体 CDN 又对部分网络环境拦截直连。因此网页版的
 * 数据与媒体统一经本 Worker 中转：
 *   POST /api/edge/request  信封转发（带浏览器请求头，自动轮换多条上游线路）
 *   GET  /img?u=            封面取源 + AES-128-CBC 解密（与 media.rs 对齐）
 *   GET  /hls?u=            播放列表取源 + 改写（分片/key 地址指向 /seg）
 *   GET  /seg?u=            分片/key/MP4 透传；子播放列表递归改写；支持 Range
 *   GET  /proxy?u=          通用取源中转（调试用）
 * 其余路径返回 404（Worker 不是网站，根路径 404 属正常）。
 * 部署：Cloudflare 后台 Workers & Pages → hghub-proxy → Edit code，整段替换后 Deploy。
 */
const TARGETS = [
  "https://huangguoai.com",
  "https://huangguoai.ai",
  "https://thu.rlhjeyuvw.cc",
  "https://whu.rlhjeyuvw.cc",
  "https://hust.rlhjeyuvw.cc",
  "https://pku.rlhjeyuvw.cc",
];
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IMG_KEY = new TextEncoder().encode("f5d965df75336270");
const IMG_IV = new TextEncoder().encode("97b60394abc2fbe1");

function cors(req) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      req.headers.get("Access-Control-Request-Headers") || "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
function respond(status, ctype, body, cache) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": ctype,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cache,
    },
  });
}
async function upFetch(target, range) {
  const h = { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", Accept: "*/*" };
  if (range) h.Range = range;
  return fetch(target, { headers: h });
}
async function fetchBytes(target) {
  const r = await upFetch(target);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return { ctype: r.headers.get("Content-Type"), bytes: new Uint8Array(await r.arrayBuffer()) };
}
async function fetchText(target) {
  const r = await upFetch(target);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.text();
}
function imageKind(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
let keyPromise = null;
function aesKey() {
  if (!keyPromise)
    keyPromise = crypto.subtle.importKey("raw", IMG_KEY, { name: "AES-CBC" }, false, ["decrypt"]);
  return keyPromise;
}
async function handleImg(target) {
  try {
    const { bytes } = await fetchBytes(target);
    let plain = bytes, kind = imageKind(plain);
    if (!kind) {
      const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: IMG_IV }, await aesKey(), bytes);
      plain = new Uint8Array(out);
      kind = imageKind(plain) || "image/jpeg";
    }
    return respond(200, kind, plain, "public, max-age=86400");
  } catch (e) {
    return respond(502, "text/plain", String((e && e.message) || e), "no-store");
  }
}
function absolutize(base, target) {
  try { return new URL(target, base).toString(); } catch (e) { return target; }
}
function hlsAttributes(line) {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  const tag = line.slice(0, idx), rest = line.slice(idx + 1), attrs = [];
  let quoted = false, start = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) { attrs.push(rest.slice(start, i)); start = i + 1; }
  }
  attrs.push(rest.slice(start));
  return [tag, attrs];
}
function mapUri(line, rewrite) {
  const p = hlsAttributes(line);
  if (!p) return line;
  const [tag, attrs] = p;
  const mapped = attrs.map((a) => {
    const eq = a.indexOf("=");
    if (eq >= 0 && a.slice(0, eq).trim() === "URI") {
      const v = a.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
        return a.slice(0, eq) + '="' + rewrite(v.slice(1, -1)) + '"';
    }
    return a;
  });
  return tag + ":" + mapped.join(",");
}
function rewritePlaylist(playlistUrl, text, prefix) {
  const out = [];
  for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) { out.push(""); continue; }
    if (line.startsWith("#")) {
      if (line.startsWith("#EXT-X-CONTENT-STEERING:")) continue;
      if (line.startsWith("#EXT-X-DATERANGE:")) {
        const p = hlsAttributes(line);
        if (p) {
          const safe = p[1].filter((a) => {
            const k = (a.split("=")[0] || "").trim().toUpperCase();
            return !k.includes("URI") && k !== "X-ASSET-LIST";
          });
          out.push(p[0] + ":" + safe.join(","));
        }
        continue;
      }
      if (line.includes('URI="')) {
        const abs = mapUri(line, (u) => absolutize(playlistUrl, u));
        out.push(mapUri(abs, (u) => prefix + "/seg?u=" + encodeURIComponent(u)));
      } else out.push(line);
    } else {
      out.push(prefix + "/seg?u=" + encodeURIComponent(absolutize(playlistUrl, line)));
    }
  }
  return out.join("\n") + "\n";
}
async function handleHls(target, prefix) {
  try {
    const text = await fetchText(target);
    if (!text.replace(/^\uFEFF/, "").startsWith("#EXTM3U"))
      return respond(502, "text/plain", "响应不是 HLS 播放列表", "no-store");
    return respond(200, "application/vnd.apple.mpegurl", rewritePlaylist(target, text, prefix), "no-store");
  } catch (e) {
    return respond(502, "text/plain", String((e && e.message) || e), "no-store");
  }
}
async function handleSeg(target, prefix, range) {
  try {
    if (range) {
      const up = await upFetch(target, range);
      const hh = { "Access-Control-Allow-Origin": "*" };
      for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
        const v = up.headers.get(k);
        if (v) hh[k] = v;
      }
      return new Response(up.body, { status: up.status, headers: hh });
    }
    const { ctype, bytes } = await fetchBytes(target);
    const looks =
      (ctype && ctype.toLowerCase().includes("mpegurl")) ||
      (bytes.length >= 7 && new TextDecoder().decode(bytes.slice(0, 7)) === "#EXTM3U") ||
      (bytes.length >= 10 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf &&
        new TextDecoder().decode(bytes.slice(3, 10)) === "#EXTM3U");
    if (looks)
      return respond(200, "application/vnd.apple.mpegurl",
        rewritePlaylist(target, new TextDecoder().decode(bytes), prefix), "public, max-age=3600");
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


// NexusAI 的主屏幕图标（真实 PNG）。GitHub Pages 经现有通道存不了二进制图，
// 故由本 Worker 解码内置的 base64 后以 image/png 发出，供 iOS apple-touch-icon 使用。
const NEXUS_ICON_B64 = "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";

export default {
  async fetch(req) {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const target = url.searchParams.get("u") || "";
    if (url.pathname === "/nexus-icon.png") {
      const bin = atob(NEXUS_ICON_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname === "/img" || url.pathname === "/hls" || url.pathname === "/seg") {
      if (!/^https:\/\//i.test(target))
        return respond(400, "text/plain", "missing or invalid u", "no-store");
      const prefix = url.origin;
      if (url.pathname === "/img") return handleImg(target);
      if (url.pathname === "/hls") return handleHls(target, prefix);
      return handleSeg(target, prefix, req.headers.get("Range"));
    }
    if (url.pathname === "/proxy") {
      if (!/^https:\/\//i.test(target))
        return new Response("bad u", { status: 400, headers: cors(req) });
      const up = await upFetch(target, req.headers.get("Range"));
      const hh = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS" };
      for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]) {
        const v = up.headers.get(k);
        if (v) hh[k] = v;
      }
      return new Response(up.body, { status: up.status, headers: hh });
    }
    if (url.pathname !== "/api/edge/request")
      return new Response("not found", { status: 404, headers: cors(req) });
    const bodyText = await req.text();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Origin: "https://huangguoai.com",
      Referer: "https://huangguoai.com/",
    };
    const auth = req.headers.get("Authorization");
    if (auth) headers.Authorization = auth;
    const tried = [];
    let lastText = "all upstream failed", lastStatus = 502;
    for (const base of TARGETS) {
      try {
        const up = await fetch(base + url.pathname, { method: "POST", headers, body: bodyText });
        const t = await up.text();
        tried.push(base + ":" + up.status);
        lastText = t; lastStatus = up.status;
        try {
          const v = JSON.parse(t);
          if (typeof v.status === "number")
            return new Response(t, {
              status: up.status,
              headers: { "Content-Type": "application/json", "X-Proxy-Tried": tried.join(","), ...cors(req) },
            });
        } catch (e) {}
      } catch (e) { tried.push(base + ":ERR"); }
    }
    return new Response(lastText, {
      status: lastStatus,
      headers: { "Content-Type": "application/json", "X-Proxy-Tried": tried.join(","), ...cors(req) },
    });
  },
};
