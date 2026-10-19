/**
 * diff-docs：runner 上把「这一代全量渲染」和「线上那一代的哈希」比出差量（overview#561 二期）。
 * 搜索机只收差量（几百到几千条），直接在线上索引上 upsert／delete，不建 _tmp、不 swap。
 *
 * 用法：
 *   node diff-docs.mjs --new <render-docs 输出目录> --base <上一代的 render-docs 输出目录（至少有 manifest.json＋hashes/）> \
 *        --out <差量目录> [--max-ratio 0.3] [--allow-version-change] [--allow-high-ratio]
 *
 * 输出 <out>/docs/<idx>.jsonl.gz（要 upsert 的文档）、<out>/deletes/<idx>.json（要删的 id）、<out>/manifest.json：
 *   { schema:1, mode:'incremental', createdAtEpoch, indexerVersion, renderRunId, commits,
 *     base:{ renderRunId, indexerVersion, commits }, expectedCounts:{idx:n}, upserts:{idx:n}, deletes:{idx:n},
 *     sha256:{idx:hex}, editionStats }
 * 退出码：0 差量已写出；1 参数／文件错误；7 不能走增量（原因码见 lib/doc-diff.mjs FALLBACK，打印在最后一行，并写进 GITHUB_OUTPUT fallback=）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { EXIT, INDEXES, readJsonlGz } from './lib/ingest-support.mjs';
import { FALLBACK, changeRatio, diffHashes, readJsonFile, readJsonGz } from './lib/doc-diff.mjs';

function setOutput(k, v) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}

function fallback(code, why) {
    console.error(`⚠️  不能走增量：${code} — ${why}`);
    setOutput('fallback', code);
    console.log(`FALLBACK ${code}`);
    process.exit(EXIT.FALLBACK_REFUSED);
}

export async function diffDocs({ newDir, baseDir, outDir, maxRatio = 0.3, allowVersionChange = false, allowHighRatio = false }) {
    const next = readJsonFile(join(newDir, 'manifest.json'));
    if (!next) throw new Error(`${newDir}/manifest.json 不存在`);
    if (next.partial) throw new Error('新一代是 partial（--limit/--only 试跑）产物，不能拿来算差量');
    const base = baseDir ? readJsonFile(join(baseDir, 'manifest.json')) : null;
    if (!base) return { fallback: FALLBACK.BASE_MISSING, why: `基线目录 ${baseDir || '（未给）'} 里没有 manifest.json` };
    if (base.indexerVersion !== next.indexerVersion && !allowVersionChange) {
        return { fallback: FALLBACK.VERSION, why: `基线 ${base.indexerVersion} → 这一代 ${next.indexerVersion}（文档口径变了，要全量）` };
    }
    const indexes = INDEXES.filter((i) => typeof next.counts?.[i] === 'number');
    mkdirSync(join(outDir, 'docs'), { recursive: true });
    mkdirSync(join(outDir, 'deletes'), { recursive: true });

    const expectedCounts = {}, upserts = {}, deletes = {}, sha256 = {}, ratios = {};
    for (const idx of indexes) {
        const bp = join(baseDir, 'hashes', `${idx}.json.gz`);
        const np = join(newDir, 'hashes', `${idx}.json.gz`);
        if (!existsSync(bp)) return { fallback: FALLBACK.BASE_MISSING, why: `基线缺 hashes/${idx}.json.gz` };
        if (!existsSync(np)) throw new Error(`新一代缺 hashes/${idx}.json.gz`);
        const bh = new Map(Object.entries(await readJsonGz(bp)));
        const nh = new Map(Object.entries(await readJsonGz(np)));
        const d = diffHashes(bh, nh);
        ratios[idx] = changeRatio(d, bh.size);
        console.log(`[${idx}] 基线 ${bh.size} → 新 ${nh.size}：新增 ${d.added}，改动 ${d.changed}，删除 ${d.del.size}，不变 ${d.unchanged}（变动 ${(ratios[idx] * 100).toFixed(2)}%）`);
        if (ratios[idx] > maxRatio && !allowHighRatio) {
            return { fallback: FALLBACK.RATIO, why: `${idx} 一次要变 ${(ratios[idx] * 100).toFixed(1)}%（上限 ${maxRatio * 100}%），该走全量` };
        }
        expectedCounts[idx] = nh.size;
        deletes[idx] = d.del.size;
        writeFileSync(join(outDir, 'deletes', `${idx}.json`), JSON.stringify([...d.del]) + '\n');

        // 从新一代全量文档里挑出要 upsert 的写进差量；同一 id 出现多次时取最后一份（与 Meili 按主键覆盖一致）
        const picked = new Map();
        if (d.upsert.size) {
            await readJsonlGz(join(newDir, 'docs', `${idx}.jsonl.gz`), {
                batchSize: 5000,
                onBatch: async (docs) => { for (const doc of docs) if (d.upsert.has(doc?.id)) picked.set(doc.id, doc); },
            });
            if (picked.size !== d.upsert.size) throw new Error(`${idx}: 哈希表里要 upsert ${d.upsert.size} 条，文档文件里只找到 ${picked.size} 条（产物不一致）`);
        }
        const tmp = join(outDir, 'docs', `${idx}.jsonl.gz.tmp`);
        const gz = createGzip({ level: 6 });
        const out = createWriteStream(tmp);
        const h = createHash('sha256');
        gz.on('data', (c) => h.update(c));
        gz.pipe(out);
        for (const doc of picked.values()) if (!gz.write(JSON.stringify(doc) + '\n')) await once(gz, 'drain');
        gz.end();
        await once(out, 'finish');
        renameSync(tmp, join(outDir, 'docs', `${idx}.jsonl.gz`));
        upserts[idx] = picked.size;
        sha256[idx] = h.digest('hex');
    }

    const manifest = {
        schema: 1,
        mode: 'incremental',
        createdAtEpoch: Date.now(),
        createdAt: new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)',
        indexerVersion: next.indexerVersion,
        renderRunId: next.renderRunId,
        commits: next.commits,
        base: { renderRunId: base.renderRunId, indexerVersion: base.indexerVersion, commits: base.commits },
        expectedCounts, upserts, deletes, sha256, ratios,
        editionStats: next.editionStats,
    };
    writeFileSync(join(outDir, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
    renameSync(join(outDir, 'manifest.json.tmp'), join(outDir, 'manifest.json'));   // 最后落盘＝完整性标记
    return { manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const a = process.argv.slice(2);
    const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
    const newDir = arg('--new'), baseDir = arg('--base'), outDir = arg('--out');
    const maxRatio = arg('--max-ratio') ? Number(arg('--max-ratio')) : 0.3;
    if (!newDir || !outDir || !(maxRatio > 0)) { console.error('用法：diff-docs.mjs --new <dir> --base <dir> --out <dir> [--max-ratio 0.3]'); process.exit(1); }
    let r;
    try {
        r = await diffDocs({ newDir, baseDir, outDir, maxRatio, allowVersionChange: a.includes('--allow-version-change'), allowHighRatio: a.includes('--allow-high-ratio') });
    } catch (e) {
        console.error(`❌ ${e.message}`);
        process.exit(1);
    }
    if (r.fallback) fallback(r.fallback, r.why);
    const total = Object.values(r.manifest.upserts).reduce((x, y) => x + y, 0) + Object.values(r.manifest.deletes).reduce((x, y) => x + y, 0);
    setOutput('delta_total', total);
    console.log(`✅ 差量：upsert ${JSON.stringify(r.manifest.upserts)} delete ${JSON.stringify(r.manifest.deletes)}（基线 run ${r.manifest.base.renderRunId} → run ${r.manifest.renderRunId}）`);
}
