/**
 * search-ingest：搜索机侧把 render-docs／diff-docs 的产物灌进 Postgres（与 indexer/ingest.mjs 同一套产物、同一套校验）。
 *
 *   全量   node ingest-pg.mjs --docs <render-docs 输出>
 *   增量   node ingest-pg.mjs --incremental <diff-docs 输出>
 *   公共   [--state /opt/search-pg/state.json] [--lock /opt/search-pg/.lock] [--sql ../sql] [--allow-shrink]
 *   环境   PGHOST／PGPORT／PGDATABASE／PGUSER／PGPASSWORD（search_ingest）、SEARCH_READ_ROLE（默认 search_ro）
 *
 * 全量：取锁 → 校验 manifest → 空 schema search_new（psql 跑 schema.sql）→ 逐索引灌（边读边校验 sha256／行数）→ 建索引、函数、授权 →
 *       自检（条数＝manifest、各类能搜出东西）→ 一个事务里 search→search_old、search_new→search，删旧 → 写 state。失败线上不动。
 * 增量：校验差量基线＝state → 先删后 upsert（单批一个事务）→ 条数＝expectedCounts → 写 state；重跑幂等。
 * juans 不入（前端没有调用）。退出码同 indexer/ingest.mjs：1 失败／6 锁被占／8 校验不过。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { PG_INDEXES, KIND_BY_INDEX, docToRow } from './pg-rows.mjs';
import { EXIT, acquireLock, manifestProblems, readJsonlGz, readState, writeState } from '../../indexer/lib/ingest-support.mjs';
import { deltaProblems } from '../../indexer/lib/doc-diff.mjs';

const a = process.argv.slice(2);
const arg = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const docsRoot = arg('--docs');
const deltaRoot = arg('--incremental');
const statePath = arg('--state', '/opt/search-pg/state.json');
const lockPath = arg('--lock', '/opt/search-pg/.lock');
const sqlDir = resolve(arg('--sql', new URL('../sql', import.meta.url).pathname));
const allowShrink = a.includes('--allow-shrink');
const allowOlder = a.includes('--allow-older');
const READ_ROLE = process.env.SEARCH_READ_ROLE || 'search_ro';
const BATCH = 2000;

if ([docsRoot, deltaRoot].filter(Boolean).length !== 1) { console.error('--docs／--incremental 二选一'); process.exit(1); }
if (!/^[a-z_][a-z0-9_]*$/.test(READ_ROLE)) { console.error('SEARCH_READ_ROLE 不合法'); process.exit(1); }

const lock = acquireLock(lockPath, { run: process.env.GITHUB_RUN_ID || null, task: 'ingest-pg' });
if (lock.busy) { console.error(`🔒 锁被占，退出（码 ${EXIT.LOCK_BUSY}）：${JSON.stringify(lock.busy)}`); process.exit(EXIT.LOCK_BUSY); }
process.on('exit', () => lock.release());
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

const client = new pg.Client();

// ─── 写库 ───

const UPSERT = (schema) => `
INSERT INTO ${schema}.search_doc (kind,id,title,author,dynasty,classification,loss_status,subtype,has_text,has_image,has_collated,
  completeness,title_chars,era_rank,title_sort,office_ids,title_tsv,title_bkt,name_tsv,desc_tsv,descr,payload)
SELECT r.kind, r.id, r.title, r.author, r.dynasty, r.classification, r.loss_status, r.subtype, r.has_text, r.has_image, r.has_collated,
  r.completeness, r.title_chars, r.era_rank, r.title_sort, ARRAY(SELECT jsonb_array_elements_text(r.office_ids)),
  array_to_tsvector(ARRAY(SELECT jsonb_array_elements_text(r.title_tok))),
  array_to_tsvector(ARRAY(SELECT lpad(least(r.title_chars, 40)::text, 2, '0') || '|' || t FROM jsonb_array_elements_text(r.title_tok) t)),
  array_to_tsvector(ARRAY(SELECT jsonb_array_elements_text(r.name_tok))),
  array_to_tsvector(ARRAY(SELECT jsonb_array_elements_text(r.desc_tok))),
  r.descr, r.payload
FROM jsonb_to_recordset($1::jsonb) AS r(kind text,id text,title text,author text,dynasty text,classification text,loss_status text,subtype text,
  has_text bool,has_image bool,has_collated bool,completeness int,title_chars int,era_rank int,title_sort text,office_ids jsonb,
  title_tok jsonb,name_tok jsonb,desc_tok jsonb,descr text,payload jsonb)
ON CONFLICT (kind, id) DO UPDATE SET title=EXCLUDED.title, author=EXCLUDED.author, dynasty=EXCLUDED.dynasty, classification=EXCLUDED.classification,
  loss_status=EXCLUDED.loss_status, subtype=EXCLUDED.subtype, has_text=EXCLUDED.has_text, has_image=EXCLUDED.has_image, has_collated=EXCLUDED.has_collated,
  completeness=EXCLUDED.completeness, title_chars=EXCLUDED.title_chars, era_rank=EXCLUDED.era_rank, title_sort=EXCLUDED.title_sort,
  office_ids=EXCLUDED.office_ids, title_tsv=EXCLUDED.title_tsv, title_bkt=EXCLUDED.title_bkt, name_tsv=EXCLUDED.name_tsv, desc_tsv=EXCLUDED.desc_tsv,
  descr=EXCLUDED.descr, payload=EXCLUDED.payload`;

async function upsertBatch(schema, index, docs) {
    const rows = docs.map((d) => docToRow(index, d));
    await client.query('BEGIN');
    try {
        await client.query(UPSERT(schema), [JSON.stringify(rows)]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    }
}

async function countOf(schema, index) {
    const r = await client.query(`SELECT count(*)::int n FROM ${schema}.search_doc WHERE kind = $1`, [KIND_BY_INDEX[index]]);
    return r.rows[0].n;
}

function psql(file, schema) {
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `schema=${schema}`, '-f', join(sqlDir, file)], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function bad(problems) {
    console.error('❌ 入库前校验不过（线上不动）：');
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(EXIT.MANIFEST_BAD);
}
const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Los_Angeles' }) + ' (America/Los_Angeles)';

// ─── 全量 ───

async function full() {
    const manifestPath = join(docsRoot, 'manifest.json');
    if (!existsSync(manifestPath)) bad([`${manifestPath} 不存在（render-docs 未完成？）`]);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const problems = manifestProblems(manifest, { requireIndexes: PG_INDEXES });
    for (const i of PG_INDEXES) if (!existsSync(join(docsRoot, 'docs', `${i}.jsonl.gz`))) problems.push(`docs/${i}.jsonl.gz 不存在`);
    if (problems.length) bad(problems);
    const prev = readState(statePath);
    if (!allowOlder && prev?.manifestCreatedAtEpoch && manifest.createdAtEpoch && manifest.createdAtEpoch < prev.manifestCreatedAtEpoch) {
        bad([`manifest.createdAt ${manifest.createdAt} 早于上次入库的 ${prev.manifestCreatedAt}（确需回退加 --allow-older）`]);
    }
    console.log(`manifest OK：indexerVersion=${manifest.indexerVersion} counts=${JSON.stringify(manifest.counts)}`);

    const t0 = Date.now();
    psql('schema.sql', 'search_new');
    for (const idx of PG_INDEXES) {
        let pushed = 0;
        const r = await readJsonlGz(join(docsRoot, 'docs', `${idx}.jsonl.gz`), {
            batchSize: BATCH,
            onBatch: async (docs) => {
                await upsertBatch('search_new', idx, docs);
                pushed += docs.length;
                if (pushed % 100000 < docs.length) console.log(`  [${idx}] ${pushed}／${manifest.counts[idx]}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
            },
        });
        if (r.sha256 !== manifest.sha256[idx] || r.count !== manifest.counts[idx]) {
            await client.query('DROP SCHEMA IF EXISTS search_new CASCADE');
            bad([`${idx}: 文件校验不过（sha256 ${r.sha256 === manifest.sha256[idx] ? '一致' : '不一致'}，行数 ${r.count} vs ${manifest.counts[idx]}）`]);
        }
    }
    console.log('灌完，建索引、函数…');
    psql('indexes.sql', 'search_new');
    psql('functions.sql', 'search_new');
    await client.query(`GRANT USAGE ON SCHEMA search_new TO ${READ_ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA search_new TO ${READ_ROLE}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA search_new TO ${READ_ROLE}`);

    const failures = await selfCheck('search_new', manifest.counts, prev?.counts);
    if (failures.length) {
        console.error('❌ 自检未通过，search_new 已丢弃，线上仍是旧一代：');
        for (const f of failures) console.error(`   · ${f}`);
        await client.query('DROP SCHEMA IF EXISTS search_new CASCADE');
        process.exit(1);
    }
    await client.query('BEGIN');
    await client.query('DROP SCHEMA IF EXISTS search_old CASCADE');
    await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='search') THEN ALTER SCHEMA search RENAME TO search_old; END IF; END $$`);
    await client.query('ALTER SCHEMA search_new RENAME TO search');
    await client.query('COMMIT');
    await client.query('DROP SCHEMA IF EXISTS search_old CASCADE');
    await setMeta('search', manifest, 'full');
    writeState(statePath, {
        schema: 1, mode: 'full', updatedAt: now(), indexerVersion: manifest.indexerVersion, renderRunId: manifest.renderRunId ?? null,
        manifestCreatedAt: manifest.createdAt ?? null, manifestCreatedAtEpoch: manifest.createdAtEpoch ?? null,
        commits: manifest.commits, counts: pickCounts(manifest.counts), previous: prev?.commits ?? null,
    });
    console.log(`✅ 全量完成（${((Date.now() - t0) / 1000).toFixed(0)}s）：${JSON.stringify(pickCounts(manifest.counts))}`);
}

const pickCounts = (c) => Object.fromEntries(PG_INDEXES.map((i) => [i, c?.[i] ?? null]));

/** 自检：每类条数＝期望；不比上一代少过 5%（除非 --allow-shrink）；各类都能搜出东西（用库里取的一条书名当查询） */
async function selfCheck(schema, expected, prevCounts) {
    const failures = [];
    for (const idx of PG_INDEXES) {
        const n = await countOf(schema, idx);
        if (n !== expected[idx]) failures.push(`[${idx}] 库里 ${n} 条，应为 ${expected[idx]} 条`);
        if (!allowShrink && prevCounts?.[idx] && n < prevCounts[idx] * 0.95) failures.push(`[${idx}] ${n} 条，比上一代 ${prevCounts[idx]} 少于 95%（确认无误加 --allow-shrink）`);
        if (n > 0) {
            const s = await client.query(`SELECT title FROM ${schema}.search_doc WHERE kind = $1 AND title <> '' LIMIT 1`, [KIND_BY_INDEX[idx]]);
            const q = Array.from(s.rows[0]?.title || '').slice(0, 2).join('');
            if (q) {
                await client.query('BEGIN');
                await client.query(`SET LOCAL search_path TO ${schema}, public`);
                const hit = await client.query('SELECT jsonb_array_length(search_one($1, $2, 5, 0)->\'hits\') n', [KIND_BY_INDEX[idx], q]);
                await client.query('ROLLBACK');
                if (!(hit.rows[0].n > 0)) failures.push(`[${idx}] 查询「${q}」没有命中`);
            }
        }
    }
    return failures;
}

async function setMeta(schema, m, mode) {
    await client.query(
        `INSERT INTO ${schema}.search_meta (k, v) VALUES ('ingest', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
        [JSON.stringify({ mode, renderRunId: m.renderRunId ?? null, indexerVersion: m.indexerVersion, commits: m.commits ?? null, at: new Date().toISOString() })],
    );
}

// ─── 增量 ───

async function incremental() {
    const delta = JSON.parse(readFileSync(join(deltaRoot, 'manifest.json'), 'utf-8'));
    const state = readState(statePath);
    const indexes = PG_INDEXES.filter((i) => typeof delta.expectedCounts?.[i] === 'number');
    const problems = deltaProblems(delta, state, { indexes });
    for (const i of indexes) {
        if (delta.upserts[i] > 0 && !existsSync(join(deltaRoot, 'docs', `${i}.jsonl.gz`))) problems.push(`docs/${i}.jsonl.gz 不存在`);
        if (!existsSync(join(deltaRoot, 'deletes', `${i}.json`))) problems.push(`deletes/${i}.json 不存在`);
    }
    if (problems.length) bad(problems);
    console.log(`差量 OK：run ${delta.base.renderRunId} → ${delta.renderRunId}；upsert ${JSON.stringify(delta.upserts)} delete ${JSON.stringify(delta.deletes)}`);

    const t0 = Date.now();
    for (const idx of indexes) {
        const ids = JSON.parse(readFileSync(join(deltaRoot, 'deletes', `${idx}.json`), 'utf-8'));
        if (ids.length !== delta.deletes[idx]) bad([`${idx}: deletes 文件 ${ids.length} 条，manifest 记 ${delta.deletes[idx]} 条`]);
        for (let k = 0; k < ids.length; k += 1000) {
            await client.query('DELETE FROM search.search_doc WHERE kind = $1 AND id = ANY($2::text[])', [KIND_BY_INDEX[idx], ids.slice(k, k + 1000)]);
        }
        if (delta.upserts[idx] > 0) {
            const r = await readJsonlGz(join(deltaRoot, 'docs', `${idx}.jsonl.gz`), { batchSize: BATCH, onBatch: (docs) => upsertBatch('search', idx, docs) });
            if (r.sha256 !== delta.sha256[idx] || r.count !== delta.upserts[idx]) {
                console.error(`❌ ${idx}: 差量文件校验不过，state 不推进（已打进去的 upsert 幂等，重跑会收敛）`);
                process.exit(EXIT.MANIFEST_BAD);
            }
        }
        console.log(`  [${idx}] 删 ${ids.length}，upsert ${delta.upserts[idx]}`);
    }
    const failures = [];
    for (const idx of indexes) {
        const n = await countOf('search', idx);
        if (n !== delta.expectedCounts[idx]) failures.push(`[${idx}] 库里 ${n} 条，按差量应为 ${delta.expectedCounts[idx]} 条（与基线不一致，需要全量对账）`);
    }
    if (failures.length) {
        console.error('❌ 增量打完后自检未通过（state 未推进）：');
        for (const f of failures) console.error(`   · ${f}`);
        process.exit(1);
    }
    await client.query('ANALYZE search.search_doc');
    await setMeta('search', delta, 'incremental');
    writeState(statePath, {
        schema: 1, mode: 'incremental', updatedAt: now(), indexerVersion: delta.indexerVersion, renderRunId: delta.renderRunId,
        manifestCreatedAt: delta.createdAt ?? null, manifestCreatedAtEpoch: delta.createdAtEpoch ?? null,
        commits: delta.commits, counts: pickCounts(delta.expectedCounts), previous: state?.commits ?? null,
    });
    console.log(`✅ 增量完成（${((Date.now() - t0) / 1000).toFixed(1)}s），state 推进到 run ${delta.renderRunId}`);
}

// ─── 入口（放最后：上面的 const 要先初始化）───
await client.connect();
try {
    if (deltaRoot) await incremental(); else await full();
} catch (e) {
    console.error('FATAL:', e);
    process.exitCode = 1;
} finally {
    await client.end().catch(() => {});
}
