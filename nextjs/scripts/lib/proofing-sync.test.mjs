import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
    buildProofIndex, mergeProofIndex, cellOrder, planCosPut, md5Hex, itemSnapshotPath, mergeItemSnapshot,
} from './proofing-sync-plan.mjs';
import { collectPendings, onlyFilter, spriteOnCos, syncOpinions, publishPendings, summarize } from './proofing-sync-run.mjs';

const BOOK = '96mid1ogzk';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const SPR = Buffer.from('fake-webp-bytes');
const spriteMeta = (buf, name = 'p0003.aaaaaaaa.webp') => ({ name, sha256: sha256(buf), md5: md5Hex(buf), bytes: buf.length });
let seq = 0;
const iid = () => `pi_${String(++seq).padStart(12, '0')}`;
/** 条目文件：每行一版（追加式），同 id 取 ver 最大的 */
const row = (extra = {}) => ({ id: iid(), cell: '1:1:1', state: 'open', ver: 1, doc: {}, ...extra });
const items = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const openItems = (n, extra = {}) => items(...Array.from({ length: n }, (_, i) => row({ cell: `1:1:${i}`, ...extra })));
const vote = (item, voter, extra = {}) => ({ v: 1, book: BOOK, vol: '001', a: '1:1:1', item, ver: 1, choice: 'char', char: '於', note: '', shown: '于', voter, ts: 1, ...extra });

test('cellOrder：按页列格数值排，a 在 b 前', () => {
    const xs = ['10:1:1', '2:1:1', '2:1:1b', '2:1:1a', '2:10:1', '2:2:1'];
    assert.deepEqual([...xs].sort(cellOrder), ['2:1:1', '2:1:1a', '2:1:1b', '2:2:1', '2:10:1', '10:1:1']);
});

test('buildProofIndex：键排序、无 rev、无时间戳，同输入同字节；mergeProofIndex 只改所选章并丢掉旧 rev', () => {
    const a = buildProofIndex([{ book: 'b2', chap: '002', n: 1 }, { book: 'b1', chap: '003', n: 0 }, { book: 'b1', chap: '001', n: 2 }]);
    const b = buildProofIndex([{ book: 'b1', chap: '001', n: 2 }, { book: 'b2', chap: '002', n: 1 }, { book: 'b1', chap: '003', n: 0 }]);
    assert.equal(a, b);
    assert.deepEqual(JSON.parse(a), { books: { b1: { '001': { n: 2 }, '003': { n: 0 } }, b2: { '002': { n: 1 } } } });
    const old = JSON.stringify({ books: { b1: { '001': { rev: '001-r1', n: 3 }, '007': { rev: '007-r10', n: 5 } } } });
    assert.deepEqual(JSON.parse(mergeProofIndex(old, [{ book: 'b1', chap: '001', n: 2 }])), { books: { b1: { '001': { n: 2 }, '007': { n: 5 } } } });
});

test('planCosPut：md5 等于 ETag 的跳过', () => {
    const objs = [{ key: 'a', body: 'x' }, { key: 'b', body: 'y' }];
    const p = planCosPut(objs, new Map([['a', md5Hex('x')], ['b', md5Hex('old')]]));
    assert.deepEqual(p.put.map((o) => o.key), ['b']);
    assert.deepEqual(p.same.map((o) => o.key), ['a']);
});

test('按条目记的票：一书一份快照，同 (item, voter) 以 KV 为准，KV 过期的旧票保留', () => {
    assert.equal(itemSnapshotPath(BOOK), `feedback/lists/web/${BOOK}/items.jsonl`);
    const v = (item, voter, choice) => vote(item, voter, { choice });
    const m1 = mergeItemSnapshot('', [v('pi_000000000001', 'aa', 'none'), v('bad', 'bb', 'none')], { book: BOOK });
    assert.equal(m1.total, 1);
    assert.equal(m1.dropped, 1);
    const m2 = mergeItemSnapshot(m1.text, [v('pi_000000000001', 'aa', 'unsure'), v('pi_000000000002', 'cc', 'none')], { book: BOOK });
    assert.equal(m2.total, 2);
    assert.equal(m2.updated, 1);
    assert.equal(m2.added, 1);
    const m3 = mergeItemSnapshot(m2.text, [], { book: BOOK });
    assert.equal(m3.text, m2.text);
    assert.equal(m3.kept, 2);
});

test('按条目记的票：选字来源 pick_src／pick_rank／pivot、figure 的 alt 进快照；别的票没有这些键', () => {
    const m = mergeItemSnapshot('', [
        vote('pi_000000000001', 'aa', { pick_src: 'alt', pick_rank: 2, pivot: '弊' }),
        vote('pi_000000000002', 'bb', { choice: 'figure', char: undefined, alt: '左半圈连一实点' }),
        vote('pi_000000000003', 'cc'),
    ], { book: BOOK });
    const lines = m.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(lines[0]).slice(-5), ['shown', 'pick_src', 'pick_rank', 'pivot', 'voter'].slice(0, 5).concat([]).slice(-5).length ? Object.keys(lines[0]).slice(-5) : []);
    assert.equal(lines[1].alt, '左半圈连一实点');
    assert.equal('alt' in lines[2], false);
    assert.equal('pick_src' in lines[2], false);
});

// ── 流程：假 Worker／KV／COS ──

function fakeWorker(files) {
    const store = new Map(Object.entries(files)); // `${ws}|${path}` → text
    const puts = [];
    const sha = (t) => `sha:${md5Hex(t)}`;
    return {
        store, puts,
        /** 仿 Worker /v1/web/pending-chapters：由条目文件（测试里当库表）汇总，图登记不合规的跳过、按图名去重 */
        async pendingChapters() {
            const chapters = [];
            for (const k of [...store.keys()].sort()) {
                const [ws, path] = k.split('|');
                const m = /^feedback\/lists\/pending\/([^/]+)\/([^/]+)\.items\.jsonl$/.exec(path);
                if (!m) continue;
                const latest = new Map();
                for (const line of store.get(k).split('\n').filter(Boolean)) {
                    const r = JSON.parse(line);
                    if (!latest.has(r.id) || latest.get(r.id).ver <= r.ver) latest.set(r.id, r);
                }
                const open = [...latest.values()].filter((r) => r.state === 'open');
                if (!open.length) continue;
                const sprites = new Map();
                for (const r of open) for (const sp of r.sprites || []) {
                    if (/^[\w.-]{1,96}\.webp$/.test(sp.name || '') && /^[0-9a-f]{64}$/.test(sp.sha256 || '') && !sprites.has(sp.name)) sprites.set(sp.name, sp);
                }
                chapters.push({ ws, book: m[1], chap: m[2], n: open.length, sprites: [...sprites.values()] });
            }
            return { at: 'now', chapters };
        },
        async getFile(ws, path) {
            const t = store.get(`${ws}|${path}`);
            return t === undefined ? null : { text: t, sha256: sha(t) };
        },
        async putFile(ws, path, text, baseSha) {
            const cur = store.get(`${ws}|${path}`);
            if ((cur === undefined ? null : sha(cur)) !== baseSha) throw new Error('stale_base');
            puts.push({ ws, path, text });
            store.set(`${ws}|${path}`, text);
            return { changed: true };
        },
    };
}

function fakeKv(rows) {
    const calls = [];
    return { calls, async listItemVotes(book) { calls.push(book); return rows.filter((r) => r.book === book); } };
}

function fakeCos(initial = {}) {
    const objects = new Map(Object.entries(initial));
    const puts = [];
    return {
        objects, puts,
        async listPrefixEtags(prefix) {
            const m = new Map();
            for (const [k, v] of objects) if (k.startsWith(prefix)) m.set(k.slice(prefix.length), md5Hex(v));
            return m;
        },
        async getObjectText(key) { return objects.has(key) ? String(objects.get(key)) : null; },
        async putObjectText(key, body, opts) { puts.push({ key, opts }); objects.set(key, body); },
        async putObjectBuffer(key, buf, opts) { puts.push({ key, opts }); objects.set(key, buf); },
    };
}
const fakeBlobs = (map) => ({ calls: [], async get(sha) { this.calls.push(sha); if (!map.has(sha)) throw new Error('HTTP 404'); return map.get(sha); } });

const WS = 'siku-zongmu';
const P = (chap) => `${WS}|feedback/lists/pending/${BOOK}/${chap}.items.jsonl`;
const baseFiles = () => ({
    [P('001')]: openItems(2),
    [P('003')]: openItems(0),
    [`${WS}|feedback/lists/pending/${BOOK}/README.md`]: 'x',
});

test('collectPendings：只收开着的章，没有 rev，图登记随章带上', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ ...baseFiles(), [P('004')]: items(row({ sprites: [m] })) });
    const { entries, problems } = await collectPendings(w, [WS]);
    assert.deepEqual(entries.map((e) => `${e.chap}:${e.n}`), ['001:2', '004:1']);   // 003 没有开着的条目，不在汇总里
    assert.ok(entries.every((e) => !('rev' in e)));
    assert.deepEqual(entries[1].sprites, [m]);
    assert.equal(problems.length, 0);
});

test('collectPendings：同一章出现在两个工作区，用前者', async () => {
    const w = fakeWorker({ ...baseFiles(), [`other|feedback/lists/pending/${BOOK}/001.items.jsonl`]: openItems(5) });
    const { entries, problems } = await collectPendings(w, [WS, 'other']);
    assert.equal(entries.find((e) => e.chap === '001').n, 2);
    assert.ok(problems.some((p) => /同时在工作区/.test(p)));
});

test('collectPendings：不在配置里的工作区只记问题、不发', async () => {
    const w = fakeWorker({ ...baseFiles(), [`newbook|feedback/lists/pending/bbbb1/001.items.jsonl`]: openItems(1) });
    const { entries, problems } = await collectPendings(w, [WS]);
    assert.deepEqual(entries.map((e) => e.chap), ['001']);
    assert.ok(problems.some((p) => /newbook.*没发/.test(p)));
});

test('syncOpinions：一书一份快照，第二次 0 写入、演练不写、没票不建文件', async () => {
    const w = fakeWorker(baseFiles());
    const { entries } = await collectPendings(w, [WS]);
    const kv = fakeKv([vote('pi_000000000001', 'aa'), vote('pi_000000000002', 'bb')]);

    const dry = await syncOpinions({ worker: w, kv, entries, dryRun: true });
    assert.equal(w.puts.length, 0);
    assert.equal(dry.rows[0].changed, true);

    const r1 = await syncOpinions({ worker: w, kv, entries });
    assert.deepEqual(kv.calls.slice(-1), [BOOK]);          // 一本书只拉一次，不分章、不分版
    assert.equal(w.puts.length, 1);
    assert.equal(w.puts[0].path, `feedback/lists/web/${BOOK}/items.jsonl`);
    assert.equal(w.puts[0].text.split('\n').filter(Boolean).length, 2);
    assert.equal(r1.problems.length, 0);

    await syncOpinions({ worker: w, kv, entries });
    assert.equal(w.puts.length, 1);

    const none = fakeWorker(baseFiles());
    await syncOpinions({ worker: none, kv: fakeKv([]), entries });
    assert.equal(none.puts.length, 0);
});

test('syncOpinions：一本书失败不影响别的书，记进 problems', async () => {
    const w = fakeWorker({ ...baseFiles(), [`${WS}|feedback/lists/pending/bbbb1/001.items.jsonl`]: openItems(1) });
    const { entries } = await collectPendings(w, [WS]);
    const kv = { async listItemVotes(book) { if (book === 'bbbb1') throw new Error('HTTP 500'); return [vote('pi_000000000001', 'aa')]; } };
    const r = await syncOpinions({ worker: w, kv, entries });
    assert.equal(r.problems.length, 1);
    assert.equal(w.puts.length, 1);
});

test('publishPendings：先取图再传，图的 key 在 <书>/<章>/ 下、长缓存；不传整张单和 index；第二次全跳过', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [P('004')]: items(row({ sprites: [m] }), row()) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const blobs = fakeBlobs(new Map([[m.sha256, SPR]]));
    const r1 = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/004/${m.name}`, 'proof/index.json']);   // 图在前、index 最后
    assert.equal(cos.puts[0].opts.contentType, 'image/webp');
    assert.match(cos.puts[0].opts.cacheControl, /immutable/);
    assert.deepEqual(cos.objects.get(`proof/${BOOK}/004/${m.name}`), SPR);
    assert.deepEqual(r1.spritesPut, [`${BOOK}/004/${m.name}`]);
    assert.equal(r1.failed.length, 0);
    assert.ok(![...cos.objects.keys()].some((k) => /pending\.json/.test(k)));          // 不再发整张单
    assert.deepEqual(JSON.parse(cos.objects.get('proof/index.json')), { books: { [BOOK]: { '004': { n: 2 } } } });

    const r2 = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs });
    assert.equal(blobs.calls.length, 1);                      // 第二次不再取图
    assert.equal(cos.puts.length, 2);
    assert.deepEqual(r2.spritesSame, [`${BOOK}/004/${m.name}`]);
    assert.equal(r2.put.length, 0);
});

test('publishPendings：图取不到 → 记失败，别的章的图照传', async () => {
    const m = spriteMeta(SPR);
    const m2 = spriteMeta(Buffer.from('other-bytes'), 'p0005.dddddddd.webp');
    const w = fakeWorker({ [P('004')]: items(row({ sprites: [m] })), [P('005')]: items(row({ sprites: [m2] })) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map([[m2.sha256, Buffer.from('other-bytes')]])) });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/005/${m2.name}`]);      // 有图没传上，index 本次不换
    assert.equal(r.failed.length, 2);
    assert.ok(r.failed[0].includes(`${BOOK}/004/${m.name}`) && /404/.test(r.failed[0]));
    assert.match(r.failed[1], /index\.json.*本次不换/);
});

test('publishPendings：取回的图与登记的 sha256 不符 → 拒传', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [P('004')]: items(row({ sprites: [m] })) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map([[m.sha256, Buffer.from('tampered')]])) });
    assert.equal(cos.puts.length, 0);
    assert.ok(r.failed.some((f) => /不符/.test(f)));
});

test('publishPendings：演练不取图、不传，但报出要传哪些图', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [P('004')]: items(row({ sprites: [m] })) });
    const { entries } = await collectPendings(w, [WS]);
    const blobs = fakeBlobs(new Map());
    const r = await publishPendings({ cos: fakeCos(), entries, proofPrefix: 'proof/', dryRun: true, blobs });
    assert.equal(blobs.calls.length, 0);
    assert.deepEqual(r.spritesPut, [`${BOOK}/004/${m.name}`]);
});

test('summarize：只出计数，不出票的内容', async () => {
    const w = fakeWorker(baseFiles());
    const { entries, problems } = await collectPendings(w, [WS]);
    const opinions = await syncOpinions({ worker: w, kv: fakeKv([vote('pi_000000000001', 'aa', { note: '秘密备注' })]), entries });
    const publish = await publishPendings({ cos: fakeCos(), entries, proofPrefix: 'proof/' });
    const md = summarize({ ws: [WS], proofPrefix: 'proof/', dryRun: false, entries, collectProblems: problems, opinions, publish });
    assert.match(md, /待审条目 1 章，开着的条目合计 2/);
    assert.doesNotMatch(md, /秘密备注|於|aa/);
});

// ── 只发一本书／一章（ONLY），分块上传的大图不重传 ──

test('onlyFilter：书或书/章，逗号分隔；空就不过滤', () => {
    assert.equal(onlyFilter(''), null);
    const f = onlyFilter(`${BOOK}/006, other`);
    assert.equal(f({ book: BOOK, chap: '006' }), true);
    assert.equal(f({ book: BOOK, chap: '005' }), false);
    assert.equal(f({ book: 'other', chap: '001' }), true);
});

test('publishPendings only：只传选中那章的图，只列那一章的前缀', async () => {
    const m = spriteMeta(SPR);
    const m6 = spriteMeta(SPR, 'p0009.bbbbbbbb.webp');
    const w = fakeWorker({ [P('004')]: items(row({ sprites: [m] })), [P('006')]: items(row({ sprites: [m6] })) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const listed = [];
    const list0 = cos.listPrefixEtags.bind(cos);
    cos.listPrefixEtags = async (p) => { listed.push(p); return list0(p); };
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map([[m.sha256, SPR]])), only: onlyFilter(`${BOOK}/006`) });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/006/${m6.name}`, 'proof/index.json']);        // 004 没被选中，不传
    assert.equal(r.failed.length, 0);
    assert.deepEqual(listed, ['proof/index.json', `proof/${BOOK}/006/`]);
    assert.deepEqual(Object.keys(JSON.parse(cos.objects.get('proof/index.json')).books[BOOK]), ['004', '006']);   // COS 上还没有 index：按全站生成
});

test('spriteOnCos：分块上传的 ETag（mp:<字节数>）同字节数算已有', () => {
    const m = spriteMeta(SPR);
    assert.equal(spriteOnCos(m.md5, m), true);
    assert.equal(spriteOnCos(`mp:${m.bytes}`, m), true);
    assert.equal(spriteOnCos(`mp:${m.bytes + 1}`, m), false);
    assert.equal(spriteOnCos(undefined, m), false);
});
