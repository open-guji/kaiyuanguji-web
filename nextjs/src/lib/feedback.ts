/**
 * 反馈（N7，overview#260）：提交体的拼装与提交。纯函数，弹窗、测试共用。
 *
 * 后端 edge-functions/api/feedback.js 不改，只收 type／content／contact／pageUrl／resourceId。
 * 页面上下文按用户定的方案塞进这几个现成字段：
 *   - 条目 id → resourceId（只认合法条目 id，其余给空）；
 *   - 章号 → pageUrl（阅读页地址本来就带章号 /read/<id>/<章>，提交时取当前地址即可）；
 *   - 选中的文字 → 拼在正文开头，形如「【原文】……」，与读者写的话空一行隔开。
 */
import { parseItemId, type ItemType } from './item-id';
import { getSiteT, type SiteMessageKey, type SiteT } from '@/i18n/translate';

/** 不传 t 时用简体（与服务端首帧、单测一致）；组件里传 useSiteT() 的结果，跟随繁简偏好 */
const HANS_T: SiteT = getSiteT('zh-Hans');

export type FeedbackKind = 'bug' | 'resource' | 'suggestion' | 'contact';

export interface FeedbackTypeOption {
    value: FeedbackKind;
    /** 字典键（i18n/messages/feedback.ts）；组件里用 t(labelKey) 显示，跟随繁简偏好 */
    labelKey: SiteMessageKey;
    placeholderKey: SiteMessageKey;
    /** 简体文案（= t(labelKey) 的简体），给不走 t 的地方与测试用 */
    label: string;
    placeholder: string;
}

/** 类型页签的顺序。contact（想参与）后端永远不公开；文案在字典 feedback.types／feedback.placeholders */
export const FEEDBACK_TYPES: FeedbackTypeOption[] = (['bug', 'resource', 'suggestion', 'contact'] as const).map((value) => {
    const labelKey = `feedback.types.${value}` as const;
    const placeholderKey = `feedback.placeholders.${value}` as const;
    return { value, labelKey, placeholderKey, label: HANS_T(labelKey), placeholder: HANS_T(placeholderKey) };
});

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

const TYPE_LABEL_KEY: Record<ItemType, SiteMessageKey> = {
    work: 'feedback.itemType.work',
    book: 'feedback.itemType.book',
    collection: 'feedback.itemType.collection',
    entity: 'feedback.itemType.entity',
};

/** 条目 id 合法才返回，否则空串。旧浮钮用 11 位正则认 id，现行 id 是 12 位，所以一直是空的 */
export function normalizeResourceId(id: string | null | undefined): string {
    return id && parseItemId(id) ? id : '';
}

/** 「史记 · 作品 · d59f20aowb9c」；没有书名时只写类型与 id。书名是数据，繁简由调用方转好再传 */
export function itemLabel(id: string, title?: string | null, t: SiteT = HANS_T): string {
    const type = parseItemId(id)?.type;
    return [title?.trim(), type ? t(TYPE_LABEL_KEY[type]) : null, id].filter(Boolean).join(' · ');
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

/** 出错时抛的 Error.message 给读者看：网络错与兜底文案走字典（t），后端给的 error 原样 */
export async function submitFeedback(body: FeedbackBody, fetchImpl: typeof fetch = fetch, t: SiteT = HANS_T): Promise<void> {
    let res: Response;
    try {
        res = await fetchImpl(FEEDBACK_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        throw new Error(t('feedback.networkError'));
    }
    if (!res.ok) {
        const err = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(err?.error || t('feedback.submitFailed'));
    }
}

/**
 * 阅读页的「关于」一行：「直斋书录解题 · 整理本 · 卷4」「诗序 · 維基文庫 · 第 12 章」。
 * version 是版本名（整理本／維基文庫…，来自 manifest）；kind 是版本类别（整理本按「卷」，其余按「章」）；
 * chapter 是三位章号（004）或章名里带的数字。
 */
export function readerFeedbackLabel(
    bookTitle: string,
    loc: { version?: string; kind?: string; chapter?: string },
    t: SiteT = HANS_T,
): string {
    const n = loc.chapter?.match(/(\d+)$/)?.[1];
    const part = n ? t(loc.kind === 'collated' ? 'feedback.readerJuan' : 'feedback.readerChapter', { n: Number(n) }) : null;
    return [bookTitle.trim(), loc.version?.trim(), part].filter(Boolean).join(' · ');
}
