import test from 'node:test';
import assert from 'node:assert/strict';
import { swapKeyVoter, planMembers, planVotes, planFeedback, run, memberEmailFromKey } from '../member-code-backfill.mjs';

const U1 = '018f1234-5678-7abc-8def-0123456789ab';
const U2 = '018f1234-5678-7abc-8def-0123456789ac';
const mrow = (email, rec) => ({ key: `member:${email.replace('@', '~0040~')}`, value: { s: JSON.stringify(rec) } });

test('swapKeyVoter：键尾与回复键都换', () => {
    assert.equal(swapKeyVoter(`cr:v:b:1:${U1}`, U1, 'K7QM2XR9'), 'cr:v:b:1:K7QM2XR9');
    assert.equal(swapKeyVoter(`tm:b:1:t:abc-${U1}`, U1, 'K7QM2XR9'), 'tm:b:1:t:abc-K7QM2XR9');
    assert.equal(swapKeyVoter('cr:v:b:1:aaaaaaaaaaaaaaaa', U1, 'K7QM2XR9'), null);
});

test('planMembers：已有合法号不动、其余发新号且不撞、uid 映射', () => {
    const seq = ['00000000', '11111119', '22222222'];
    let i = 0;
    const p = planMembers([
        mrow('a@x.com', { role: 'reader', uid: U1 }),
        mrow('b@x.com', { role: 'reader', code: '00000000' }),
        mrow('c@x.com', { _deleted: true }),
        { key: 'member:bad', value: { s: 'not json' } },
    ], ['00000000'], () => seq[i++]);
    assert.equal(p.keep, 1);
    assert.equal(p.issue.length, 1);
    assert.notEqual(p.issue[0].code, '00000000'); // 撞了索引里的号，换了下一个
    assert.equal(p.skipped, 2);
    assert.equal(p.uidToCode.get(U1), p.issue[0].code);
    assert.equal(p.issue[0].rec.uid, U1);
});

test('planVotes：只动 UUID 票；映射不到的只记 uuid 前 8 位', () => {
    const map = new Map([[U1, 'K7QM2XR9']]);
    const rows = [
        { key: `cr:v:b:1:${U1}`, value: { voter: U1, char: '于' }, ts: 5 },
        { key: `cr:v:b:1:${U2}`, value: { voter: U2 }, ts: 6 },
        { key: 'cr:v:b:1:aaaaaaaaaaaaaaaa', value: { voter: 'aaaaaaaaaaaaaaaa' }, ts: 7 },
    ];
    const p = planVotes('cellreview', rows, map);
    assert.equal(p.moves.length, 1);
    assert.deepEqual(p.moves[0].value, { voter: 'K7QM2XR9', voter_prev: U1, char: '于' });
    assert.equal(p.moves[0].newKey, 'cr:v:b:1:K7QM2XR9');
    assert.deepEqual(p.unmapped, ['018f1234']);
});

test('planFeedback：member 是 UUID 的才改', () => {
    const map = new Map([[U1, 'K7QM2XR9']]);
    const p = planFeedback([
        { key: 'fb_1_a', value: { s: JSON.stringify({ id: 'fb_1_a', member: U1, content: 'x' }) } },
        { key: 'fb_2_b', value: { s: JSON.stringify({ id: 'fb_2_b', content: 'y' }) } },
    ], map);
    assert.equal(p.edits.length, 1);
    assert.equal(JSON.parse(p.edits[0].value.s).member, 'K7QM2XR9');
});

test('memberEmailFromKey 还原 @', () => {
    assert.equal(memberEmailFromKey('member:a~0040~x.com'), 'a@x.com');
});

function fakeWorker(data) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const kind = u.searchParams.get('kind');
        const method = init.method || 'GET';
        calls.push({ method, kind, key: u.searchParams.get('key') });
        if (method === 'GET') {
            const pre = u.searchParams.get('prefix') || '';
            const items = (data[kind] || []).filter((r) => r.key.startsWith(pre));
            return { ok: true, json: async () => ({ items, hasMore: false, next: 0 }) };
        }
        if (method === 'DELETE') return { ok: kind !== 'cellreview' };
        for (const it of JSON.parse(init.body).items) { calls.push({ method: 'PUT', kind: it.kind, key: it.key, value: it.value }); }
        return { ok: true };
    };
    return { fetchImpl, calls };
}

test('run：dry_run 不写；apply 发号、迁票、改反馈，cellreview 旧键列为待清理', async () => {
    const data = {
        kv: [
            mrow('a@x.com', { role: 'reader', uid: U1 }),
            { key: `fb_1_a`, value: { s: JSON.stringify({ id: 'fb_1_a', member: U1 }) } },
        ],
        cellreview: [{ key: `cr:v:b:1:${U1}`, value: { voter: U1 }, ts: 1 }],
        charfix: [{ key: `cf:b:1:v:c:${U1}`, value: { voter: U1 }, ts: 2 }],
        thread: [],
    };
    const dry = fakeWorker(data);
    const logs = [];
    await run({ apply: false, base: 'http://w', token: 't', fetchImpl: dry.fetchImpl, log: (s) => logs.push(s) });
    assert.equal(dry.calls.filter((c) => c.method !== 'GET').length, 0);

    const real = fakeWorker(data);
    const r = await run({ apply: true, base: 'http://w', token: 't', fetchImpl: real.fetchImpl, log: (s) => logs.push(s) });
    const code = r.mp.issue[0].code;
    const puts = real.calls.filter((c) => c.method === 'PUT');
    assert.ok(puts.some((c) => c.key === `membercode:${code}` && c.value.s === 'a@x.com'));
    assert.ok(puts.some((c) => c.key === `cr:v:b:1:${code}` && c.value.voter === code));
    assert.ok(puts.some((c) => c.key === `cf:b:1:v:c:${code}`));
    assert.ok(real.calls.some((c) => c.method === 'DELETE' && c.kind === 'charfix'));
    assert.equal(r.leftover.length, 1);
    assert.ok(!logs.join('\n').includes('a@x.com'), '日志里不能出现邮箱');
});
