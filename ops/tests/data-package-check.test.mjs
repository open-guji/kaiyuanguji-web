/**
 * data-package-check.test.mjs — 数据包检查（ops/data-package-check.mjs）：整包扫描、与上一次发布对比、阈值、输出、CLI。
 * 用法：node --test ops/tests/data-package-check.test.mjs
 * 夹具：ops/tests/fixtures/data-contract/（旧格式线上条目、book-index schema-v2 的 contract-sample）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    Findings, scanEntries, compareToBaseline, checkAbsolute, fetchBaseline, runCheck, renderSummary,
    THRESHOLDS, COUNT_RANGES, MIN_ENTRY_FILES,
} from '../data-package-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures', 'data-contract');
const SCRIPT = join(HERE, '..', 'data-package-check.mjs');
const load = (rel) => JSON.parse(readFileSync(join(FX, rel), 'utf-8'));
const write = (p, doc) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc)); };

/** 用夹具造一个数据包（dirs：用哪几套夹具的条目）；meta／meta-home 的计数按条目实数生成，保证自洽。 */
function makePackage(dirs = ['old', 'v2']) {
    const root = mkdtempSync(join(tmpdir(), 'dpc-'));
    const data = join(root, 'data');
    const counts = { work: 0, book: 0, collection: 0, entity: 0 };
    for (const d of dirs) {
        for (const f of readdirSync(join(FX, d, 'entry'))) {
            if (!f.endsWith('.json')) continue;
            if (existsSync(join(data, 'entry', f))) continue; // 新旧夹具有同 id 的，只取一份
            mkdirSync(join(data, 'entry'), { recursive: true });
            copyFileSync(join(FX, d, 'entry', f), join(data, 'entry', f));
            counts[load(`${d}/entry/${f}`).type]++;
        }
    }
    const meta = {
        works: counts.work, books: counts.book, collections: counts.collection, entities: counts.entity,
        resourceCounts: { hasText: 3, hasImage: 5 }, subtypeStats: { book: counts.work },
    };
    write(join(data, 'meta.json'), meta);
    write(join(data, 'version.json'), load('old/version.json'));
    write(join(root, 'latest.json'), load('old/latest.json'));
    const tree = [{ id: 'a', label: '經部', count: 3, children: [{ id: 'b', label: '易類', count: 1 }] }];
    write(join(data, 'read', 'tree.json'), tree);
    write(join(data, 'catalog', 'tree.json'), tree);
    write(join(data, 'meta-home', 'sections.json'), { counts: { works: counts.work, books: counts.book, collections: counts.collection, entities: counts.entity } });
    write(join(data, 'index', 'texts', '0.json'), { d59f2ho5z08x: [{ key: 'default', kind: 'transcription', label: '維基文庫', chapters_total: 1 }] });
    write(join(data, 'items', 'd59f2ho5z08x', 'manifest.json'), { id: 'd59f2ho5z08x', versions: [{ key: 'default', chapters_total: 1 }] });
    write(join(data, 'items', 'd59f2ho5z08x', 'default', '001.txt'), '正文');
    return { root, data, meta, counts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const codeSet = (report, severity) => new Set(report.findings.filter((f) => f.severity === severity).map((f) => f.code));

// ─── 整包：旧格式、新格式、混合都通过 ───

for (const dirs of [['old'], ['v2'], ['old', 'v2']]) {
    test(`整包扫描：${dirs.join('＋')} 格式的包没有 block（小包，跳过绝对下限）`, () => {
        const pkg = makePackage(dirs);
        try {
            const r = runCheck({ root: pkg.root, absolute: false });
            assert.deepEqual([...codeSet(r, 'block')], [], JSON.stringify(r.findings.filter((f) => f.severity === 'block')));
            assert.deepEqual([...codeSet(r, 'warn')].filter((c) => c !== 'entry.unknown-field'), [], JSON.stringify(r.findings.filter((f) => f.severity === 'warn')));
            assert.equal(r.counts.entryFiles, readdirSync(join(pkg.data, 'entry')).length);
            assert.equal(r.counts.byType.work + r.counts.byType.book + r.counts.byType.collection + r.counts.byType.entity, r.counts.entryFiles);
            assert.equal(r.texts.itemOwners, 1);
            assert.equal(r.texts.itemFiles, 2);
            assert.equal(r.texts.indexOwners, 1);
            assert.equal(r.trees['read/tree.json'].nodes, 2);
        } finally { pkg.cleanup(); }
    });
}

test('整包扫描：默认（含绝对下限）时小包会被判条目太少——绝对下限在起作用', () => {
    const pkg = makePackage(['old']);
    try {
        const r = runCheck({ root: pkg.root });
        assert.ok(codeSet(r, 'block').has('abs.entry-files'));
        assert.ok(codeSet(r, 'block').has('abs.range'));
    } finally { pkg.cleanup(); }
});

test('整包扫描：各种坏包都能抓到', () => {
    const cases = [
        ['缺 meta.json', (p) => rmSync(join(p.data, 'meta.json')), 'block', 'meta.missing'],
        ['缺 version.json', (p) => rmSync(join(p.data, 'version.json')), 'block', 'version.missing'],
        ['缺 latest.json', (p) => rmSync(join(p.root, 'latest.json')), 'block', 'latest.missing'],
        ['缺 read/tree.json', (p) => rmSync(join(p.data, 'read', 'tree.json')), 'block', 'tree.missing'],
        ['缺 meta-home', (p) => rmSync(join(p.data, 'meta-home', 'sections.json')), 'block', 'meta-home.missing'],
        ['缺 index/texts', (p) => rmSync(join(p.data, 'index', 'texts'), { recursive: true }), 'block', 'texts-index.missing'],
        ['条目不是合法 JSON', (p) => writeFileSync(join(p.data, 'entry', readdirSync(join(p.data, 'entry'))[0]), '{oops'), 'block', 'entry.json'],
        ['条目 id 与文件名不一致', (p) => { const f = join(p.data, 'entry', readdirSync(join(p.data, 'entry'))[0]); const d = JSON.parse(readFileSync(f, 'utf-8')); d.id = 'zzz'; writeFileSync(f, JSON.stringify(d)); }, 'block', 'entry.id-filename'],
        ['meta 计数与条目实数对不上', (p) => write(join(p.data, 'meta.json'), { ...p.meta, works: p.meta.works + 1, subtypeStats: { book: p.meta.works + 1 } }), 'warn', 'meta.entry-mismatch'],
        ['meta-home 计数对不上', (p) => write(join(p.data, 'meta-home', 'sections.json'), { counts: { works: 1, books: 1, collections: 1, entities: 1 } }), 'block', 'meta-home.counts-mismatch'],
        ['subtypeStats 之和不等于 works', (p) => write(join(p.data, 'meta.json'), { ...p.meta, subtypeStats: { book: 1 } }), 'block', 'meta.subtype-sum'],
        ['manifest 的 id 与目录名不一致', (p) => write(join(p.data, 'items', 'd59f2ho5z08x', 'manifest.json'), { id: 'other', versions: [{ key: 'a' }] }), 'block', 'manifest.id'],
        ['文本索引分片版本为空', (p) => write(join(p.data, 'index', 'texts', '0.json'), { a: [] }), 'block', 'texts-index.versions'],
    ];
    for (const [name, mutate, severity, code] of cases) {
        const pkg = makePackage(['old', 'v2']);
        try {
            mutate(pkg);
            const r = runCheck({ root: pkg.root, absolute: false });
            assert.ok(codeSet(r, severity).has(code), `${name}：应有 ${severity} ${code}，实际 ${JSON.stringify(r.findings.map((f) => [f.severity, f.code]))}`);
        } finally { pkg.cleanup(); }
    }
});

test('整包扫描：新字段上报但不算错（非 `_` 的是 warn，`_` 起首的是 info）', () => {
    const pkg = makePackage(['old']);
    try {
        const f = join(pkg.data, 'entry', readdirSync(join(pkg.data, 'entry'))[0]);
        const d = JSON.parse(readFileSync(f, 'utf-8'));
        writeFileSync(f, JSON.stringify({ ...d, brand_new: 1, _brand_new_derived: [] }));
        const r = runCheck({ root: pkg.root, absolute: false });
        assert.ok(codeSet(r, 'warn').has('entry.unknown-field'));
        assert.ok(codeSet(r, 'info').has('entry.unknown-derived-field'));
        assert.equal(codeSet(r, 'block').size, 0);
        assert.equal(r.unknownFields.top.brand_new, 1);
        assert.equal(r.unknownFields.derived._brand_new_derived, 1);
    } finally { pkg.cleanup(); }
});

test('scanEntries：数据根里没有 entry/ 目录：block，不抛错', () => {
    const f = new Findings();
    const r = scanEntries(join(tmpdir(), 'definitely-not-here'), f);
    assert.equal(r.stats.files, 0);
    assert.ok(f.list().some((x) => x.code === 'entry.dir-missing' && x.severity === 'block'));
});

test('Findings：按 code 聚合、例子最多 5 个、按级别排序', () => {
    const f = new Findings();
    for (let i = 0; i < 12; i++) f.add({ severity: 'warn', code: 'a', message: `m${i}` });
    f.add({ severity: 'block', code: 'b', message: 'x' });
    f.add({ severity: 'info', code: 'c', message: 'y' });
    const l = f.list();
    assert.deepEqual(l.map((x) => x.code), ['b', 'a', 'c']);
    assert.equal(l[1].count, 12);
    assert.equal(l[1].examples.length, 5);
    assert.deepEqual([f.count('block'), f.count('warn'), f.count('info')], [1, 12, 1]);
});

// ─── 数量阈值与基线对比（用 2026-10-07 线上真实计数） ───

const LIVE = { entries: 147007, works: 95039, books: 20894, collections: 84, entities: 30990, hasText: 11513, hasImage: 18791 };
const verdictOf = (cur, key) => {
    const f = new Findings();
    const rows = compareToBaseline({ [key]: cur }, { [key]: LIVE[key] }, f);
    return rows[0].verdict;
};

test('阈值：与上一次相同／小幅波动 ok', () => {
    assert.equal(verdictOf(LIVE.works, 'works'), 'ok');
    assert.equal(verdictOf(LIVE.works + 300, 'works'), 'ok');           // 日常增长
    assert.equal(verdictOf(LIVE.works - 100, 'works'), 'ok');           // −0.105%
});

test('阈值：降超过 0.2% 警告，超过 1% 阻断', () => {
    assert.equal(verdictOf(LIVE.works - 200, 'works'), 'warn');         // −0.21%
    assert.equal(verdictOf(LIVE.works - 950, 'works'), 'warn');         // −1.0%（不到 1% 以上）
    assert.equal(verdictOf(LIVE.works - 1000, 'works'), 'block');       // −1.05%
    assert.equal(verdictOf(LIVE.hasText - 200, 'hasText'), 'block');    // −1.7%
    assert.equal(verdictOf(Math.round(LIVE.entries * 0.7), 'entries'), 'block'); // 掉三成
});

test('阈值：涨超过 20% 阻断（疑似重复打包）', () => {
    assert.equal(verdictOf(Math.round(LIVE.works * 1.19), 'works'), 'ok');
    assert.equal(verdictOf(Math.round(LIVE.works * 1.21), 'works'), 'block');
});

test('阈值：小计数（collections 84）按绝对值：降 1 警告、降 ≥2 阻断；涨不判', () => {
    assert.equal(verdictOf(84, 'collections'), 'ok');
    assert.equal(verdictOf(83, 'collections'), 'warn');
    assert.equal(verdictOf(82, 'collections'), 'block');
    assert.equal(verdictOf(60, 'collections'), 'block');
    assert.equal(verdictOf(120, 'collections'), 'ok');
});

test('阈值：基线缺项或当前缺项记 n/a，不算问题', () => {
    const f = new Findings();
    const rows = compareToBaseline({ works: 5, hasText: undefined }, { works: undefined, hasText: 3 }, f);
    assert.deepEqual(rows.map((r) => r.verdict), ['n/a', 'n/a']);
    assert.equal(f.list().length, 0);
    assert.ok(THRESHOLDS.dropBlockPct > THRESHOLDS.dropWarnPct);
});

test('绝对下限：条目总数与各类计数区间', () => {
    const mk = (files, byType) => { const f = new Findings(); checkAbsolute({ files, byType }, f); return f.list().map((x) => x.code); };
    const ok = { work: 95039, book: 20894, collection: 84, entity: 30990 };
    assert.deepEqual(mk(147007, ok), []);
    assert.deepEqual(mk(MIN_ENTRY_FILES - 1, ok), ['abs.entry-files']);
    assert.deepEqual(mk(147007, { ...ok, work: COUNT_RANGES.works.min - 1 }), ['abs.range']);
    assert.deepEqual(mk(147007, { ...ok, collection: COUNT_RANGES.collections.max + 1 }), ['abs.range']);
});

// ─── 基线读取 ───

const fakeFetch = (routes) => async (url) => {
    const path = new URL(url).pathname.replace(/^\//, '');
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[path] };
};

test('fetchBaseline：读 latest.json 与 current/meta.json，拼出计数基线；没配基线返回 null', async () => {
    const meta = load('old/meta.json');
    const latest = load('old/latest.json');
    const b = await fetchBaseline('https://data.example.com/', { fetchImpl: fakeFetch({ 'latest.json': latest, 'current/meta.json': meta }) });
    assert.equal(b.cacheKey, latest.cacheKey);
    assert.deepEqual(b.counts, { works: 95039, books: 20894, collections: 84, entities: 30990, hasText: 11513, hasImage: 18791 });
    assert.equal(await fetchBaseline('', {}), null);
});

test('fetchBaseline：读不到（404、网络错）返回 {error}，不抛错', async () => {
    const b = await fetchBaseline('https://data.example.com', { fetchImpl: fakeFetch({}) });
    assert.match(b.error, /HTTP 404/);
    const c = await fetchBaseline('https://data.example.com', { fetchImpl: async () => { throw new Error('net down'); } });
    assert.match(c.error, /net down/);
});

test('runCheck 带基线：条目暴跌会在对比表里标 block，并出现 baseline.delta 发现；读不到基线只是 info', () => {
    const pkg = makePackage(['old', 'v2']);
    try {
        const baseline = { base: 'https://x', commit: 'abc', counts: { works: 100, books: 100, collections: 100, entities: 100, hasText: 3, hasImage: 5 } };
        const r = runCheck({ root: pkg.root, baseline, absolute: false });
        const row = r.comparison.find((x) => x.key === 'entries');
        assert.equal(row.base, 400);
        assert.equal(row.verdict, 'block');
        assert.ok(codeSet(r, 'block').has('baseline.delta'));
        const r2 = runCheck({ root: pkg.root, baseline: { base: 'https://x', error: 'HTTP 503' }, absolute: false });
        assert.ok(codeSet(r2, 'info').has('baseline.unavailable'));
        assert.equal(r2.comparison.length, 0);
        const r3 = runCheck({ root: pkg.root, baseline: null, absolute: false });
        assert.ok(codeSet(r3, 'info').has('baseline.skipped'));
    } finally { pkg.cleanup(); }
});

// ─── 输出与 CLI ───

test('renderSummary：有标题、对比表、统计、发现；只报告模式的措辞', () => {
    const pkg = makePackage(['old']);
    try {
        const baseline = { base: 'https://x', commit: 'abcdef1234567', counts: { works: 2, books: 2, collections: 1, entities: 1, hasText: 3, hasImage: 5 } };
        const md = renderSummary(runCheck({ root: pkg.root, baseline, absolute: false }));
        assert.match(md, /## 数据包检查（只报告，不阻断/);
        assert.match(md, /与上一次发布对比/);
        assert.match(md, /### 本包统计/);
        assert.match(md, /条目文件 \d+/);
        assert.match(renderSummary(runCheck({ root: pkg.root, absolute: false }), { enforce: true }), /阻断模式/);
    } finally { pkg.cleanup(); }
});

test('CLI：只报告模式恒退出 0，写 summary 与 json；--enforce 遇 block 退出 1', () => {
    const pkg = makePackage(['old', 'v2']);
    try {
        const summary = join(pkg.root, 'summary.md');
        const json = join(pkg.root, 'stats.json');
        const run = (...extra) => spawnSync(process.execPath, [SCRIPT, '--root', pkg.root, '--baseline', '', '--summary', summary, '--json', json, ...extra], { encoding: 'utf-8' });
        // 小包：绝对下限必然 block
        const a = run();
        assert.equal(a.status, 0, a.stderr);
        assert.match(readFileSync(summary, 'utf-8'), /数据包检查/);
        const stats = JSON.parse(readFileSync(json, 'utf-8'));
        assert.ok(stats.summary.block >= 1);
        assert.equal(stats.version, 1);
        const b = run('--enforce');
        assert.equal(b.status, 1);
    } finally { pkg.cleanup(); }
});

test('CLI：数据根不存在时只报告模式退出 0，--enforce 退出 1', () => {
    const run = (...extra) => spawnSync(process.execPath, [SCRIPT, '--root', join(tmpdir(), 'no-such-root'), '--baseline', '', ...extra], { encoding: 'utf-8' });
    assert.equal(run().status, 0);
    assert.equal(run('--enforce').status, 1);
});

// ─── 接线 ───

test('deploy.yml 里数据包检查是只报告模式：continue-on-error、不带 --enforce、在私有文本检查之后、COS 同步之前；test.yml 跑这两个测试文件', () => {
    const yml = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf-8');
    const i = yml.indexOf('- name: Data package check (report-only');
    assert.ok(i > 0, 'deploy.yml 没有数据包检查这一步');
    const step = yml.slice(i, yml.indexOf('\n      - name:', i + 10));
    assert.match(step, /continue-on-error: true/);
    assert.ok(!step.includes('--enforce'), '只报告模式不应带 --enforce');
    assert.match(step, /--summary "\$GITHUB_STEP_SUMMARY"/);
    assert.ok(i > yml.indexOf('- name: Verify no private text leaked into public data'));
    assert.ok(i < yml.indexOf('- name: Decide COS data sync'));
    assert.match(yml, /name: Upload data package stats[\s\S]*?if-no-files-found: ignore/);
    const test = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'test.yml'), 'utf-8');
    assert.match(test, /node --test ops\/tests\/data-contract\.test\.mjs ops\/tests\/data-package-check\.test\.mjs/);
});
