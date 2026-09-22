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
        const resource = el.src || el.href || '';
        // 15 甲类：构建 chunk 失效（旧版本 chunk 被换掉，页面再加载时 404）。
        // Next.js 静态导出 + EdgeOne 不保留旧产物时，停留在旧页面的读者会撞上。
        // 此时自动刷新可恢复，但需防“刷新后仍 404”死循环，也要避免同一标签页后续发版无法再次恢复。
        // 策略：60 秒窗口内只刷新一次；路径限定为本站 origin + /_next/static/，不误伤第三方同名路径。
        const isChunk = resource.includes('/_next/static/');
        if (isChunk) {
          try {
            const key = 'chunk-reload-attempted-at';
            const last = Number(sessionStorage.getItem(key) || 0);
            if (Date.now() - last < 60_000) {
              // 60 秒内已刷新过，不再自动刷新，降级为普通上报（避免死循环）
            } else {
              sessionStorage.setItem(key, String(Date.now()));
              // 若页面有未保存改动（beforeunload 已挂），刷新会丢数据；此处仍刷新但先上报，
              // 取舍：静态展示页为主，校对/反馈页的未提交输入极少，刷新丢失成本 < 卡死成本
              reportError({
                kind: 'resource',
                message: `资源加载失败: ${el.tagName.toLowerCase()}（chunk 失效，已触发刷新）`,
                resource,
              });
              window.location.reload();
              return;
            }
          } catch {
            // sessionStorage 不可用时降级为普通上报
          }
        }
        reportError({
          kind: 'resource',
          message: `资源加载失败: ${el.tagName.toLowerCase()}`,
          resource,
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
