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

export default {
  async fetch(req) {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const target = url.searchParams.get("u") || "";
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
