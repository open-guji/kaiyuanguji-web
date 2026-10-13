/**
 * 阅读页 <meta description> 的正文开头（overview#581）：从已取到的首章 markdown 抽前几十～上百字，
 * 去掉标题／强调／链接等标记与校勘括号 \(…\)，折叠空白。纯函数，服务端、测试共用。
 */
export function leadText(md: string | null | undefined, max = 120): string {
    if (!md) return '';
    const plain = md
        .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ') // 标题行（章名已在 title 里）
        .replace(/\\\([^)]*\\\)/g, '') // 校勘括号 \(…\)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[*_`>~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return '';
    const chars = Array.from(plain); // 按码位切，不劈开扩展区汉字
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : plain;
}

/**
 * 阅读页服务端直出的首章正文（overview#581 方案 A 第 3 项）：按段落切，累计到 max 字就在段落边界停，
 * 后面的交给阅读器。保留校勘括号等原文标记（与阅读器呈现一致），只去掉标题行、图片和 HTML 标签。
 * 第一段本身就超长时按码位截断。纯函数，服务端、测试共用。
 */
export function leadParagraphs(md: string | null | undefined, max = 2000): { paragraphs: string[]; truncated: boolean } {
    if (!md) return { paragraphs: [], truncated: false };
    const blocks = md
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<[^>]+>/g, '')
        .split(/\n\s*\n/)
        .map((b) => b.split('\n').filter((l) => !/^\s{0,3}#{1,6}\s/.test(l)).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const paragraphs: string[] = [];
    let used = 0;
    for (let i = 0; i < blocks.length; i++) {
        const len = Array.from(blocks[i]).length;
        if (used + len > max) {
            if (paragraphs.length === 0) paragraphs.push(`${Array.from(blocks[i]).slice(0, max).join('')}…`);
            return { paragraphs, truncated: true };
        }
        paragraphs.push(blocks[i]);
        used += len;
    }
    return { paragraphs, truncated: false };
}
