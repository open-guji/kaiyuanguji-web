/**
 * 完整 indexer (Node.js) — 把 book-index-draft + book-index 全量推到 Meili
 *
 * 用法（在上海云上跑；平时经 ./reindex-limited.sh 调用，别直接跑）：
 *   DRAFT_DIR=/root/book-index-draft \
 *   PRODUCTION_DIR=/root/book-index \
 *   TEXT_DIR=/root/book-text \
 *   MEILI_URL=http://127.0.0.1:7700 \
 *   MEILI_KEY=xxx \
 *   node full-reindex.mjs [--dry-run] [--limit 1000] [--only works,books] [--allow-shrink]
 *
 * 设计：
 *   - 流式遍历 {draft,production}/index/{books,works,entities}/{0-f}.json
 *   - 每 1000 doc 推一批；最多 3 个 in-flight task
 *   - 有整理本（manifest.json 里有 kind=collated 的版本）的 work 同时把整理本正文推 juans index —— 正文在 **book-text**
 *     仓（2026-08-26 拆出），不在元数据仓；只认新结构 manifest.json＋<key>/（overview#307，旧的
 *     collated_edition/ 已于 2026-09-30 迁移掉）
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

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { editionCoverageProblem, derivedInputProblem } from './lib/work-fields.mjs';
import { createMeiliOps, SETTINGS } from './lib/meili-ops.mjs';
import { iterAllRoots as iterAllRootsIn } from './lib/shards.mjs';
import { isTombstone } from './lib/tombstone.mjs';
import { EXIT, acquireLock } from './lib/ingest-support.mjs';
import { buildWorkDoc, buildBookDoc, buildCollectionDoc, buildEntityDoc, buildJuanDocs as buildJuanDocsIn, readDetail as readDetailIn, addEditionStats } from './lib/doc-builders.mjs';

const EDITION_STATS = { total: 0, present: 0, positive: 0 };
const DERIVED_DIR = () => process.env.BOOK_INDEX_DERIVED_DIR || '';
const readDetail = (p, id) => readDetailIn(p, id, DERIVED_DIR());
const buildJuanDocs = (entry, opts) => buildJuanDocsIn(TEXT_DIR, entry, opts);


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
// swap 前的文档数下限闸（lib/doc-floor.mjs）：新建的比线上少一半以上就不换。确实要大幅缩减时带 --allow-shrink
// （或 FORCE_SHRINK=1）；--limit 的试跑结果也只有这样才会换上线（否则被闸挡住，线上不动）
const ALLOW_SHRINK = args.includes('--allow-shrink') || process.env.FORCE_SHRINK === '1';

// ─── 工具 ───


const iterAllRoots = (typeDir) => iterAllRootsIn(ROOTS, typeDir);
const { meiliRequest, waitForTask, pushBatch, configureSettings, tmpIndexUid, createFreshTmpIndex, swapOrDiscard, checkIndexHealth } = createMeiliOps({ url: MEILI_URL, key: MEILI_KEY, allowShrink: ALLOW_SHRINK });

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
        if (doWorks) assertDerivedInput();   // 只在要建 works 时查产物（--only juans/books 不需要，Eric 审）
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
                try { detail = readDetail(detailPath, entry.id); } catch { continue; }
                // 双保险：shard 没标 promoted_to、但 detail 已 stub 化的漏网墓碑
                if (isTombstone(detail)) continue; // 升格墓碑字段是 promoted_to，旧的是 _promoted_to，两个都认；并条墓碑是 merged_into
                if (doWorks) { addEditionStats(EDITION_STATS, detail, isDraft); yield { kind: 'work', doc: buildWorkDoc(entry, detail, isDraft) }; }
                // 不再看 has_collated 标记（它来自数据仓、会滞后）：有没有整理本版本以文本仓的 manifest.json 为准
                if (doJuans) {
                    for (const j of buildJuanDocs(entry)) {
                        yield { kind: 'juan', doc: j };
                    }
                }
            }
        }

        // 自校文本（self_collated）挂在 Book 上：只扫 has_text 的 Book（几十条量级），按其所属 work_id 出 juans 文档
        async function* selfCollatedJuans() {
            if (!doJuans) return;
            let n = 0;
            for (const { entry, rootDir } of iterAllRoots('books')) {
                if (limit && n >= limit) break;
                if (!entry.has_text) continue;
                n++;
                const detailPath = join(rootDir, entry.path || '');
                let detail = null;
                try { detail = existsSync(detailPath) ? readDetail(detailPath, entry.id) : null; } catch { detail = null; }
                if (isTombstone(detail)) continue;
                const workId = (detail && typeof detail.work_id === 'string' && detail.work_id) || entry.work_id || entry.id;
                for (const j of buildJuanDocs(entry, { workId, kinds: ['self_collated'] })) yield { kind: 'juan', doc: j };
            }
        }
        async function* allDocs() {
            yield* combined();
            yield* selfCollatedJuans();
        }

        // 拆两个流推
        let worksBuf = [], juansBuf = [], worksTotal = 0, juansTotal = 0;
        const worksPending = [], juansPending = [];
        const t0 = Date.now();
        for await (const { kind, doc } of allDocs()) {
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
                swapResults.works = await swapOrDiscard('works', async (tmp) => {
                    const h = await checkIndexHealth(tmp, 'works');
                    console.log(`📚 版本数覆盖：非草稿 works ${EDITION_STATS.total}，带 _edition_count ${EDITION_STATS.present}，>0 的 ${EDITION_STATS.positive}（硬线：有数字 ≥95%，>0 ≥30%）`);
                    const p = limit ? null : editionCoverageProblem(EDITION_STATS);   // --limit 试跑不闸
                    if (p) h.failures.push(p);
                    return { ok: h.failures.length === 0, failures: h.failures };
                });
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
                        try { detail = readDetail(detailPath, entry.id); } catch { detail = null; }
                    }
                }
                // 双保险：shard 没标 promoted_to、但 detail 已 stub 化的漏网墓碑（同 works）
                if (isTombstone(detail)) continue;
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
            let tomb = 0;
            for (const { entry, rootDir, isDraft } of iterAllRoots(name)) {
                if (limit && n >= limit) break;
                n++;
                // shard 条目不带 merged_into（derived.md〈八〉），并条墓碑只能读 detail 判（同 works／books）
                if (entry.path) {
                    const detailPath = join(rootDir, entry.path);
                    if (existsSync(detailPath)) {
                        let detail = null;
                        try { detail = readDetail(detailPath, entry.id); } catch { detail = null; }
                        if (isTombstone(detail)) { tomb++; continue; }
                    }
                }
                yield builder(entry, isDraft);
            }
            if (tomb) console.log(`  [${name}] 读 detail 跳过 ${tomb} 个墓碑`);
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


// 产物准入（overview#345）：schema-v2 源仓必须带同 commit 的 derive 产物，否则部类全空。退出码 5。
function assertDerivedInput() {
    if (!PRODUCTION_DIR || !existsSync(PRODUCTION_DIR)) return;
    const dir = (process.env.BOOK_INDEX_DERIVED_DIR || '').trim();
    let derivedCommit = '', sourceCommit = '';
    try { derivedCommit = readFileSync(join(dir, 'SOURCE_COMMIT'), 'utf-8').trim(); } catch { /* 缺失由判定函数报 */ }
    try { sourceCommit = execFileSync('git', ['-C', PRODUCTION_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(); } catch { /* 同上 */ }
    const problem = derivedInputProblem({
        schemaV2: existsSync(join(PRODUCTION_DIR, 'build', 'build_derived.py')),
        derivedDir: dir, dirExists: !!dir && existsSync(dir), derivedCommit, sourceCommit,
    });
    if (problem && process.env.ALLOW_NO_DERIVED !== '1') {
        console.error(`❌ 产物准入失败：${problem}\n   不建索引（线上保持不变）。确需跳过带 ALLOW_NO_DERIVED=1。`);
        process.exit(5);
    }
}
// 与 ingest.mjs 共用同一把锁（overview#561）：搜索机上 full-reindex 与 ingest 不得并发。
// 锁路径 INDEXER_LOCK，默认 /opt/indexer/.lock（目录不存在＝非搜索机环境，不加锁）。
{
    const lockPath = process.env.INDEXER_LOCK || '/opt/indexer/.lock';
    if (process.env.INDEXER_LOCK || existsSync(dirname(lockPath))) {
        const lock = acquireLock(lockPath, { run: process.env.GITHUB_RUN_ID || null, task: 'full-reindex' });
        if (lock.busy) {
            console.error(`🔒 锁被占，退出（码 ${EXIT.LOCK_BUSY}）。持有者：${JSON.stringify(lock.busy)}`);
            process.exit(EXIT.LOCK_BUSY);
        }
        process.on('exit', () => lock.release());
        for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
    }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
