/**
 * G-23 第二批 §一·10：pageUrl 只对本站域名渲染成链接。
 * “本站”＝当前查看页面所在的域名（不硬编码域名表——公开列表与后台都在同一个 Next.js
 * 应用里跑，谁在看就以谁的 window.location 为准），任意外部网址一律按纯文本展示。
 */
export function isSameSiteUrl(url: string | undefined | null, currentHref: string): boolean {
    if (!url) return false;
    try {
        const target = new URL(url, currentHref);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
        const current = new URL(currentHref);
        return target.hostname === current.hostname;
    } catch {
        return false;
    }
}
