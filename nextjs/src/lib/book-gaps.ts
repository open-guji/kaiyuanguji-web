/**
 * 缺页（guji-gaps/0.1）在网站里的两处用法：书介绍页列出各册缺页、下载本册时把注记行带上。
 * 数据来源：章条目的 `gaps_file`（与 cord_file 同目录，如 009.gaps.json）；阅读页的显示在 book-index-ui 里。
 * 取不到、形状不对一律当没有缺页，不影响别的功能。
 */
import { adaptGaps, type ReaderGap } from 'book-index-ui';

export type { ReaderGap };

/** 章条目里声明了缺页文件的，返回文件名；只认一段安全文件名 */
export function gapsFileOf(chapter: unknown): string | null {
    const v = (chapter as { gaps_file?: unknown } | null | undefined)?.gaps_file;
    return typeof v === 'string' && /^[\w.-]+$/.test(v) ? v : null;
}

export interface ChapterGaps {
    /** 章文件名（去扩展名，如 009），读法同阅读页地址里的章号 */
    chapter: string;
    title?: string;
    gaps: ReaderGap[];
}

type TextStorage = {
    getTextManifest?(id: string): Promise<{ versions?: { key: string }[] } | null>;
    getTextIndex?(id: string, key: string): Promise<{ chapters?: Record<string, unknown>[] } | null>;
    getTextFile?(id: string, key: string, file: string): Promise<unknown>;
};

/** 一本书（主版本）里各章的缺页；没有、取不到都返回空数组 */
export async function collectBookGaps(storage: TextStorage, id: string): Promise<ChapterGaps[]> {
    try {
        const manifest = await storage.getTextManifest?.(id);
        const key = manifest?.versions?.[0]?.key;
        if (!key) return [];
        const index = await storage.getTextIndex?.(id, key);
        const withGaps = (index?.chapters ?? []).filter(c => gapsFileOf(c));
        const rows = await Promise.all(withGaps.map(async (c): Promise<ChapterGaps | null> => {
            const raw = await storage.getTextFile?.(id, key, gapsFileOf(c)!).catch(() => null);
            const gaps = adaptGaps(raw);
            const file = typeof c.file === 'string' ? c.file.replace(/\.[^.]+$/, '') : '';
            return gaps.length && file ? { chapter: file, title: typeof c.title === 'string' ? c.title : undefined, gaps } : null;
        }));
        return rows.filter((r): r is ChapterGaps => !!r);
    } catch {
        return [];
    }
}

/**
 * 把缺页注记插进下载生成的 guji-markdown：阅读页同一规则，注记行在 after_page 那页之后、下一页标记 `<!-- pN -->` 之前
 * （没有下一页就放末尾；after_page 为 0 的放在第一个页标记之前）。lines.md／char.json 本身不动，只改下载出来的文字。
 */
export function insertGapNotes(text: string, gaps: readonly ReaderGap[]): string {
    if (!gaps.length) return text;
    const marker = /^<!-- p(\d+) -->$/gm;
    const marks: { page: number; index: number }[] = [];
    for (let m = marker.exec(text); m; m = marker.exec(text)) marks.push({ page: Number(m[1]), index: m.index });
    const at = (g: ReaderGap) => {
        const next = marks.find(k => k.page > g.afterPage);
        return next ? next.index : text.length;
    };
    const inserts = gaps.map(g => ({ pos: at(g), note: g.note })).sort((a, b) => a.pos - b.pos);
    let out = '';
    let last = 0;
    for (const ins of inserts) {
        out += text.slice(last, ins.pos);
        if (out && !out.endsWith('\n')) out += '\n';
        out += `${ins.note}\n\n`;
        last = ins.pos;
    }
    return out + text.slice(last);
}
