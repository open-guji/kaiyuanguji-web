'use client';

import { useEffect } from 'react';
import { reportError } from '@/lib/error-report';

/**
 * 全局前端错误监听：未捕获异常、未处理的 Promise rejection、资源加载失败。
 * 渲染 null，仅挂监听。上报走 @/lib/error-report（失败静默）。
 */
export default function ErrorMonitor() {
  useEffect(() => {
    function onError(event: ErrorEvent) {
      // 资源加载错误（<img>/<script>/<link> 等）：event.target 是元素而非 window。
      // 这类错误不冒泡，靠捕获阶段监听。
      const target = event.target;
      if (target instanceof HTMLElement) {
        const el = target as HTMLElement & { src?: string; href?: string };
        reportError({
          kind: 'resource',
          message: `资源加载失败: ${el.tagName.toLowerCase()}`,
          resource: el.src || el.href || '',
        });
        return;
      }
      reportError({
        kind: 'js',
        message: event.message || 'Unknown error',
        stack: (event.error as Error | undefined)?.stack,
        source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      });
    }

    function onRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : reason && typeof reason === 'object' && 'message' in reason
              ? String((reason as { message: unknown }).message)
              : String(reason);
      reportError({
        kind: 'unhandledrejection',
        message: message || 'Unhandled rejection',
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    }

    window.addEventListener('error', onError, true); // 捕获阶段，才能拿到资源错误
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
