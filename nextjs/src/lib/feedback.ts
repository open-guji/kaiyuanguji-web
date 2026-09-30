/**
 * 反馈（N7，overview#260）：提交体的拼装与提交。纯函数，弹窗、测试共用。
 *
 * 后端 edge-functions/api/feedback.js 不改，只收 type／content／contact／pageUrl／resourceId。
 * 页面上下文按用户定的方案塞进这几个现成字段：
 *   - 条目 id → resourceId（只认合法条目 id，其余给空）；
 *   - 卷号 → pageUrl（阅读页地址本来就带 &juan=，提交时取当前地址即可）；
 *   - 选中的文字 → 拼在正文开头，形如「【原文】……」，与读者写的话空一行隔开。
 */
import { parseItemId, type ItemType } from './item-id';

export type FeedbackKind = 'bug' | 'resource' | 'suggestion' | 'contact';

export interface FeedbackTypeOption {
    value: FeedbackKind;
    label: string;
    placeholder: string;
}

/** 类型页签的顺序与文案。contact（想参与）后端永远不公开 */
export const FEEDBACK_TYPES: FeedbackTypeOption[] = [
    { value: 'bug', label: '内容有误', placeholder: '哪里不对？写下你看到的，以及应当是什么' },
    { value: 'resource', label: '补充资源', placeholder: '哪里有这部书的影印本、整理本或其他资料？请附上链接或出处' },
    { value: 'suggestion', label: '功能建议', placeholder: '希望网站增加或改进什么？' },
    { value: 'contact', label: '想参与', placeholder: '想参与整理、校对或合作？简单介绍一下自己（这类留言不公开）' },
];

/** 与后端的上限一致：正文 2000、联系方式 200 */
export const CONTENT_MAX = 2000;
export const CONTACT_MAX = 200;
/** 带进正文的选中文字最多这么多字，超出截断加「…」 */
export const QUOTE_MAX = 200;

/** 反馈针对的对象：条目、阅读页某一卷、选中的一段文字 */
export interface FeedbackContext {
    /** 条目 id；不合法的在提交时丢掉 */
    resourceId?: string;
    /** 弹窗里「关于」后面显示的一行，如「史记 · 作品 · d59f20aowb9c」 */
    label?: string;
    /** 选中的原文 */
    quote?: string;
    /** 阅读页当前位置锚点（如 `rd-e-3`）：提交时拼在 pageUrl 的 # 后面 */
    anchor?: string;
}

const TYPE_LABEL: Record<ItemType, string> = { work: '作品', book: '版本', collection: '丛编', entity: '人物' };

/** 条目 id 合法才返回，否则空串。旧浮钮用 11 位正则认 id，现行 id 是 12 位，所以一直是空的 */
export function normalizeResourceId(id: string | null | undefined): string {
    return id && parseItemId(id) ? id : '';
}

/** 「史记 · 作品 · d59f20aowb9c」；没有书名时只写类型与 id */
export function itemLabel(id: string, title?: string | null): string {
    const type = parseItemId(id)?.type;
    return [title?.trim(), type ? TYPE_LABEL[type] : null, id].filter(Boolean).join(' · ');
}

/** 选中文字：压掉换行与连续空白，超长截断 */
export function clampQuote(text: string | null | undefined): string {
    const s = (text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX)}…` : s;
}

function quotePrefix(quote: string | undefined): string {
    const q = clampQuote(quote);
    return q ? `【原文】${q}\n\n` : '';
}

/** 读者正文还能写多少字（选中文字占掉的要扣掉，否则拼起来超过后端上限会被 400） */
export function contentBudget(quote?: string): number {
    return CONTENT_MAX - quotePrefix(quote).length;
}

export interface FeedbackInput {
    type: FeedbackKind;
    text: string;
    contact?: string;
    context?: FeedbackContext | null;
    pageUrl: string;
}

export interface FeedbackBody {
    type: FeedbackKind;
    content: string;
    contact?: string;
    pageUrl: string;
    resourceId: string;
}

/** 锚点只认阅读器条目锚点 `rd-e-N`，其余丢掉；换掉地址里原有的 # 部分 */
function withAnchor(pageUrl: string, anchor: string | undefined): string {
    if (!anchor || !/^rd-e-\d+$/.test(anchor)) return pageUrl;
    return `${pageUrl.split('#')[0]}#${anchor}`;
}

export function buildFeedbackBody({ type, text, contact, context, pageUrl }: FeedbackInput): FeedbackBody {
    const body: FeedbackBody = {
        type,
        content: quotePrefix(context?.quote) + text.trim(),
        pageUrl: withAnchor(pageUrl, context?.anchor),
        resourceId: normalizeResourceId(context?.resourceId),
    };
    const c = contact?.trim().slice(0, CONTACT_MAX);
    if (c) body.contact = c;
    return body;
}

/** 反馈只走同源接口。本地开发时这里是 404，不会像旧组件那样直连正式站（正式站与测试站共用 KV） */
export const FEEDBACK_API = '/api/feedback';

export async function submitFeedback(body: FeedbackBody, fetchImpl: typeof fetch = fetch): Promise<void> {
    let res: Response;
    try {
        res = await fetchImpl(FEEDBACK_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error('网络错误，请稍后重试');
    }
    if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(err?.error || '提交失败，请稍后重试');
    }
}

/** 阅读页的「关于」一行：「直斋书录解题 · 整理本 · 卷4」。卷号取地址里的卷号（011，或旧式 juan/011.json）／章节名里的数字 */
export function readerFeedbackLabel(bookTitle: string, q: { kind: 'collated' | 'fulltext'; juan?: string }): string {
    const n = q.juan?.match(/(\d+)(?:\.json)?$/)?.[1];
    const part = n ? (q.kind === 'collated' ? `卷${Number(n)}` : `第 ${Number(n)} 章`) : null;
    return [bookTitle.trim(), q.kind === 'collated' ? '整理本' : '全文', part].filter(Boolean).join(' · ');
}
