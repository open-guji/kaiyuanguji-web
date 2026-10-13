/**
 * @jest-environment node
 *
 * #605 A 块步 3：管理页分类／认领选项与「超时未认领」判定。
 */
// @ts-expect-error edge-functions 是纯 JS
import { CATEGORIES, ASSIGNEES } from '../../../../edge-functions/api/feedback-classify.js';
import { ASSIGNEE_OPTIONS, CATEGORY_OPTIONS, categoryOf, isClaimOverdue, CLAIM_SLA_MS } from '../feedbackTriage';

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
