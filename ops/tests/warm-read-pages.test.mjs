import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listHotPages, warmPages, renderSummary } from '../warm-read-pages.mjs';

const DATA = 'https://data.test/staging';
const SITE = 'https://staging.test';

function fakeData(files) {
    return async (url) => {
        const rel = new URL(url).pathname.replace(/^\/staging\/current\//, '');
        if (!(rel in files)) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => files[rel] };
    };
}

test('热门页：featured 全部＋各节点第 1 页，去重，featured 在前', async () => {
    const files = {
        'read/featured.json': { collated: [{ id: 'a' }], books: [{ id: 'b' }] },
        'read/tree.json': [{ id: 'n1' }, { id: 'n2' }],
        'read/n1/1.json': [{ id: 'c' }, { id: 'a' }],
        'read/n2/1.json': [{ id: 'd' }],
    };
    const { urls, errors } = await listHotPages({ target: SITE, dataBase: DATA, fetchImpl: fakeData(files) });
    assert.deepEqual(urls, ['a', 'b', 'c', 'd'].map((id) => `${SITE}/read/${id}`));
    assert.deepEqual(errors, []);
});

test('清单读不了：记进 errors，其余照常，不抛', async () => {
    const files = { 'read/tree.json': [{ id: 'n1' }, { id: 'n2' }], 'read/n2/1.json': [{ id: 'x' }] };
    const { urls, errors } = await listHotPages({ target: SITE, dataBase: DATA, fetchImpl: fakeData(files) });
    assert.deepEqual(urls, [`${SITE}/read/x`]);
    assert.equal(errors.length, 2); // featured.json、n1/1.json
    const boom = async () => { throw new Error('ECONNRESET'); };
    const r = await listHotPages({ target: SITE, dataBase: DATA, fetchImpl: boom });
    assert.deepEqual(r.urls, []);
    assert.ok(r.errors.every((e) => /ECONNRESET/.test(e)));
});

test('预热：记首次状态与耗时，网络错记 0，不重试', async () => {
    const calls = [];
    const f = async (url) => {
        calls.push(url);
        if (url.endsWith('/b')) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
        if (url.endsWith('/c')) throw new Error('fetch failed');
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    let t = 0;
    const { results } = await warmPages(['a', 'b', 'c'].map((x) => `${SITE}/read/${x}`), { fetchImpl: f, concurrency: 2, now: () => (t += 100) });
    assert.equal(calls.length, 3);
    const by = Object.fromEntries(results.map((r) => [r.url.slice(-1), r.status]));
    assert.deepEqual(by, { a: 200, b: 503, c: 0 });
    assert.ok(results.every((r) => r.ms > 0));
    const md = renderSummary({ results, errors: ['read/n1/1.json → HTTP 404'] }, { target: SITE });
    assert.match(md, /3 页，首次非 200 的 2 页（66\.7%）/);
    assert.match(md, /503×1/);
    assert.match(md, /连接失败／超时×1/);
    assert.match(md, /清单读不了/);
});
