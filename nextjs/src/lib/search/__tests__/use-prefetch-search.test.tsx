/**
 * usePrefetchSearch 单测 — 防止预热逻辑回归
 *
 * 关键回归点：
 * 1. TDZ：第一版 cleanup/onFocus/trigger 互引用 const 导致 minifier 重排撞
 *    "Cannot access 'a' before initialization"。这里通过覆盖触发路径
 *    （searchQuery 立即调 cleanup）防止再发生
 * 2. detailId 时不预热（详情页不浪费流量）
 * 3. searchQuery 时立即触发
 * 4. 5s 兜底
 * 5. focus input 触发
 */
import React from 'react';
import { render } from '@testing-library/react';
import { usePrefetchSearch } from '../use-prefetch-search';

function Probe(props: { detailId: string | null; searchQuery: string | null; init: () => Promise<unknown>; idleTimeoutMs?: number; enabled?: boolean }) {
    usePrefetchSearch(props);
    return null;
}

describe('usePrefetchSearch', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('detailId 非空时不预热', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        render(<Probe detailId="aTNoXY45BGY3" searchQuery={null} init={init} />);
        jest.advanceTimersByTime(10_000);
        expect(init).not.toHaveBeenCalled();
    });

    it('searchQuery 非空时立即触发（无 TDZ 异常）', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        // searchQuery 路径会立即调 trigger() → cleanup()
        // — 第一版的 TDZ bug 就在这条路径触发
        expect(() => {
            render(<Probe detailId={null} searchQuery="史記" init={init} />);
        }).not.toThrow();
        expect(init).toHaveBeenCalledTimes(1);
    });

    it('5s 兜底触发', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        render(<Probe detailId={null} searchQuery={null} init={init} idleTimeoutMs={5000} />);
        expect(init).not.toHaveBeenCalled();
        jest.advanceTimersByTime(4999);
        expect(init).not.toHaveBeenCalled();
        jest.advanceTimersByTime(2);
        expect(init).toHaveBeenCalledTimes(1);
    });

    it('input focus 触发（focusin 事件）', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        render(<Probe detailId={null} searchQuery={null} init={init} idleTimeoutMs={5000} />);

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        expect(init).toHaveBeenCalledTimes(1);
        document.body.removeChild(input);
    });

    it('非 input focus 不触发（避免误触）', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        render(<Probe detailId={null} searchQuery={null} init={init} idleTimeoutMs={5000} />);

        const button = document.createElement('button');
        document.body.appendChild(button);
        button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        expect(init).not.toHaveBeenCalled();
        document.body.removeChild(button);
    });

    it('触发一次后不再重复触发（即使 5s 兜底也到了）', () => {
        const init = jest.fn().mockResolvedValue(undefined);
        render(<Probe detailId={null} searchQuery={null} init={init} idleTimeoutMs={5000} />);

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(init).toHaveBeenCalledTimes(1);

        // 5s 兜底已被 cleanup 取消，不会再触发
        jest.advanceTimersByTime(10_000);
        expect(init).toHaveBeenCalledTimes(1);

        // 再次 focus 也不触发（triggered 标记）
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(init).toHaveBeenCalledTimes(1);

        document.body.removeChild(input);
    });

    it('init 失败不抛异常（用户体验：预热是 best-effort）', () => {
        const init = jest.fn().mockRejectedValue(new Error('worker boom'));
        expect(() => {
            render(<Probe detailId={null} searchQuery="abc" init={init} />);
        }).not.toThrow();
    });

    describe('enabled=false（hybrid 搜索 L1 健康时关掉预热）', () => {
        it('searchQuery 即时路径不触发', () => {
            const init = jest.fn().mockResolvedValue(undefined);
            render(<Probe detailId={null} searchQuery="史記" init={init} enabled={false} />);
            expect(init).not.toHaveBeenCalled();
        });

        it('5s 兜底不触发', () => {
            const init = jest.fn().mockResolvedValue(undefined);
            render(<Probe detailId={null} searchQuery={null} init={init} idleTimeoutMs={5000} enabled={false} />);
            jest.advanceTimersByTime(10_000);
            expect(init).not.toHaveBeenCalled();
        });

        it('input focus 不触发', () => {
            const init = jest.fn().mockResolvedValue(undefined);
            render(<Probe detailId={null} searchQuery={null} init={init} enabled={false} />);
            const input = document.createElement('input');
            document.body.appendChild(input);
            input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            expect(init).not.toHaveBeenCalled();
            document.body.removeChild(input);
        });
    });
});
