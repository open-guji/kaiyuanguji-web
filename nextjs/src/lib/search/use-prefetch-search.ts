/**
 * usePrefetchSearch — 在合适时机预热搜索 worker（下载 ~2 MB gzip 索引）。
 *
 * 触发条件（任一）：
 *   - URL 带 q=（用户主动搜索／deep link 进来）→ 立即触发
 *   - 任何 input 获得 focus（搜索框唯一可聚焦输入）→ 立即触发
 *   - 在页面停留 ≥ 5s 兜底
 *
 * 详情页（detailId 非空）不预热 — 大部分详情访客不返回搜索。
 *
 * `enabled=false` 时彻底不预热（hybrid 搜索 L1 健康时省 2 MB 流量；L1 失败的
 * fallback 路径会按需 init worker，不依赖预热）。
 *
 * 历史教训：
 *  - 第一版用 const trigger / cleanup 互引用导致 minifier 重排撞 TDZ
 *    → "Cannot access 'a' before initialization"。改用 function declaration
 *    （hoisted）后 OK。
 */
import { useEffect } from 'react';

export interface PrefetchOptions {
    detailId: string | null;
    searchQuery: string | null;
    /** 可注入的 worker init 函数，便于测试 */
    init: () => Promise<unknown>;
    /** 兜底超时（毫秒），默认 5000 */
    idleTimeoutMs?: number;
    /** 是否启用预热（默认 true）。配了 L1 (Meili) 时建议传 false */
    enabled?: boolean;
}

export function usePrefetchSearch({
    detailId,
    searchQuery,
    init,
    idleTimeoutMs = 5000,
    enabled = true,
}: PrefetchOptions): void {
    useEffect(() => {
        if (!enabled) return;
        if (detailId) return;
        if (typeof window === 'undefined') return;

        let triggered = false;
        let timer = 0;

        function trigger() {
            if (triggered) return;
            triggered = true;
            cleanup();
            init().catch(() => { /* 静默失败 */ });
        }
        function onFocus(e: FocusEvent) {
            if ((e.target as HTMLElement)?.tagName === 'INPUT') trigger();
        }
        function cleanup() {
            if (timer) window.clearTimeout(timer);
            document.removeEventListener('focusin', onFocus, true);
        }

        if (searchQuery) {
            trigger();
            return;
        }

        document.addEventListener('focusin', onFocus, true);
        timer = window.setTimeout(trigger, idleTimeoutMs);

        return cleanup;
    }, [detailId, searchQuery, init, idleTimeoutMs, enabled]);
}
