/**
 * 作品的「文本来源」汇总（用户 10-28：作品下所有版本已有的文本都收进来，自己整理的作默认）。
 *
 * 一部作品（Work）下的文本散在几个条目里：Work 自己的（多是维基文库转录）、各个 Book（版本）下的（本站自校本、别的来源……）。
 * 阅读页的版本选择框只管本条目内的版本，所以打包时给每个有 ≥2 个可读条目的作品算一张表 `read_texts`，
 * 写进 Work 与各 Book 的 entry JSON：网站据此在阅读页列出全部来源、作品页的阅读入口默认指向第一项。
 *
 * 一行 ＝ 一个条目的主版本：{ id, label, edition?, own? }；链接就是 /read/<id>（主版本，地址里不写 key）。
 * 排序：本站自己整理的（own）在前，其余 Work 自己、再 Book（按 id，输出稳定）。
 * 条目内还有别的版本（如 Work 下有维基文庫与 Kanripo）仍由阅读器自己的选择框管，这里不展开。
 *
 * 版本的显示规则与 src/lib/reader-manifest.ts 保持一致（有全文版时不列整理本；有精校自建版时不列粗校自建版），改一处记得改另一处。
 */
import { join, dirname } from 'path';
import { readEntryDoc } from './derived.mjs';
import { newStructureReadable, publicVersions, readManifest } from './text-layout.mjs';

/** 版本名里不能当来源的类别词（同 src/lib/reader-route.ts 的 CATEGORY_WORD） */
const CATEGORY_WORD = /^(整理本|整理|转录全文|轉錄全文|转录|轉錄|全文|文本)$/;

/** 阅读页给读者看的版本（与 readerManifest 同规则） */
export function readerVersions(versions) {
    const hasFullText = versions.some((v) => v.kind === 'transcription');
    const fineOwn = new Set(versions.filter((v) => v.kind === 'self_collated' && v.quality === 'fine').map((v) => v.source_name ?? ''));
    return versions.filter((v) => {
        if (hasFullText && v.kind === 'collated') return false;
        if (v.kind === 'self_collated' && v.quality === 'rough' && fineOwn.has(v.source_name ?? '')) return false;
        return true;
    });
}

/** 主版本：default，没有就第一份 */
export function primaryVersion(versions) {
    return versions.find((v) => v.key === 'default') ?? versions[0] ?? null;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 版本的来源名：label 不是类别词就用 label，否则 source_name */
export function sourceLabel(v) {
    for (const c of [v?.label, v?.source_name]) {
        const s = str(c);
        if (s && !CATEGORY_WORD.test(s)) return s;
    }
    return undefined;
}

/**
 * 纯函数。candidates：可读条目 [{ id, type: 'work'|'book', work_id?, edition?, versions }]（versions 是该条目可读的公开版本，manifest 原样）。
 * 返回 Map<条目 id, 行[]>：Work 与它下面各 Book 共用同一张表；不足两个可读条目的作品不出。
 */
export function buildReadTexts(candidates) {
    const groups = new Map();
    const add = (wid, c) => (groups.get(wid) ?? groups.set(wid, []).get(wid)).push(c);
    for (const c of candidates) {
        if (c.type === 'work') add(c.id, c);
        else if (c.work_id) add(c.work_id, c);
    }
    const out = new Map();
    for (const members of groups.values()) {
        const rows = [];
        for (const m of members) {
            const shown = readerVersions(m.versions);
            const v = primaryVersion(shown);
            if (!v) continue;
            const own = shown.some((x) => x.kind === 'self_collated');
            const row = { id: m.id, label: sourceLabel(v) ?? str(m.edition) ?? m.id };
            if (m.type === 'book' && str(m.edition)) row.edition = str(m.edition);
            if (own) row.own = true;
            rows.push({ row, type: m.type });
        }
        if (rows.length < 2) continue;
        rows.sort((a, b) => (b.row.own ? 1 : 0) - (a.row.own ? 1 : 0)
            || (a.type === b.type ? 0 : a.type === 'work' ? -1 : 1)
            || (a.row.id < b.row.id ? -1 : 1));
        const list = rows.map((r) => r.row);
        for (const m of members) if (list.some((r) => r.id === m.id)) out.set(m.id, list);
    }
    return out;
}

/**
 * 打包用：扫 index 里所有 Work／Book，取有可读文本的，交给 buildReadTexts。
 * @param {{ works?: Record<string, any>, books?: Record<string, any> }} index
 * @param {{ textDirFor: (item: any) => string, rootDirFor: (item: any) => string }} dirs
 */
export function collectReadTexts(index, { textDirFor, rootDirFor }) {
    const candidates = [];
    for (const [type, items] of [['work', index.works], ['book', index.books]]) {
        for (const item of Object.values(items ?? {})) {
            const itemDir = join(textDirFor(item), dirname(item.path), item.id);
            let nt;
            try {
                nt = newStructureReadable(itemDir);
            } catch {
                continue; // 坏 manifest 由打包主流程报错，这里只管跳过
            }
            if (!nt) continue;
            const readableKeys = new Set(nt.versions.map((v) => v.key));
            const versions = publicVersions(readManifest(itemDir)).filter((v) => readableKeys.has(v.key));
            const c = { id: item.id, type, versions };
            if (type === 'book') {
                let d = null;
                try { d = readEntryDoc({ id: item.id, srcPath: join(rootDirFor(item), item.path), stat: 'read' })?.doc ?? null; } catch { /* 读不了就没有 work_id，不进汇总 */ }
                c.work_id = str(d?.work_id) ?? str(d?._work?.id) ?? str(item.work_id);
                c.edition = str(d?.edition) ?? str(item.edition);
            }
            candidates.push(c);
        }
    }
    return buildReadTexts(candidates);
}
