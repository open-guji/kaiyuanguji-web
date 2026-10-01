/**
 * 服务端繁→简转换（overview#280 S4）：条目页的 meta description／og:description 出简体，
 * 大陆读者用简体搜索，搜索引擎对简繁的匹配不完全。数据不动，只在渲染时转。
 *
 * 用 opencc-js 的 t2cn，转换口径与 book-index-ui 的 LocaleProvider 一致（Converter({ from: 'tw', to: 'cn' })），
 * 这样页面上看到的简体和 meta 里的简体是同一套字表。词典进程内只建一次。
 * 转换出任何错都退回原文——meta 里多一段繁体不算事故，页面渲染不出来才是。
 */
import type { Metadata } from 'next';
import { Converter } from 'opencc-js/t2cn';

type Convert = (text: string) => string;
let converter: Convert | null | undefined;

function get(): Convert | null {
    if (converter !== undefined) return converter;
    try {
        converter = Converter({ from: 'tw', to: 'cn' });
    } catch (err) {
        console.warn(`[simplify] 建繁简转换器失败，meta 退回原文：${(err as Error).message}`);
        converter = null;
    }
    return converter;
}

/** 繁体（或简繁混排）→ 简体；转不了就原样返回 */
export function toSimplified(text: string): string {
    if (!text) return text;
    const c = get();
    if (!c) return text;
    try {
        return c(text);
    } catch {
        return text;
    }
}

function simplifyTextFields<T>(o: T): T {
    if (!o || typeof o !== 'object') return o;
    const out = { ...(o as Record<string, unknown>) };
    for (const k of ['title', 'description']) {
        if (typeof out[k] === 'string') out[k] = toSimplified(out[k] as string);
    }
    return out as T;
}

/**
 * 服务端直出的 <title>、meta、og、twitter 一律简体（overview#337）：
 * 繁简偏好存在浏览器 localStorage，服务端拿不到；首帧正文本来就是简体，title 与之一致。
 * 数据（书名、分类名、回目、检索词）在这里统一转；JSON-LD 不经过这里，保持原文（S4）。
 */
export function simplifyMetadata(meta: Metadata): Metadata {
    const out = simplifyTextFields(meta);
    if (out.openGraph) out.openGraph = simplifyTextFields(out.openGraph);
    if (out.twitter) out.twitter = simplifyTextFields(out.twitter);
    return out;
}
