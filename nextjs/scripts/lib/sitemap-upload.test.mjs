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
import { publishSitemaps, planSitemaps, checkSitemaps, sitemapKey, NAME_RE, STORED_SITE } from './sitemap-upload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = STORED_SITE;
const urlset = (paths) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('\n')}\n</urlset>\n`;
const index = (names) => `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['sitemap.xml', ...names.map((n) => `sitemaps/${n}.xml`)].map((n) => `<sitemap><loc>${SITE}/${n}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;

function makeDir(shards = ['work-001', 'work-002', 'book-001', 'nodes-001'], opts = {}) {
    const d = mkdtempSync(join(tmpdir(), 'sm-'));
    mkdirSync(join(d, 'sitemaps'));
    for (const n of shards) writeFileSync(join(d, 'sitemaps', `${n}.xml`), opts.shardXml?.[n] ?? urlset([`/item/${n}`]));
    writeFileSync(join(d, 'sitemap-index.xml'), opts.indexXml ?? index(opts.listed ?? shards));
    return d;
}

/** 内存后端：记录写入顺序 */
function memBackend(initial = {}) {
    const store = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
    const puts = [];
    return {
        store, puts, deleted: [],
        async put(key, body, meta) { puts.push({ key, meta }); store.set(key, Buffer.from(body)); },
        async get(key) { return store.get(key) ?? null; },
        async list(prefix) { return [...store.keys()].filter((k) => k.startsWith(prefix)); },
        async del(keys) { this.deleted.push(...keys); for (const k of keys) store.delete(k); },
    };
}

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
    const r = await publishSitemaps({ dir: makeDir(), backend: b, retryDelayMs: 0 });
    assert.equal(r.uploaded, 5);
    assert.equal(b.puts.length, 5);
    assert.equal(b.puts[4].key, 'sitemaps/sitemap-index.xml');
    assert.deepEqual(b.puts.slice(0, 4).map((p) => p.key).sort(), ['sitemaps/book-001.xml', 'sitemaps/nodes-001.xml', 'sitemaps/work-001.xml', 'sitemaps/work-002.xml']);
    for (const p of b.puts) {
        assert.equal(p.meta.contentType, 'application/xml; charset=utf-8');
        assert.equal(p.meta.cacheControl, 'public, max-age=300');
    }
});

test('演练前缀：全部写在 staging/sitemaps/ 下，不碰根', async () => {
    const b = memBackend();
    await publishSitemaps({ dir: makeDir(), prefix: 'staging', backend: b, retryDelayMs: 0 });
    assert.ok(b.puts.every((p) => p.key.startsWith('staging/sitemaps/')));
});

test('dry-run：只检查，不碰后端', async () => {
    const r = await publishSitemaps({ dir: makeDir(), backend: null, dryRun: true });
    assert.equal(r.uploaded, 0);
    assert.equal(r.planned, 5);
});

test('检查不过就一个对象都不传：分片名不在白名单／索引列了不存在的分片／分片不在索引里', async () => {
    const cases = [
        [makeDir(['work-001', 'evil-001'], { listed: ['work-001'] }), /白名单/],
        [makeDir(['work-001'], { listed: ['work-001', 'work-002'] }), /目录里没有这个分片/],
        [makeDir(['work-001', 'book-001'], { listed: ['work-001'] }), /不在索引里/],
    ];
    for (const [dir, re] of cases) {
        const b = memBackend();
        await assert.rejects(() => publishSitemaps({ dir, backend: b, retryDelayMs: 0 }), re);
        assert.equal(b.puts.length, 0);
    }
});

test('检查不过：<loc> 不是正式站地址（比如把测试站的 sitemap 传上去）', async () => {
    const d = makeDir(['work-001'], { shardXml: { 'work-001': urlset([]).replace('</urlset>', '<url><loc>https://staging.kaiyuanguji.com/item/x</loc></url></urlset>') } });
    const b = memBackend();
    await assert.rejects(() => publishSitemaps({ dir: d, backend: b }), /不是正式站地址/);
    assert.equal(b.puts.length, 0);
});

test('检查不过：截断的分片、没有 XML 声明、缺目录或缺索引', () => {
    const plan = { shards: [{ name: 'work-001' }] };
    assert.ok(checkSitemaps(plan, { 'work-001': urlset(['/a']).replace('</urlset>\n', ''), 'sitemap-index': index(['work-001']) }).some((e) => /收尾/.test(e)));
    assert.ok(checkSitemaps(plan, { 'work-001': 'hello', 'sitemap-index': index(['work-001']) }).some((e) => /不是 XML/.test(e)));
    assert.ok(planSitemaps(join(tmpdir(), 'no-such-dir-xyz')).errors.length >= 2);
});

test('传完回读索引核对字节数，不一致就抛错', async () => {
    const b = memBackend();
    const origGet = b.get.bind(b);
    b.get = async (k) => { const v = await origGet(k); return v ? v.subarray(0, v.length - 3) : v; };
    await assert.rejects(() => publishSitemaps({ dir: makeDir(), backend: b, retryDelayMs: 0 }), /回读/);
});

test('单个对象失败会重试，仍失败才抛错；失败时索引没传', async () => {
    const b = memBackend();
    let n = 0;
    const origPut = b.put.bind(b);
    b.put = async (k, body, meta) => { if (k.includes('work-001') && ++n <= 2) throw new Error('boom'); return origPut(k, body, meta); };
    const r = await publishSitemaps({ dir: makeDir(), backend: b, retryDelayMs: 0 });
    assert.equal(r.uploaded, 5);          // 前两次失败，第三次成功

    const b2 = memBackend();
    b2.put = async (k) => { if (k.includes('work-002')) throw new Error('always'); };
    await assert.rejects(() => publishSitemaps({ dir: makeDir(), backend: b2, retryDelayMs: 0 }), /传 work-002失败/);
    assert.equal(b2.store.has('sitemaps/sitemap-index.xml'), false, '分片没传全，索引不能传');
});

test('清理：只删前缀下合规名字且不在这一版里的旧分片，别的对象不动；清理失败只警告', async () => {
    const b = memBackend({
        'sitemaps/work-003.xml': 'old', 'sitemaps/work-001.xml': 'old1',
        'sitemaps/README.txt': 'keep', 'sitemaps/evil-001.xml': 'keep',      // 不合规的名字不碰
        'staging/sitemaps/work-003.xml': 'other-prefix',                       // 别的前缀不碰
        'latest.json': '{}',
    });
    const r = await publishSitemaps({ dir: makeDir(['work-001', 'work-002']), backend: b, retryDelayMs: 0 });
    assert.deepEqual(b.deleted, ['sitemaps/work-003.xml']);
    assert.equal(r.pruned, 1);
    for (const k of ['sitemaps/README.txt', 'sitemaps/evil-001.xml', 'staging/sitemaps/work-003.xml', 'latest.json']) assert.ok(b.store.has(k), k);

    const b2 = memBackend({ 'sitemaps/work-009.xml': 'old' });
    b2.del = async () => { throw new Error('nope'); };
    const r2 = await publishSitemaps({ dir: makeDir(['work-001']), backend: b2, retryDelayMs: 0 });
    assert.equal(r2.pruned, 0);
    assert.equal(r2.warnings.length, 1);
});
