/**
 * ingest：搜索机侧入库（overview#561）。
 * 搜索机不再持有数据仓：只读 runner 产出的文档包。三种模式：
 *
 *   全量   node ingest.mjs --docs <render-docs 输出> [--allow-shrink] [--allow-partial] [--only works,books]
 *   增量   node ingest.mjs --incremental <diff-docs 输出>          （二期：直接在线上索引 upsert／delete，不建 tmp）
 *   认领   node ingest.mjs --adopt <render-docs 输出>               （不碰 Meili，只把这一代记成 state 的基线；
 *                                                                    旧路径 full-reindex 刚建完、口径相同那一代用）
 *   公共参数：[--state /opt/indexer/state.json] [--lock /opt/indexer/.lock]；MEILI_URL／MEILI_KEY 环境变量
 *
 * 增量流程：取锁 → 差量 manifest 校验（基线 renderRunId 必须等于 state 里的，indexerVersion 一致，sha256／行数）→
 *       每个索引先 delete-batch 再 upsert，每批 task 都等到 succeeded → 自检（线上条数＝expectedCounts、前端形态查询、
 *       部类／版本数闸）→ 全部通过才写 state.json。失败：state 不动，下次差量仍以旧基线算，重跑会收敛（upsert 幂等、删不存在的 id 无害）。
 *
 * 流程：取锁 → 校验 manifest（结构＋每个文件 sha256／行数） → 每个索引建 <idx>_tmp 推满 →
 *       settings → 自检＋文档数下限闸（lib/meili-ops 的 verifyTmp，与 full-reindex 同口径）→ 全部通过后一起 swap →
 *       全部成功后才原子写 state.json。任何一环失败：线上索引原封不动、state 不动。
 * 退出码：0 成功；1 失败（含自检未过）；6 锁被占；8 manifest／文件校验不过（增量：基线对不上也是 8）。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createMeiliOps, SETTINGS } from './lib/meili-ops.mjs';
import { editionCoverageProblem } from './lib/work-fields.mjs';
import { EXIT, INDEXES, acquireLock, manifestProblems, readJsonlGz, readState, writeState } from './lib/ingest-support.mjs';
import { deltaProblems } from './lib/doc-diff.mjs';

const a = process.argv.slice(2);
const arg = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const docsRoot = arg('--docs');
const deltaRoot = arg('--incremental');
const adoptRoot = arg('--adopt');
const statePath = arg('--state', '/opt/indexer/state.json');
const lockPath = arg('--lock', '/opt/indexer/.lock');
const allowPartial = a.includes('--allow-partial');
const allowShrink = a.includes('--allow-shrink') || process.env.FORCE_SHRINK === '1';
const only = arg('--only') ? arg('--only').split(',') : null;
const allowOlder = a.includes('--allow-older');
const BATCH = { works: 1000, juans: 500, books: 2000, collections: 2000, entities: 2000 };
const MAX_CONCURRENT = Math.max(1, Math.floor(Number(process.env.MAX_CONCURRENT)) || 3);
if (only && only.some((i) => !INDEXES.includes(i))) { console.error(`--only 含未知索引：${only.filter((i) => !INDEXES.includes(i)).join(',')}（可选 ${INDEXES.join(',')}）`); process.exit(1); }

if ([docsRoot, deltaRoot, adoptRoot].filter(Boolean).length !== 1) { console.error('--docs／--incremental／--adopt 三选一'); process.exit(1); }
if (!adoptRoot && !process.env.MEILI_KEY) { console.error('需要 MEILI_KEY 环境变量'); process.exit(1); }
const ops = createMeiliOps({ url: process.env.MEILI_URL || 'http://127.0.0.1:7700', key: process.env.MEILI_KEY, allowShrink });

const lock = acquireLock(lockPath, { run: process.env.GITHUB_RUN_ID || null, task: 'ingest' });
if (lock.busy) {
    console.error(`🔒 锁被占，退出（码 ${EXIT.LOCK_BUSY}）。持有者：${JSON.stringify(lock.busy)}`);
    process.exit(EXIT.LOCK_BUSY);
}
process.on('exit', () => lock.release());
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

try {
    if (deltaRoot) await mainIncremental();
    else if (adoptRoot) adopt();
    else await main();
} catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
}

async function main() {
    const manifestPath = join(docsRoot, 'manifest.json');
    if (!existsSync(manifestPath)) bad([`${manifestPath} 不存在（render-docs 未完成？manifest 最后落盘）`]);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const indexes = INDEXES.filter((i) => !only || only.includes(i));
    if (!indexes.length) bad(['--only 没有选中任何索引']);
    const problems = manifestProblems(manifest, { allowPartial, requireIndexes: indexes });
    for (const i of indexes) if (!existsSync(join(docsRoot, 'docs', `${i}.jsonl.gz`))) problems.push(`docs/${i}.jsonl.gz 不存在`);
    if (problems.length) bad(problems);
    // 旧产物不得覆盖新数据：manifest 比上次入库的还早就拒绝（--allow-older 显式放行，如回滚）
    const prevState = readState(statePath);
    if (!allowOlder && prevState?.manifestCreatedAtEpoch && manifest.createdAtEpoch && manifest.createdAtEpoch < prevState.manifestCreatedAtEpoch) {
        bad([`manifest.createdAt ${manifest.createdAt} 早于上次入库的 ${prevState.manifestCreatedAt}（旧产物会覆盖新数据；确需回退加 --allow-older）`]);
    }
    console.log(`manifest OK：indexerVersion=${manifest.indexerVersion} commits=${JSON.stringify(manifest.commits)} counts=${JSON.stringify(manifest.counts)}`);

    // 逐索引：建 tmp → 推满（边推边校验 sha256／行数，不一致则整个放弃）→ settings → 自检＋swap
    const verified = {};
    for (const idx of indexes) {
        const file = join(docsRoot, 'docs', `${idx}.jsonl.gz`);
        const tmp = await ops.createFreshTmpIndex(idx);
        console.log(`\n=== ${idx}（建到 ${tmp}）===`);
        const pending = [];
        const t0 = Date.now();
        let pushed = 0;
        const r = await readJsonlGz(file, {
            batchSize: BATCH[idx],
            onBatch: async (docs) => {
                const uid = await ops.pushBatch(tmp, docs);
                if (uid != null) pending.push(ops.waitForTask(uid));
                pushed += docs.length;
                while (pending.length >= MAX_CONCURRENT) await pending.shift();
            },
        });
        await Promise.all(pending);
        if (r.sha256 !== manifest.sha256[idx] || r.count !== manifest.counts[idx]) {
            await ops.meiliRequest('DELETE', `/indexes/${tmp}`).catch(() => {});
            bad([`${idx}: 文件校验不过（sha256 ${r.sha256 === manifest.sha256[idx] ? '一致' : '不一致'}，行数 ${r.count} vs manifest ${manifest.counts[idx]}）`]);
        }
        console.log(`  [${idx}] 推完 ${pushed} 条，用 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        await ops.configureSettings(tmp, SETTINGS[idx]);
        verified[idx] = await ops.verifyTmp(idx, async (t) => {
            const h = await ops.checkIndexHealth(t, idx, { checkHits: idx !== 'juans' });
            if (idx === 'works') {
                const e = manifest.editionStats;
                console.log(`📚 版本数覆盖：非草稿 works ${e.total}，带 _edition_count ${e.present}，>0 的 ${e.positive}`);
                const p = editionCoverageProblem(e);
                if (p) h.failures.push(p);
            }
            return { ok: h.failures.length === 0, failures: h.failures };
        });
    }

    // 两段式：所有索引都建好并验过，才一起 swap；任何一个没过，全部 tmp 丢弃，线上整体保持旧一代
    const failed = Object.entries(verified).filter(([, v]) => !v.ok);
    if (failed.length) {
        for (const [i, v] of failed) { console.error(`❌ [${i}] 自检未通过：`); for (const f of v.failures) console.error(`   · ${f}`); }
        for (const i of indexes) await ops.meiliRequest('DELETE', `/indexes/${ops.tmpIndexUid(i)}`).catch(() => {});
        console.error(`\n❌ 以下索引自检未通过：${failed.map(([i]) => i).join(', ')}；所有 tmp 已删，线上仍是同一代旧数据，state.json 未更新`);
        process.exit(1);
    }
    for (const idx of indexes) await ops.swapTmp(idx);

    if (only || manifest.partial) { console.log('\n（--only／partial 部分入库，不更新 state.json）'); return; }
    const stats = await ops.meiliRequest('GET', '/stats');
    const counts = Object.fromEntries(INDEXES.map((i) => [i, stats.indexes?.[i]?.numberOfDocuments ?? null]));
    writeState(statePath, {
        schema: 1,
        mode: 'full',
        updatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: manifest.indexerVersion,
        renderRunId: manifest.renderRunId ?? null,
        manifestCreatedAt: manifest.createdAt ?? null,
        manifestCreatedAtEpoch: manifest.createdAtEpoch ?? null,
        commits: manifest.commits,
        counts,
        previous: readState(statePath)?.commits ?? null,
    });
    console.log(`\n✅ 全部 swap 成功，state.json 已更新：${JSON.stringify(counts)}`);
}

/** 认领：不碰 Meili，只把一代 render-docs 产物记成基线（下一次增量以它的哈希为准）。 */
function adopt() {
    const manifest = JSON.parse(readFileSync(join(adoptRoot, 'manifest.json'), 'utf-8'));
    const problems = manifestProblems(manifest);
    if (!manifest.renderRunId) problems.push('manifest 没有 renderRunId（不是 runner 上产出的，下一次增量找不到它的哈希）');
    if (problems.length) bad(problems);
    writeState(statePath, {
        schema: 1,
        mode: 'adopt',
        updatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: manifest.indexerVersion,
        renderRunId: manifest.renderRunId,
        manifestCreatedAt: manifest.createdAt ?? null,
        manifestCreatedAtEpoch: manifest.createdAtEpoch ?? null,
        commits: manifest.commits,
        counts: manifest.counts,
        previous: readState(statePath)?.commits ?? null,
    });
    console.log(`✅ 已认领 run ${manifest.renderRunId} 为基线（未改动 Meili）：${JSON.stringify(manifest.commits)}`);
}

async function mainIncremental() {
    const delta = JSON.parse(readFileSync(join(deltaRoot, 'manifest.json'), 'utf-8'));
    const state = readState(statePath);
    const indexes = INDEXES.filter((i) => typeof delta.expectedCounts?.[i] === 'number' && (!only || only.includes(i)));
    if (only) bad(['增量不支持 --only（基线是整代的，只打一部分会让 state 与线上对不上）']);
    const problems = deltaProblems(delta, state, { indexes });
    for (const i of indexes) {
        if (delta.upserts[i] > 0 && !existsSync(join(deltaRoot, 'docs', `${i}.jsonl.gz`))) problems.push(`docs/${i}.jsonl.gz 不存在`);
        if (!existsSync(join(deltaRoot, 'deletes', `${i}.json`))) problems.push(`deletes/${i}.json 不存在`);
    }
    if (problems.length) bad(problems);
    console.log(`差量 OK：基线 run ${delta.base.renderRunId} → run ${delta.renderRunId}；upsert ${JSON.stringify(delta.upserts)} delete ${JSON.stringify(delta.deletes)}`);

    // 断点续打：同一份差量（renderRunId 相同）重跑时，跳过上次已确认 succeeded 的批次。首次补齐十几万条时，
    // 中途超时／断线后在 Actions 里重跑 apply 就从断点接着打，不从头来。state 推进后进度文件即删。
    const progressPath = `${statePath}.progress.json`;
    let progress = null;
    try { progress = JSON.parse(readFileSync(progressPath, 'utf-8')); } catch { /* 没有 */ }
    if (!progress || progress.renderRunId !== delta.renderRunId) progress = { renderRunId: delta.renderRunId, done: {} };
    else console.log(`↻ 接着上次的进度打：${JSON.stringify(progress.done)}`);
    const saveProgress = () => writeFileSync(progressPath, JSON.stringify(progress) + '\n');
    const doneOf = (idx) => (progress.done[idx] ??= { deleteBatches: 0, upsertBatches: 0 });

    const t0 = Date.now();
    for (const idx of indexes) {
        const pg = doneOf(idx);
        // 先删后加：同一代里删和加的 id 不重叠，顺序其实无关；先删让条数中途只会往下走，自检口径更直观
        const ids = JSON.parse(readFileSync(join(deltaRoot, 'deletes', `${idx}.json`), 'utf-8'));
        if (ids.length !== delta.deletes[idx]) bad([`${idx}: deletes 文件 ${ids.length} 条，manifest 记 ${delta.deletes[idx]} 条`]);
        for (let b = pg.deleteBatches, k = b * 1000; k < ids.length; b++, k += 1000) {
            const r = await ops.meiliRequest('POST', `/indexes/${idx}/documents/delete-batch`, ids.slice(k, k + 1000));
            await ops.waitForTask(r.taskUid, 1_800_000);
            pg.deleteBatches = b + 1; saveProgress();
        }
        let pushed = 0, skipped = 0;
        if (delta.upserts[idx] > 0) {
            const pending = [];
            let batchNo = 0;
            // Meili 按入队顺序处理 task；FIFO 等到哪一批，就确认到哪一批
            const confirmOldest = async () => { await pending.shift(); pg.upsertBatches++; saveProgress(); };
            const r = await readJsonlGz(join(deltaRoot, 'docs', `${idx}.jsonl.gz`), {
                batchSize: BATCH[idx],
                onBatch: async (docs) => {
                    if (batchNo++ < pg.upsertBatches) { skipped += docs.length; return; }   // 上次已确认
                    const uid = await ops.pushBatch(idx, docs);
                    pending.push(uid != null ? ops.waitForTask(uid, 1_800_000) : Promise.resolve());
                    pushed += docs.length;
                    while (pending.length >= MAX_CONCURRENT) await confirmOldest();
                    if (pushed % 20000 < docs.length) console.log(`  [${idx}] upsert ${pushed + skipped}／${delta.upserts[idx]}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
                },
            });
            while (pending.length) await confirmOldest();
            if (r.sha256 !== delta.sha256[idx] || r.count !== delta.upserts[idx]) {
                // 已经打进去的 upsert 是幂等的，state 不推进，下次以旧基线重算会再打一遍，不会丢
                console.error(`❌ ${idx}: 差量文件校验不过（sha256 ${r.sha256 === delta.sha256[idx] ? '一致' : '不一致'}，行数 ${r.count} vs ${delta.upserts[idx]}），state 不推进`);
                process.exit(EXIT.MANIFEST_BAD);
            }
        }
        console.log(`  [${idx}] 删 ${ids.length}，upsert ${pushed}${skipped ? `（另有 ${skipped} 条上次已打，跳过）` : ''}`);
    }

    // 自检：在线上索引上跑（没有 tmp），口径同全量
    const failures = [];
    for (const idx of indexes) {
        const c = await ops.docCount(idx);
        if (c.state !== 'ok') failures.push(`[${idx}] 读不到条数（${c.error || c.state}）`);
        else if (c.docs !== delta.expectedCounts[idx]) failures.push(`[${idx}] 线上 ${c.docs} 条，按差量应为 ${delta.expectedCounts[idx]} 条（线上与基线不一致，需要全量对账）`);
        if (!(delta.upserts[idx] || delta.deletes[idx])) continue;   // 没动过的索引不必重测前端形态
        const h = await ops.checkIndexHealth(idx, idx, { checkHits: idx !== 'juans' });
        for (const f of h.failures) failures.push(`[${idx}] ${f}`);
    }
    if (indexes.includes('works')) {
        const e = delta.editionStats;
        const p = e ? editionCoverageProblem(e) : '差量 manifest 缺 editionStats';
        if (p) failures.push(`[works] ${p}`);
    }
    if (failures.length) {
        console.error('❌ 增量打完后自检未通过（线上已含本次改动；state 未推进，修好后重跑会收敛，必要时走全量）：');
        for (const f of failures) console.error(`   · ${f}`);
        process.exit(1);
    }
    const counts = Object.fromEntries(indexes.map((i) => [i, delta.expectedCounts[i]]));
    writeState(statePath, {
        schema: 1,
        mode: 'incremental',
        updatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: delta.indexerVersion,
        renderRunId: delta.renderRunId,
        manifestCreatedAt: delta.createdAt ?? null,
        manifestCreatedAtEpoch: delta.createdAtEpoch ?? null,
        commits: delta.commits,
        counts,
        previous: state?.commits ?? null,
    });
    try { unlinkSync(progressPath); } catch { /* 没有 */ }
    console.log(`\n✅ 增量完成（${((Date.now() - t0) / 1000).toFixed(1)}s），state.json 已推进到 run ${delta.renderRunId}`);
}

function bad(problems) {
    console.error('❌ 入库前校验不过（线上不动）：');
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(EXIT.MANIFEST_BAD);
}
