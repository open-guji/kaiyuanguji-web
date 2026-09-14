// 轻量前端错误上报：POST 到 EdgeOne 边缘函数 /api/track-error
// （见 edge-functions/api/track-error.js）。不依赖任何第三方 SDK。
//
// 设计要点：
//   - SSR/build 安全：无 window 时 no-op。
//   - 客户端节流去重：同一指纹本会话只报一次 + 每页上限，防异常风暴刷爆 KV。
//   - sendBeacon 优先（页面卸载也能送达），降级 fetch(keepalive)；失败一律静默——
//     监控本身绝不能产生噪音或影响主流程。

const ENDPOINT = '/api/track-error';
const MAX_PER_PAGE = 20;

export type ErrorKind = 'js' | 'unhandledrejection' | 'fetch' | 'resource' | 'react';

export interface ErrorPayload {
  kind: ErrorKind;
  message: string;
  stack?: string;
  source?: string; // file:line:col（JS 错误）
  resource?: string; // fetch 失败的资源 id/url
  status?: number; // http status
}

// 数据版本（commit），由 cos-storage.resolveCosVersion 解析后回填，附在每条上报里，
// 便于把错误归因到具体的数据/构建版本。
let release = '';
export function setRelease(v: string): void {
  if (v) release = v;
}

const seen = new Set<string>();
let sentCount = 0;

function fingerprint(p: ErrorPayload): string {
  return [p.kind, p.message, p.source || p.resource || '', p.status ?? ''].join('|');
}

/**
 * 自动化浏览器不上报。
 *
 * 2026-09-14 从生产错误日志倒查出来：138 条 `entry 不存在 (404)` 里有 90 条
 * （65%）是我们自己的测试打的——
 *   · 60 条来自 e2e 用例「不存在的 ID 给出友好提示而非白屏」，它**有意**访问
 *     `?id=nonexistent000`，每次部署跑一遍；那条 404 是用例的预期结果，不是缺陷；
 *   · 30 条来自 perf-prod 夜跑，场景 ID 早已失效（另见 perf/smoke.ts 的说明）。
 * 结果是错误日志里堆着一大片「已知且无害」的记录，真实读者撞上的问题被埋在里面，
 * 而 /toolkit/errors 默认又勾着「隐藏 404」——两头一夹，谁也没看见。
 *
 * 测试自己制造的错误混进真实读者的错误里，等于给监控注水。CI 那边有 pageerror
 * 断言兜底，不靠这条上报链路，所以这里直接不发。
 * （Playwright / Selenium 下 navigator.webdriver === true，已实测。）
 */
function isAutomated(): boolean {
  try {
    return navigator.webdriver === true;
  } catch {
    return false;
  }
}

export function reportError(payload: ErrorPayload): void {
  if (typeof window === 'undefined') return; // SSR / build：no-op
  if (isAutomated()) return;                 // e2e / perf 的自造错误不进生产监控
  if (!payload || !payload.message) return;
  if (sentCount >= MAX_PER_PAGE) return;

  const fp = fingerprint(payload);
  if (seen.has(fp)) return;
  seen.add(fp);
  sentCount += 1;

  const body = JSON.stringify({
    ...payload,
    message: String(payload.message).slice(0, 1000),
    stack: payload.stack ? String(payload.stack).slice(0, 4000) : undefined,
    pageUrl: window.location.href,
    release,
  });

  try {
    // sendBeacon 优先：不阻塞、页面卸载/跳转时也能送达
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    // 降级：keepalive 让卸载阶段仍尝试发送；失败静默
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 监控不能影响主流程 */
  }
}
