/*
 * 整页导航失败自动重试一次（overview#322「第一次打开阅读页／条目页报错、刷新就好」）。
 *
 * 只管 /read/… 与 /item/… 的整页导航（mode=navigate 的 GET）：
 *   - 网络错（边缘直接断开、连接重置）或 5xx（冷渲染临时故障回的纯文本 500）→ 等 300ms 再请求一次；
 *   - 第二次仍失败就原样交给浏览器（读者看到的与没有本脚本时一样）。
 * 不缓存任何东西、不碰其他请求（不调 respondWith，照常走网络）。
 * 页面里的 error.tsx 管不到这一路：整页请求失败时页面根本没加载出来，只有 Service Worker 能接住。
 *
 * 停用：把 KILL 改成 true 发版——已装的 Service Worker 下次检查更新时会注销自己（浏览器至少每 24 小时查一次）。
 */
var KILL = false;
var NAV_RETRY_PATH = /^\/(read|item)\//;
var NAV_RETRY_DELAY_MS = 300;

/** 取一次；网络错或 5xx 时等一下再取一次。fetchImpl／sleep 可替换，便于单测 */
async function navigateWithRetry(request, fetchImpl, sleep) {
  var first;
  try {
    first = await fetchImpl(request);
    if (first.status < 500) return first;
  } catch (err) {
    first = null;
  }
  await sleep(NAV_RETRY_DELAY_MS);
  try {
    return await fetchImpl(request);
  } catch (err) {
    if (first) return first;
    throw err;
  }
}

function shouldHandle(request, origin) {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  var url = new URL(request.url);
  return url.origin === origin && NAV_RETRY_PATH.test(url.pathname);
}

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(KILL ? self.registration.unregister() : self.clients.claim());
});
self.addEventListener('fetch', function (event) {
  if (KILL || !shouldHandle(event.request, self.location.origin)) return;
  event.respondWith(navigateWithRetry(event.request, function (r) { return fetch(r); }, function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }));
});

if (typeof module !== 'undefined') module.exports = { navigateWithRetry: navigateWithRetry, shouldHandle: shouldHandle };
