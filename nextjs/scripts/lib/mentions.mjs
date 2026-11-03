/**
 * mentions.mjs — 专名出处反查（A12 设计稿「专名出处反查：设计与规范」）：某个实体（人物、地名、官名……，以及 Work）
 * 在哪些古籍的哪些章被专名号标出。正向数据只在 book-text 的 `NNN.entity.json`（A33），这里在打包时派生，不写回源数据。
 *
 * 两层（为全库规模设计：全库估 2,300 万～4,600 万条专名号，逐条预生成会有 7～13 GB）：
 *   - 这里只出「目录」：每个实体在哪本书、哪一章、各几次，外加至多 EXAMPLES 条带上下文的例子；
 *   - 某一章里的逐处位置不预生成：阅读页本来就要下载该章的 entity 文件，`#e=<id>` 在浏览器里现场标出全部并可逐处跳。
 *   产物量≈（实体×章）对数，与专名号条数基本无关。
 *
 * 两趟，内存与总量无关：
 *   1. 收集：reader-files 逐章已解析了 entity.json 与 char.json，借它的结果（onChapter 钩子）。每章先按实体聚合成
 *      一行（次数＋至多 2 条例子），按实体 id 哈希追加到磁盘分桶临时文件（内存里只有当前一章）。
 *   2. 汇总：先按现行 id（沿升格、墓碑）重新分桶，再逐桶读入、按实体分组、按打包顺序（书→版本→章）排好，写 `mentions/<entity_id>.json`；
 *      章行太多的热门实体（朝代、官名、孔子……）把各书的章目录拆到 `mentions/<entity_id>/<item>.json`。只写有变的，删不再产出的。
 *
 * 产物（schema mentions/v2）：
 *   { schema, entity_id, total, chapters, books: [{ item, title?, count, chapter_count, chapters?: [ChapterRow] }], examples: [Example] }
 *   ChapterRow：{ key, chapter, count, heading?, ids? }——ids 是该章 entity 文件里实际写的 id（与现行 id 不同时才有：草稿、墓碑），
 *     阅读页地址 `/read/<item>[/<key>]/<chapter>#e=<ids 或 entity_id，逗号分隔>`。
 *   Example：{ item, key, chapter, start, end, text, heading?, before, after, v? }，start／end 是格位，地址 `…/<chapter>#<start>~<end>`。
 * 收：target.status=matched 且有 entity_id；matched_multi（合称）的各 targets[].entity_id；decomposition.parts[] 里有 entity_id 的片段各算一次。不收 ambiguous／new_candidate。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MENTIONS_DIRNAME = 'mentions';
export const MENTIONS_SCHEMA = 'mentions/v2';
/** 实体页的例子条数；每章至多先取 1 条，章不够再取第 2 条 */
export const EXAMPLES = 20;
/** 章行总数超过这个就把各书章目录拆成单独文件 */
export const CHAPTER_INLINE = 300;
export const CONTEXT_CHARS = 12;
const BUCKETS = 1024;
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
        // 合称（二程、正嘉）：整段对各条目各算一次
        if (t?.status === 'matched_multi' && Array.isArray(t.targets)) {
            for (const x of new Set(t.targets.map((y) => y?.entity_id).filter(Boolean))) emit(x, e.anchor.start, e.anchor.end, e.text);
        }
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
    const stats = { chapters: 0, mentions: 0, rows: 0 };
    let seq = 0; // 跨章的全局顺序：打包按条目→版本→章的顺序走，汇总时据此排序
    return {
        stats,
        add(args) {
            const list = chapterMentions(args);
            stats.chapters++;
            if (list.length === 0) return;
            const ord = seq++;
            // 本章按实体聚合：次数、首个标题、至多 2 条例子
            const rows = new Map();
            for (const { eid, rec } of list) {
                let r = rows.get(eid);
                if (!r) rows.set(eid, (r = { item: args.item, key: args.key, chapter: args.chapter, count: 0, ex: [] }));
                r.count++;
                if (r.ex.length < 2) r.ex.push(rec);
                if (!r.heading && rec.heading) r.heading = rec.heading;
            }
            const byBucket = new Map();
            for (const [eid, r] of rows) {
                const b = bucketOf(eid);
                byBucket.set(b, (byBucket.get(b) ?? '') + `${JSON.stringify([eid, ord, r])}\n`);
            }
            for (const [b, text] of byBucket) appendFileSync(join(spoolDir, `${b}.jsonl`), text);
            stats.mentions += list.length;
            stats.rows += rows.size;
        },
        /**
         * outDir：产物根（写 outDir/mentions/）。resolveId(id) → 现行 id 或 null（沿 promotions／merged_into）。
         * titleOf(itemId) → 书名（可缺）。→ report
         */
        finalize({ outDir, resolveId = (id) => id, titleOf = () => undefined }) {
            const root = join(outDir, MENTIONS_DIRNAME);
            mkdirSync(root, { recursive: true });
            const produced = new Set();
            const report = {
                schema: MENTIONS_SCHEMA, chapters: stats.chapters, mentions: stats.mentions, rows: stats.rows,
                entities: 0, files: 0, split_entities: 0, written: 0, bytes: 0, max_file_bytes: 0, unresolved: 0, unresolved_ids: [], removed: 0,
            };
            let counted = 0;
            const out = (rel, body) => {
                const text = JSON.stringify(body);
                if (writeIfChanged(join(root, rel), text)) report.written++;
                produced.add(rel);
                report.files++;
                report.bytes += text.length;
                if (text.length > report.max_file_bytes) report.max_file_bytes = text.length;
            };
            // 先按现行 id 重新分桶：草稿／墓碑与现行 id 哈希到不同桶时，不重分就会各写一份、后写的盖掉先写的
            const resolvedDir = join(spoolDir, 'resolved');
            mkdirSync(resolvedDir, { recursive: true });
            for (const f of readdirSync(spoolDir).filter((x) => x.endsWith('.jsonl')).sort()) {
                const byBucket = new Map();
                for (const line of readFileSync(join(spoolDir, f), 'utf-8').split('\n')) {
                    if (!line) continue;
                    const [raw, ord, r] = JSON.parse(line);
                    const eid = resolveId(raw);
                    if (!eid) {
                        report.unresolved += r.count;
                        if (report.unresolved_ids.length < 50 && !report.unresolved_ids.includes(raw)) report.unresolved_ids.push(raw);
                        continue;
                    }
                    const b = bucketOf(eid);
                    byBucket.set(b, (byBucket.get(b) ?? '') + `${JSON.stringify([eid, ord, raw, r])}\n`);
                }
                for (const [b, text] of byBucket) appendFileSync(join(resolvedDir, `${b}.jsonl`), text);
                rmSync(join(spoolDir, f), { force: true });
            }
            for (const f of readdirSync(resolvedDir).sort()) {
                const groups = new Map();
                for (const line of readFileSync(join(resolvedDir, f), 'utf-8').split('\n')) {
                    if (!line) continue;
                    const [eid, ord, raw, r] = JSON.parse(line);
                    let g = groups.get(eid);
                    if (!g) groups.set(eid, (g = []));
                    g.push([ord, raw, r]);
                }
                for (const [eid, rows] of groups) {
                    rows.sort((x, y) => x[0] - y[0]);
                    // 同一章可能经不同原始 id（草稿／墓碑）归到同一实体：合并成一行，记下原始 id 供阅读页匹配
                    const chap = new Map();
                    for (const [, raw, r] of rows) {
                        const k = `${r.item}|${r.key}|${r.chapter}`;
                        let c = chap.get(k);
                        if (!c) chap.set(k, (c = { item: r.item, key: r.key, chapter: r.chapter, count: 0, heading: r.heading, raw: new Set(), ex: [] }));
                        c.count += r.count;
                        c.raw.add(raw);
                        c.ex.push(...r.ex);
                    }
                    const books = new Map();
                    let total = 0;
                    for (const c of chap.values()) {
                        let b = books.get(c.item);
                        if (!b) books.set(c.item, (b = { item: c.item, count: 0, chapters: [] }));
                        const row = { key: c.key, chapter: c.chapter, count: c.count };
                        if (c.heading) row.heading = c.heading;
                        if (c.raw.size > 1 || !c.raw.has(eid)) row.ids = [...c.raw].sort();
                        b.chapters.push(row);
                        b.count += c.count;
                        total += c.count;
                    }
                    // 例子：先每章第 1 条，不够再每章第 2 条
                    const cs = [...chap.values()];
                    const examples = [];
                    for (let k = 0; k < 2 && examples.length < EXAMPLES; k++) {
                        for (const c of cs) { if (c.ex[k]) examples.push(c.ex[k]); if (examples.length >= EXAMPLES) break; }
                    }
                    const split = chap.size > CHAPTER_INLINE;
                    if (split) mkdirSync(join(root, eid), { recursive: true });
                    const bookList = [...books.values()].map((b) => {
                        const head = { item: b.item, ...(titleOf(b.item) ? { title: titleOf(b.item) } : {}), count: b.count, chapter_count: b.chapters.length };
                        if (!split) return { ...head, chapters: b.chapters };
                        out(`${eid}/${b.item}.json`, { schema: MENTIONS_SCHEMA, entity_id: eid, item: b.item, chapters: b.chapters });
                        return head;
                    });
                    out(`${eid}.json`, { schema: MENTIONS_SCHEMA, entity_id: eid, total, chapters: chap.size, books: bookList, examples });
                    if (split) report.split_entities++;
                    counted += total;
                    report.entities++;
                }
            }
            // 删不再产出的文件（实体不再被提到、或不再拆分）
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
            if (counted + report.unresolved !== stats.mentions) throw new Error(`mentions 计数不守恒：目录 ${counted} + 解不开 ${report.unresolved} ≠ 收集 ${stats.mentions}`);
            writeFileSync(join(root, '_report.json'), `${JSON.stringify(report, null, 2)}\n`);
            rmSync(spoolDir, { recursive: true, force: true });
            return report;
        },
    };
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
