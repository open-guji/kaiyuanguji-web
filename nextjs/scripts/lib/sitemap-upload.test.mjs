/**
 * sitemap-upload.test.mjs — sitemap 上传的检查与顺序（内存后端，不联网）。
 * 用法：node --test scripts/lib/sitemap-upload.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    publishSitemaps, planSitemaps, checkSitemaps, sitemapKey, NAME_RE, STORED_SITE, MAX_URLS_PER_SHARD, PRUNE_MIN_AGE_MS,
} from './sitemap-upload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = STORED_SITE;
const urlset = (paths) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('\n')}\n</urlset>\n`;
const index = (names) => `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['sitemap.xml', ...names.map((n) => `sitemaps/${n}.xml`)].map((n) => `<sitemap><loc>${SITE}/${n}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

function makeDir(shards = ['work-001', 'work-002', 'book-001', 'nodes-001'], opts = {}) {
    const d = mkdtempSync(join(tmpdir(), 'sm-'));
    mkdirSync(join(d, 'sitemaps'));
    for (const n of shards) writeFileSync(join(d, 'sitemaps', `${n}.xml`), opts.shardXml?.[n] ?? urlset([`/item/${n}`]));
    writeFileSync(join(d, 'sitemap-index.xml'), opts.indexXml ?? index(opts.listed ?? shards));
    return d;
}

/** 内存后端：记录每次 put 的 key（含失败的）、存对象和写入时间。initial: { key: body | { body, lastModified } } */
function memBackend(initial = {}) {
    const store = new Map();
    for (const [k, v] of Object.entries(initial)) {
        const o = typeof v === 'string' ? { body: v, lastModified: NOW - 10 * DAY } : v;
        store.set(k, { body: Buffer.from(o.body), lastModified: o.lastModified });
    }
    const b = {
        store, putCalls: [], deleted: [],
        async put(key, body, meta) { b.putCalls.push({ key, meta }); store.set(key, { body: Buffer.from(body), lastModified: NOW }); },
        async get(key) { return store.get(key)?.body ?? null; },
        async list(prefix) { return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, lastModified: v.lastModified })); },
        async del(keys) { b.deleted.push(...keys); for (const k of keys) store.delete(k); },
    };
    return b;
}
const opts = { retryDelayMs: 0, now: NOW };

test('NAME_RE 与路由代理的白名单正则、STORED_SITE 与路由代理的存储站点逐字相同', () => {
    const ts = readFileSync(join(HERE, '..', '..', 'src', 'lib', 'server', 'sitemap-proxy.ts'), 'utf-8');
    const m = ts.match(/const NAME_RE = (\/.*\/);/);
    assert.ok(m, '没找到路由代理里的 NAME_RE');
    assert.equal(NAME_RE.toString(), m[1]);
    assert.ok(ts.includes(`export const STORED_SITE = '${STORED_SITE}';`));
});

test('sitemapKey：前缀可空、可带斜杠', () => {
    assert.equal(sitemapKey('', 'work-001'), 'sitemaps/work-001.xml');
    assert.equal(sitemapKey(undefined, 'sitemap-index'), 'sitemaps/sitemap-index.xml');
    assert.equal(sitemapKey('/staging/', 'work-001'), 'staging/sitemaps/work-001.xml');
});

test('先传所有分片，索引最后一个传；缓存头与类型正确', async () => {
    const b = memBackend();
    const r = await publishSitemaps({ dir: makeDir(), backend: b, ...opts });
    assert.equal(r.uploaded, 5);
    assert.equal(b.putCalls.length, 5);
    assert.equal(b.putCalls[4].key, 'sitemaps/sitemap-index.xml');
    assert.deepEqual(b.putCalls.slice(0, 4).map((p) => p.key).sort(), ['sitemaps/book-001.xml', 'sitemaps/nodes-001.xml', 'sitemaps/work-001.xml', 'sitemaps/work-002.xml']);
    for (const p of b.putCalls) {
        assert.equal(p.meta.contentType, 'application/xml; charset=utf-8');
        assert.equal(p.meta.cacheControl, 'public, max-age=300');
    }
});

test('演练前缀：全部写在 staging/sitemaps/ 下，不碰根', async () => {
    const b = memBackend();
    await publishSitemaps({ dir: makeDir(), prefix: 'staging', backend: b, ...opts });
    assert.ok(b.putCalls.every((p) => p.key.startsWith('staging/sitemaps/')));
});

test('dry-run：只检查，不碰后端', async () => {
    const r = await publishSitemaps({ dir: makeDir(), backend: null, dryRun: true });
    assert.equal(r.uploaded, 0);
    assert.equal(r.planned, 5);
});

test('并发数非正整数：拒绝，且一个对象都不传（否则会没传分片就发索引）', async () => {
    for (const c of [0, -1, 1.5, NaN, '3']) {
        const b = memBackend();
        await assert.rejects(() => publishSitemaps({ dir: makeDir(), backend: b, concurrency: c, ...opts }), /concurrency 必须是正整数/);
        assert.equal(b.putCalls.length, 0);
    }
});

test('检查不过就一个对象都不传：分片名不在白名单／索引列了不存在的分片／分片不在索引里', async () => {
    const cases = [
        [makeDir(['work-001', 'evil-001'], { listed: ['work-001'] }), /白名单/],
        [makeDir(['work-001'], { listed: ['work-001', 'work-002'] }), /目录里没有这个分片/],
        [makeDir(['work-001', 'book-001'], { listed: ['work-001'] }), /不在索引里/],
    ];
    for (const [dir, re] of cases) {
        const b = memBackend();
        await assert.rejects(() => publishSitemaps({ dir, backend: b, ...opts }), re);
        assert.equal(b.putCalls.length, 0);
    }
});

test('检查不过：<loc> 不是正式站地址（比如把测试站的 sitemap 传上去）', async () => {
    const d = makeDir(['work-001'], { shardXml: { 'work-001': urlset([]).replace('</urlset>', '<url><loc>https://staging.kaiyuanguji.com/item/x</loc></url></urlset>') } });
    const b = memBackend();
    await assert.rejects(() => publishSitemaps({ dir: d, backend: b, ...opts }), /不是正式站地址/);
    assert.equal(b.putCalls.length, 0);
});

test('检查不过：分片地址数超过 sitemap 协议的 50,000（SITEMAP_PER_SHARD 设大了）', async () => {
    const big = urlset(Array.from({ length: MAX_URLS_PER_SHARD + 1 }, (_, i) => `/item/${i}`));
    const b = memBackend();
    await assert.rejects(() => publishSitemaps({ dir: makeDir(['work-001'], { shardXml: { 'work-001': big } }), backend: b, ...opts }), /超过 sitemap 协议的 50000 上限/);
    assert.equal(b.putCalls.length, 0);
    // 恰好 50,000 可以
    const ok = urlset(Array.from({ length: MAX_URLS_PER_SHARD }, (_, i) => `/item/${i}`));
    await publishSitemaps({ dir: makeDir(['work-001'], { shardXml: { 'work-001': ok } }), backend: memBackend(), ...opts });
});

test('检查不过：截断的分片、没有 XML 声明', () => {
    const plan = { shards: [{ name: 'work-001' }] };
    assert.ok(checkSitemaps(plan, { 'work-001': urlset(['/a']).replace('</urlset>\n', ''), 'sitemap-index': index(['work-001']) }).some((e) => /收尾/.test(e)));
    assert.ok(checkSitemaps(plan, { 'work-001': 'hello', 'sitemap-index': index(['work-001']) }).some((e) => /不是 XML/.test(e)));
});

test('目录问题：缺 sitemaps 目录、缺索引、没有分片，各自有对应的诊断', () => {
    const errs = planSitemaps(join(tmpdir(), 'no-such-dir-xyz')).errors;
    assert.ok(errs.some((e) => /no-such-dir-xyz\/sitemaps$/.test(e) && /^没有 /.test(e)), errs.join('|'));
    assert.ok(errs.some((e) => /no-such-dir-xyz\/sitemap-index\.xml$/.test(e) && /^没有 /.test(e)), errs.join('|'));
    assert.ok(errs.includes('没有任何分片'));
    // 目录在、索引缺：只报索引
    const noIdx = mkdtempSync(join(tmpdir(), 'sm-'));
    mkdirSync(join(noIdx, 'sitemaps'));
    writeFileSync(join(noIdx, 'sitemaps', 'work-001.xml'), urlset(['/a']));
    const e2 = planSitemaps(noIdx).errors;
    assert.equal(e2.length, 1);
    assert.match(e2[0], /sitemap-index\.xml$/);
});

test('传完回读索引核对字节数，不一致就抛错', async () => {
    const b = memBackend();
    const origGet = b.get.bind(b);
    b.get = async (k) => { const v = await origGet(k); return v ? v.subarray(0, v.length - 3) : v; };
    await assert.rejects(() => publishSitemaps({ dir: makeDir(), backend: b, ...opts }), /回读/);
});

test('单个对象失败会重试：work-001 前两次失败、第三次成功，共三次尝试，分片真的在后端里，索引随后才传', async () => {
    const b = memBackend();
    let n = 0;
    const origPut = b.put.bind(b);
    b.put = async (k, body, meta) => {
        if (k === 'sitemaps/work-001.xml' && ++n <= 2) { b.putCalls.push({ key: k, failed: true }); throw new Error('boom'); }
        return origPut(k, body, meta);
    };
    const r = await publishSitemaps({ dir: makeDir(), backend: b, ...opts });
    assert.equal(r.uploaded, 5);
    assert.equal(b.putCalls.filter((c) => c.key === 'sitemaps/work-001.xml').length, 3);
    assert.ok(b.store.has('sitemaps/work-001.xml'), '重试成功的分片应在后端里');
    const last = b.putCalls[b.putCalls.length - 1];
    assert.equal(last.key, 'sitemaps/sitemap-index.xml');
    assert.ok(!last.failed);
});

test('某个分片重试后仍失败：抛错，且索引从未被尝试上传', async () => {
    const b = memBackend();
    const origPut = b.put.bind(b);
    b.put = async (k, body, meta) => {
        if (k === 'sitemaps/work-002.xml') { b.putCalls.push({ key: k, failed: true }); throw new Error('always'); }
        return origPut(k, body, meta);
    };
    await assert.rejects(() => publishSitemaps({ dir: makeDir(), backend: b, ...opts }), /传 work-002失败/);
    assert.equal(b.putCalls.filter((c) => c.key === 'sitemaps/work-002.xml').length, 3);
    assert.ok(!b.putCalls.some((c) => c.key === 'sitemaps/sitemap-index.xml'), '分片没传全，索引连尝试都不能有');
    assert.equal(b.store.has('sitemaps/sitemap-index.xml'), false);
});

test('清理：只删前缀下合规名字、不在这一版里、且放满一天的旧分片；别的对象和太新的都不动', async () => {
    const b = memBackend({
        'sitemaps/work-003.xml': 'old',                                          // 旧、合规、不在这版 → 删
        'sitemaps/work-001.xml': 'old1',                                         // 在这版里 → 会被覆盖，不删
        'sitemaps/work-004.xml': { body: 'fresh', lastModified: NOW - 3600_000 }, // 才一小时：缓存里的旧索引可能还引用 → 留
        'sitemaps/README.txt': 'keep', 'sitemaps/evil-001.xml': 'keep',          // 不合规的名字不碰
        'staging/sitemaps/work-003.xml': 'other-prefix',                         // 别的前缀不碰
        'latest.json': '{}',
    });
    const r = await publishSitemaps({ dir: makeDir(['work-001', 'work-002']), backend: b, ...opts });
    assert.deepEqual(b.deleted, ['sitemaps/work-003.xml']);
    assert.equal(r.pruned, 1);
    for (const k of ['sitemaps/work-004.xml', 'sitemaps/README.txt', 'sitemaps/evil-001.xml', 'staging/sitemaps/work-003.xml', 'latest.json']) assert.ok(b.store.has(k), k);
    assert.equal(PRUNE_MIN_AGE_MS, DAY);
});

test('清理失败（包括 COS 对个别对象报错）只警告，发布本身成功，不把没删掉的算作已清理', async () => {
    const b2 = memBackend({ 'sitemaps/work-009.xml': 'old' });
    b2.del = async () => { throw new Error('1 个对象没删掉：sitemaps/work-009.xml(AccessDenied)'); };
    const r2 = await publishSitemaps({ dir: makeDir(['work-001']), backend: b2, ...opts });
    assert.equal(r2.pruned, 0);
    assert.equal(r2.warnings.length, 1);
    assert.match(r2.warnings[0], /AccessDenied/);
    assert.ok(b2.store.has('sitemaps/sitemap-index.xml'));
});
