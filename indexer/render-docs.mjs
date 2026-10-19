/**
 * render-docs：在 runner 上把三仓数据渲染成 Meili 文档（JSONL.gz）＋ manifest.json（overview#561 一期）。
 * 搜索机不再持有数据仓，只拉本脚本的产物，由 ingest.mjs 入库。
 *
 * 用法：
 *   DRAFT_DIR=… PRODUCTION_DIR=… TEXT_DIR=… BOOK_INDEX_DERIVED_DIR=… \
 *   node render-docs.mjs --out <dir> [--limit N] [--only works,juans,books,collections,entities]
 *
 * 输出 <out>/docs/<index>.jsonl.gz、<out>/hashes/<index>.json.gz（{id → 文档哈希}，增量比对用，二期）与 <out>/manifest.json：
 *   { schema:1, createdAt, indexerVersion, renderRunId, commits:{draft,prod,text,derived},
 *     counts:{idx:n}, sha256:{idx:hex}, editionStats:{total,present,positive}, partial:bool }
 *   renderRunId＝GITHUB_RUN_ID：下一次增量靠它找到这一代的哈希（diff-docs.mjs）。
 * 退出码：1 参数／环境错误；5 派生产物缺失或与源仓 commit 不符（同 full-reindex）。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { buildWorkDoc, buildBookDoc, buildCollectionDoc, buildEntityDoc, buildJuanDocs, readDetail, addEditionStats } from './lib/doc-builders.mjs';
import { iterAllRoots, insideRoot } from './lib/shards.mjs';
import { createReadStats, readStatsProblem } from './lib/derived-core.mjs';
import { isTombstone } from './lib/tombstone.mjs';
import { derivedInputProblem } from './lib/work-fields.mjs';
import { docHash, writeJsonGz } from './lib/doc-diff.mjs';

const LIB = new URL('./lib/', import.meta.url);
// 影响文档内容的代码与数据：任一变动 → indexerVersion 变 → ingest 必须走全量（design §四）
const VERSION_FILES = ['doc-builders.mjs', 'shards.mjs', 'work-fields.mjs', 'derived-core.mjs', 'sort-fields.mjs', 'to-simplified-core.mjs', 'variant-chars.json', 'char-text.mjs', 'tombstone.mjs', 'meili-ops.mjs', 'doc-diff.mjs'];
const SELF = new URL('./render-docs.mjs', import.meta.url);

export function indexerVersion() {
    const h = createHash('sha256');
    for (const f of VERSION_FILES) h.update(f).update(readFileSync(new URL(f, LIB)));
    h.update('render-docs.mjs').update(readFileSync(SELF));
    h.update(readFileSync(new URL('./package-lock.json', import.meta.url)));
    return h.digest('hex').slice(0, 16);
}

function gitHead(dir) {
    if (!dir || !existsSync(dir)) return null;
    try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** 一个 JSONL.gz 写入器：带背压，边写边算 sha256（对压缩后字节）。 */
function openSink(path) {
    const gz = createGzip({ level: 6 });
    const out = createWriteStream(path);
    const hash = createHash('sha256');
    gz.on('data', (c) => hash.update(c));
    gz.pipe(out);
    let n = 0;
    const hashes = new Map();
    return {
        hashes,
        async write(doc) {
            n++;
            // 与 meili-ops pushBatch 同一条 id 规则：Meili 不收的 id 不进哈希表，否则差量会一直想 upsert 它
            if (doc && typeof doc.id === 'string' && /^[A-Za-z0-9_-]+$/.test(doc.id)) hashes.set(doc.id, docHash(doc));
            if (!gz.write(JSON.stringify(doc) + '\n')) await once(gz, 'drain');
        },
        async close() {
            gz.end();
            await once(out, 'finish');
            return { count: n, sha256: hash.digest('hex') };
        },
    };
}

export async function renderDocs({ draftDir, prodDir, textDir, derivedDir, outDir, limit = null, only = null }) {
    const roots = [{ dir: draftDir, isDraft: true }];
    if (prodDir && existsSync(prodDir)) roots.push({ dir: prodDir, isDraft: false });
    else console.warn('⚠️  PRODUCTION_DIR 未设置或不存在 —— 已升格条目将缺席！');
    if (!textDir || !existsSync(textDir)) console.warn('⚠️  TEXT_DIR 未设置或不存在 —— juans 将为空！');

    const want = (i) => !only || only.includes(i);
    const docsDir = join(outDir, 'docs');
    const hashesDir = join(outDir, 'hashes');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(hashesDir, { recursive: true });
    const sinks = {};
    for (const i of ['works', 'juans', 'books', 'collections', 'entities']) if (want(i)) sinks[i] = openSink(join(docsDir, `${i}.jsonl.gz.tmp`));
    const editionStats = { total: 0, present: 0, positive: 0 };
    const iter = (t) => iterAllRoots(roots, t);
    // 口径与 full-reindex.mjs 逐条对齐（增量的基线是旧路径建的线上索引，渲染结果必须和它一致，否则条数自检对不上）：
    //   · 墓碑一律用 isTombstone（升格 promoted_to＋并条 merged_into），collections／entities 也读 detail 判并条墓碑；
    //   · derived 缺产物的计数只看 works（full-reindex 在 works 自检时判闸，books／collections／entities 读不到产物时
    //     detail 记 null、照样出文档）——它们另用一个不判闸的计数器。
    const readStats = createReadStats();
    const otherStats = createReadStats();
    const safeDetail = (rootDir, entry, isDraft = false, stats = readStats) => {
        const p = resolve(rootDir, entry.path || '');
        if (!insideRoot(rootDir, p)) { console.warn(`⚠️  路径越出数据根目录，跳过：${entry.id} ${entry.path}`); return undefined; }
        if (!existsSync(p)) return undefined;
        try { return readDetail(p, entry.id, derivedDir, { isDraft, stats }); } catch { return undefined; }
    };

    if (want('works') || want('juans')) {
        let n = 0;
        for (const { entry, rootDir, isDraft } of iter('works')) {
            if (limit && n >= limit) break;
            n++;
            const detail = safeDetail(rootDir, entry, isDraft);
            if (!detail || isTombstone(detail)) continue;
            if (sinks.works) { addEditionStats(editionStats, detail, isDraft); await sinks.works.write(buildWorkDoc(entry, detail, isDraft)); }
            if (sinks.juans) for (const j of buildJuanDocs(textDir, entry)) await sinks.juans.write(j);
        }
        if (sinks.juans) {   // 自校文本挂在 Book 上，按所属 work_id 出 juans
            let m = 0;
            for (const { entry, rootDir, isDraft } of iter('books')) {
                if (limit && m >= limit) break;
                if (!entry.has_text) continue;
                m++;
                // Book 无 derived 产物：读源档、不计 readStats（GUJI-535）
                const bp = resolve(rootDir, entry.path || '');
                let detail = null;
                if (insideRoot(rootDir, bp) && existsSync(bp)) { try { detail = readDetail(bp, entry.id, '', { isDraft }); } catch { detail = null; } }
                if (isTombstone(detail)) continue;
                const workId = (detail && typeof detail.work_id === 'string' && detail.work_id) || entry.work_id || entry.id;
                for (const j of buildJuanDocs(textDir, entry, { workId, kinds: ['self_collated'] })) await sinks.juans.write(j);
            }
        }
    }
    if (sinks.books) {
        let n = 0;
        for (const { entry, rootDir, isDraft } of iter('books')) {
            if (limit && n >= limit) break;
            n++;
            const detail = entry.path ? (safeDetail(rootDir, entry, isDraft, otherStats) ?? null) : null;
            if (isTombstone(detail)) continue;
            await sinks.books.write(buildBookDoc(entry, detail, isDraft));
        }
    }
    for (const [name, builder] of [['collections', buildCollectionDoc], ['entities', buildEntityDoc]]) {
        if (!sinks[name]) continue;
        let n = 0;
        let tomb = 0;
        for (const { entry, rootDir, isDraft } of iter(name)) {
            if (limit && n >= limit) break;
            n++;
            // shard 条目不带 merged_into（derived.md〈八〉），并条墓碑只能读 detail 判（同 full-reindex）
            if (entry.path && isTombstone(safeDetail(rootDir, entry, isDraft, otherStats) ?? null)) { tomb++; continue; }
            await sinks[name].write(builder(entry, isDraft));
        }
        if (tomb) console.log(`  [${name}] 读 detail 跳过 ${tomb} 个墓碑`);
    }

    // 生产库缺 derived 产物＝产物不全：不落 manifest（.tmp 留着，ingest 认 manifest 才算完整），与准入闸同一开关
    const readProblem = process.env.ALLOW_NO_DERIVED === '1' ? null : readStatsProblem(readStats);
    if (readProblem) throw new Error(readProblem);
    const counts = {}, sha256 = {};
    for (const [i, s] of Object.entries(sinks)) {
        const r = await s.close();
        counts[i] = r.count; sha256[i] = r.sha256;
        renameSync(join(docsDir, `${i}.jsonl.gz.tmp`), join(docsDir, `${i}.jsonl.gz`));
        await writeJsonGz(join(hashesDir, `${i}.json.gz`), Object.fromEntries(s.hashes));
    }
    const manifest = {
        schema: 1,
        createdAtEpoch: Date.now(),
        createdAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: indexerVersion(),
        renderRunId: process.env.GITHUB_RUN_ID || null,
        commits: { draft: gitHead(draftDir), prod: gitHead(prodDir), text: gitHead(textDir), derived: derivedCommit(derivedDir) },
        counts, sha256, editionStats, derivedRead: readStats,
        partial: !!(limit || only),
    };
    writeFileSync(join(outDir, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
    renameSync(join(outDir, 'manifest.json.tmp'), join(outDir, 'manifest.json'));   // manifest 最后落盘＝完整性标记
    return manifest;
}

function derivedCommit(dir) {
    try { return readFileSync(join(dir, 'SOURCE_COMMIT'), 'utf-8').trim(); } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const a = process.argv.slice(2);
    const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    const draftDir = process.env.DRAFT_DIR, prodDir = process.env.PRODUCTION_DIR;
    const textDir = process.env.TEXT_DIR, derivedDir = (process.env.BOOK_INDEX_DERIVED_DIR || '').trim();
    const outDir = arg('--out');
    const limit = arg('--limit') ? parseInt(arg('--limit')) : null;
    if (limit !== null && !(limit > 0)) { console.error('--limit 必须是正整数'); process.exit(1); }
    const only = arg('--only') ? arg('--only').split(',') : null;
    if (only && only.some((i) => !['works', 'juans', 'books', 'collections', 'entities'].includes(i))) { console.error(`--only 含未知索引：${only.join(',')}`); process.exit(1); }
    if (!draftDir || !outDir) { console.error('需要 DRAFT_DIR 环境变量与 --out <dir>'); process.exit(1); }
    const needsDerived = !only || only.some((i) => i === 'works' || i === 'juans');
    if (needsDerived && prodDir && existsSync(prodDir)) {   // 产物准入（overview#345）：与 full-reindex 同判法
        const problem = derivedInputProblem({
            schemaV2: existsSync(join(prodDir, 'build', 'build_derived.py')),
            derivedDir, dirExists: !!derivedDir && existsSync(derivedDir),
            derivedCommit: derivedCommit(derivedDir) || '', sourceCommit: gitHead(prodDir) || '',
        });
        if (problem && process.env.ALLOW_NO_DERIVED !== '1') { console.error(`❌ 产物准入失败：${problem}`); process.exit(5); }
    }
    const m = await renderDocs({ draftDir, prodDir, textDir, derivedDir, outDir, limit, only });
    console.log(`✅ render-docs 完成：${JSON.stringify(m.counts)}  indexerVersion=${m.indexerVersion}`);
}
