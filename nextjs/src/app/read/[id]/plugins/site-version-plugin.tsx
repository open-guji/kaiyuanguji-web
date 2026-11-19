import type { ReaderPlugin } from 'book-index-ui';

/**
 * 阅读设置栏底部的小字：当前网站版本（和构建提交），方便确认读者看到的是不是新版。
 * 构建期由 next.config 内联（NEXT_PUBLIC_WEB_VERSION、NEXT_PUBLIC_WEB_COMMIT）。
 */
export function siteVersionLabel(version = process.env.NEXT_PUBLIC_WEB_VERSION, commit = process.env.NEXT_PUBLIC_WEB_COMMIT): string {
    const v = (version || '').trim();
    const c = (commit || '').trim().slice(0, 7);
    if (!v && !c) return '';
    return `网站版本 ${v ? `v${v}` : ''}${c ? `${v ? ' · ' : ''}${c}` : ''}`;
}

export const siteVersionPlugin: ReaderPlugin = {
    id: 'kyg:site-version',
    settings: {
        group: 'more',
        order: 9999,
        render: () => {
            const text = siteVersionLabel();
            return text ? (
                <div data-testid="site-version" style={{ fontSize: 12, color: 'var(--color-ink-2)', paddingTop: 4 }}>{text}</div>
            ) : null;
        },
    },
};
