import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hide, isHidden, listAll, parseIds, renderTable, summarize } from '../feedback-hide.mjs';

const BASE = 'https://www.test';
const TOKEN = 'tok';

const REC = {
    probe: { id: 'fb_1790189101041_jrc4', type: 'bug', status: 'pending', content: 'verify probe', createdAt: '2026-09-23T18:45:01Z', pageUrl: 'https://www.kaiyuanguji.com/verify' },
    real: { id: 'fb_1775781252628_8mh1', type: 'resource', status: 'resolved', content: '?????ID???', createdAt: '2026-04-10T00:34:00Z' },
    done: { id: 'fb_1775932844473_fnkf', type: 'bug', status: 'resolved', content: 'test', test: true, visibility: 'hidden' },
    contact: { id: 'fb_1789000000000_abcd', type: 'contact', status: 'pending', content: '想加入，邮箱 a.b@example.com 电话 13812345678', contact: 'wx: secret_id', updatedBy: 'm@x.org' },
};

/** 假的 /api/feedback：GET 要 Bearer 才回全量（分两页），POST update 要 body.token */
function fakeApi(records) {
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if ((init.method ?? 'GET') === 'GET') {
            assert.equal(init.headers?.Authorization, `Bearer ${TOKEN}`);
            const all = Object.values(records);
            const page = u.searchParams.get('cursor') ? all.slice(2) : all.slice(0, 2);
            const hasMore = !u.searchParams.get('cursor') && all.length > 2;
            return { ok: true, status: 200, json: async () => ({ success: true, items: page, hasMore, cursor: hasMore ? 'c1' : '' }) };
        }
        const body = JSON.parse(init.body);
        posts.push(body);
        if (body.token !== TOKEN) return { ok: false, status: 401, json: async () => ({ success: false, error: '未授权' }) };
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    return { fetchImpl, posts };
}

test('parseIds：逗号／空白／全角逗号分隔，去重；格式不对的单列', () => {
    assert.deepEqual(parseIds('fb_1_a, fb_2_b，fb_1_a\nbad x'), { ids: ['fb_1_a', 'fb_2_b'], invalid: ['bad', 'x'] });
    assert.deepEqual(parseIds(''), { ids: [], invalid: [] });
});

test('isHidden 与 feedback.js 公开读规则互为反面', () => {
    assert.equal(isHidden(REC.probe), false);
    assert.equal(isHidden(REC.done), true);
    assert.equal(isHidden(REC.contact), true);
    assert.equal(isHidden({ visibility: 'hidden' }), true);
});

test('summarize／renderTable：不出 contact、updatedBy；不公开的条目正文一字不出，公开的脱敏、截断', () => {
    const md = renderTable([REC.contact, REC.done]);
    assert.ok(!md.includes('secret_id'));
    assert.ok(!md.includes('m@x.org'));
    assert.ok(!md.includes('想加入'));
    assert.ok(!md.includes('a.b@example.com'));
    assert.ok(!md.includes('13812345678'));
    assert.match(md, /不公开，正文 \d+ 字不输出/);
    const pub = summarize({ id: 'fb_1_a', content: '请联系 a.b@example.com 或 13812345678' });
    assert.match(pub.snippet, /\*\*\*@\*\*\*/);
    assert.ok(!pub.snippet.includes('13812345678'));
    const long = summarize({ id: 'fb_1_a', content: '字'.repeat(60) });
    assert.equal(long.snippet, `${'字'.repeat(40)}…`);
    assert.equal(summarize(REC.probe).page, '/verify');
});

test('listAll 翻完所有页', async () => {
    const { fetchImpl } = fakeApi(REC);
    const all = await listAll({ base: BASE, token: TOKEN, fetchImpl });
    assert.equal(all.length, 4);
});

test('hide dry_run：列出计划、不发任何写请求；已隐藏的跳过，库里没有的记失败', async () => {
    const { fetchImpl, posts } = fakeApi(REC);
    const r = await hide({ base: BASE, token: TOKEN, ids: [REC.probe.id, REC.done.id, 'fb_9_zz'], apply: false, fetchImpl, log: () => {} });
    assert.deepEqual(r.planned.map((x) => x.id), [REC.probe.id]);
    assert.deepEqual(r.skipped.map((x) => x.id), [REC.done.id]);
    assert.deepEqual(r.failed.map((x) => x.id), ['fb_9_zz']);
    assert.equal(posts.length, 0);
});

test('hide --apply：每条发一次 update，只改 test＋visibility', async () => {
    const { fetchImpl, posts } = fakeApi(REC);
    const r = await hide({ base: BASE, token: TOKEN, ids: [REC.probe.id], apply: true, fetchImpl, log: () => {} });
    assert.deepEqual(r.done, [REC.probe.id]);
    assert.deepEqual(posts, [{ action: 'update', token: TOKEN, id: REC.probe.id, test: true, visibility: 'hidden' }]);
});

test('管理读失败直接抛错，不往下写', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({ success: false, error: 'KV 超时' }) });
    await assert.rejects(hide({ base: BASE, token: TOKEN, ids: [REC.probe.id], apply: true, fetchImpl, log: () => {} }), /管理读失败：HTTP 503 KV 超时/);
});
