/**
 * 对照本（维基文庫整理出的 md，每卷一个文件）→ 参与比对的字序列。
 * 去掉：卷标题行（`## 卷001`）、整理状态行（「有标点。」「已修正。」「好」…）、`#` 标记、全部标点与空白；
 * 其余（含各篇标题文字）保留，因为底本的标题也是字层里的字。
 */

const STATUS_LINE = /^(有标点|无标点|已修正|好$|簡繁|简繁)/;
const VOLUME_LINE = /^#+\s*卷[\d〇零一二三四五六七八九十百]+\s*$/;
/** 标点、空白、分隔符：\p{P} 覆盖「，。、；：？！《》「」『』“”‘’（）·」等全部常见中西标点；注意 □ 属于 So（符号），不在内，要保留 */
const STRIP = /[\p{P}\p{Z}\s]/gu;

export function wikiChars(md: string): string[] {
    const lines = md
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !VOLUME_LINE.test(s) && !STATUS_LINE.test(s))
        .map((s) => s.replace(/^#+\s*/, ''));
    return Array.from(lines.join('').replace(STRIP, ''));
}
