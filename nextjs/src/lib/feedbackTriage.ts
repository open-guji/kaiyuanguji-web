// 反馈分流（#605 A 块）：分类／认领块的选项与「超时未认领」判定。
// 取值与 edge-functions/api/feedback-classify.js 的 CATEGORIES／ASSIGNEES 一致
// （feedback-triage-ui.test.ts 对表）。

export const CATEGORY_OPTIONS: { value: string; label: string }[] = [
    { value: 'typo', label: '错字' },
    { value: 'entry', label: '目录条目' },
    { value: 'site', label: '网站' },
    { value: 'join', label: '想加入' },
    { value: 'other', label: '其他' },
];
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTIONS.map((o) => [o.value, o.label]));

/** assignee 是「块」不是人 */
export const ASSIGNEE_OPTIONS: { value: string; label: string }[] = [
    { value: 'catalog', label: '目录' },
    { value: 'web', label: '网站' },
    { value: 'text', label: '文本' },
    { value: 'cv', label: 'CV' },
    { value: 'collate', label: '整理' },
    { value: 'layout', label: '排版' },
    { value: 'owner', label: '站长' },
];
export const ASSIGNEE_LABEL: Record<string, string> = Object.fromEntries(ASSIGNEE_OPTIONS.map((o) => [o.value, o.label]));

/** 旧记录没有 category：按 type 推（与后端 legacyCategory 同口径，不回写） */
export function categoryOf(rec: { category?: string; type: string }): string {
    if (rec.category) return rec.category;
    if (rec.type === 'bug') return 'site';
    if (rec.type === 'resource') return 'entry';
    if (rec.type === 'contact') return 'join';
    return 'other';
}

export const CLAIM_SLA_MS = 24 * 3600 * 1000;
const SLA_CATEGORIES = ['typo', 'entry', 'site'];
const OPEN_STATUSES = ['pending', 'in_progress'];

/** 24h 内无人认领的错字／条目／网站类反馈（join、other 不计；已处置的不计；测试数据不计） */
export function isClaimOverdue(
    rec: { category?: string; type: string; status: string; assignee?: string; createdAt: string; test?: boolean },
    now: number = Date.now(),
): boolean {
    if (rec.assignee || rec.test) return false;
    if (!SLA_CATEGORIES.includes(categoryOf(rec))) return false;
    if (!OPEN_STATUSES.includes(rec.status)) return false;
    const t = new Date(rec.createdAt).getTime();
    return Number.isFinite(t) && now - t > CLAIM_SLA_MS;
}

const DAY_MS = 24 * 3600 * 1000;

export interface SlaStats {
    /** 近 30 天内被认领的条数（按 claimedAt） */
    claimed30: number;
    /** 当前超 24h 未认领 */
    overdue: number;
    /** 近 30 天认领耗时（claimedAt − createdAt）的中位数，毫秒；没有样本为 null */
    medianClaimMs: number | null;
}

export function slaStats(
    items: { category?: string; type: string; status: string; assignee?: string; createdAt: string; claimedAt?: string; test?: boolean }[],
    now: number = Date.now(),
): SlaStats {
    const real = items.filter((i) => !i.test);
    const waits: number[] = [];
    for (const i of real) {
        if (!i.assignee || !i.claimedAt) continue;
        const c = new Date(i.claimedAt).getTime();
        const s = new Date(i.createdAt).getTime();
        if (!Number.isFinite(c) || !Number.isFinite(s) || now - c > 30 * DAY_MS) continue;
        waits.push(Math.max(0, c - s));
    }
    waits.sort((a, b) => a - b);
    const n = waits.length;
    const medianClaimMs = n === 0 ? null : n % 2 ? waits[(n - 1) / 2] : (waits[n / 2 - 1] + waits[n / 2]) / 2;
    return { claimed30: n, overdue: real.filter((i) => isClaimOverdue(i, now)).length, medianClaimMs };
}

/** 毫秒 → 「x 小时 y 分钟」；不足 1 分钟写「不到 1 分钟」；null 写「—」 */
export function fmtDuration(ms: number | null): string {
    if (ms === null) return '—';
    const m = Math.round(ms / 60000);
    if (m < 1) return '不到 1 分钟';
    const h = Math.floor(m / 60);
    return h ? `${h} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}
