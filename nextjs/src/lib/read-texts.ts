/**
 * 作品的「文本来源」表（打包时算好写进 entry.read_texts，见 scripts/lib/read-texts.mjs）：
 * 作品下各个条目（Work 自己、各 Book）的主版本一行，本站自己整理的在前。
 * 阅读页用它列出全部来源，作品页的阅读入口默认指向第一行。
 */
import { readerPath } from './reader-route';

export interface ReadTextRow {
    id: string;
    /** 来源名：「開源古籍自校本」「維基文庫」…… */
    label: string;
    /** 底本（Book 的版本名），Work 自己的没有 */
    edition?: string;
    /** 本站自己整理的 */
    own?: true;
}

/** 从 entry 里取表；字段缺失或形态不对返回空数组 */
export function readTextsOf(entry: unknown): ReadTextRow[] {
    const raw = (entry as { read_texts?: unknown } | null | undefined)?.read_texts;
    if (!Array.isArray(raw)) return [];
    const rows: ReadTextRow[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const { id, label, edition, own } = r as Record<string, unknown>;
        if (typeof id !== 'string' || !id || typeof label !== 'string') continue;
        rows.push({ id, label, ...(typeof edition === 'string' && edition ? { edition } : {}), ...(own === true ? { own: true as const } : {}) });
    }
    return rows;
}

/** 作品页阅读入口的默认去处：表的第一行（自建本在前）；没有表或第一行就是本条目时返回 null（走原来的本条目阅读页） */
export function defaultReadTarget(entryId: string, rows: ReadTextRow[]): string | null {
    const first = rows[0];
    if (!first || first.id === entryId) return null;
    return readerPath(first.id);
}

/** 一行给读者看的文字：来源 · 底本 */
export function readTextLabel(r: ReadTextRow): string {
    return r.edition && r.edition !== r.label ? `${r.label} · ${r.edition}` : r.label;
}
