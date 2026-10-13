/**
 * @jest-environment node
 *
 * #605 A 块步 3：管理页分类／认领选项与「超时未认领」判定。
 */
// @ts-expect-error edge-functions 是纯 JS
import { CATEGORIES, ASSIGNEES } from '../../../../edge-functions/api/feedback-classify.js';
import { ASSIGNEE_OPTIONS, CATEGORY_OPTIONS, categoryOf, isClaimOverdue, CLAIM_SLA_MS, slaStats, fmtDuration } from '../feedbackTriage';

describe('选项与后端白名单对表', () => {
    it('分类、认领块取值完全一致（任何一边加减都会红）', () => {
        expect(CATEGORY_OPTIONS.map((o) => o.value)).toEqual(CATEGORIES);
        expect(ASSIGNEE_OPTIONS.map((o) => o.value)).toEqual(ASSIGNEES);
    });
});

describe('categoryOf（旧记录读时推）', () => {
    it('有 category 用 category；无则按 type', () => {
        expect(categoryOf({ category: 'typo', type: 'bug' })).toBe('typo');
        expect(categoryOf({ type: 'bug' })).toBe('site');
        expect(categoryOf({ type: 'resource' })).toBe('entry');
        expect(categoryOf({ type: 'contact' })).toBe('join');
        expect(categoryOf({ type: 'other' })).toBe('other');
    });
});

describe('isClaimOverdue', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const base = { type: 'bug', status: 'pending', createdAt: new Date(now - CLAIM_SLA_MS - 1000).toISOString() };
    it('超 24h、未认领、待处理的网站／条目／错字类 → 超时', () => {
        expect(isClaimOverdue(base, now)).toBe(true);
        expect(isClaimOverdue({ ...base, category: 'typo' }, now)).toBe(true);
        expect(isClaimOverdue({ ...base, status: 'in_progress' }, now)).toBe(true);
    });
    it('刚好 24h 内不算；已认领不算', () => {
        expect(isClaimOverdue({ ...base, createdAt: new Date(now - CLAIM_SLA_MS + 1000).toISOString() }, now)).toBe(false);
        expect(isClaimOverdue({ ...base, assignee: 'web' }, now)).toBe(false);
    });
    it('join／other、已处置、测试数据、坏时间 都不算', () => {
        expect(isClaimOverdue({ ...base, type: 'contact' }, now)).toBe(false);
        expect(isClaimOverdue({ ...base, category: 'other' }, now)).toBe(false);
        for (const status of ['resolved', 'wontfix', 'duplicate']) expect(isClaimOverdue({ ...base, status }, now)).toBe(false);
        expect(isClaimOverdue({ ...base, test: true }, now)).toBe(false);
        expect(isClaimOverdue({ ...base, createdAt: 'garbage' }, now)).toBe(false);
    });
});

describe('slaStats／fmtDuration（步 7）', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const H = 3600 * 1000;
    const at = (ms: number) => new Date(now - ms).toISOString();
    it('近 30 天认领数、超时数、中位数；测试数据与 30 天前的不计', () => {
        const items = [
            { type: 'bug', status: 'pending', createdAt: at(10 * H), assignee: 'web', claimedAt: at(9 * H) },          // 等 1h
            { type: 'bug', status: 'pending', createdAt: at(20 * H), assignee: 'text', claimedAt: at(16 * H) },        // 等 4h
            { type: 'bug', status: 'pending', createdAt: at(40 * H), assignee: 'web', claimedAt: at(30 * H) },         // 等 10h
            { type: 'bug', status: 'pending', createdAt: at(900 * H), assignee: 'web', claimedAt: at(800 * H) },       // 30 天前，不计
            { type: 'bug', status: 'pending', createdAt: at(30 * H) },                                                  // 超时
            { type: 'bug', status: 'pending', createdAt: at(30 * H), test: true },                                      // 测试，不计
            { type: 'contact', status: 'pending', createdAt: at(30 * H) },                                              // join，不计超时
        ];
        expect(slaStats(items, now)).toEqual({ claimed30: 3, overdue: 1, medianClaimMs: 4 * H });
    });
    it('偶数个样本取中间两个的平均；无样本为 null', () => {
        const mk = (wait: number) => ({ type: 'bug', status: 'resolved', createdAt: at(wait + H), assignee: 'web', claimedAt: at(H) });
        expect(slaStats([mk(2 * H), mk(4 * H)], now).medianClaimMs).toBe(3 * H);
        expect(slaStats([], now)).toEqual({ claimed30: 0, overdue: 0, medianClaimMs: null });
    });
    it('时长文案', () => {
        expect(fmtDuration(null)).toBe('—');
        expect(fmtDuration(20 * 1000)).toBe('不到 1 分钟');
        expect(fmtDuration(45 * 60000)).toBe('45 分钟');
        expect(fmtDuration(4 * H + 5 * 60000)).toBe('4 小时 5 分钟');
    });
});
