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

/**
 * 同一本书的另一个版本（如光盘本）的章 md → 参与比对的字序列。
 * 与维基文庫那份不同：章文件与底本一一对应（同一个文件 stem），第一行 `## 章标题` 是章名、不是正文，去掉；
 * 其余照常去掉标点与空白（这类版本多数没有标点，保持原分行）。
 * 双行小注的标记 `<…|…>`（`<` `>` 起止，`|` 换列）不是字，去掉（它们属符号类 Sm，不在 STRIP 里）。
 */
const NOTE_MARK = /[<>|]/g;

export function chapterChars(md: string): string[] {
    const lines = md.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length && /^#{1,2}\s/.test(lines[0])) lines.shift();
    return Array.from(lines.map((s) => s.replace(/^#+\s*/, '')).join('').replace(NOTE_MARK, '').replace(STRIP, ''));
}
