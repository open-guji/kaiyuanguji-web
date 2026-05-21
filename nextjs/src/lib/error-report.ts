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

export function reportError(payload: ErrorPayload): void {
  if (typeof window === 'undefined') return; // SSR / build：no-op
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
