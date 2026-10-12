/**
 * render-docs：在 runner 上把三仓数据渲染成 Meili 文档（JSONL.gz）＋ manifest.json（overview#561 一期）。
 * 搜索机不再持有数据仓，只拉本脚本的产物，由 ingest.mjs 入库。
 *
 * 用法：
 *   DRAFT_DIR=… PRODUCTION_DIR=… TEXT_DIR=… BOOK_INDEX_DERIVED_DIR=… \
 *   node render-docs.mjs --out <dir> [--limit N] [--only works,juans,books,collections,entities]
 *
 * 输出 <out>/docs/<index>.jsonl.gz 与 <out>/manifest.json：
 *   { schema:1, createdAt, indexerVersion, commits:{draft,prod,text,derived},
 *     counts:{idx:n}, sha256:{idx:hex}, editionStats:{total,present,positive}, partial:bool }
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
import { isPromotedTombstone } from './lib/tombstone.mjs';
import { derivedInputProblem } from './lib/work-fields.mjs';

const LIB = new URL('./lib/', import.meta.url);
// 影响文档内容的代码与数据：任一变动 → indexerVersion 变 → ingest 必须走全量（design §四）
const VERSION_FILES = ['doc-builders.mjs', 'shards.mjs', 'work-fields.mjs', 'sort-fields.mjs', 'to-simplified-core.mjs', 'variant-chars.json', 'char-text.mjs', 'tombstone.mjs', 'meili-ops.mjs'];
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
    return {
        async write(doc) {
            n++;
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
    mkdirSync(docsDir, { recursive: true });
    const sinks = {};
    for (const i of ['works', 'juans', 'books', 'collections', 'entities']) if (want(i)) sinks[i] = openSink(join(docsDir, `${i}.jsonl.gz.tmp`));
    const editionStats = { total: 0, present: 0, positive: 0 };
    const iter = (t) => iterAllRoots(roots, t);
    const safeDetail = (rootDir, entry) => {
        const p = resolve(rootDir, entry.path || '');
        if (!insideRoot(rootDir, p)) { console.warn(`⚠️  路径越出数据根目录，跳过：${entry.id} ${entry.path}`); return undefined; }
        if (!existsSync(p)) return undefined;
        try { return readDetail(p, entry.id, derivedDir); } catch { return undefined; }
    };

    if (want('works') || want('juans')) {
        let n = 0;
        for (const { entry, rootDir, isDraft } of iter('works')) {
            if (limit && n >= limit) break;
            n++;
            const detail = safeDetail(rootDir, entry);
            if (!detail || isPromotedTombstone(detail)) continue;
            if (sinks.works) { addEditionStats(editionStats, detail, isDraft); await sinks.works.write(buildWorkDoc(entry, detail, isDraft)); }
            if (sinks.juans) for (const j of buildJuanDocs(textDir, entry)) await sinks.juans.write(j);
        }
        if (sinks.juans) {   // 自校文本挂在 Book 上，按所属 work_id 出 juans
            let m = 0;
            for (const { entry, rootDir } of iter('books')) {
                if (limit && m >= limit) break;
                if (!entry.has_text) continue;
                m++;
                const detail = safeDetail(rootDir, entry) ?? null;
                if (isPromotedTombstone(detail)) continue;
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
            const detail = entry.path ? (safeDetail(rootDir, entry) ?? null) : null;
            if (isPromotedTombstone(detail)) continue;
            await sinks.books.write(buildBookDoc(entry, detail, isDraft));
        }
    }
    for (const [name, builder] of [['collections', buildCollectionDoc], ['entities', buildEntityDoc]]) {
        if (!sinks[name]) continue;
        let n = 0;
        for (const { entry, isDraft } of iter(name)) {
            if (limit && n >= limit) break;
            n++;
            await sinks[name].write(builder(entry, isDraft));
        }
    }

    const counts = {}, sha256 = {};
    for (const [i, s] of Object.entries(sinks)) {
        const r = await s.close();
        counts[i] = r.count; sha256[i] = r.sha256;
        renameSync(join(docsDir, `${i}.jsonl.gz.tmp`), join(docsDir, `${i}.jsonl.gz`));
    }
    const manifest = {
        schema: 1,
        createdAtEpoch: Date.now(),
        createdAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: indexerVersion(),
        commits: { draft: gitHead(draftDir), prod: gitHead(prodDir), text: gitHead(textDir), derived: derivedCommit(derivedDir) },
        counts, sha256, editionStats,
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
