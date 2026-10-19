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
