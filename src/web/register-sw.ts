/* 网页版 Service Worker 注册（public/hg-sw.js）。
 * SW 提供虚拟媒体协议层（/hg/img、/hg/hls、/hg/seg），必须赶在封面/视频
 * 请求发出前接管页面：首次访问时等 SW 激活后自动刷新一次（带防循环标记）。
 */
export function registerHgSw(): void {
  if (!("serviceWorker" in navigator)) return;
  const base = import.meta.env.BASE_URL || "/";
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${base}hg-sw.js`, { scope: base })
      .then(async () => {
        if (navigator.serviceWorker.controller) return;
        const KEY = "hghub.sw.activated";
        try {
          if (sessionStorage.getItem(KEY)) return;
          sessionStorage.setItem(KEY, "1");
        } catch {
          return;
        }
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) window.location.reload();
      })
      .catch(() => {
        /* SW 注册失败时仅封面/播放不可用，其余功能不受影响 */
      });
  });
}
