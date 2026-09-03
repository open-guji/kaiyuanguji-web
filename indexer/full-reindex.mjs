/**
 * 完整 indexer (Node.js) — 把 book-index-draft + book-index 全量推到 Meili
 *
 * 用法（在上海云上跑）：
 *   DRAFT_DIR=/root/book-index-draft \
 *   PRODUCTION_DIR=/root/book-index \
 *   MEILI_URL=http://127.0.0.1:7700 \
 *   MEILI_KEY=xxx \
 *   node full-reindex.mjs [--dry-run] [--limit 1000] [--only works,books]
 *
 * 设计：
 *   - 流式遍历 {draft,production}/index/{books,works,entities}/{0-f}.json
 *   - 每 1000 doc 推一批；最多 3 个 in-flight task
 *   - has_collated 的 work 同时把所有 collated_edition/text/*.md 推 juans index
 *   - 推完所有数据后再 PATCH settings（避免索引时反复 reindex）
 *
 * 两个数据仓缺一不可（2026-08-25 修）：升格（promote）会把条目搬到
 * production 仓，draft 侧只留 `promoted_to` 墓碑（detail 文件被 stub 化，
 * 只剩标题）。此前本脚本只读 draft，后果是——
 *   · 2.3 万条已升格条目（恰恰是质量最高的那批）在搜索里只剩裸标题，
 *     作者/朝代/描述全空，completeness=0，排序垫底；
 *   · 按作者、按描述内容搜这些书完全搜不到；
 *   · production 侧的真身从未进过索引。
 * 与 nextjs/scripts/bundle-data.mjs 的 loadShardedIndex() 保持同一套语义。
 *
 * 依赖：opencc-js（繁简）、pinyin-pro（拼音）
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import * as crypto from 'node:crypto';
import * as OpenCC from 'opencc-js';
import { pinyin as toPinyin } from 'pinyin-pro';

const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

const DRAFT_DIR = process.env.DRAFT_DIR;
const PRODUCTION_DIR = process.env.PRODUCTION_DIR;
const MEILI_URL = process.env.MEILI_URL || 'http://127.0.0.1:7700';
const MEILI_KEY = process.env.MEILI_KEY;
if (!DRAFT_DIR || !MEILI_KEY) {
    console.error('需要设置 DRAFT_DIR 和 MEILI_KEY 环境变量');
    process.exit(1);
}

// 数据根：draft 在前、production 在后。ID 不冲突（snowflake status 位区分），
// 且已升格的 draft 条目是墓碑、会被 iterAllRoots 跳过，所以顺序遍历即等价于合并。
const ROOTS = [{ dir: DRAFT_DIR, isDraft: true }];
if (PRODUCTION_DIR && existsSync(PRODUCTION_DIR)) {
    ROOTS.push({ dir: PRODUCTION_DIR, isDraft: false });
} else {
    // 不静默降级：缺 production 会让 2 万多条正式条目搜不到，必须显眼
    console.warn('⚠️  PRODUCTION_DIR 未设置或不存在 —— 所有已升格条目将不会进入索引！');
    console.warn('    正确用法：PRODUCTION_DIR=/root/book-index node full-reindex.mjs');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1]) : null;
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? args[onlyArg + 1].split(',') : null;

// ─── 工具 ───

const MD_RE = /[#*`\[\]>]+|^---.*?$/gm;

function mergeSimp(text) {
    if (!text) return '';
    const s = t2s(text);
    return s === text ? text : `${text} ${s}`;
}

function allPinyin(text) {
    if (!text) return '';
    const words = toPinyin(text, { toneType: 'none' });           // "shi ji"
    const compact = words.replace(/\s+/g, '');                     // "shiji"
    const initials = toPinyin(text, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '');  // "sj"
    return `${words} ${compact} ${initials}`;
}

function titlesToStrings(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(t => {
        if (typeof t === 'string' && t) return [t];
        if (t && typeof t === 'object' && t.book_title) return [t.book_title];
        return [];
    });
}

// ─── doc builders ───

function buildWorkDoc(entry, detail, isDraft = true) {
    const desc = detail.description ?? {};
    const descText = typeof desc === 'string' ? desc : (desc.text || '');
    const indexedBy = Array.isArray(detail.indexed_by) ? detail.indexed_by : [];
    const summaries = indexedBy
        .filter(ib => ib && typeof ib === 'object' && ib.summary)
        .map(ib => ib.summary)
        .join('\n\n');
    const title = entry.title || '';
    const author = entry.author || '';
    const aliases = [
        ...titlesToStrings(detail.additional_titles),
        ...titlesToStrings(detail.attached_texts),
    ];

    let completeness = 0;
    if (entry.has_collated) completeness += 5;
    if (entry.has_text) completeness += 3;
    if (entry.has_image) completeness += 2;
    if (entry.subtype === 'book' || entry.subtype === 'classic') completeness += 2;
    completeness += Math.min((detail.books || []).length, 10);

    return {
        id: entry.id,
        type: 'work',
        is_draft: isDraft,
        title,
        author,
        dynasty: entry.dynasty || '',
        role: entry.role || '',
        subtype: entry.subtype || '',
        has_collated: !!entry.has_collated,
        has_text: !!entry.has_text,
        has_image: !!entry.has_image,
        juan_count: entry.juan_count || 0,
        completeness,
        title_chars: Array.from(title).length,
        title_search: mergeSimp(title),
        author_search: mergeSimp(author),
        aliases_search: aliases.map(mergeSimp).join(' '),
        description_search: mergeSimp(descText),
        indexed_by_search: mergeSimp(summaries),
        pinyin: `${allPinyin(title)} ${allPinyin(author)}`,
    };
}

function buildBookDoc(entry, isDraft = true) {
    const title = entry.title || '';
    const author = entry.author || '';
    const edition = entry.edition || '';
    const holder = entry.holder || '';
    return {
        id: entry.id,
        type: 'book',
        is_draft: isDraft,
        title, author, edition, holder,
        dynasty: entry.dynasty || '',
        has_text: !!entry.has_text,
        has_image: !!entry.has_image,
        completeness: (entry.has_text ? 3 : 0) + (entry.has_image ? 2 : 0),
        title_chars: Array.from(title).length,
        title_search: mergeSimp(title),
        author_search: mergeSimp(author),
        edition_search: mergeSimp(edition),
        holder_search: mergeSimp(holder),
        pinyin: `${allPinyin(title)} ${allPinyin(author)}`,
    };
}

function buildCollectionDoc(entry, isDraft = true) {
    const title = entry.title || entry.name || '';
    return {
        id: entry.id,
        type: 'collection',
        is_draft: isDraft,
        title,
        completeness: 5,
        title_chars: Array.from(title).length,
        title_search: mergeSimp(title),
        pinyin: allPinyin(title),
    };
}

function buildEntityDoc(entry, isDraft = true) {
    const name = entry.primary_name || entry.title || '';
    return {
        id: entry.id,
        type: 'entity',
        is_draft: isDraft,
        subtype: entry.subtype || 'people',
        primary_name: name,
        dynasty: entry.dynasty || '',
        birth_year: entry.birth_year ?? null,
        death_year: entry.death_year ?? null,
        cbdb_id: entry.cbdb_id ?? null,
        completeness: entry.cbdb_id ? 1 : 0,
        title_chars: Array.from(name).length,
        name_search: mergeSimp(name),
        pinyin: allPinyin(name),
    };
}

function buildJuanDocs(workEntry, rootDir) {
    const workId = workEntry.id;
    const relPath = workEntry.path || '';
    if (!relPath) return [];
    const workDir = join(rootDir, dirname(relPath), workId, 'collated_edition', 'text');
    if (!existsSync(workDir)) return [];
    const docs = [];
    let mdFiles;
    try { mdFiles = readdirSync(workDir).filter(f => f.endsWith('.md')).sort(); } catch { return []; }
    for (const fname of mdFiles) {
        let text;
        try { text = readFileSync(join(workDir, fname), 'utf-8'); } catch { continue; }
        const clean = text.replace(MD_RE, ' ').replace(/\s+/g, ' ').trim();
        if (!clean) continue;
        const juanName = basename(fname, '.md');
        const juanHash = crypto.createHash('md5').update(juanName, 'utf-8').digest('hex').slice(0, 12);
        docs.push({
            id: `${workId}_${juanHash}`,
            type: 'juan',
            work_id: workId,
            juan_name: juanName,
            snippet: clean.slice(0, 200),
            content_search: mergeSimp(clean.slice(0, 5000)),
        });
    }
    return docs;
}

// ─── HTTP ───

async function meiliRequest(method, path, body) {
    const r = await fetch(`${MEILI_URL}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${MEILI_KEY}`,
            'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`${method} ${path}: ${r.status} ${t}`);
    }
    return r.json();
}

async function waitForTask(taskUid, timeoutMs = 600_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const t = await meiliRequest('GET', `/tasks/${taskUid}`);
        if (['succeeded', 'failed', 'canceled'].includes(t.status)) {
            if (t.status !== 'succeeded') {
                throw new Error(`task ${taskUid} ${t.status}: ${JSON.stringify(t.error || t)}`);
            }
            return t;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`task ${taskUid} timed out`);
}

async function pushBatch(indexUid, docs) {
    // 防御性：过滤掉空 ID（Meili 拒绝接受任何含空 id 的批次）
    const valid = docs.filter(d => d && d.id && typeof d.id === 'string' && /^[A-Za-z0-9_-]+$/.test(d.id));
    if (valid.length < docs.length) {
        console.warn(`  [${indexUid}] dropped ${docs.length - valid.length} doc(s) with invalid id`);
    }
    if (valid.length === 0) return null;
    const r = await meiliRequest('POST', `/indexes/${indexUid}/documents`, valid);
    return r.taskUid;
}

async function resetIndex(indexUid, primaryKey = 'id') {
    try {
        const t = await meiliRequest('DELETE', `/indexes/${indexUid}`);
        await waitForTask(t.taskUid).catch(() => {});
    } catch {}
    const t = await meiliRequest('POST', '/indexes', { uid: indexUid, primaryKey });
    await waitForTask(t.taskUid);
}

async function configureSettings(indexUid, settings) {
    const t = await meiliRequest('PATCH', `/indexes/${indexUid}/settings`, settings);
    await waitForTask(t.taskUid);
}

// ─── 流式遍历 index shards ───

function* iterIndexShards(rootDir, typeDir) {
    const shardDir = join(rootDir, 'index', typeDir);
    if (existsSync(shardDir) && statSync(shardDir).isDirectory()) {
        const files = readdirSync(shardDir).filter(f => f.endsWith('.json')).sort();
        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(shardDir, f), 'utf-8'));
                for (const entry of Object.values(data)) yield entry;
            } catch (e) {
                console.error(`  ERROR reading ${f}: ${e.message}`);
            }
        }
    } else {
        const f = join(rootDir, 'index', `${typeDir}.json`);
        if (existsSync(f)) {
            const data = JSON.parse(readFileSync(f, 'utf-8'));
            for (const entry of Object.values(data)) yield entry;
        }
    }
}

/**
 * 跨 draft + production 遍历，产出 { entry, rootDir, isDraft }。
 * 跳过升格墓碑（draft 侧 `promoted_to`），否则会把「裸标题、无作者」的
 * stub 推进索引，把 production 里的真身挤掉。
 */
function* iterAllRoots(typeDir) {
    let tombstones = 0;
    for (const { dir, isDraft } of ROOTS) {
        for (const entry of iterIndexShards(dir, typeDir)) {
            if (!entry || !entry.id) continue;
            if (entry.promoted_to) { tombstones++; continue; }
            yield { entry, rootDir: dir, isDraft };
        }
    }
    if (tombstones) console.log(`  [${typeDir}] 跳过 ${tombstones} 个升格墓碑`);
}

// ─── settings ───

const SETTINGS = {
    works: {
        searchableAttributes: ['title_search', 'aliases_search', 'author_search', 'pinyin', 'description_search', 'indexed_by_search'],
        filterableAttributes: ['type', 'is_draft', 'dynasty', 'subtype', 'has_collated', 'has_text', 'has_image'],
        sortableAttributes: ['completeness', 'juan_count', 'title_chars'],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'title_chars:asc', 'exactness', 'completeness:desc'],
    },
    books: {
        searchableAttributes: ['title_search', 'edition_search', 'author_search', 'holder_search', 'pinyin'],
        filterableAttributes: ['type', 'is_draft', 'dynasty', 'has_text', 'has_image', 'holder'],
        sortableAttributes: ['completeness', 'title_chars'],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'title_chars:asc', 'exactness', 'completeness:desc'],
    },
    collections: {
        searchableAttributes: ['title_search', 'pinyin'],
        filterableAttributes: ['type', 'is_draft'],
    },
    entities: {
        searchableAttributes: ['name_search', 'pinyin'],
        filterableAttributes: ['type', 'is_draft', 'subtype', 'dynasty'],
        sortableAttributes: ['completeness', 'title_chars'],
    },
    juans: {
        searchableAttributes: ['content_search', 'juan_name'],
        filterableAttributes: ['work_id'],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'exactness'],
    },
};

// ─── push helper ───

// 批量参数可用环境变量压小，给内存紧张的机器留活路。
// 上海云是 2 核 / 2GB / 无 swap，Meili 常驻就占 ~860MB：2026-09-04 用默认值
// 跑全量重建，速率从 600/s 一路掉到 194/s，最后整机失去响应（SSH 连不上、
// /health 返 000），只能等它自己缓过来。批越大 Meili 单次 indexing 的峰值
// 内存越高，是压垮机器的主因。低配机建议 BATCH_SIZE=200 MAX_CONCURRENT=1。
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 3;

async function pushInBatches(indexUid, iterable, { batchSize = BATCH_SIZE, maxConcurrent = MAX_CONCURRENT } = {}) {
    let batch = [];
    let total = 0;
    const pending = [];
    const t0 = Date.now();
    for await (const doc of iterable) {
        if (!doc) continue;
        batch.push(doc);
        if (batch.length >= batchSize) {
            if (!dryRun) {
                pending.push(pushBatch(indexUid, batch).then(waitForTask));
                while (pending.length >= maxConcurrent) {
                    await pending.shift();
                }
            }
            total += batch.length;
            const sec = (Date.now() - t0) / 1000;
            console.log(`  [${indexUid}] ${total} (${(total / sec).toFixed(0)}/s)`);
            batch = [];
        }
    }
    if (batch.length) {
        if (!dryRun) pending.push(pushBatch(indexUid, batch).then(waitForTask));
        total += batch.length;
    }
    await Promise.all(pending);
    console.log(`  [${indexUid}] DONE: ${total} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ─── main ───

async function main() {
    console.log(`DRAFT: ${DRAFT_DIR}`);
    console.log(`MEILI: ${MEILI_URL}`);
    console.log(`MODE:  ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    if (limit) console.log(`LIMIT: ${limit} per index`);
    console.log();

    let indices = ['works', 'juans', 'books', 'collections', 'entities'];
    if (only) indices = indices.filter(i => only.includes(i));
    console.log(`will process: ${indices.join(', ')}`);

    if (!dryRun) {
        for (const idx of indices) {
            console.log(`reset ${idx}...`);
            await resetIndex(idx);
        }
    }

    // works + juans 同 loop
    if (indices.includes('works') || indices.includes('juans')) {
        const doWorks = indices.includes('works');
        const doJuans = indices.includes('juans');
        console.log(`\n=== works + juans ===`);

        async function* combined() {
            let n = 0;
            for (const { entry, rootDir, isDraft } of iterAllRoots('works')) {
                if (limit && n >= limit) break;
                n++;
                const detailPath = join(rootDir, entry.path || '');
                if (!existsSync(detailPath)) continue;
                let detail;
                try { detail = JSON.parse(readFileSync(detailPath, 'utf-8')); } catch { continue; }
                // 双保险：shard 没标 promoted_to、但 detail 已 stub 化的漏网墓碑
                if (detail._promoted_to) continue;
                if (doWorks) yield { kind: 'work', doc: buildWorkDoc(entry, detail, isDraft) };
                if (doJuans && entry.has_collated) {
                    for (const j of buildJuanDocs(entry, rootDir)) {
                        yield { kind: 'juan', doc: j };
                    }
                }
            }
        }

        // 拆两个流推
        let worksBuf = [], juansBuf = [], worksTotal = 0, juansTotal = 0;
        const worksPending = [], juansPending = [];
        const t0 = Date.now();
        for await (const { kind, doc } of combined()) {
            if (kind === 'work') {
                worksBuf.push(doc);
                if (worksBuf.length >= BATCH_SIZE) {
                    if (!dryRun) {
                        worksPending.push(pushBatch('works', worksBuf).then(waitForTask));
                        while (worksPending.length >= 3) await worksPending.shift();
                    }
                    worksTotal += worksBuf.length;
                    worksBuf = [];
                    const sec = (Date.now() - t0) / 1000;
                    console.log(`  works: ${worksTotal} (${(worksTotal/sec).toFixed(0)}/s)`);
                }
            } else if (kind === 'juan') {
                juansBuf.push(doc);
                if (juansBuf.length >= 500) {
                    if (!dryRun) {
                        juansPending.push(pushBatch('juans', juansBuf).then(waitForTask));
                        while (juansPending.length >= 3) await juansPending.shift();
                    }
                    juansTotal += juansBuf.length;
                    juansBuf = [];
                }
            }
        }
        if (worksBuf.length) {
            if (!dryRun) worksPending.push(pushBatch('works', worksBuf).then(waitForTask));
            worksTotal += worksBuf.length;
        }
        if (juansBuf.length) {
            if (!dryRun) juansPending.push(pushBatch('juans', juansBuf).then(waitForTask));
            juansTotal += juansBuf.length;
        }
        await Promise.all([...worksPending, ...juansPending]);
        console.log(`  WORKS: ${worksTotal} | JUANS: ${juansTotal} | ${((Date.now()-t0)/1000).toFixed(1)}s`);

        if (!dryRun) {
            if (doWorks) { console.log('  configuring works...'); await configureSettings('works', SETTINGS.works); }
            if (doJuans) { console.log('  configuring juans...'); await configureSettings('juans', SETTINGS.juans); }
        }
    }

    // books / collections / entities
    for (const [name, builder] of [
        ['books', buildBookDoc],
        ['collections', buildCollectionDoc],
        ['entities', buildEntityDoc],
    ]) {
        if (!indices.includes(name)) continue;
        console.log(`\n=== ${name} ===`);
        function* iter() {
            let n = 0;
            for (const { entry, isDraft } of iterAllRoots(name)) {
                if (limit && n >= limit) break;
                n++;
                yield builder(entry, isDraft);
            }
        }
        await pushInBatches(name, iter(), { batchSize: 2000 });
        if (!dryRun) await configureSettings(name, SETTINGS[name]);
    }

    if (!dryRun) {
        console.log('\n=== final stats ===');
        const s = await meiliRequest('GET', '/stats');
        for (const [idx, info] of Object.entries(s.indexes)) {
            console.log(`  ${idx}: ${info.numberOfDocuments} docs`);
        }
        console.log(`  database: ${(s.databaseSize / 1024 / 1024).toFixed(1)} MB`);
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
