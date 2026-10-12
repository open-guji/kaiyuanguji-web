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
