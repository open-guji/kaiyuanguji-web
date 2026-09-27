/**
 * 完整 indexer (Node.js) — 把 book-index-draft + book-index 全量推到 Meili
 *
 * 用法（在上海云上跑；平时经 ./reindex-limited.sh 调用，别直接跑）：
 *   DRAFT_DIR=/root/book-index-draft \
 *   PRODUCTION_DIR=/root/book-index \
 *   TEXT_DIR=/root/book-text \
 *   MEILI_URL=http://127.0.0.1:7700 \
 *   MEILI_KEY=xxx \
 *   node full-reindex.mjs [--dry-run] [--limit 1000] [--only works,books]
 *
 * 设计：
 *   - 流式遍历 {draft,production}/index/{books,works,entities}/{0-f}.json
 *   - 每 1000 doc 推一批；最多 3 个 in-flight task
 *   - has_collated 的 work 同时把整理本正文推 juans index —— 正文在 **book-text**
 *     仓（2026-08-26 拆出），不在元数据仓。此前本脚本仍到元数据仓找
 *     collated_edition/，拆分后那里永远是空的，juans 索引因此为 0（2026-09-06 修）
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
// 文本仓：整理本 / 辑佚 / 全文。与元数据仓同一套 ID 与 Work/c1/c2/c3/ 分片目录，
// 所以由 entry.path 的目录部分 + id 就能定位到 book-text 里的整理本目录。
const TEXT_DIR = process.env.TEXT_DIR;
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
if (!TEXT_DIR || !existsSync(TEXT_DIR)) {
    // 同样不静默：没有 book-text，juans 索引就是空的，整理本正文一个字都搜不到
    console.warn('⚠️  TEXT_DIR 未设置或不存在 —— juans 索引将为空（整理本正文搜不到）！');
    console.warn('    正确用法：TEXT_DIR=/root/book-text node full-reindex.mjs');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1]) : null;
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? args[onlyArg + 1].split(',') : null;

// ─── 工具 ───

const MD_RE = /[#*`\[\]>]+|^---.*?$/gm;

// 简介进 searchableAttributes 的字符上限（A4，2026-09-27）：O1 的
// full-reindex-allfields.mjs 把详情所有字符串叶子拼成 detail_search 全量索引，
// 内存/盘涨幅偏大；这里只取 description 前 N 字，是"精简版"的口径。
const DESC_SEARCH_MAX_CHARS = 1000;

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
        description_search: mergeSimp(descText.slice(0, DESC_SEARCH_MAX_CHARS)),
        indexed_by_search: mergeSimp(summaries),
        pinyin: `${allPinyin(title)} ${allPinyin(author)}`,
    };
}

// detail 可为 null（读不到 / 解析失败时的退路）：此时只用 shard 里已denormalize 的字段，
// description/aliases 留空，不影响其余字段——与 works 一侧「detailPath 不存在就 continue」
// 不同，books 这条不想因为一个 detail 缺失就整条丢弃（shard 里的 title/author 等仍可搜）。
function buildBookDoc(entry, detail, isDraft = true) {
    const desc = detail?.description ?? {};
    const descText = typeof desc === 'string' ? desc : (desc.text || '');
    const aliases = [
        ...titlesToStrings(detail?.additional_titles),
        ...titlesToStrings(detail?.attached_texts),
    ];
    const title = entry.title || '';
    const author = entry.author || '';
    const edition = entry.edition || '';
    const holder = entry.holder || '';
    return {
        id: entry.id,
        type: 'book',
        is_draft: isDraft,
        title, author, edition, holder,
        dynasty: entry.dynasty || '',          // 撰人朝代
        era: entry.era || '',                  // 刊刻朝代（2026-09 投影自 Book.dating，与 dynasty 不是一回事）
        sort_year: entry.sort_year ?? null,
        has_text: !!entry.has_text,
        has_image: !!entry.has_image,
        completeness: (entry.has_text ? 3 : 0) + (entry.has_image ? 2 : 0),
        title_chars: Array.from(title).length,
        title_search: mergeSimp(title),
        author_search: mergeSimp(author),
        aliases_search: aliases.map(mergeSimp).join(' '),
        edition_search: mergeSimp(edition),
        holder_search: mergeSimp(holder),
        description_search: mergeSimp(descText.slice(0, DESC_SEARCH_MAX_CHARS)),
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

function juanDoc(workId, juanName, clean) {
    const juanHash = crypto.createHash('md5').update(juanName, 'utf-8').digest('hex').slice(0, 12);
    return {
        id: `${workId}_${juanHash}`,
        type: 'juan',
        work_id: workId,
        juan_name: juanName,
        snippet: clean.slice(0, 200),
        content_search: mergeSimp(clean.slice(0, 5000)),
    };
}

/**
 * 一部整理本的各卷正文 → juans 文档。
 *
 * 正文在 book-text：`{TEXT_DIR}/Work/c1/c2/c3/{id}/collated_edition/`。
 * 优先读派生的 `text/*.md`；没有 md 时退到卷档 `juan/NNN.json`，拼各节
 * title + content。两种来源都没有就返回空。
 */
function buildJuanDocs(workEntry) {
    if (!TEXT_DIR) return [];
    const workId = workEntry.id;
    const relPath = workEntry.path || '';
    if (!relPath) return [];
    const ceDir = join(TEXT_DIR, dirname(relPath), workId, 'collated_edition');
    if (!existsSync(ceDir)) return [];
    const docs = [];

    const textDir = join(ceDir, 'text');
    let mdFiles = [];
    try { if (existsSync(textDir)) mdFiles = readdirSync(textDir).filter(f => f.endsWith('.md')).sort(); } catch { mdFiles = []; }
    if (mdFiles.length) {
        for (const fname of mdFiles) {
            let text;
            try { text = readFileSync(join(textDir, fname), 'utf-8'); } catch { continue; }
            const clean = text.replace(MD_RE, ' ').replace(/\s+/g, ' ').trim();
            if (!clean) continue;
            docs.push(juanDoc(workId, basename(fname, '.md'), clean));
        }
        return docs;
    }

    const juanDir = join(ceDir, 'juan');
    if (!existsSync(juanDir)) return [];
    let jsonFiles;
    try { jsonFiles = readdirSync(juanDir).filter(f => f.endsWith('.json')).sort(); } catch { return []; }
    for (const fname of jsonFiles) {
        let juan;
        try { juan = JSON.parse(readFileSync(join(juanDir, fname), 'utf-8')); } catch { continue; }
        const secs = Array.isArray(juan?.sections) ? juan.sections : [];
        const clean = secs
            .map(s => [s?.title, s?.content].filter(Boolean).join(' '))
            .join(' ').replace(/\s+/g, ' ').trim();
        if (!clean) continue;
        docs.push(juanDoc(workId, juan?.title || basename(fname, '.json'), clean));
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

async function configureSettings(indexUid, settings) {
    const t = await meiliRequest('PATCH', `/indexes/${indexUid}/settings`, settings);
    await waitForTask(t.taskUid);
}

// ─── swap 式重建（A4，2026-09-27）───
//
// 此前是先 DELETE 整个索引再重建：DELETE 生效到重建完之间，线上这个索引是空的
// ——O1 实测每晚约 8 分钟空窗，其间该类目搜索恒为 0 结果。
// 改法：新数据全部先建到 `<idx>_tmp`（settings 也配在 tmp 上），自检通过后
// 用 Meili 的 /swap-indexes 原子换名，线上流量在换名前后都读得到完整数据、
// 中间没有「索引不存在/为空」的窗口；自检不通过就直接删掉 tmp，`<idx>` 原封不动。

function tmpIndexUid(indexUid) {
    return `${indexUid}_tmp`;
}

async function indexExists(indexUid) {
    try {
        await meiliRequest('GET', `/indexes/${indexUid}`);
        return true;
    } catch {
        return false;
    }
}

/** 保证 indexUid 存在（可以是空的）——只有当它已存在时 /swap-indexes 才能把 tmp 换进去。 */
async function ensureIndexExists(indexUid, primaryKey = 'id') {
    if (await indexExists(indexUid)) return;
    const t = await meiliRequest('POST', '/indexes', { uid: indexUid, primaryKey });
    await waitForTask(t.taskUid);
}

/** 把 tmp 索引清空重建（每轮重建都从空的开始，不残留上一轮失败的半成品）。 */
async function createFreshTmpIndex(indexUid, primaryKey = 'id') {
    const tmp = tmpIndexUid(indexUid);
    if (await indexExists(tmp)) {
        const t = await meiliRequest('DELETE', `/indexes/${tmp}`);
        await waitForTask(t.taskUid).catch(() => {});
    }
    const t = await meiliRequest('POST', '/indexes', { uid: tmp, primaryKey });
    await waitForTask(t.taskUid);
    return tmp;
}

/**
 * 自检通过则原子 swap（tmp → 正式名），线上无空窗；不通过则删 tmp、退出非 0、
 * 保留旧索引不动。selfTestFn 收 tmp 的 indexUid，返回 { ok, failures }。
 */
async function swapOrDiscard(indexUid, selfTestFn) {
    const tmp = tmpIndexUid(indexUid);
    const { ok, failures } = await selfTestFn(tmp);
    if (!ok) {
        console.error(`❌ [${indexUid}] 自检未通过，放弃本次更新：`);
        for (const f of failures) console.error(`   · ${f}`);
        console.error(`   已删除 ${tmp}，线上 ${indexUid} 保持不变（未 swap）`);
        await meiliRequest('DELETE', `/indexes/${tmp}`).catch(() => {});
        return false;
    }
    await ensureIndexExists(indexUid); // 首次跑：正式名还不存在，先占一个空的才有得 swap
    const swapTask = await meiliRequest('POST', '/swap-indexes', [{ indexes: [indexUid, tmp] }]);
    await waitForTask(swapTask.taskUid);
    // swap 后 tmp 名下是旧数据（或首次跑时的空占位），删掉腾地方
    const delTask = await meiliRequest('DELETE', `/indexes/${tmp}`);
    await waitForTask(delTask.taskUid).catch(() => {});
    console.log(`✅ [${indexUid}] 自检通过，已 swap 生效，旧索引已删`);
    return true;
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

// A4（2026-09-27）searchableAttributes 顺序统一改成 书名 > 作者 > 其他名/别名 > （其余）> 简介：
// 简介放最后一位，与「精简版、不抢排面」的口径一致；任务书 §二 明定这个顺序，
// pinyin／indexed_by_search 不在裁定范围内，保持原有相对位置（在别名之后、简介之前）。
const SETTINGS = {
    works: {
        searchableAttributes: ['title_search', 'author_search', 'aliases_search', 'pinyin', 'description_search', 'indexed_by_search'],
        filterableAttributes: ['type', 'is_draft', 'dynasty', 'subtype', 'has_collated', 'has_text', 'has_image'],
        sortableAttributes: ['completeness', 'juan_count', 'title_chars'],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'title_chars:asc', 'exactness', 'completeness:desc'],
    },
    books: {
        searchableAttributes: ['title_search', 'author_search', 'aliases_search', 'edition_search', 'holder_search', 'pinyin', 'description_search'],
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
    console.log(`PROD:  ${PRODUCTION_DIR || '(未设置！)'}`);
    console.log(`TEXT:  ${TEXT_DIR || '(未设置！juans 将为空)'}`);
    console.log(`MEILI: ${MEILI_URL}`);
    console.log(`MODE:  ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
    if (limit) console.log(`LIMIT: ${limit} per index`);
    console.log();

    let indices = ['works', 'juans', 'books', 'collections', 'entities'];
    if (only) indices = indices.filter(i => only.includes(i));
    console.log(`will process: ${indices.join(', ')}`);

    // 建到 tmp、不删正式索引——swapOrDiscard 收尾时才原子换名，全程无空窗。
    if (!dryRun) {
        for (const idx of indices) {
            console.log(`prepare ${tmpIndexUid(idx)}...`);
            await createFreshTmpIndex(idx);
        }
    }

    const swapResults = {};

    // works + juans 同 loop
    if (indices.includes('works') || indices.includes('juans')) {
        const doWorks = indices.includes('works');
        const doJuans = indices.includes('juans');
        const worksIdx = tmpIndexUid('works');
        const juansIdx = tmpIndexUid('juans');
        console.log(`\n=== works + juans（建到 tmp）===`);

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
                    for (const j of buildJuanDocs(entry)) {
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
                        worksPending.push(pushBatch(worksIdx, worksBuf).then(waitForTask));
                        // 此前写死 3：MAX_CONCURRENT=1 在这条主循环里根本没生效，2GB 机上
                        // Meili 同时嚼三批，RSS 冲到 1.1GB、available 掉到 196MB（2026-09-07 实测）
                        while (worksPending.length >= MAX_CONCURRENT) await worksPending.shift();
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
                        juansPending.push(pushBatch(juansIdx, juansBuf).then(waitForTask));
                        while (juansPending.length >= MAX_CONCURRENT) await juansPending.shift();
                    }
                    juansTotal += juansBuf.length;
                    juansBuf = [];
                }
            }
        }
        if (worksBuf.length) {
            if (!dryRun) worksPending.push(pushBatch(worksIdx, worksBuf).then(waitForTask));
            worksTotal += worksBuf.length;
        }
        if (juansBuf.length) {
            if (!dryRun) juansPending.push(pushBatch(juansIdx, juansBuf).then(waitForTask));
            juansTotal += juansBuf.length;
        }
        await Promise.all([...worksPending, ...juansPending]);
        console.log(`  WORKS: ${worksTotal} | JUANS: ${juansTotal} | ${((Date.now()-t0)/1000).toFixed(1)}s`);

        if (!dryRun) {
            if (doWorks) {
                console.log('  configuring works (tmp)...');
                await configureSettings(worksIdx, SETTINGS.works);
                swapResults.works = await swapOrDiscard('works', (tmp) => checkIndexHealth(tmp, 'works'));
            }
            if (doJuans) {
                console.log('  configuring juans (tmp)...');
                await configureSettings(juansIdx, SETTINGS.juans);
                // juans 不参与 is_draft 前端形态自检：前端查整理本正文走 work_id 过滤，形态与其余四类不同
                swapResults.juans = await swapOrDiscard('juans', (tmp) => checkIndexHealth(tmp, 'juans', { checkHits: false }));
            }
        }
    }

    // books（需要读 detail 拿 description/additional_titles，同 works 的路子）
    if (indices.includes('books')) {
        console.log(`\n=== books（建到 tmp）===`);
        const booksIdx = tmpIndexUid('books');
        function* iterBooks() {
            let n = 0;
            for (const { entry, rootDir, isDraft } of iterAllRoots('books')) {
                if (limit && n >= limit) break;
                n++;
                let detail = null;
                if (entry.path) {
                    const detailPath = join(rootDir, entry.path);
                    if (existsSync(detailPath)) {
                        try { detail = JSON.parse(readFileSync(detailPath, 'utf-8')); } catch { detail = null; }
                    }
                }
                // 双保险：shard 没标 promoted_to、但 detail 已 stub 化的漏网墓碑（同 works）
                if (detail?._promoted_to) continue;
                yield buildBookDoc(entry, detail, isDraft);
            }
        }
        await pushInBatches(booksIdx, iterBooks(), { batchSize: 2000 });
        if (!dryRun) {
            await configureSettings(booksIdx, SETTINGS.books);
            swapResults.books = await swapOrDiscard('books', (tmp) => checkIndexHealth(tmp, 'books'));
        }
    }

    // collections / entities：不需要读 detail，字段全在 shard 里
    for (const [name, builder] of [
        ['collections', buildCollectionDoc],
        ['entities', buildEntityDoc],
    ]) {
        if (!indices.includes(name)) continue;
        console.log(`\n=== ${name}（建到 tmp）===`);
        const idxTmp = tmpIndexUid(name);
        function* iter() {
            let n = 0;
            for (const { entry, isDraft } of iterAllRoots(name)) {
                if (limit && n >= limit) break;
                n++;
                yield builder(entry, isDraft);
            }
        }
        await pushInBatches(idxTmp, iter(), { batchSize: 2000 });
        if (!dryRun) {
            await configureSettings(idxTmp, SETTINGS[name]);
            swapResults[name] = await swapOrDiscard(name, (tmp) => checkIndexHealth(tmp, name));
        }
    }

    if (!dryRun) {
        console.log('\n=== final stats ===');
        const s = await meiliRequest('GET', '/stats');
        for (const [idx, info] of Object.entries(s.indexes)) {
            console.log(`  ${idx}: ${info.numberOfDocuments} docs`);
        }
        console.log(`  database: ${(s.databaseSize / 1024 / 1024).toFixed(1)} MB`);

        const failed = Object.entries(swapResults).filter(([, ok]) => !ok).map(([idx]) => idx);
        if (failed.length) {
            console.error(`\n❌ 以下索引自检未通过、未 swap，线上仍是旧数据：${failed.join(', ')}`);
            console.error('   详情见上方各索引自己的自检日志。补救：修好问题后重跑本脚本 --only <idx>。');
            process.exitCode = 1;
        } else {
            console.log(`\n✅ 全部 swap 成功：${Object.keys(swapResults).join(', ') || '(无索引改动)'}`);
        }
    }
}

/**
 * 按前端真实查询形态验证一个索引（swap 前测 tmp，测过才让它上位）—— 2026-09-21
 * 事故后定的判法，2026-09-27（A4）从「重建完事后全局补测」改成「每个索引建完
 * 就近测，作为 swap 前的准入闸」，判法本身不变。
 *
 * 事故：2026-09-07 works 被删并重建，但收尾的 configureSettings 没跑到，
 * settings 永久缺失、退回 Meili 默认，而前端每条搜索都带 `filter=is_draft = false`，
 * 于是 works 一律 400，用户搜「史记」看不到任何**作品**，只有书籍/丛编/人物。
 * 持续 13 天无人发现——脚本本身报「成功」，/health 绿，文档数满格，裸查询
 * （不带 filter）照样 200 有结果，只有**照抄前端形态的查询**才暴露得出来。
 *
 * checkHits=false 用于 juans：前端查整理本正文走 work_id 过滤，形态与其余
 * 四类（is_draft 过滤）不同，硬套会全部判假失败。
 */
async function checkIndexHealth(testUid, settingsKey, { checkHits = true } = {}) {
    const failures = [];
    const want = SETTINGS[settingsKey];
    if (!want) return { ok: true, failures };

    let settings;
    try {
        settings = await meiliRequest('GET', `/indexes/${testUid}/settings`);
    } catch (e) {
        return { ok: false, failures: [`读 settings 失败 — ${e.message}`] };
    }
    const gotFilterable = settings.filterableAttributes ?? [];
    const missingFilter = (want.filterableAttributes ?? []).filter(a => !gotFilterable.includes(a));
    if (missingFilter.length) {
        failures.push(`filterableAttributes 缺 [${missingFilter.join(', ')}]（实得 [${gotFilterable.join(', ')}]）`);
    }
    const gotSearchable = settings.searchableAttributes ?? [];
    if (gotSearchable.length === 1 && gotSearchable[0] === '*') {
        failures.push(`searchableAttributes 仍是默认 ['*']，settings 未生效`);
    }

    if (checkHits) {
        // 前端那条查询能不能真跑通——比对着 settings 逐条核对更可信：
        // settings 对不对是间接证据，查询通不通才是用户实际遇到的。
        try {
            const r = await meiliRequest(
                'GET',
                `/indexes/${testUid}/search?q=&limit=1&filter=${encodeURIComponent('is_draft = false')}`,
            );
            if (typeof r.estimatedTotalHits === 'number' && r.estimatedTotalHits === 0) {
                failures.push(`带 is_draft 过滤查到 0 条 —— 该类内容对用户恒为空`);
            }
        } catch (e) {
            failures.push(`前端形态查询失败 — ${e.message}（前端每条搜索都带此 filter，该索引对用户恒为空）`);
        }
    }

    return { ok: failures.length === 0, failures };
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
