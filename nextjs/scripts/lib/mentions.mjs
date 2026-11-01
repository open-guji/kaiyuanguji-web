/**
 * mentions.mjs — 专名出处反查（A12 设计稿「专名出处反查：设计与规范」）：某个实体（人物、地名、官名……，以及 Work）
 * 在哪些古籍的哪一处被专名号标出。正向数据只在 book-text 的 `NNN.entity.json`（A33），这里在打包时派生，不写回源数据。
 *
 * 两趟，内存与总量无关：
 *   1. 收集：reader-files 逐章已经解析了 entity.json 与 char.json，借它的结果（onChapter 钩子），每条 matched span
 *      算出上下文与所属章内标题，按实体 id 哈希追加到磁盘上的分桶临时文件（内存里只有当前一章）。
 *   2. 汇总：逐桶读入、按实体分组排序、分页写出（只写有变的，删不再产出的）。
 *      第 1 页 `mentions/<entity_id>.json`，第 n 页（n≥2）`mentions/<entity_id>/<n>.json`：多数实体只有一页，省掉逐个建目录。
 *
 * 产物（schema mentions/v1）：第 1 页带 total／pages／books，实体页只取这一个文件；404 就是没有出处。
 *   items[]：{item, key, chapter, start, end, text, heading?, before, after, v}；start／end 是格位（页:列:格[ab]），
 *   阅读页地址 `/read/<item>[/<key>]/<chapter>#<start>~<end>`。
 * 收：target.status=matched 且有 entity_id；decomposition.parts[] 里有 entity_id 的片段各算一次。不收 ambiguous／new_candidate。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MENTIONS_DIRNAME = 'mentions';
export const MENTIONS_SCHEMA = 'mentions/v1';
export const PAGE_SIZE = 50;
export const CONTEXT_CHARS = 12;
const BUCKETS = 256;
const SAFE_ID = /^[\w-]+$/;

function bucketOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % BUCKETS;
}

/** char.json → { chars: [字…], anchors: [格位…], pos: Map<格位, 下标> }（按 pages→columns→cells 的顺序，即阅读顺序） */
export function charSequence(char) {
    const chars = [];
    const anchors = [];
    const pos = new Map();
    for (const p of Array.isArray(char?.pages) ? char.pages : []) {
        for (const col of Array.isArray(p?.columns) ? p.columns : []) {
            for (const cell of Array.isArray(col?.cells) ? col.cells : []) {
                if (typeof cell?.a !== 'string') continue;
                pos.set(cell.a, chars.length);
                anchors.push(cell.a);
                chars.push(typeof cell.c === 'string' ? cell.c : '');
            }
        }
    }
    return { chars, anchors, pos };
}

/** 一章的 matched span → 记录（不含实体 id 之外的归一）。纯函数，单测直接用。 */
export function chapterMentions({ item, key, chapter, entity, char, headings }) {
    const { chars, anchors, pos } = charSequence(char);
    const heads = (Array.isArray(headings) ? headings : [])
        .map((h) => [pos.get(h?.anchor), h?.label])
        .filter(([i, l]) => typeof i === 'number' && typeof l === 'string' && l)
        .sort((a, b) => a[0] - b[0]);
    const v = typeof entity?.version === 'string' ? entity.version : undefined;
    const out = [];
    const emit = (eid, start, end, text) => {
        if (typeof eid !== 'string' || !SAFE_ID.test(eid) || typeof start !== 'string' || typeof end !== 'string') return;
        const i = pos.get(start);
        const j = pos.get(end);
        const rec = { item, key, chapter, start, end, text: typeof text === 'string' ? text : '' };
        let heading;
        if (typeof i === 'number') for (const [hi, label] of heads) { if (hi <= i) heading = label; else break; }
        if (heading) rec.heading = heading;
        rec.before = typeof i === 'number' ? chars.slice(Math.max(0, i - CONTEXT_CHARS), i).join('') : '';
        rec.after = typeof j === 'number' ? chars.slice(j + 1, j + 1 + CONTEXT_CHARS).join('') : '';
        if (v) rec.v = v;
        out.push({ eid, ord: typeof i === 'number' ? i : -1, rec });
    };
    for (const e of Array.isArray(entity?.entities) ? entity.entities : []) {
        if (!e || typeof e !== 'object' || !e.anchor) continue;
        const t = e.target;
        if (t?.status === 'matched' && t.entity_id) emit(t.entity_id, e.anchor.start, e.anchor.end, e.text);
        // 拆分的复合地名／官名：各片段单独挂，格位按片段在 span 内的字序推
        const parts = Array.isArray(e.decomposition?.parts) ? e.decomposition.parts : [];
        if (parts.length === 0) continue;
        const s = pos.get(e.anchor.start);
        if (typeof s !== 'number') continue;
        for (const p of parts) {
            const pt = p?.target;
            if (!pt?.entity_id || !Array.isArray(p.offset)) continue;
            const a = anchors[s + p.offset[0]];
            const b = anchors[s + p.offset[1] - 1];
            if (a && b) emit(pt.entity_id, a, b, p.text);
        }
    }
    return out;
}

/**
 * 收集器。add(...) 每章调一次（reader-files 的 onChapter）；finalize(...) 汇总写出。
 * spoolDir 每次打包前清空；不进产物。
 */
export function createMentionCollector({ spoolDir }) {
    rmSync(spoolDir, { recursive: true, force: true });
    mkdirSync(spoolDir, { recursive: true });
    const stats = { chapters: 0, mentions: 0 };
    let ordSeq = 0; // 跨章的全局顺序：打包按条目→版本→章的顺序走，汇总时据此稳定排序
    return {
        stats,
        add(args) {
            const list = chapterMentions(args);
            stats.chapters++;
            if (list.length === 0) return;
            const byBucket = new Map();
            const base = ordSeq;
            ordSeq += 1;
            for (const { eid, ord, rec } of list) {
                const b = bucketOf(eid);
                const line = `${JSON.stringify([eid, base, ord, rec])}\n`;
                byBucket.set(b, (byBucket.get(b) ?? '') + line);
            }
            for (const [b, text] of byBucket) appendFileSync(join(spoolDir, `${b}.jsonl`), text);
            stats.mentions += list.length;
        },
        /**
         * outDir：产物根（写 outDir/mentions/）。resolveId(id) → 现行 id 或 null（沿 promotions／merged_into）。
         * titleOf(itemId) → 书名（可缺）。→ report
         */
        finalize({ outDir, resolveId = (id) => id, titleOf = () => undefined }) {
            const root = join(outDir, MENTIONS_DIRNAME);
            mkdirSync(root, { recursive: true });
            const produced = new Set();
            const report = { schema: MENTIONS_SCHEMA, chapters: stats.chapters, mentions: stats.mentions, entities: 0, pages: 0, written: 0, unresolved: 0, unresolved_ids: [], removed: 0 };
            let counted = 0;
            for (const f of readdirSync(spoolDir).sort()) {
                const groups = new Map();
                for (const line of readFileSync(join(spoolDir, f), 'utf-8').split('\n')) {
                    if (!line) continue;
                    const [raw, base, ord, rec] = JSON.parse(line);
                    const eid = resolveId(raw);
                    if (!eid) {
                        report.unresolved++;
                        if (report.unresolved_ids.length < 50 && !report.unresolved_ids.includes(raw)) report.unresolved_ids.push(raw);
                        continue;
                    }
                    let g = groups.get(eid);
                    if (!g) groups.set(eid, (g = []));
                    g.push([base, ord, rec]);
                }
                for (const [eid, rows] of groups) {
                    rows.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
                    const items = rows.map((r) => r[2]);
                    const books = new Map();
                    for (const it of items) books.set(it.item, (books.get(it.item) ?? 0) + 1);
                    const pages = Math.ceil(items.length / PAGE_SIZE);
                    if (pages > 1) mkdirSync(join(root, eid), { recursive: true });
                    for (let k = 0; k < pages; k++) {
                        const body = { schema: MENTIONS_SCHEMA, entity_id: eid, page: k + 1, pages, total: items.length };
                        if (k === 0) body.books = [...books].map(([item, count]) => ({ item, ...(titleOf(item) ? { title: titleOf(item) } : {}), count }));
                        body.items = items.slice(k * PAGE_SIZE, (k + 1) * PAGE_SIZE);
                        const rel = pagePath(eid, k + 1);
                        if (writeIfChanged(join(root, rel), JSON.stringify(body))) report.written++;
                        produced.add(rel);
                        report.pages++;
                    }
                    counted += items.length;
                    report.entities++;
                }
            }
            // 删不再产出的页（实体不再被提到、或页数变少）
            for (const d of readdirSync(root, { withFileTypes: true })) {
                if (d.isFile()) {
                    if (d.name !== '_report.json' && !produced.has(d.name)) { rmSync(join(root, d.name), { force: true }); report.removed++; }
                    continue;
                }
                if (!d.isDirectory()) continue;
                const dir = join(root, d.name);
                let left = 0;
                for (const f of readdirSync(dir)) {
                    if (produced.has(`${d.name}/${f}`)) { left++; continue; }
                    rmSync(join(dir, f), { force: true });
                    report.removed++;
                }
                if (left === 0) rmSync(dir, { recursive: true, force: true });
            }
            if (counted + report.unresolved !== stats.mentions) throw new Error(`mentions 计数不守恒：分页 ${counted} + 解不开 ${report.unresolved} ≠ 收集 ${stats.mentions}`);
            writeFileSync(join(root, '_report.json'), `${JSON.stringify(report, null, 2)}\n`);
            rmSync(spoolDir, { recursive: true, force: true });
            return report;
        },
    };
}

/**
 * 实体 id → 现行 id：先沿 promotions（草稿→正式），再沿条目的 merged_into（墓碑→现行）；正式库里没有这个条目就回 null。
 * readEntry(id) → 条目对象或 null（打包时读刚写出的 entry/<id>.json）。结果缓存，同一 id 只读一次。
 */
/** 第 1 页 `<id>.json`（多数实体只有这一页，不建目录）；第 n 页（n≥2）`<id>/<n>.json` */
export function pagePath(eid, n) {
    return n === 1 ? `${eid}.json` : `${eid}/${n}.json`;
}

export function makeIdResolver({ promotions = {}, readEntry }) {
    const cache = new Map();
    return (id) => {
        if (cache.has(id)) return cache.get(id);
        let cur = promotions[id]?.production_id ?? id;
        const seen = new Set();
        let out = null;
        while (cur && !seen.has(cur)) {
            seen.add(cur);
            const e = readEntry(cur);
            if (!e) break;
            if (typeof e.merged_into === 'string' && e.merged_into) { cur = e.merged_into; continue; }
            out = cur;
            break;
        }
        cache.set(id, out);
        return out;
    };
}

function writeIfChanged(path, text) {
    if (existsSync(path) && readFileSync(path, 'utf-8') === text) return false;
    writeFileSync(path, text);
    return true;
}
