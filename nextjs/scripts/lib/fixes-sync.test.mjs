import test from 'node:test';
import assert from 'node:assert/strict';
import { fixId, mergeFixes, buildPublicFixes, toPublicFix, fixesSnapshotPath, fixesPublicKey } from './fixes-sync.mjs';
import { syncFixes, publishFixes, summarize } from './proofing-sync-run.mjs';

const BOOK = '96mid1ogzk';
const char = (cell, voter, extra = {}) => ({ v: 1, kind: 'char', book_id: BOOK, volume: '002', text_version: '1.0.1', cell_id: cell, old_char: '日', new_char: '曰', basis: '', entity_ids: [], voter, ts: 1, ...extra });
const span = (start, end, voter, extra = {}) => ({ v: 1, kind: 'span', book_id: BOOK, volume: '002', text_version: '1.0.1', start, end, sub: 'missing', old_text: '全總', new_text: '全書總', note: '', voter, ts: 2, ...extra });
const ent = (eid, voter, extra = {}) => ({ v: 1, kind: 'entity', book_id: BOOK, volume: '003', chapter: '003', entity_id: eid, entity_version: '1.9.1', anchor: { start: '5:1:3', end: '5:1:4' }, text: '王弼', note: '不是人名', voter, ts: 3, ...extra });

test('路径：快照在中心库 feedback/lists/web/<书>/fixes.jsonl，公开清单在 proof/fixes/<书>.json', () => {
    assert.equal(fixesSnapshotPath(BOOK), `feedback/lists/web/${BOOK}/fixes.jsonl`);
    assert.equal(fixesPublicKey(BOOK), `fixes/${BOOK}.json`);
    assert.throws(() => fixesSnapshotPath('../x'));
});

test('fixId：与 KV key 同口径；认不出的是 null', () => {
    assert.equal(fixId(char('3:1:6', 'aa')), 'cf|002|1.0.1|3:1:6|aa');
    assert.equal(fixId(span('3:1:5', '3:1:6', 'aa')), 'cs|002|1.0.1|3:1:5-3:1:6|missing|aa');
    assert.equal(fixId(ent('e00001', 'aa')), 'ce|003|e00001|aa');
    assert.equal(fixId({ kind: 'char', volume: '002', voter: 'aa' }), null);
    assert.equal(fixId({ kind: 'x', volume: '002', voter: 'aa' }), null);
    assert.equal(fixId(null), null);
});

test('mergeFixes：新增、覆盖、KV 过期的旧条目保留、别的书丢掉；按册与格位排，键序无关、同输入同字节', () => {
    const first = mergeFixes('', [span('3:1:5', '3:1:6', 'bb'), char('10:2:1', 'aa'), char('3:2:1', 'aa'), ent('e00001', 'cc'), { ...char('1:1:1', 'zz'), book_id: 'other1' }], BOOK);
    assert.equal(first.total, 4);
    assert.equal(first.added, 4);
    assert.equal(first.dropped, 1);
    const recs = first.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.map((r) => `${r.volume}/${r.cell_id || r.start || r.anchor.start}`), ['002/3:1:5', '002/3:2:1', '002/10:2:1', '003/5:1:3']);
    assert.ok(first.text.endsWith('\n'));
    const shuffled = Object.fromEntries(Object.entries(char('3:2:1', 'aa')).reverse());
    assert.equal(mergeFixes(first.text, [shuffled, span('3:1:5', '3:1:6', 'bb'), char('10:2:1', 'aa'), ent('e00001', 'cc')], BOOK).text, first.text);

    const second = mergeFixes(first.text, [char('3:2:1', 'aa', { new_char: '日', ts: 9 })], BOOK);
    assert.equal(second.total, 4);
    assert.equal(second.updated, 1);
    assert.equal(second.kept, 3);
    assert.equal(mergeFixes('', [], BOOK).text, '');
});

test('公开形：voter 只留 6 位、正文脱敏、空字段不出', () => {
    const p = toPublicFix(char('3:2:1', 'abcdef0123456789', { basis: '电话 13812345678' }));
    assert.deepEqual(Object.keys(p).sort(), ['at', 'kind', 'new', 'note', 'old', 'ts', 'tv', 'who']);
    assert.equal(p.who, 'abcdef');
    assert.ok(!p.note.includes('13812345678'));
    const s = toPublicFix(span('3:1:5', '3:1:6', 'bb', { new_text: '', note: '漏字' }));
    assert.deepEqual(s, { kind: 'span', at: '3:1:5', end: '3:1:6', sub: 'missing', old: '全總', note: '漏字', tv: '1.0.1', who: 'bb', ts: 2 });
    const e = toPublicFix(ent('e00001', 'cc'));
    assert.deepEqual(e, { kind: 'entity', at: '5:1:3', end: '5:1:4', ev: '1.9.1', eid: 'e00001', old: '王弼', note: '不是人名', who: 'cc', ts: 3 });
});

test('buildPublicFixes：按册分组、不带生成时间（同快照同字节）', () => {
    const snap = mergeFixes('', [span('3:1:5', '3:1:6', 'bb'), ent('e00001', 'cc')], BOOK).text;
    const a = buildPublicFixes(snap, BOOK);
    assert.equal(a, buildPublicFixes(snap, BOOK));
    const j = JSON.parse(a);
    assert.equal(j.book, BOOK);
    assert.deepEqual(Object.keys(j.volumes), ['002', '003']);
    assert.ok(!a.includes('"voter"'));
});

function fakeWorker(files = {}) {
    const puts = [];
    return {
        puts,
        files,
        async getFile(ws, path) { return files[`${ws}/${path}`] ? { text: files[`${ws}/${path}`], sha256: 'sha-old' } : null; },
        async putFile(ws, path, text, base) { puts.push({ ws, path, text, base }); files[`${ws}/${path}`] = text; return {}; },
    };
}

test('syncFixes：三类都拉、合并后写中心库；没变不写；演练不写；某书出错记问题不中断', async () => {
    const worker = fakeWorker();
    const calls = [];
    const kv = {
        async listFixes(book, kind) {
            calls.push(`${book}/${kind}`);
            if (book === 'bad0') throw new Error('HTTP 500');
            return kind === 'char' ? [char('3:2:1', 'aa')] : kind === 'span' ? [span('3:1:5', '3:1:6', 'bb')] : [];
        },
    };
    const r = await syncFixes({ worker, kv, ws: 'siku-zongmu', books: [BOOK, 'bad0'] });
    assert.deepEqual(calls.slice(0, 3), [`${BOOK}/char`, `${BOOK}/span`, `${BOOK}/entity`]);
    assert.equal(worker.puts.length, 1);
    assert.equal(worker.puts[0].path, `feedback/lists/web/${BOOK}/fixes.jsonl`);
    assert.equal(worker.puts[0].base, null);
    assert.equal(r.rows[0].total, 2);
    assert.equal(r.problems.length, 1);
    const again = await syncFixes({ worker, kv, ws: 'siku-zongmu', books: [BOOK] });
    assert.equal(worker.puts.length, 1);
    assert.equal(again.rows[0].written, false);
    const dry = await syncFixes({ worker: fakeWorker(), kv, ws: 'siku-zongmu', books: [BOOK], dryRun: true });
    assert.equal(dry.rows[0].written, false);
    assert.equal(dry.rows[0].changed, true);
});

test('publishFixes：有快照的书出公开清单，md5 相同跳过；没快照跳过', async () => {
    const snap = mergeFixes('', [span('3:1:5', '3:1:6', 'bb')], BOOK).text;
    const worker = fakeWorker({ [`siku-zongmu/feedback/lists/web/${BOOK}/fixes.jsonl`]: snap });
    const put = [];
    const cos = {
        async listPrefixEtags(prefix) { assert.equal(prefix, 'proof/fixes/'); return new Map(); },
        async putObjectText(key, body, opts) { put.push({ key, body, opts }); },
    };
    const r = await publishFixes({ worker, cos, ws: 'siku-zongmu', books: [BOOK, 'none1'], proofPrefix: 'proof/' });
    assert.deepEqual(r.put, [`fixes/${BOOK}.json`]);
    assert.equal(put[0].key, `proof/fixes/${BOOK}.json`);
    assert.match(put[0].opts.contentType, /json/);
    const md = summarize({ ws: ['siku-zongmu'], proofPrefix: 'proof/', dryRun: false, entries: [], collectProblems: [], fixes: { rows: [], problems: [] }, fixesPublish: r });
    assert.match(md, /意见清单 → COS/);
});

import { threadId, targetOf, parseHidden, threadsSnapshotPath } from './fixes-sync.mjs';

const vote = (target, voter, stance = 'agree', extra = {}) => ({ v: 1, book_id: BOOK, volume: '002', target, stance, voter, ts: 5, ...extra });
const reply = (target, voter, ts, text, extra = {}) => ({ v: 1, book_id: BOOK, volume: '002', target, stance: 'reply', name: '甲', text, voter, ts, ...extra });
const T = 'span~3:1:5~3:1:6~missing';

test('讨论：threadId、targetOf 与网站同口径；hidden.txt 解析', () => {
    assert.equal(threadId(vote(T, 'aa')), `tv|002|${T}|aa`);
    assert.equal(threadId(reply(T, 'aa', 7, 'x')), `tm|002|${T}|7|aa`);
    assert.equal(threadId({ ...vote(T, 'aa'), stance: 'x' }), null);
    assert.equal(targetOf(span('3:1:5', '3:1:6', 'bb')), T);
    assert.equal(targetOf(char('3:2:1', 'aa')), 'char~3:2:1~~');
    assert.equal(targetOf(ent('e1', 'aa')), 'entity~5:1:3~5:1:4~');
    assert.deepEqual([...parseHidden('# 注释\ntm|002|x|1|aa\n\n  cf|002|1.0.1|3:2:1|aa  # 广告\n')], ['tm|002|x|1|aa', 'cf|002|1.0.1|3:2:1|aa']);
    assert.equal(threadsSnapshotPath(BOOK), `feedback/lists/web/${BOOK}/threads.jsonl`);
});

test('公开清单带讨论：表态只出计数（同来源改态覆盖），回复按时间、脱敏；hidden 的意见与回复不出', () => {
    const fx = mergeFixes('', [span('3:1:5', '3:1:6', 'bb'), char('3:2:1', 'aa')], BOOK).text;
    let th = mergeFixes('', [vote(T, 'aa'), vote(T, 'bb'), vote(T, 'cc', 'disagree'), reply(T, 'aa', 9, '后一条'), reply(T, 'bb', 8, '电话 13812345678')], BOOK, threadId).text;
    th = mergeFixes(th, [vote(T, 'bb', 'disagree')], BOOK, threadId).text; // bb 改态
    const hidden = parseHidden(`tm|002|${T}|9|aa\ncf|002|1.0.1|3:2:1|aa`);
    const j = JSON.parse(buildPublicFixes(fx, BOOK, th, hidden));
    assert.equal(j.volumes['002'].length, 1);
    const t = j.threads['002'][T];
    assert.equal(t.agree, 1);
    assert.equal(t.disagree, 2);
    assert.equal(t.replies.length, 1);
    assert.equal(t.replies[0].name, '甲');
    assert.ok(!t.replies[0].text.includes('13812345678'));
    assert.ok(!JSON.stringify(j).includes('"voter"'));
    // 没有讨论时不出 threads 键（与旧清单同形）
    assert.equal(JSON.parse(buildPublicFixes(fx, BOOK)).threads, undefined);
});

test('syncFixes：有 listThreads 时另存 threads.jsonl；publishFixes 读 threads 与 hidden', async () => {
    const worker = fakeWorker();
    const kv = {
        async listFixes(book, kind) { return kind === 'span' ? [span('3:1:5', '3:1:6', 'bb')] : []; },
        async listThreads(book, kind) { return kind === 'vote' ? [vote(T, 'aa')] : [reply(T, 'aa', 9, '同意')]; },
    };
    const r = await syncFixes({ worker, kv, ws: 'w', books: [BOOK] });
    assert.deepEqual(worker.puts.map((p) => p.path), [`feedback/lists/web/${BOOK}/fixes.jsonl`, `feedback/lists/web/${BOOK}/threads.jsonl`]);
    assert.equal(r.rows.length, 2);
    worker.files[`w/feedback/lists/web/${BOOK}/hidden.txt`] = '';
    const put = [];
    const cos = { async listPrefixEtags() { return new Map(); }, async putObjectText(key, body) { put.push(JSON.parse(body)); } };
    await publishFixes({ worker, cos, ws: 'w', books: [BOOK], proofPrefix: 'proof/' });
    assert.equal(put[0].threads['002'][T].agree, 1);
    assert.equal(put[0].threads['002'][T].replies[0].text, '同意');
});

test('buildPublicFixes：整理组回复的 team 标记带到公开清单', () => {
    const th = [{ book_id: BOOK, volume: '002', target: 'span~3:1:5~3:1:6~missing', stance: 'reply', name: '整理组', text: '已补', team: true, voter: 'team', ts: 5 }]
        .map((r) => JSON.stringify(r)).join('\n');
    const out = JSON.parse(buildPublicFixes('', BOOK, th));
    assert.equal(out.threads['002']['span~3:1:5~3:1:6~missing'].replies[0].team, true);
});

// ---------------- 状态回写（M11 B2，GUJI-714）----------------

import { statusListPath, parseStatusRows, planStatusWrites, publicStatus } from './fixes-sync.mjs';
import { syncStatus } from './proofing-sync-run.mjs';

const ST = 'span~3:1:9~3:1:9~missing';
const srow = (extra = {}) => ({ v: 1, book: BOOK, volume: '002', target: ST, state: 'adopted', reply: '感谢指正，已采纳，待随下一版文本更新。', opinions: ['op_span_29a02d06d6'], ts: '2026-10-20T18:52:50Z', ...extra });
const lines = (...rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('status.jsonl：路径、按 /api/fixes 的口径校验（别的书、坏 target、坏 state、缺 state 都不收）', () => {
    assert.equal(statusListPath(BOOK), `feedback/lists/web/${BOOK}/status.jsonl`);
    assert.throws(() => statusListPath('../x'));
    const text = lines(srow(), srow({ book: 'other1' }), srow({ target: 'x~1' }), srow({ state: 'done' }), srow({ state: undefined }), srow({ target: 'char~4:1:2~~', state: 'adopted', version: '1.0.2' })) + 'not json\n';
    const { rows, bad } = parseStatusRows(text, BOOK);
    assert.equal(rows.length, 2);
    assert.equal(bad, 5);
    assert.deepEqual(rows.map((r) => [r.target, r.state, r.version]), [[ST, 'adopted', ''], ['char~4:1:2~~', 'adopted', '1.0.2']]);
    assert.deepEqual(publicStatus({ state: 'rejected', reason: '电话 13812345678', ts: '2026-10-20T00:00:00Z' }).ts, Date.parse('2026-10-20T00:00:00Z'));
    assert.ok(!publicStatus({ state: 'rejected', reason: '电话 13812345678' }).reason.includes('13812345678'));
});

test('planStatusWrites：状态不同才写；同样文字的整理组回复（KV 或快照里有）不再发；册没读到不盲写', () => {
    const { rows } = parseStatusRows(lines(srow(), srow({ target: 'char~4:1:2~~', state: 'rejected', reason: '图上清楚是甲', reply: undefined }), srow({ volume: '003' })), BOOK);
    // KV 里什么都没有：第一条要写状态＋回复，第二条只写状态，003 册没读到跳过
    let p = planStatusWrites(rows, { '002': {} }, '', BOOK);
    assert.equal(p.skipped, 1);
    assert.deepEqual(p.posts.map((x) => x.body), [
        { book_id: BOOK, volume: '002', target: ST, state: 'adopted', reply: '感谢指正，已采纳，待随下一版文本更新。' },
        { book_id: BOOK, volume: '002', target: 'char~4:1:2~~', state: 'rejected', reason: '图上清楚是甲' },
    ]);
    assert.equal(p.posts[0].from, 'open');
    // KV 已一致：不写
    const live = { '002': {
        [ST]: { agree: 1, disagree: 0, replies: [{ name: '整理组', text: '感谢指正，已采纳，待随下一版文本更新。', team: true, ts: 1 }], status: { state: 'adopted', ts: 1 } },
        'char~4:1:2~~': { agree: 0, disagree: 0, replies: [], status: { state: 'rejected', reason: '图上清楚是甲', ts: 1 } },
    } };
    p = planStatusWrites(rows, live, '', BOOK);
    assert.equal(p.posts.length, 0);
    assert.equal(p.same, 2);
    // 状态一样、回复在 KV 里过期了但快照里有：不再发
    const live2 = { '002': { ...live['002'], [ST]: { ...live['002'][ST], replies: [] } } };
    const snap = JSON.stringify({ book_id: BOOK, volume: '002', target: ST, stance: 'reply', name: '整理组', text: '感谢指正，已采纳，待随下一版文本更新。', team: true, voter: 'team', ts: 1 });
    assert.equal(planStatusWrites(rows, live2, snap, BOOK).posts.length, 0);
    // 读者自己写了同样的话不算整理组回复：照发回复，但状态不动
    const live3 = { '002': { ...live['002'], [ST]: { ...live['002'][ST], replies: [{ name: '甲', text: '感谢指正，已采纳，待随下一版文本更新。', ts: 1 }] } } };
    p = planStatusWrites(rows, live3, '', BOOK);
    assert.deepEqual(p.posts.map((x) => [x.state, x.reply, Object.keys(x.body).sort().join(',')]), [[false, true, 'book_id,reply,target,volume']]);
    // 进了文本：版本变了要重写状态
    const { rows: r2 } = parseStatusRows(lines(srow({ version: '1.0.2', reply: undefined })), BOOK);
    p = planStatusWrites(r2, live, '', BOOK);
    assert.deepEqual(p.posts[0].body, { book_id: BOOK, volume: '002', target: ST, state: 'adopted', version: '1.0.2' });
});

test('syncStatus：读中心库 status.jsonl 与 /api/fixes 现状，演练只列不写；正式写 POST；读不到的册记问题', async () => {
    const worker = fakeWorker({ [`w/feedback/lists/web/${BOOK}/status.jsonl`]: lines(srow(), srow({ volume: '003' })) });
    const posted = [];
    const site = {
        async liveFixes(book, volume) {
            if (volume === '003') throw new Error('HTTP 500');
            return { success: true, book, volumes: { [volume]: [] }, threads: { [volume]: { [ST]: { agree: 1, disagree: 0, replies: [] } } } };
        },
        async postFixes(body) { posted.push(body); return { success: true }; },
    };
    const dry = await syncStatus({ worker, site, ws: 'w', books: [BOOK, 'none1'], dryRun: true });
    assert.equal(posted.length, 0);
    assert.deepEqual(dry.planned, [{ book: BOOK, volume: '002', target: ST, from: 'open', to: 'adopted', reply: true }]);
    assert.equal(dry.problems.length, 1);
    assert.match(dry.problems[0], /003/);
    const md = summarize({ ws: ['w'], proofPrefix: 'proof/', dryRun: true, entries: [], collectProblems: [], status: dry });
    assert.match(md, /意见处理结论 → 网站/);
    assert.match(md, /open → adopted，加整理组回复/);
    const real = await syncStatus({ worker, site, ws: 'w', books: [BOOK] });
    assert.equal(real.rows[0].posted, 1);
    assert.equal(posted[0].state, 'adopted');
    assert.equal(posted[0].book_id, BOOK);
    assert.equal(worker.puts.length, 0); // 不写中心库
});

test('公开清单并进状态（与 /api/fixes 同形）：open 不出、没有意见的处也带上、ts 转毫秒', async () => {
    const fx = mergeFixes('', [span('3:1:5', '3:1:6', 'bb')], BOOK).text;
    const status = lines(srow({ target: T, version: '1.0.2', reason: undefined }), srow({ target: 'char~4:1:2~~', state: 'open' }));
    const j = JSON.parse(buildPublicFixes(fx, BOOK, '', new Set(), status));
    assert.deepEqual(j.threads['002'][T], { agree: 0, disagree: 0, replies: [], status: { state: 'adopted', version: '1.0.2', ts: Date.parse('2026-10-20T18:52:50Z') } });
    assert.equal(j.threads['002']['char~4:1:2~~'], undefined);
    // publishFixes 读中心库 status.jsonl
    const worker = fakeWorker({ [`w/feedback/lists/web/${BOOK}/fixes.jsonl`]: fx, [`w/feedback/lists/web/${BOOK}/status.jsonl`]: status });
    const put = [];
    const cos = { async listPrefixEtags() { return new Map(); }, async putObjectText(key, body) { put.push(JSON.parse(body)); } };
    await publishFixes({ worker, cos, ws: 'w', books: [BOOK], proofPrefix: 'proof/' });
    assert.equal(put[0].threads['002'][T].status.state, 'adopted');
    // 没有 status.jsonl 时与旧清单逐字节相同
    assert.equal(buildPublicFixes(fx, BOOK, '', new Set(), ''), buildPublicFixes(fx, BOOK));
});
