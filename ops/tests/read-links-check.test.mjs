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

test('pickSome 带种子可复现；summary 列出失败', () => {
    const a = pickSome([1, 2, 3, 4, 5, 6, 7, 8], 3, mulberry32(7));
    const b = pickSome([1, 2, 3, 4, 5, 6, 7, 8], 3, mulberry32(7));
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    assert.equal(pickSome([1, 2], 20, mulberry32(1)).length, 2);
    const md = renderSummary({ checked: 3, failures: [{ id: 'x', what: '数据', detail: 'y' }] }, { target: SITE, seed: 9 });
    assert.match(md, /失败 1 处/);
    assert.match(md, /\| x \| 数据 \| y \|/);
});

test('顶层清单读不了（404、网络错误、JSON 坏）：记成失败返回，不抛', async () => {
    let r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch({}, {}) });
    assert.equal(r.checked, 0);
    assert.ok(r.failures.some((f) => f.id === 'read/tree.json' && /HTTP 404/.test(f.detail)));
    const boom = async () => { throw new Error('ECONNRESET'); };
    r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: boom });
    assert.ok(r.failures.some((f) => f.id === 'read/tree.json' && /ECONNRESET/.test(f.detail)));
    const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } });
    r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: badJson });
    assert.ok(r.failures.some((f) => /Unexpected token/.test(f.detail)));
    // 失败照样能渲染 summary
    assert.match(renderSummary(r, { target: SITE, seed: 1 }), /read\/tree\.json/);
});

test('多页节点：从随机的若干页抽卡，不只看第 1 页；某页读不了记失败', async () => {
    const files = baseFiles();
    // 节点 120 张卡 → 6 页；每页一张卡，id 形如 p<页号>
    files['read/tree.json'] = [{ id: 'n1', label: '史部', count: 120 }];
    files['read/featured.json'] = { collated: [], books: [] };
    for (let n = 1; n <= 6; n++) files[`read/n1/${n}.json`] = [{ id: `p${n}`, title: `书${n}` }];
    const seen = new Set();
    const spy = async (url) => {
        const m = new URL(url).pathname.match(/read\/n1\/(\d+)\.json$/);
        if (m) seen.add(Number(m[1]));
        return fakeFetch(files, {})(url);
    };
    await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: spy, perNode: 4, seed: 3 });
    assert.equal(seen.size, 4); // 6 页里挑 4 个不同的页
    assert.ok([...seen].some((n) => n > 1), '不只是第 1 页');
    // 某一页读不了：记失败，不抛，其余页照常抽
    delete files['read/n1/2.json'];
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, {}), perNode: 6, seed: 3 });
    assert.ok(r.failures.some((f) => f.id === 'read/n1/2.json'));
});

// ─── 新结构（overview#307）：items/<id>/manifest.json ───

function newStructureFiles(extra = {}) {
    const files = baseFiles();
    files['read/tree.json'] = [{ id: 'n1', label: '史部', count: 1 }];
    files['read/n1/1.json'] = [{ id: WORK, title: '禮記' }];
    files['read/featured.json'] = { collated: [], books: [] };
    files[`items/${WORK}/manifest.json`] = { id: WORK, versions: [{ key: 'default', kind: 'collated' }, { key: 'wikisource', kind: 'transcription' }] };
    files[`items/${WORK}/default/index.json`] = { chapters: [{ n: 1, file: '001', has_json: true }] };
    files[`items/${WORK}/default/001.txt`] = '正文';
    files[`items/${WORK}/default/001.json`] = {};
    files[`items/${WORK}/wikisource/index.json`] = { chapters: [{ n: 1, file: '001', has_json: false }] };
    files[`items/${WORK}/wikisource/001.txt`] = '维基';
    return { ...files, ...extra };
}
const newPages = () => ({ [`/read/${WORK}`]: 'ok', [`/read/${WORK}/wikisource`]: 'ok' });

test('新结构：每个版本的目录、首章（has_json 的含 json）和页面（主版本 /read/<id>、其他 /read/<id>/<key>）都查', async () => {
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(newStructureFiles(), newPages()), seed: 1 });
    assert.equal(r.checked, 1);
    assert.deepEqual(r.failures, []);
});

test('新结构：缺首章 json、缺非主版本页面、目录 chapters 为空都报；旧结构 404 的 manifest 不算失败', async () => {
    const files = newStructureFiles();
    delete files[`items/${WORK}/default/001.json`];
    files[`items/${WORK}/wikisource/index.json`] = { chapters: [] };
    const pages = { [`/read/${WORK}`]: 'ok' }; // 缺 /read/<id>/wikisource
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, pages), seed: 1 });
    const details = r.failures.map((f) => f.detail).join('\n');
    assert.match(details, /default\/001\.json/);
    assert.match(details, /\/read\/[^\s]+\/wikisource/);
    assert.match(details, /wikisource\/index\.json 的 chapters 为空/);
    // 旧结构的 baseFiles 没有 manifest.json，前面的旧结构用例已覆盖「不算失败」
});

test('新结构：manifest 带 internal、versions[0] 不是 default、key 不合法，都报', async () => {
    const files = newStructureFiles();
    files[`items/${WORK}/manifest.json`] = { id: WORK, versions: [{ key: 'wikisource', kind: 'transcription' }, { key: 'shidian', kind: 'transcription', visibility: 'internal' }, { key: 'manifest' }] };
    files[`items/${WORK}/shidian/index.json`] = { chapters: [{ file: '001' }] };
    files[`items/${WORK}/shidian/001.txt`] = 'x';
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: fakeFetch(files, newPages()), seed: 1 });
    const details = r.failures.map((f) => f.detail).join('\n');
    assert.match(details, /visibility=internal/);
    assert.match(details, /versions\[0\] 不是 default/);
    assert.match(details, /不合法的版本 key/);
});

test('manifest 请求返回 404 才当旧结构；5xx 记失败、不往旧路径上走', async () => {
    const files = baseFiles();
    const pages = basePages();
    const inner = fakeFetch(files, pages);
    const flaky = async (url, init) => {
        if (new URL(url).pathname.endsWith(`/items/${WORK}/manifest.json`)) return { ok: false, status: 503 };
        return inner(url, init);
    };
    const r = await checkReadLinks({ target: SITE, dataBase: DATA, fetchImpl: flaky, seed: 1 });
    assert.ok(r.failures.some((f) => f.id === WORK && /manifest\.json → HTTP 503/.test(f.detail)));
    // 其余（BOOK 的旧结构）照常通过
    assert.ok(!r.failures.some((f) => f.id === BOOK));
});
