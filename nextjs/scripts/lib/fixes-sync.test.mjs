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
