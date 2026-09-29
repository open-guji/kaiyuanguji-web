/**
 * public/content/*.md 渲染出的说明页（/read/md/<名>）。
 *
 * 阅读页搬到一级目录 /read/<id> 之后，这些页原来的 /read/<名>（和 /read/<名>.md）与它同一层，
 * 挪到 /read/md/<名>（overview#267）。旧地址由阅读页路由和中间件 308 过来。
 * 名单写死在这里而不在运行时读 public/content：阅读页是函数渲染，运行时没有这个目录；
 * 单测（__tests__/markdown-pages.test.ts）核对它与目录里的 .md 文件一致，漏了会红。
 * 纯函数，不依赖 React／Next，中间件（边缘运行时）也用。
 */
export const MARKDOWN_PAGE_NAMES = [
    'assistant',
    'extraction',
    'intelligence',
    'roadmap_overview',
    'storage',
    'toolkit',
    'typesetting',
] as const;

/** 说明页新地址 */
export function markdownPagePath(name: string): string {
    return `/read/md/${name}`;
}

/** 旧地址 /read/<名>（可带 .md）里的名字，是说明页就返回，否则 null（交给阅读页当条目 id 处理） */
export function legacyMarkdownName(segment: string): string | null {
    let s = segment;
    try {
        s = decodeURIComponent(segment);
    } catch {
        return null;
    }
    const name = s.replace(/\.md$/, '');
    return (MARKDOWN_PAGE_NAMES as readonly string[]).includes(name) ? name : null;
}
