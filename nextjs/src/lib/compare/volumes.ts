/**
 * 册↔卷对应。自校本按「册」（001–099），维基文庫按「卷」（卷001…）。
 * 用底本 index.json 里各册 headings 的一级标题（「卷一　經部一」）切出本册内每一卷的字范围，
 * 再按卷序号找对照本里同名的章（title「卷001」）。
 */

export interface BaseCell {
    /** 字 */
    c: string;
    /** 格位 `页:列:序[子列]` */
    a: string;
}

export interface Heading {
    level: number;
    label: string;
    anchor: string;
}

/** 对照本章（wikisource/index.json 的 chapters 一项，只取用得到的字段） */
export interface WikiChapter {
    file: string;
    title: string;
}

const DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 汉字数字（一～九百九十九、〇）→ 数；不认的返回 null */
export function cnNumber(s: string): number | null {
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    if (![...s].every((ch) => ch in DIGIT || ch === '十' || ch === '百')) return null;
    // 〇一二三…逐位写法（一〇二）
    if (![...s].some((ch) => ch === '十' || ch === '百')) {
        let n = 0;
        for (const ch of s) n = n * 10 + DIGIT[ch];
        return n;
    }
    let total = 0;
    let cur = 0;
    for (const ch of s) {
        if (ch === '百') {
            total += (cur || 1) * 100;
            cur = 0;
        } else if (ch === '十') {
            total += (cur || 1) * 10;
            cur = 0;
        } else cur = DIGIT[ch];
    }
    return total + cur;
}

/** 一级标题「卷一　經部一」→ 1；不是「卷＋数」开头的返回 null */
export function volumeNo(label: string): number | null {
    const m = /^卷([\d〇零一二三四五六七八九十百]+)/.exec(label.trim());
    return m ? cnNumber(m[1]) : null;
}

/** 卷序号 → 对照本章文件（title 为「卷001」：数字补零到三位）；没有返回 null */
export function wikiFileOf(no: number, chapters: readonly WikiChapter[]): string | null {
    const want = `卷${String(no).padStart(3, '0')}`;
    return chapters.find((c) => c.title.trim() === want)?.file ?? null;
}

export interface VolumeSeg {
    /** 卷序号；认不出（卷首、序等）为 null */
    no: number | null;
    label: string;
    /** 本册字序列里的 [from, to) */
    from: number;
    to: number;
    /** 本册里这一卷是从中间开始的（上一册的卷延续过来） */
    startsPartial: boolean;
    /** 这一卷可能延续到下一册 */
    endsPartial: boolean;
    /** 「卷端署题区」的右端（不含）：从卷首到第一个二级标题之前，题名、卷次署题落在这里的纯删算 struct */
    headEnd: number;
}

const anchorKey = (a: string): string => a;

/**
 * 切本册：按一级标题分卷。
 * @param prevVolNo 上一册末尾所在的卷（本册第一个一级标题之前的字属于它）；不知道就传 null
 * @param lastContinues 下一册开头是否接着本册最后一卷（下一册第一个一级标题不在册首）
 */
export function splitVolumes(cells: readonly BaseCell[], headings: readonly Heading[], prevVolNo: number | null, lastContinues: boolean): VolumeSeg[] {
    const index = new Map<string, number>();
    cells.forEach((cell, i) => index.set(anchorKey(cell.a), i));
    const at = (anchor: string): number | undefined => index.get(anchorKey(anchor));
    // 一级标题（卷）起点，按字序列排好
    const starts = headings
        .filter((h) => h.level === 1)
        .map((h) => ({ i: at(h.anchor), label: h.label }))
        .filter((s): s is { i: number; label: string } => s.i !== undefined)
        .sort((x, y) => x.i - y.i);
    const level2 = headings
        .filter((h) => h.level >= 2)
        .map((h) => at(h.anchor))
        .filter((i): i is number => i !== undefined)
        .sort((x, y) => x - y);
    const segs: VolumeSeg[] = [];
    const push = (no: number | null, label: string, from: number, to: number, startsPartial: boolean, endsPartial: boolean) => {
        if (to <= from) return;
        const l2 = level2.find((i) => i >= from && i < to);
        segs.push({ no, label, from, to, startsPartial, endsPartial, headEnd: l2 ?? from });
    };
    if (starts.length === 0) {
        push(prevVolNo, '', 0, cells.length, prevVolNo !== null, lastContinues);
        return segs;
    }
    if (starts[0].i > 0) push(prevVolNo, '', 0, starts[0].i, true, false);
    starts.forEach((s, k) => {
        const to = k + 1 < starts.length ? starts[k + 1].i : cells.length;
        push(volumeNo(s.label), s.label, s.i, to, false, k + 1 === starts.length && lastContinues);
    });
    return segs;
}

/** 下一册是否接着本册最后一卷：下一册第一个一级标题不在册首（页 1）就说明册首那段属于上一卷 */
export function nextContinues(nextHeadings: readonly Heading[] | undefined): boolean {
    if (!nextHeadings || nextHeadings.length === 0) return false;
    const first = nextHeadings.find((h) => h.level === 1);
    if (!first) return true;
    const page = Number(first.anchor.split(':')[0]);
    return !(page <= 1);
}
