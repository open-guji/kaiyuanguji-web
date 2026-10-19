// switch_cos.mjs 单测（假 COS 客户端、假 fetch，不连网）。运行：node --test fulltext/build/tests/
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_KEY, DEFAULT_PUBLIC_URL, buildSwitch, laIso, parseArgs, readBack, run } from '../switch_cos.mjs';

const quiet = () => {};
const noSleep = async () => {};

/** 假 COS：putJson 存进 store；假 fetch 从 store 读（模拟公开地址读回） */
function fake({ putFails = false } = {}) {
    const store = {};
    const calls = [];
    const client = {
        putJson: async (k, o, cc) => {
            calls.push({ k, cc });
            if (putFails) throw Object.assign(new Error('AccessDenied'), { statusCode: 403 });
            store[k] = JSON.stringify(o);
        },
    };
    const fetchImpl = async url => {
        const key = new URL(url).pathname.replace(/^\//, '');
        return key in store ? new Response(store[key], { status: 200 }) : new Response('nope', { status: 404 });
    };
    return { store, calls, client, fetchImpl };
}

test('参数：state 必须 on/off；默认 key 与公开地址；非法 key／地址拒绝', () => {
    const a = parseArgs(['--state', 'off', '--reason', '维护', '--by', 'alice']);
    assert.equal(a.key, DEFAULT_KEY);
    assert.equal(a.publicUrl, DEFAULT_PUBLIC_URL);
    assert.equal(a.reason, '维护');
    for (const bad of [[], ['--state', 'maybe'], ['--state', 'on', '--key', '../x.json'], ['--state', 'on', '--key', 'a.txt'],
                       ['--state', 'on', '--public-url', 'http://x/y.json'], ['--state', 'on', '--bogus'], ['--state']]) {
        assert.throws(() => parseArgs(bad), e => e.code === 2, JSON.stringify(bad));
    }
});

test('laIso：洛杉矶时间带偏移（夏令时 -07:00、冬令时 -08:00）', () => {
    assert.equal(laIso(new Date('2026-10-19T17:05:09Z')), '2026-10-19T10:05:09-07:00');
    assert.equal(laIso(new Date('2026-12-01T08:00:00Z')), '2026-12-01T00:00:00-08:00');
    assert.equal(Date.parse(laIso(new Date('2026-10-19T17:05:09Z'))), Date.parse('2026-10-19T17:05:09Z'));
});

test('buildSwitch：enabled 跟 state；reason 去控制字符、限长', () => {
    const now = new Date('2026-10-19T17:00:00Z');
    assert.deepEqual(buildSwitch({ state: 'on', reason: '', by: 'bob' }, now),
        { enabled: true, reason: '', updatedAt: '2026-10-19T10:00:00-07:00', by: 'bob' });
    const off = buildSwitch({ state: 'off', reason: `a\nb${'x'.repeat(300)}`, by: 'bob' }, now);
    assert.equal(off.enabled, false);
    assert.equal(off.reason.length, 200);
    assert.ok(!off.reason.includes('\n'));
});

test('run：写开关文件（no-cache），再从公开地址读回核对', async () => {
    const f = fake();
    const a = parseArgs(['--state', 'off', '--reason', '搜索机挂了', '--by', 'carol',
                         '--public-url', 'https://bucket.example.com/fulltext/switch.json']);
    const r = await run(a, f.client, { fetchImpl: f.fetchImpl, log: quiet, now: new Date('2026-10-19T17:00:00Z'), sleep: noSleep });
    assert.deepEqual(f.calls, [{ k: 'fulltext/switch.json', cc: 'no-cache' }]);
    assert.deepEqual(JSON.parse(f.store['fulltext/switch.json']),
        { enabled: false, reason: '搜索机挂了', updatedAt: '2026-10-19T10:00:00-07:00', by: 'carol' });
    assert.equal(r.readBack.enabled, false);
});

test('写入失败 → 退出码 6', async () => {
    const f = fake({ putFails: true });
    const a = parseArgs(['--state', 'on', '--public-url', 'https://bucket.example.com/fulltext/switch.json']);
    await assert.rejects(run(a, f.client, { fetchImpl: f.fetchImpl, log: quiet, sleep: noSleep }), e => e.code === 6);
});

test('读回对不上（公开地址指向别的桶／旧内容）→ 重试后退出码 6', async () => {
    const f = fake();
    const a = parseArgs(['--state', 'on', '--public-url', 'https://other.example.com/elsewhere/switch.json']);
    let tries = 0;
    const fetchImpl = async () => { tries++; return new Response(JSON.stringify({ enabled: false, updatedAt: 'old' }), { status: 200 }); };
    await assert.rejects(run(a, f.client, { fetchImpl, log: quiet, sleep: noSleep }), e => e.code === 6 && /内容不符/.test(e.message));
    assert.equal(tries, 5);
});

test('readBack：前几次失败（网络错、404）后读到就成功', async () => {
    const want = { enabled: true, updatedAt: 'T' };
    const seq = [() => { throw new TypeError('network'); }, () => new Response('', { status: 404 }),
                 () => new Response(JSON.stringify({ ...want, reason: '' }), { status: 200 })];
    let i = 0;
    const got = await readBack('https://x.example.com/s.json', want, { fetchImpl: async () => seq[i++](), sleep: noSleep });
    assert.equal(got.enabled, true);
    assert.equal(i, 3);
});

test('dry-run 不写', async () => {
    const f = fake();
    const r = await run(parseArgs(['--state', 'on', '--dry-run']), f.client, { fetchImpl: f.fetchImpl, log: quiet });
    assert.equal(f.calls.length, 0);
    assert.equal(r.body.enabled, true);
});
