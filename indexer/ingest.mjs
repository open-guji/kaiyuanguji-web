/**
 * ingest：搜索机侧入库（overview#561 一期，仅全量模式）。
 * 搜索机不再持有数据仓：只读 render-docs 产出的 docs/*.jsonl.gz＋manifest.json。
 *
 *   MEILI_URL=… MEILI_KEY=… node ingest.mjs --docs <dir> [--state /opt/indexer/state.json]
 *        [--lock /opt/indexer/.lock] [--allow-shrink] [--allow-partial] [--only works,books]
 *
 * 流程：取锁 → 校验 manifest（结构＋每个文件 sha256／行数） → 每个索引建 <idx>_tmp 推满 →
 *       settings → 自检＋文档数下限闸（lib/meili-ops 的 swapOrDiscard，与 full-reindex 同口径）→ swap →
 *       全部成功后才原子写 state.json。任何一环失败：线上索引原封不动、state 不动。
 * 退出码：0 成功；1 失败（含自检未过）；6 锁被占；8 manifest／文件校验不过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMeiliOps, SETTINGS } from './lib/meili-ops.mjs';
import { editionCoverageProblem } from './lib/work-fields.mjs';
import { EXIT, INDEXES, acquireLock, manifestProblems, readJsonlGz, readState, writeState } from './lib/ingest-support.mjs';

const a = process.argv.slice(2);
const arg = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const docsRoot = arg('--docs');
const statePath = arg('--state', '/opt/indexer/state.json');
const lockPath = arg('--lock', '/opt/indexer/.lock');
const allowPartial = a.includes('--allow-partial');
const allowShrink = a.includes('--allow-shrink') || process.env.FORCE_SHRINK === '1';
const only = arg('--only') ? arg('--only').split(',') : null;
const BATCH = { works: 1000, juans: 500, books: 2000, collections: 2000, entities: 2000 };
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 3;

if (!docsRoot || !process.env.MEILI_KEY) { console.error('需要 --docs <dir> 与 MEILI_KEY 环境变量'); process.exit(1); }
const ops = createMeiliOps({ url: process.env.MEILI_URL || 'http://127.0.0.1:7700', key: process.env.MEILI_KEY, allowShrink });

const lock = acquireLock(lockPath, { run: process.env.GITHUB_RUN_ID || null, task: 'ingest' });
if (lock.busy) {
    console.error(`🔒 锁被占，退出（码 ${EXIT.LOCK_BUSY}）。持有者：${JSON.stringify(lock.busy)}`);
    process.exit(EXIT.LOCK_BUSY);
}
process.on('exit', () => lock.release());
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

try {
    await main();
} catch (e) {
    console.error('FATAL:', e);
    process.exit(1);
}

async function main() {
    const manifestPath = join(docsRoot, 'manifest.json');
    if (!existsSync(manifestPath)) bad([`${manifestPath} 不存在（render-docs 未完成？manifest 最后落盘）`]);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const indexes = INDEXES.filter((i) => !only || only.includes(i));
    const problems = manifestProblems(manifest, { allowPartial, requireIndexes: indexes });
    for (const i of indexes) if (!existsSync(join(docsRoot, 'docs', `${i}.jsonl.gz`))) problems.push(`docs/${i}.jsonl.gz 不存在`);
    if (problems.length) bad(problems);
    console.log(`manifest OK：indexerVersion=${manifest.indexerVersion} commits=${JSON.stringify(manifest.commits)} counts=${JSON.stringify(manifest.counts)}`);

    // 逐索引：建 tmp → 推满（边推边校验 sha256／行数，不一致则整个放弃）→ settings → 自检＋swap
    const swapped = {};
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
        swapped[idx] = await ops.swapOrDiscard(idx, async (t) => {
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

    const failed = Object.entries(swapped).filter(([, ok]) => !ok).map(([i]) => i);
    if (failed.length) {
        console.error(`\n❌ 以下索引自检未通过、未 swap，线上仍是旧数据：${failed.join(', ')}；state.json 未更新`);
        process.exit(1);
    }

    if (only) { console.log('\n（--only 部分入库，不更新 state.json）'); return; }
    const stats = await ops.meiliRequest('GET', '/stats');
    const counts = Object.fromEntries(INDEXES.map((i) => [i, stats.indexes?.[i]?.numberOfDocuments ?? null]));
    writeState(statePath, {
        schema: 1,
        mode: 'full',
        updatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: manifest.indexerVersion,
        commits: manifest.commits,
        counts,
        previous: readState(statePath)?.commits ?? null,
    });
    console.log(`\n✅ 全部 swap 成功，state.json 已更新：${JSON.stringify(counts)}`);
}

function bad(problems) {
    console.error('❌ 入库前校验不过（线上不动）：');
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(EXIT.MANIFEST_BAD);
}
