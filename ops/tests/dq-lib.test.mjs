/**
 * ops/dq-lib.mjs 单测（不联网：用内存里的假站点代替 data.kaiyuanguji.com）。
 *
 * 跑法（仓库根目录）：node --test ops/tests/dq-lib.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    decodeId, REF_FIELDS, insertHash, hash8, sample, extractRefs, registeredTextFiles, isTextIndexPath, newStructureKey,
    createHttp, pool, runDq, renderMarkdown, hasFailures, MAX_CONCURRENCY,
} from '../dq-lib.mjs';

// ─── 纯函数 ───

test('decodeId：与 book-index-ui extractType 同一套位布局（取自线上真实 id）', () => {
    assert.deepEqual(decodeId('988fz1pb10'), { type: 'book', status: 'official' });
    assert.equal(decodeId('d59f2hqpqrya').type, 'work');
    assert.equal(decodeId('8rlcsybg2hhl').type, 'collection');
    assert.equal(decodeId('').type, 'unknown');
    assert.equal(decodeId('abc!').type, 'unknown');
    assert.equal(decodeId(null).type, 'unknown');
});

test('decodeId：按位构造的 id 能解回来', () => {
    const make = (status, typeBits) => ((BigInt(status) << 62n) | (BigInt(typeBits) << 59n) | 12345n).toString(36);
    assert.deepEqual(decodeId(make(0, 3)), { type: 'work', status: 'official' });
    assert.deepEqual(decodeId(make(1, 4)), { type: 'entity', status: 'draft' });
    assert.equal(decodeId(make(0, 1)).type, 'unknown'); // 1 不是合法类型位
});

test('insertHash：与 cos-storage.ts 同一算法', () => {
    assert.equal(insertHash('default/001.json', 'abcd1234'), 'default/001.abcd1234.json');
    assert.equal(insertHash('wikisource/index.json', 'x'), 'wikisource/index.x.json');
    assert.equal(insertHash('noext', 'h'), 'noext.h');
    assert.equal(insertHash('a.b.txt', 'h'), 'a.b.h.txt');
});

test('sample：同 seed 可复现、数量为 ceil(n*rate)、至少 1 个', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `id${i}`);
    const a = sample(ids, 0.02, 42), b = sample(ids, 0.02, 42), c = sample(ids, 0.02, 43);
    assert.equal(a.length, 20);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.equal(new Set(a).size, a.length);
    assert.equal(sample(ids, 0.0001, 1).length, 1);
    assert.equal(sample(ids, 0, 1).length, 0);
    assert.equal(sample([], 0.5, 1).length, 0);
    assert.equal(sample(['x', 'y'], 1, 1).length, 2);
});

test('extractRefs：字符串、{id}、{work_id} 三种形状，认不出的单独标出', () => {
    const refs = extractRefs({
        work_id: 'w1',
        books: ['b1', { id: 'b2' }],
        related_works: [{ work_id: 'w2' }, 42],
        contained_in: [{ id: 'c1' }],
        other: ['ignored'],
    });
    assert.deepEqual(refs, [
        { field: 'work_id', id: 'w1' },
        { field: 'books', id: 'b1' },
        { field: 'books', id: 'b2' },
        { field: 'related_works', id: 'w2' },
        { field: 'related_works', bad: 42 },
        { field: 'contained_in', id: 'c1' },
    ]);
    assert.deepEqual(extractRefs({ work_id: '' }), []);
});

test('extractRefs：schema-v2 派生字段 _books／_members／_related／_collections 也抽（元素是带 id 的对象）', () => {
    const refs = extractRefs({
        _books: [{ id: 'b1', title: 'x' }],
        _members: [{ id: 'm1', t: 'work' }, { id: 'm2', t: 'book' }],
        _related: [{ id: 'r1', relation: 'part_of', direction: 'out' }, 7],
        _collections: [{ id: 'c1', h: 1 }],
        _works: [{ work_id: 'w9' }], // 不在巡检字段表里，仍被忽略
    });
    assert.deepEqual(refs, [
        { field: '_books', id: 'b1' },
        { field: '_members', id: 'm1' },
        { field: '_members', id: 'm2' },
        { field: '_related', id: 'r1' },
        { field: '_related', bad: 7 },
        { field: '_collections', id: 'c1' },
    ]);
    // 旧字段仍在表里、顺序在前；空数组不产出
    assert.deepEqual(REF_FIELDS.slice(0, 4), ['work_id', 'books', 'related_works', 'contained_in']);
    assert.deepEqual(extractRefs({ _books: [], _members: [], _related: [], _collections: [] }), []);
});

test('registeredTextFiles：<key>/index.json，file 不带扩展名，has_json 的章登记 .json（md 可缺，不登记）', () => {
    const r = registeredTextFiles('default/index.json', { chapters: [{ n: 1, file: '001', has_json: true }, { n: 2, file: '002' }, { file: '003' }, { n: 4 }] });
    assert.equal(r.format, 'texts.chapters');
    assert.deepEqual(r.registered, ['default/001.json', 'default/002.txt', 'default/003.txt']);
    assert.deepEqual(r.optional, ['default/001.txt']); // has_json 的章 md 可缺
    assert.deepEqual(registeredTextFiles('wikisource-2/index.json', { chapters: [{ file: '001' }] }).registered, ['wikisource-2/001.txt']);
    assert.equal(registeredTextFiles('default/index.json', { versions: [] }).format, 'texts.unknown');
});

test('newStructureKey／isTextIndexPath 认 <key>/index.json，不撞保留字', () => {
    assert.equal(newStructureKey('default/index.json'), 'default');
    assert.equal(newStructureKey('wikisource-2/index.json'), 'wikisource-2');
    for (const p of ['collated_edition/index.json', 'full_text/index.json', 'manifest/index.json', 'fragments/index.json', '001/index.json', 'a/b/index.json', 'default/001.json']) assert.equal(newStructureKey(p), null, p);
    assert.ok(isTextIndexPath('default/index.json'));
    assert.ok(isTextIndexPath('kanripo/index.json'));
    assert.ok(!isTextIndexPath('manifest.json'));
});

// ─── HTTP：重试、429 退避、并发上限 ───

const noSleep = async () => {};
const resp = (status, body = '', headers = {}) => new Response(status === 204 || status === 304 ? null : body, { status, headers });

test('createHttp：429 带 Retry-After 会退避后重试成功', async () => {
    let calls = 0;
    const sleeps = [];
    const http = createHttp({
        fetchImpl: async () => (++calls === 1 ? resp(429, '', { 'retry-after': '2' }) : resp(200, '{"a":1}')),
        sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    const r = await http.getJson('https://x/a.json');
    assert.deepEqual(r.json, { a: 1 });
    assert.equal(calls, 2);
    assert.equal(http.stats.throttled, 1);
    assert.ok(sleeps.some((ms) => ms > 1500), `应按 Retry-After 等约 2 秒，实际 ${sleeps}`);
});

test('createHttp：5xx 和网络错误重试，404 不重试', async () => {
    let calls = 0;
    const http = createHttp({
        fetchImpl: async () => { calls++; if (calls === 1) throw new Error('reset'); if (calls === 2) return resp(503); return resp(200, 'ok'); },
        sleepImpl: noSleep,
    });
    assert.equal((await http.request('https://x/')).status, 200);
    assert.equal(calls, 3);

    let c404 = 0;
    const h2 = createHttp({ fetchImpl: async () => { c404++; return resp(404); }, sleepImpl: noSleep });
    assert.equal((await h2.request('https://x/')).status, 404);
    assert.equal(c404, 1);

    const h3 = createHttp({ fetchImpl: async () => resp(500), sleepImpl: noSleep, maxAttempts: 3 });
    const r3 = await h3.request('https://x/');
    assert.equal(r3.ok, false);
    assert.equal(h3.stats.failures, 1);
    assert.equal(h3.stats.requests, 3);
});

test('pool：同时在飞不超过 8，哪怕要求更多', async () => {
    let inFlight = 0, peak = 0;
    const out = await pool(Array.from({ length: 50 }, (_, i) => i), 100, async (x) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return x * 2;
    });
    assert.equal(peak, MAX_CONCURRENCY);
    assert.equal(out[49], 98);
});

// ─── 端到端：内存假站点 ───

const COMMIT = { commitId: 'c'.repeat(40), productionCommitId: 'p'.repeat(40), textCommitId: 't'.repeat(40) };
const idOf = (typeBits, seq) => ((BigInt(typeBits) << 59n) | (1700000000n << 19n) | BigInt(seq)).toString(36);

function buildSite({ netFail = null, staleCdn = false, breakCurrent = false, danglingRef = false, missingChapter = false, lagTextPointer = false, newStructure = 'clean' } = {}) {
    if (missingChapter) newStructure = 'missingChapter';
    const files = new Map();
    const put = (p, v) => files.set(p, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
    const B = 'https://d.test';

    const work = idOf(3, 1), book = idOf(0, 2), coll = idOf(2, 3), ent = idOf(4, 4);
    const entries = {
        [work]: { id: work, type: 'work', title: '甲' },
        [book]: { id: book, type: 'book', work_id: work, contained_in: [{ id: coll }], ...(danglingRef ? { related_works: ['zzzzzzzzzz'] } : {}) },
        [coll]: { id: coll, type: 'collection', books: [book] },
        [ent]: { id: ent, type: 'entity' },
    };
    const shards = {};
    const rootShards = {};
    for (const [id, e] of Object.entries(entries)) {
        const buf = Buffer.from(JSON.stringify(e));
        const h = hash8(buf);
        files.set(`${B}/h1/entry/${id}.${h}.json`, buf);
        files.set(`${B}/current/entry/${id}.json`, breakCurrent && id === book ? Buffer.from(JSON.stringify({ ...e, title: '改过' })) : buf);
        (shards[id.slice(-2)] ??= {})[id] = h;
    }
    for (const [k, s] of Object.entries(shards)) {
        const buf = Buffer.from(JSON.stringify(s));
        rootShards[k] = hash8(buf);
        files.set(`${B}/h1/manifest/${k}.${rootShards[k]}.json`, buf);
    }
    put(`${B}/latest.json`, { commitId: COMMIT.commitId.slice(0, 12), fullCommitId: COMMIT.commitId, productionCommitId: COMMIT.productionCommitId, textCommitId: COMMIT.textCommitId });
    put(`${B}/current/version.json`, COMMIT);
    put(`${B}/current/meta.json`, { works: 1, books: 1, collections: 1, entities: 1 });
    put(`${B}/current/promotions.json`, { version: 1, promotions: {} });
    put(`${B}/h1/manifest-root.json`, { version: 2, root: 'k1.json', dataCommit: COMMIT });
    put(`${B}/h1/roots/k1.json`, { shardKeyLength: 2, shardCount: Object.keys(rootShards).length, dataCommit: COMMIT, shards: rootShards });

    // 阅读文本：work 有 default（整理本）与 wikisource 两个版本
    const tfiles = {};
    const addText = (rel, content) => { const buf = Buffer.from(content); const h = hash8(buf); tfiles[rel] = h; files.set(`${B}/h1/text/${work}/${insertHash(rel, h)}`, buf); };
    {
        // 新结构（overview#307）：manifest.json＋<key>/index.json（file 不带扩展名）＋NNN.txt，整理本章另有 NNN.json
        const versions = [{ key: 'default', kind: 'collated', label: '整理本' }, { key: 'wikisource', kind: 'transcription', label: '維基文庫' }];
        if (newStructure === 'leak') versions.push({ key: 'shidian', kind: 'transcription', label: '識典', visibility: 'internal' });
        if (newStructure === 'missingVersion') versions.push({ key: 'kanripo', kind: 'transcription', label: 'Kanripo' });
        addText('manifest.json', JSON.stringify({ id: work, versions }));
        addText('default/index.json', JSON.stringify({ chapters: [{ n: 1, file: '001', has_json: true }, { n: 2, file: '002', has_json: false }] }));
        addText('default/001.txt', '卷一');
        addText('default/001.json', '{}');
        if (newStructure !== 'missingChapter') addText('default/002.txt', '卷二');
        addText('wikisource/index.json', JSON.stringify({ chapters: [{ n: 1, file: '001', has_json: false }] }));
        addText('wikisource/001.txt', '維基');
    }
    const tshard = { [work]: tfiles };
    const tbuf = Buffer.from(JSON.stringify(tshard));
    const tk = work.slice(-2);
    files.set(`${B}/h1/text-manifest/${tk}.${hash8(tbuf)}.json`, tbuf);
    const textCommit = lagTextPointer ? { ...COMMIT, textCommitId: 'old' } : COMMIT;
    put(`${B}/h1/text-manifest-root.json`, { version: 2, root: 't1.json', dataCommit: textCommit });
    put(`${B}/h1/text-roots/t1.json`, { shardKeyLength: 2, shardCount: 1, ownerCount: 1, fileCount: Object.keys(tfiles).length, dataCommit: textCommit, shards: { [tk]: hash8(tbuf) } });

    const requested = [];
    const fetchImpl = async (url, init = {}) => {
        const [key, query = ''] = url.split('?');
        requested.push({ key, query, method: init.method ?? 'GET' });
        // staleCdn：节点按 ?v=<commitId> 缓存了 book 的旧版，换个 v 就拿到源站新版
        if (staleCdn && key.endsWith(`/current/entry/${book}.json`) && query === `v=${COMMIT.commitId.slice(0, 12)}`) {
            return resp(200, JSON.stringify({ ...entries[book], classification: undefined, title: '旧' }));
        }
        if (staleCdn && key.endsWith('/current/version.json') && query === `v=${COMMIT.commitId.slice(0, 12)}`) {
            return resp(200, JSON.stringify({ ...COMMIT, productionCommitId: 'old' }));
        }
        if (netFail && key.includes(netFail)) throw new TypeError('fetch failed');
        const buf = files.get(key);
        if (!buf) return resp(404);
        return resp(200, init.method === 'HEAD' ? null : buf);
    };
    return { base: B, fetchImpl, requested, ids: { work, book, coll, ent } };
}

const runOn = (site, extra = {}) => runDq({ base: site.base, fetchImpl: site.fetchImpl, sleepImpl: noSleep, entryRate: 1, textRate: 1, pointerRetryMs: 0, seed: 1, ...extra });

test('runDq：干净的站点没有任何问题，计数正确', async () => {
    const site = buildSite();
    const r = await runOn(site);
    assert.deepEqual(r.findings, []);
    assert.equal(r.counts.total, 4);
    assert.deepEqual(r.counts.byType, { work: 1, book: 1, collection: 1, entity: 1 });
    assert.equal(r.entries.sampled, 4);
    assert.equal(r.entries.currentMatch, 4);
    assert.equal(r.refs.refs, 3); // book.work_id、book.contained_in、coll.books
    assert.equal(r.refs.dangling, 0);
    assert.equal(r.text.registered, 3); // default 的 001.json／002.txt＋wikisource 的 001.txt（001.txt 是 has_json 章的可选 md）
    assert.equal(r.text.filesChecked, 4);
    assert.equal(hasFailures(r), false);
    // current/ 请求都带 ?v= cache-bust（fetchImpl 看不到 query，这里只核对走的是 current 路径）
    assert.ok(site.requested.some((q) => q.key.endsWith(`/current/entry/${site.ids.book}.json`)));
    assert.match(renderMarkdown(r), /网站打包问题：0/);
});

test('runDq：current 与 h1 不一致 → 网站打包问题，并说出差在哪个字段', async () => {
    const r = await runOn(buildSite({ breakCurrent: true }));
    const f = r.findings.filter((x) => x.code === 'current-h1-differ');
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'packaging');
    assert.match(f[0].message, /title/);
    assert.match(f[0].message, /绕过 CDN 缓存后仍不一致/);
    assert.equal(hasFailures(r), true);
});

test('runDq：?v=<commitId> 命中 CDN 旧缓存、源站已一致 → current-cdn-stale', async () => {
    const site = buildSite({ staleCdn: true });
    const r = await runOn(site);
    assert.equal(r.entries.currentDiffer, 1);
    assert.equal(r.entries.currentCdnStale, 1);
    const f = r.findings.find((x) => x.code === 'current-cdn-stale');
    assert.equal(f.kind, 'packaging');
    assert.deepEqual(f.detail.changed, ['title']);
    assert.ok(!r.findings.some((x) => x.code === 'current-h1-differ'));
    assert.equal(r.findings.find((x) => x.code === 'current-version-cdn-stale')?.kind, 'packaging');
    // 带 cache-bust 的 current 请求确实用的是 latest.json 的短 commitId
    assert.ok(site.requested.some((q) => q.key.includes('/current/entry/') && q.query === `v=${COMMIT.commitId.slice(0, 12)}`));
    // 已知问题（overview#169）：进报告但不让 job 变红
    assert.equal(hasFailures(r), false);
});

test('runDq：悬空引用 → 数据仓问题，默认不让任务变红', async () => {
    const r = await runOn(buildSite({ danglingRef: true }));
    assert.equal(r.refs.dangling, 1);
    const f = r.findings.find((x) => x.code === 'ref-dangling');
    assert.equal(f.kind, 'data');
    assert.match(f.message, /related_works → zzzzzzzzzz/);
    assert.equal(hasFailures(r, 'packaging'), false);
    assert.equal(hasFailures(r, 'any'), true);
});

test('runDq：index 登记了 manifest 里没有的章 → 数据仓问题', async () => {
    const r = await runOn(buildSite({ missingChapter: true }));
    assert.equal(r.text.registeredMissing, 1);
    const f = r.findings.find((x) => x.code === 'text-registered-missing');
    assert.equal(f.kind, 'data');
    assert.deepEqual(f.detail.missing, ['default/002.txt']);
});

test('runDq：指针落后于 latest.json → 重看一次，仍落后才记打包问题', async () => {
    const site = buildSite({ lagTextPointer: true });
    let slept = 0;
    const r = await runDq({ base: site.base, fetchImpl: site.fetchImpl, sleepImpl: async () => { slept++; }, entryRate: 1, textRate: 1, pointerRetryMs: 1000, seed: 1 });
    assert.ok(slept >= 1);
    const f = r.findings.find((x) => x.code === 'pointer-lag');
    assert.equal(f.kind, 'packaging');
    assert.match(f.message, /text-manifest-root/);
});

test('runDq：latest.json 取不到直接收尾', async () => {
    const r = await runDq({ base: 'https://none.test', fetchImpl: async () => resp(404), sleepImpl: noSleep });
    assert.equal(r.findings[0].code, 'latest-unreadable');
    assert.equal(hasFailures(r), true);
});

test('runDq：网络错误重试用尽 → 单列「巡检取数失败」，比例小不让 job 变红', async () => {
    const site = buildSite();
    const r = await runOn({ ...site, fetchImpl: buildSite({ netFail: '/wikisource/001.' }).fetchImpl });
    const f = r.findings.filter((x) => x.code === 'text-file-unreachable');
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, 'fetch');
    assert.equal(r.http.failures, 1);
    assert.match(renderMarkdown(r), /巡检取数失败.*：1/);
    // 1 次失败 / 几十次请求 > 1%：这个小站点上会变红；大站点上同样 1 次则不会
    assert.equal(hasFailures(r), true);
    assert.equal(hasFailures({ ...r, http: { ...r.http, requests: 10_000 } }), false);
});

test('runDq：404 仍算网站打包问题', async () => {
    const site = buildSite({ missingChapter: false });
    const base = site.fetchImpl;
    const r = await runOn({ ...site, fetchImpl: async (url, init) => (url.includes('/wikisource/001.') ? resp(404) : base(url, init)) });
    assert.equal(r.findings.find((x) => x.code === 'text-file-unreachable').kind, 'packaging');
});

test('runDq：新结构文本干净——manifest.json、各版本目录、章文件（含 has_json）都核对到', async () => {
    const r = await runOn(buildSite());
    assert.deepEqual(r.findings, []);
    assert.equal(r.text.manifests, 1);
    assert.equal(r.text.indexes, 2);
    assert.equal(r.text.registered, 3); // default 的 001.json／002.txt＋wikisource 的 001.txt；default 的 001.txt 是 has_json 章的可选 md，不计登记
    assert.equal(r.text.filesChecked, 4); // 但在产物里就照样核对取得到、哈希对得上
    assert.equal(hasFailures(r), false);
});

test('runDq：新结构缺登记的章文件、manifest 列了没有目录的版本、internal 版本泄漏，各报各的', async () => {
    let r = await runOn(buildSite({ newStructure: 'missingChapter' }));
    assert.ok(r.findings.some((f) => f.code === 'text-registered-missing' && f.kind === 'data'));
    r = await runOn(buildSite({ newStructure: 'missingVersion' }));
    const f = r.findings.find((x) => x.code === 'text-manifest-version-missing');
    assert.ok(f && f.kind === 'data');
    assert.match(f.message, /kanripo/);
    r = await runOn(buildSite({ newStructure: 'leak' }));
    const leak = r.findings.find((x) => x.code === 'text-internal-leak');
    assert.ok(leak && leak.kind === 'packaging', 'internal 进了公开产物是打包问题');
    assert.equal(hasFailures(r), true);
});
