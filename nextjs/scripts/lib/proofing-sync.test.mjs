import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
    parsePendingPath, readPending, buildProofIndex, mergeSnapshot, cellOrder, planCosPut, md5Hex, webSnapshotPath, reissueHints,
} from './proofing-sync-plan.mjs';
import { collectPendings, onlyFilter, spriteOnCos, syncOpinions, publishPendings, summarize } from './proofing-sync-run.mjs';

const BOOK = '96mid1ogzk';
const pending = (rev, n) => JSON.stringify({ rev, cv_version: '0.2.0', cells: Array.from({ length: n }, (_, i) => ({ a: `1:1:${i}` })) });
const vote = (a, voter, extra = {}) => ({ v: 1, book: BOOK, vol: 'vol01', a, rev: '001-r2', choice: 'char', char: '於', note: '', shown: '于', voter, ts: 1, ...extra });

test('parsePendingPath：只认 proofing/<书>/<章>.pending.json', () => {
    assert.deepEqual(parsePendingPath(`feedback/lists/proofing/${BOOK}/001.pending.json`), { book: BOOK, chap: '001' });
    assert.equal(parsePendingPath(`feedback/lists/proofing/${BOOK}/001.json`), null);
    assert.equal(parsePendingPath(`feedback/lists/proofing/${BOOK}/x/001.pending.json`), null);
    assert.equal(parsePendingPath(`feedback/lists/web/${BOOK}/001.pending.json`), null);
    assert.equal(parsePendingPath(`feedback/lists/proofing/BAD!/001.pending.json`), null);
});

test('readPending：要 rev 与 cells', () => {
    assert.deepEqual(readPending(pending('001-r2', 3)), { rev: '001-r2', n: 3, sprites: [] });
    assert.ok(readPending('{').error);
    assert.ok(readPending('{"cells":[]}').error);
    assert.ok(readPending('{"rev":"x"}').error);
});

test('buildProofIndex：键排序、无时间戳，同输入同字节', () => {
    const a = buildProofIndex([{ book: 'b2', chap: '002', rev: 'r', n: 1 }, { book: 'b1', chap: '003', rev: 's', n: 0 }, { book: 'b1', chap: '001', rev: 't', n: 2 }]);
    const b = buildProofIndex([{ book: 'b1', chap: '001', rev: 't', n: 2 }, { book: 'b2', chap: '002', rev: 'r', n: 1 }, { book: 'b1', chap: '003', rev: 's', n: 0 }]);
    assert.equal(a, b);
    assert.deepEqual(JSON.parse(a), { books: { b1: { '001': { rev: 't', n: 2 }, '003': { rev: 's', n: 0 } }, b2: { '002': { rev: 'r', n: 1 } } } });
    assert.deepEqual(Object.keys(JSON.parse(a).books), ['b1', 'b2']);
});

test('cellOrder：按页列格数值排，a 在 b 前', () => {
    const xs = ['10:1:1', '2:1:1', '2:1:1b', '2:1:1a', '2:10:1', '2:2:1'];
    assert.deepEqual([...xs].sort(cellOrder), ['2:1:1', '2:1:1a', '2:1:1b', '2:2:1', '2:10:1', '10:1:1']);
});

test('mergeSnapshot：选字来源 pick_src／pick_rank／pivot 进快照，排在 shown 之后；旧票没有就不出现', () => {
    const g = { book: BOOK, rev: '001-r2' };
    const r = mergeSnapshot('', [vote('1:1:1', 'aa', { pick_src: 'alt', pick_rank: 2, pivot: '弊' }), vote('1:1:2', 'bb')], g);
    const [x, y] = r.text.trim().split('\n');
    assert.deepEqual(Object.keys(JSON.parse(x)).slice(-6), ['shown', 'pick_src', 'pick_rank', 'pivot', 'voter', 'ts']);
    assert.ok(!y.includes('pick_'));
});

test('mergeSnapshot：新票加入、重投覆盖、KV 过期的旧票保留、别的书和 rev 丢掉、排序稳定', () => {
    const g = { book: BOOK, rev: '001-r2' };
    const first = mergeSnapshot('', [vote('3:1:1', 'bb'), vote('3:1:1', 'aa'), vote('1:2:3', 'cc'), vote('1:1:1', 'dd', { rev: '001-r1' })], g);
    assert.equal(first.total, 3);
    assert.equal(first.added, 3);
    assert.equal(first.dropped, 1);
    const lines = first.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((r) => `${r.a}/${r.voter}`), ['1:2:3/cc', '3:1:1/aa', '3:1:1/bb']);
    assert.ok(first.text.endsWith('\n'));

    // 同样的 KV 再跑一次：字节不变
    assert.equal(mergeSnapshot(first.text, [vote('3:1:1', 'bb'), vote('3:1:1', 'aa'), vote('1:2:3', 'cc')], g).text, first.text);
    // KV 键序不同也一样
    const shuffled = { ts: 1, voter: 'cc', shown: '于', note: '', char: '於', choice: 'char', rev: '001-r2', a: '1:2:3', vol: 'vol01', book: BOOK, v: 1 };
    assert.equal(mergeSnapshot(first.text, [shuffled, vote('3:1:1', 'bb'), vote('3:1:1', 'aa')], g).text, first.text);

    // 一张改票，一张过期（KV 没了）
    const second = mergeSnapshot(first.text, [vote('3:1:1', 'aa', { choice: 'none', char: undefined, ts: 2 })], g);
    assert.equal(second.total, 3);
    assert.equal(second.updated, 1);
    assert.equal(second.kept, 2);
    const aa = second.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.voter === 'aa');
    assert.equal(aa.choice, 'none');
    assert.equal('char' in aa, false);
});

test('mergeSnapshot：空 KV、空旧快照 → 空文本', () => {
    const m = mergeSnapshot('', [], { book: BOOK, rev: '001-r2' });
    assert.equal(m.text, '');
    assert.equal(m.total, 0);
});

test('webSnapshotPath 拒绝坏 rev', () => {
    assert.equal(webSnapshotPath(BOOK, '001-r2'), `feedback/lists/web/${BOOK}/001-r2.jsonl`);
    assert.throws(() => webSnapshotPath(BOOK, '../x'));
});

test('planCosPut：md5 等于 ETag 的跳过', () => {
    const objs = [{ key: 'a', body: 'x' }, { key: 'b', body: 'y' }];
    const p = planCosPut(objs, new Map([['a', md5Hex('x')], ['b', md5Hex('old')]]));
    assert.deepEqual(p.put.map((o) => o.key), ['b']);
    assert.deepEqual(p.same.map((o) => o.key), ['a']);
});

// ── 流程：假 Worker／KV／COS ──

function fakeWorker(files) {
    const store = new Map(Object.entries(files)); // `${ws}|${path}` → text
    const puts = [];
    const sha = (t) => `sha:${md5Hex(t)}`;
    return {
        store, puts,
        async listFiles(ws, prefix) {
            const out = [...store.keys()].filter((k) => k.startsWith(`${ws}|${prefix}`)).sort().map((k) => ({ src_path: k.split('|')[1] }));
            return { files: out, truncated: false };
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

function fakeKv(items) {
    const calls = [];
    return { calls, async listVotes(rev, book) { calls.push(`${book}/${rev}`); return items.filter((r) => r.rev === rev && r.book === book); } };
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
        async putObjectText(key, body, opts) { puts.push({ key, opts }); objects.set(key, body); },
        async putObjectBuffer(key, buf, opts) { puts.push({ key, opts }); objects.set(key, buf); },
    };
}

const WS = 'siku-zongmu';
const baseFiles = () => ({
    [`${WS}|feedback/lists/proofing/${BOOK}/001.pending.json`]: pending('001-r2', 2),
    [`${WS}|feedback/lists/proofing/${BOOK}/003.pending.json`]: pending('003-r1', 0),
    [`${WS}|feedback/lists/proofing/${BOOK}/README.md`]: 'x',
    [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: '{bad',
});

test('collectPendings：收齐、坏文件记问题、非待审单略过', async () => {
    const w = fakeWorker(baseFiles());
    const { entries, problems } = await collectPendings(w, [WS]);
    assert.deepEqual(entries.map((e) => `${e.chap}:${e.rev}:${e.n}`), ['001:001-r2:2', '003:003-r1:0']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /004\.pending\.json/);
});

test('collectPendings：同一章出现在两个工作区，用前者', async () => {
    const w = fakeWorker({ ...baseFiles(), [`other|feedback/lists/proofing/${BOOK}/001.pending.json`]: pending('001-r9', 5) });
    const { entries, problems } = await collectPendings(w, [WS, 'other']);
    assert.equal(entries.find((e) => e.chap === '001').rev, '001-r2');
    assert.ok(problems.some((p) => /同时在工作区/.test(p)));
});

test('syncOpinions：写快照、第二次 0 写入、演练不写、没票不建文件', async () => {
    const w = fakeWorker(baseFiles());
    const { entries } = await collectPendings(w, [WS]);
    const kv = fakeKv([vote('1:1:1', 'aa'), vote('1:1:0', 'bb')]);

    const dry = await syncOpinions({ worker: w, kv, entries, dryRun: true });
    assert.equal(w.puts.length, 0);
    assert.equal(dry.rows.find((r) => r.rev === '001-r2').changed, true);

    const r1 = await syncOpinions({ worker: w, kv, entries });
    assert.deepEqual(kv.calls.slice(-2).sort(), [`${BOOK}/001-r2`, `${BOOK}/003-r1`]);
    assert.equal(w.puts.length, 1); // 003-r1 没票，不建文件
    assert.equal(w.puts[0].path, `feedback/lists/web/${BOOK}/001-r2.jsonl`);
    assert.equal(w.puts[0].text.split('\n').filter(Boolean).length, 2);
    assert.equal(r1.problems.length, 0);

    await syncOpinions({ worker: w, kv, entries });
    assert.equal(w.puts.length, 1);
});

test('syncOpinions：一组失败不影响别的组，记进 problems', async () => {
    const w = fakeWorker(baseFiles());
    const { entries } = await collectPendings(w, [WS]);
    const kv = { async listVotes(rev) { if (rev === '003-r1') throw new Error('HTTP 500'); return [vote('1:1:1', 'aa')]; } };
    const r = await syncOpinions({ worker: w, kv, entries });
    assert.equal(r.problems.length, 1);
    assert.equal(w.puts.length, 1);
});

test('publishPendings：传单子与 index（index 最后、短缓存），第二次全跳过', async () => {
    const w = fakeWorker(baseFiles());
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const r1 = await publishPendings({ cos, entries, proofPrefix: 'staging/proof/' });
    assert.deepEqual(cos.puts.map((p) => p.key), [`staging/proof/${BOOK}/001.pending.json`, `staging/proof/${BOOK}/003.pending.json`, 'staging/proof/index.json']);
    assert.equal(cos.puts[0].opts.cacheControl, 'public, max-age=300');
    assert.deepEqual(JSON.parse(cos.objects.get('staging/proof/index.json')), { books: { [BOOK]: { '001': { rev: '001-r2', n: 2 }, '003': { rev: '003-r1', n: 0 } } } });
    assert.equal(cos.objects.get(`staging/proof/${BOOK}/001.pending.json`), pending('001-r2', 2));
    assert.equal(r1.failed.length, 0);

    const r2 = await publishPendings({ cos, entries, proofPrefix: 'staging/proof/' });
    assert.equal(r2.put.length, 0);
    assert.equal(cos.puts.length, 3);
});

test('publishPendings：演练不传；单子传失败就不换 index', async () => {
    const w = fakeWorker(baseFiles());
    const { entries } = await collectPendings(w, [WS]);
    const dryCos = fakeCos();
    const d = await publishPendings({ cos: dryCos, entries, proofPrefix: 'proof/', dryRun: true });
    assert.equal(dryCos.puts.length, 0);
    assert.equal(d.put.length, 3);

    const cos = fakeCos();
    cos.putObjectText = async (key) => { if (key.endsWith('001.pending.json')) throw new Error('boom'); cos.puts.push({ key }); };
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/' });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/003.pending.json`]);
    assert.equal(r.failed.length, 2);
});

test('summarize：只出计数，不出票的内容', async () => {
    const w = fakeWorker(baseFiles());
    const { entries, problems } = await collectPendings(w, [WS]);
    const opinions = await syncOpinions({ worker: w, kv: fakeKv([vote('1:1:1', 'aa', { note: '秘密备注' })]), entries });
    const publish = await publishPendings({ cos: fakeCos(), entries, proofPrefix: 'proof/' });
    const md = summarize({ ws: [WS], proofPrefix: 'proof/', dryRun: false, entries, collectProblems: problems, opinions, publish });
    assert.match(md, /待审单 2 章，待审格合计 2/);
    assert.doesNotMatch(md, /秘密备注|於|aa/);
});


// ── GUJI-675：待审单带 sprites[] ──

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const SPR = Buffer.from('fake-webp-bytes');
const spriteMeta = (buf, name = 'p0003.aaaaaaaa.webp') => ({ name, sha256: sha256(buf), md5: md5Hex(buf), bytes: buf.length });
const pendingWithSprites = (rev, sprites) => JSON.stringify({ rev, cells: [{ a: '1:1:1' }], sprites });
const fakeBlobs = (map) => ({ calls: [], async get(sha) { this.calls.push(sha); if (!map.has(sha)) throw new Error('HTTP 404'); return map.get(sha); } });

test('readPending：sprites[] 可选，不合规的整张单子拒收', () => {
    assert.deepEqual(readPending(pending('001-r2', 1)).sprites, []);
    const m = spriteMeta(SPR);
    assert.deepEqual(readPending(pendingWithSprites('004-r6', [m])).sprites, [m]);
    assert.ok(readPending(pendingWithSprites('004-r6', [{ ...m, name: '../x.webp' }])).error);
    assert.ok(readPending(pendingWithSprites('004-r6', [{ ...m, sha256: 'zz' }])).error);
    assert.ok(readPending(pendingWithSprites('004-r6', [m, m])).error);
    assert.ok(readPending(JSON.stringify({ rev: 'r', cells: [], sprites: 'x' })).error);
});

test('publishPendings：先传图、再传单子、最后 index；图的 key 在 <书>/<章>/ 下、长缓存；第二次全跳过', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: pendingWithSprites('004-r6', [m]) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const blobs = fakeBlobs(new Map([[m.sha256, SPR]]));
    const r1 = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/004/${m.name}`, `proof/${BOOK}/004.pending.json`, 'proof/index.json']);
    assert.equal(cos.puts[0].opts.contentType, 'image/webp');
    assert.match(cos.puts[0].opts.cacheControl, /immutable/);
    assert.deepEqual(cos.objects.get(`proof/${BOOK}/004/${m.name}`), SPR);
    assert.deepEqual(r1.spritesPut, [`${BOOK}/004/${m.name}`]);
    assert.equal(r1.failed.length, 0);

    const r2 = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs });
    assert.equal(blobs.calls.length, 1);                      // 第二次不再取图
    assert.equal(cos.puts.length, 3);
    assert.deepEqual(r2.spritesSame, [`${BOOK}/004/${m.name}`]);
    assert.equal(r2.put.length, 0);
});

test('publishPendings：图取不到 → 这一章的单子不传、index 不换，别的章照传', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({
        [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: pendingWithSprites('004-r6', [m]),
        [`${WS}|feedback/lists/proofing/${BOOK}/005.pending.json`]: pending('005-r1', 1),
    });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map()) });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/005.pending.json`]);
    assert.ok(r.failed.some((f) => f.includes(`${BOOK}/004/${m.name}`) && /404/.test(f)));
    assert.ok(r.failed.some((f) => /004\.pending\.json.*单子本次不传/.test(f)));
    assert.ok(r.failed.some((f) => /index\.json.*本次不换/.test(f)));
});

test('publishPendings：取回的图与登记的 sha256 不符 → 拒传', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: pendingWithSprites('004-r6', [m]) });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map([[m.sha256, Buffer.from('tampered')]])) });
    assert.equal(cos.puts.length, 0);
    assert.ok(r.failed.some((f) => /不符/.test(f)));
});

test('publishPendings：演练不取图、不传，但报出要传哪些图', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({ [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: pendingWithSprites('004-r6', [m]) });
    const { entries } = await collectPendings(w, [WS]);
    const blobs = fakeBlobs(new Map());
    const r = await publishPendings({ cos: fakeCos(), entries, proofPrefix: 'proof/', dryRun: true, blobs });
    assert.equal(blobs.calls.length, 0);
    assert.deepEqual(r.spritesPut, [`${BOOK}/004/${m.name}`]);
});

test('reissueHints：快照里投过票的格占线上单 ≥ 20% 才提醒重出单（GUJI-688）', () => {
    const g = { book: BOOK, rev: '001-r2' };
    const m = mergeSnapshot('', [vote('1:1:1', 'aa'), vote('1:1:1', 'bb'), vote('1:1:2', 'aa')], g);
    assert.equal(m.cells, 2);
    const entries = [{ book: BOOK, rev: '001-r2', n: 10 }, { book: BOOK, rev: '002-r1', n: 10 }];
    const rows = [{ ...g, cells: m.cells }, { book: BOOK, rev: '002-r1', cells: 1 }];
    assert.deepEqual(reissueHints(rows, entries), [{ book: BOOK, rev: '001-r2', voted: 2, n: 10, pct: 20 }]);
    assert.deepEqual(reissueHints(rows, entries, 0.5), []);
    assert.deepEqual(reissueHints([{ book: BOOK, rev: 'x', cells: 3 }], entries), []); // 没有对应线上单的不提醒
});

// ── 只发一本书／一章（ONLY），分块上传的大图不重传 ──

test('onlyFilter：书或书/章，逗号分隔；空就不过滤', () => {
    assert.equal(onlyFilter(''), null);
    const f = onlyFilter(`${BOOK}/006, other`);
    assert.equal(f({ book: BOOK, chap: '006' }), true);
    assert.equal(f({ book: BOOK, chap: '005' }), false);
    assert.equal(f({ book: 'other', chap: '001' }), true);
});

test('publishPendings only：index 照全站重算，只传选中那章的单子和图，只列那几处', async () => {
    const m = spriteMeta(SPR);
    const w = fakeWorker({
        [`${WS}|feedback/lists/proofing/${BOOK}/004.pending.json`]: pendingWithSprites('004-r6', [m]),
        [`${WS}|feedback/lists/proofing/${BOOK}/006.pending.json`]: pendingWithSprites('006-r5', [spriteMeta(SPR, 'p0009.bbbbbbbb.webp')]),
    });
    const { entries } = await collectPendings(w, [WS]);
    const cos = fakeCos();
    const listed = [];
    const list0 = cos.listPrefixEtags.bind(cos);
    cos.listPrefixEtags = async (p) => { listed.push(p); return list0(p); };
    const r = await publishPendings({ cos, entries, proofPrefix: 'proof/', blobs: fakeBlobs(new Map([[m.sha256, SPR]])), only: onlyFilter(`${BOOK}/006`) });
    assert.deepEqual(cos.puts.map((p) => p.key), [`proof/${BOOK}/006/p0009.bbbbbbbb.webp`, `proof/${BOOK}/006.pending.json`, 'proof/index.json']);
    assert.deepEqual(Object.keys(JSON.parse(cos.objects.get('proof/index.json')).books[BOOK]), ['004', '006']);
    assert.deepEqual(listed, ['proof/index.json', `proof/${BOOK}/006`]);
    assert.equal(r.failed.length, 0);
});

test('spriteOnCos：分块上传的 ETag（mp:<字节数>）同字节数算已有', () => {
    const m = spriteMeta(SPR);
    assert.equal(spriteOnCos(m.md5, m), true);
    assert.equal(spriteOnCos(`mp:${m.bytes}`, m), true);
    assert.equal(spriteOnCos(`mp:${m.bytes + 1}`, m), false);
    assert.equal(spriteOnCos(undefined, m), false);
});
