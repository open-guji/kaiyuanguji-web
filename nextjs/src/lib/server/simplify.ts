/**
 * 服务端繁→简转换（overview#280 S4）：条目页的 meta description／og:description 出简体，
 * 大陆读者用简体搜索，搜索引擎对简繁的匹配不完全。数据不动，只在渲染时转。
 *
 * 用 opencc-js 的 t2cn，转换口径与 book-index-ui 的 LocaleProvider 一致（Converter({ from: 't', to: 'cn' })），
 * 这样页面上看到的简体和 meta 里的简体是同一套字表。词典进程内只建一次。
 * 不用 tw 预设：它带台湾用词表，把「著録」「所著」「編著」里的「著」转成「着」（overview#368）。
 * 转换出任何错都退回原文——meta 里多一段繁体不算事故，页面渲染不出来才是。
 *
 * t2cn 之前先做异体字归一（overview#350）：「㫖」「縂」「寳」这类异体字 t2cn 不认，会原样留在简体里。
 * 归一表与组件库 LocaleProvider 用的是同一份（book-index-ui/variant-chars.json），不另存副本。
 */
import type { Metadata } from 'next';
import { Converter } from 'opencc-js/t2cn';
import VARIANT_CHARS from 'book-index-ui/variant-chars.json';
import { createToSimplified, normalizeVariants as normalizeVariantsWith } from '../to-simplified-core.mjs';

const VARIANTS: Readonly<Record<string, string>> = VARIANT_CHARS;

/** 异体字 → 正字（按码位，含扩展区字）；没有异体字时原样返回 */
export function normalizeVariants(text: string): string {
    return normalizeVariantsWith(text, VARIANTS);
}

/**
 * 繁体（或简繁混排）→ 简体；转不了就原样返回。全站唯一入口（overview#448 S0）：
 * 逻辑在 lib/to-simplified-core.mjs（含转换前后等长的保证），这里只注入 opencc-js 与异体字表。
 */
export const toSimplified: (text: string) => string = createToSimplified({
    createConverter: () => Converter({ from: 't', to: 'cn' }),
    variants: VARIANTS,
    warn: (msg) => console.warn(msg),
});

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
