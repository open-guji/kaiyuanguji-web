// ingest.mjs --incremental／--adopt 端到端：起一个假的 Meili（只实现用到的几个接口），子进程跑 ingest。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from './meili-ops.mjs';
import { diffDocs } from '../diff-docs.mjs';
import { docHash, writeJsonGz } from './doc-diff.mjs';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const INGEST = fileURLToPath(new URL('../ingest.mjs', import.meta.url));

function fakeMeili(initial) {
    const idx = Object.fromEntries(Object.entries(initial).map(([k, docs]) => [k, new Map(docs.map((d) => [d.id, d]))]));
    const calls = [];
    let task = 0;
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const url = new URL(req.url, 'http://x');
        const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        let m;
        calls.push(`${req.method} ${url.pathname}`);
        if (req.method === 'GET' && url.pathname.startsWith('/tasks/')) return send({ status: 'succeeded' });
        if ((m = url.pathname.match(/^\/indexes\/(\w+)\/documents\/delete-batch$/))) {
            for (const id of JSON.parse(body)) idx[m[1]]?.delete(id);
            return send({ taskUid: ++task });
        }
        if ((m = url.pathname.match(/^\/indexes\/(\w+)\/documents$/)) && req.method === 'POST') {
            idx[m[1]] ??= new Map();
            for (const d of JSON.parse(body)) idx[m[1]].set(d.id, d);
            return send({ taskUid: ++task });
        }
        if ((m = url.pathname.match(/^\/indexes\/(\w+)\/stats$/))) return idx[m[1]] ? send({ numberOfDocuments: idx[m[1]].size }) : send({ message: 'nope' }, 404);
        if ((m = url.pathname.match(/^\/indexes\/(\w+)\/settings$/))) return send(SETTINGS[m[1]]);
        if ((m = url.pathname.match(/^\/indexes\/(\w+)\/search$/))) return send({ estimatedTotalHits: idx[m[1]]?.size ?? 0, hits: [] });
        send({ message: `unhandled ${req.method} ${url.pathname}` }, 500);
    });
    return { server, idx, calls };
}

function run(args, env) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [INGEST, ...args], { env: { ...process.env, ...env } });
        let out = '';
        p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
        p.on('close', (code) => resolve({ code, out }));
    });
}

async function writeJsonl(path, docs) {
    const gz = createGzip(); const out = createWriteStream(path); gz.pipe(out);
    for (const d of docs) gz.write(JSON.stringify(d) + '\n');
    gz.end(); await once(out, 'finish');
}

// 只有 works 有内容，其余四个索引是空的（manifest 校验要求五个都在）
async function fakeRender(dir, runId, works) {
    mkdirSync(join(dir, 'docs'), { recursive: true }); mkdirSync(join(dir, 'hashes'), { recursive: true });
    const all = { works, juans: [], books: [], collections: [], entities: [] };
    for (const [i, docs] of Object.entries(all)) {
        await writeJsonl(join(dir, 'docs', `${i}.jsonl.gz`), docs);
        await writeJsonGz(join(dir, 'hashes', `${i}.json.gz`), Object.fromEntries(docs.map((d) => [d.id, docHash(d)])));
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, indexerVersion: 'v1', renderRunId: runId, createdAtEpoch: 1,
        commits: { draft: 'd', prod: runId, text: 't', derived: runId },
        counts: Object.fromEntries(Object.entries(all).map(([i, d]) => [i, d.length])),
        sha256: Object.fromEntries(Object.keys(all).map((i) => [i, 'a'.repeat(64)])),
        editionStats: { total: 10, present: 10, positive: 5 }, partial: false }));
}

const w = (id, t) => ({ id, type: 'work', is_draft: false, classification: '史部', t });

async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'inc-'));
    const baseWorks = [w('a', 1), w('b', 2), w('c', 3)];
    await fakeRender(join(root, 'base'), '10', baseWorks);
    await fakeRender(join(root, 'new'), '20', [w('a', 1), w('b', 9), w('d', 4)]);
    await diffDocs({ newDir: join(root, 'new'), baseDir: join(root, 'base'), outDir: join(root, 'delta'), maxRatio: 1 });
    const meili = fakeMeili({ works: baseWorks, juans: [], books: [], collections: [], entities: [] });
    await new Promise((r) => meili.server.listen(0, '127.0.0.1', r));
    const env = { MEILI_URL: `http://127.0.0.1:${meili.server.address().port}`, MEILI_KEY: 'k' };
    const common = ['--state', join(root, 'state.json'), '--lock', join(root, '.lock')];
    return { root, meili, env, common };
}

test('认领一代基线后打增量：删 c、改 b、加 d，自检过了才推进 state', async () => {
    const { root, meili, env, common } = await setup();
    try {
        let r = await run(['--adopt', join(root, 'base'), ...common], env);
        assert.equal(r.code, 0, r.out);
        assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf-8')).renderRunId, '10');
        assert.ok(!meili.calls.length, '认领不碰 Meili');

        r = await run(['--incremental', join(root, 'delta'), ...common], env);
        assert.equal(r.code, 0, r.out);
        assert.deepEqual([...meili.idx.works.keys()].sort(), ['a', 'b', 'd']);
        assert.equal(meili.idx.works.get('b').t, 9);
        const st = JSON.parse(readFileSync(join(root, 'state.json'), 'utf-8'));
        assert.equal(st.renderRunId, '20'); assert.equal(st.mode, 'incremental');
        assert.ok(!meili.calls.some((c) => c.includes('_tmp') || c.includes('swap')), '增量不建 tmp、不 swap');
        assert.ok(!existsSync(join(root, '.lock')), '锁已释放');

        // 同一份差量再打一次：基线已经是 20，不能再打
        r = await run(['--incremental', join(root, 'delta'), ...common], env);
        assert.equal(r.code, 8, r.out);
        assert.match(r.out, /基线对不上/);
    } finally { meili.server.close(); }
});

test('线上与基线不一致（条数对不上）：自检不过，state 不推进', async () => {
    const { root, meili, env, common } = await setup();
    try {
        await run(['--adopt', join(root, 'base'), ...common], env);
        meili.idx.works.set('zzz', w('zzz', 0));   // 线上多了一条基线里没有的
        const r = await run(['--incremental', join(root, 'delta'), ...common], env);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /按差量应为 3 条/);
        assert.equal(JSON.parse(readFileSync(join(root, 'state.json'), 'utf-8')).renderRunId, '10');
    } finally { meili.server.close(); }
});

test('没有 state（从没认领／全量过）：拒绝增量', async () => {
    const { root, meili, env, common } = await setup();
    try {
        const r = await run(['--incremental', join(root, 'delta'), ...common], env);
        assert.equal(r.code, 8, r.out);
        assert.match(r.out, /STATE_MISSING_OR_CORRUPT/);
        assert.equal(meili.idx.works.size, 3, '线上没动');
    } finally { meili.server.close(); }
});
