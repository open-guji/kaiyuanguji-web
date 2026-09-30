import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadLinks, fullTextShardOf, pickSome, renderSummary } from '../read-links-check.mjs';
import { mulberry32 } from '../dq-lib.mjs';

const DATA = 'https://data.test';
const SITE = 'https://www.test';
// 合法的 base36 id：type 位由 decodeId 解出。用真实 id：Work d59f1iofm800（type work），Book 96kzkdm8e8（type book）
const WORK = 'd59f1iofm800';
const BOOK = '96kzkdm8e8';

function fakeFetch(files, pages) {
    return async (url) => {
        const u = new URL(url);
        const hit = u.origin === new URL(SITE).origin ? pages[u.pathname] : files[u.pathname.replace(/^\/current\//, '')];
        if (hit === undefined) return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => hit, text: async () => String(hit) };
    };
}

function baseFiles() {
    const shard = fullTextShardOf(WORK);
    return {
        'read/tree.json': [{ id: 'n1', label: '史部' }],
        'read/n1/1.json': [{ id: WORK, title: '禮記' }],
        'read/featured.json': { collated: [], books: [{ id: BOOK, title: '本' }] },
        [`index/full_text/${shard}.json`]: { [WORK]: [{ key: 'k1', owner_type: 'Work', primary: true, total_chapters: 2 }] },
        [`items/${WORK}/full_text/k1/index.json`]: { chapters: [{ file: '001.md' }] },
        [`items/${WORK}/full_text/k1/001.txt`]: '正文',
        [`items/${BOOK}/full_text/index.json`]: { chapters: [{ file: '001.md' }] },
        [`items/${BOOK}/full_text/001.txt`]: '正文',
    };
}
const basePages = () => ({ [`/read/${WORK}`]: 'ok', [`/read/${BOOK}`]: 'ok' });

test('全部可读：页面与数据都 200，无失败', async () => {
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(baseFiles(), basePages()), seed: 1 });
    assert.equal(r.checked, 2);
    assert.deepEqual(r.failures, []);
});

test('页面 404 与首章缺失都会报', async () => {
    const files = baseFiles();
    delete files[`items/${WORK}/full_text/k1/001.txt`];
    const pages = basePages();
    delete pages[`/read/${BOOK}`];
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, pages), seed: 1 });
    assert.equal(r.failures.length, 2);
    assert.ok(r.failures.some((f) => f.id === WORK && f.what === '数据' && /001\.txt/.test(f.detail)));
    assert.ok(r.failures.some((f) => f.id === BOOK && f.what === '阅读页'));
});

test('Work 在 index/full_text 里没有站内条目（只有 Book 所有）也报', async () => {
    const files = baseFiles();
    files[`index/full_text/${fullTextShardOf(WORK)}.json`] = { [WORK]: [{ key: 'k1', owner_type: 'Book' }] };
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, basePages()), seed: 1 });
    assert.ok(r.failures.some((f) => f.id === WORK && /没有/.test(f.detail)));
});

test('整理本卡：查 collated_edition 目录与首卷', async () => {
    const files = baseFiles();
    files['read/featured.json'] = { collated: [{ id: WORK, collated: true }], books: [] };
    files['read/n1/1.json'] = [];
    files[`items/${WORK}/collated_edition/index.json`] = { juan_files: ['juan/001.json'] };
    const pages = { [`/read/${WORK}`]: 'ok' };
    let r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, pages), seed: 1 });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0].detail, /juan\/001\.json/);
    files[`items/${WORK}/collated_edition/juan/001.json`] = {};
    r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, pages), seed: 1 });
    assert.deepEqual(r.failures, []);
});

test('tree.json 读不了直接抛错；pickSome 带种子可复现；summary 列出失败', async () => {
    await assert.rejects(checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch({}, {}) }), /tree\.json/);
    const a = pickSome([1, 2, 3, 4, 5, 6, 7, 8], 3, mulberry32(7));
    const b = pickSome([1, 2, 3, 4, 5, 6, 7, 8], 3, mulberry32(7));
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    assert.equal(pickSome([1, 2], 20, mulberry32(1)).length, 2);
    const md = renderSummary({ checked: 3, failures: [{ id: 'x', what: '数据', detail: 'y' }] }, { target: SITE, seed: 9 });
    assert.match(md, /失败 1 处/);
    assert.match(md, /\| x \| 数据 \| y \|/);
});
