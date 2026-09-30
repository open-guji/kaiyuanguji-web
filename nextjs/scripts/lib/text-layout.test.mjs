import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
    collatedChapterJsons, chapterMdFile, chapterTxtFile, filterTextsShard, firstChapterOf, isTextKey, newStructureReadable, publicKeys, publicManifest, publicVersions, readManifest,
} from './text-layout.mjs';

function item(files) {
    const root = mkdtempSync(join(tmpdir(), 'text-layout-'));
    for (const [rel, data] of Object.entries(files)) {
        const p = join(root, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    }
    return root;
}
const ver = (key, extra = {}) => ({ key, kind: 'transcription', label: key, source: key, ...extra });
const idx = (...files) => ({ chapters: files.map((f, i) => ({ n: i + 1, file: f, title: `卷${i + 1}`, has_json: false })) });

test('isTextKey：default 与 [a-z0-9-] 字母开头的非保留字', () => {
    for (const k of ['default', 'collated', 'wikisource', 'wikisource-2', 'open-guji', 'shidian']) assert.equal(isTextKey(k), true, k);
    for (const k of ['manifest', 'fragments', 'sources', '001', '3d', 'Wiki', 'a_b', '', 'a/b', '..', undefined, 5]) assert.equal(isTextKey(k), false, String(k));
});

test('章文件名：新结构 file 不带扩展名，md／txt 换算，容忍带扩展名的', () => {
    assert.equal(chapterMdFile('001'), '001.md');
    assert.equal(chapterMdFile('001.md'), '001.md');
    assert.equal(chapterMdFile('001.txt'), '001.md');
    assert.equal(chapterTxtFile('001'), '001.txt');
    assert.equal(chapterTxtFile('001.md'), '001.txt');
    assert.deepEqual(firstChapterOf({ chapters: [{ n: 1, file: '001', has_json: true }] }), { file: '001', hasJson: true });
    assert.equal(firstChapterOf({ chapters: [] }), null);
    assert.equal(firstChapterOf({}), null);
});

test('readManifest：没有／坏 JSON／没有 versions 都当旧结构（null）', () => {
    const r = item({ 'a/manifest.json': { id: 'a', versions: [ver('default')] }, 'b/manifest.json': '{oops', 'c/manifest.json': { id: 'c' } });
    try {
        assert.equal(readManifest(join(r, 'a')).versions.length, 1);
        assert.equal(readManifest(join(r, 'b')), null);
        assert.equal(readManifest(join(r, 'c')), null);
        assert.equal(readManifest(join(r, 'none')), null);
    } finally { rmSync(r, { recursive: true, force: true }); }
});

test('publicVersions／publicManifest：internal 与不合法 key 不公开；无变化原样返回同一对象', () => {
    const m = { id: 'x', versions: [ver('default'), ver('shidian', { visibility: 'internal' }), ver('manifest'), ver('wikisource')] };
    assert.deepEqual(publicVersions(m).map((v) => v.key), ['default', 'wikisource']);
    assert.deepEqual(publicManifest(m).versions.map((v) => v.key), ['default', 'wikisource']);
    const clean = { id: 'y', versions: [ver('default')] };
    assert.equal(publicManifest(clean), clean);
    assert.deepEqual(publicVersions({ id: 'z', visibility: 'internal', versions: [ver('default')] }), []);
    assert.equal(publicManifest({ id: 'z', visibility: 'internal', versions: [ver('default', { visibility: 'internal' })] }), null);
    assert.equal(publicManifest(null), null);
});

test('newStructureReadable：每个公开版本要章目录非空；整理本标记；主版本首章', () => {
    const r = item({
        'w/manifest.json': { id: 'w', versions: [ver('default', { kind: 'collated' }), ver('wikisource'), ver('kanripo'), ver('shidian', { visibility: 'internal' })] },
        'w/default/index.json': idx('001', '002'),
        'w/wikisource/index.json': idx('001'),
        'w/kanripo/index.json': { chapters: [] }, // 空目录：这份不算
        'w/shidian/index.json': idx('001'), // 内部：不算
        'e/manifest.json': { id: 'e', versions: [ver('default')] },
        'e/default/index.json': { chapters: [] },
        'n/default/index.json': idx('001'), // 没有 manifest：旧结构，这里不认
        'p/manifest.json': { id: 'p', visibility: 'internal', versions: [ver('default')] },
        'p/default/index.json': idx('001'),
    });
    try {
        const w = newStructureReadable(join(r, 'w'));
        assert.deepEqual(w.versions.map((v) => v.key), ['default', 'wikisource']);
        assert.equal(w.collated, true);
        assert.deepEqual(w.defaultFirst, { file: '001', hasJson: false });
        assert.equal(newStructureReadable(join(r, 'e')), null);
        assert.equal(newStructureReadable(join(r, 'n')), null);
        assert.equal(newStructureReadable(join(r, 'p')), null);
        assert.deepEqual(publicKeys(join(r, 'w')), ['default', 'wikisource', 'kanripo']);
        // 只有非主版本可读：defaultFirst 为 null，但条目仍可读
        const o = item({ 'o/manifest.json': { id: 'o', versions: [ver('default'), ver('wikisource')] }, 'o/default/index.json': { chapters: [] }, 'o/wikisource/index.json': idx('001') });
        try {
            const x = newStructureReadable(join(o, 'o'));
            assert.equal(x.defaultFirst, null);
            assert.equal(x.versions.length, 1);
        } finally { rmSync(o, { recursive: true, force: true }); }
    } finally { rmSync(r, { recursive: true, force: true }); }
});

test('filterTextsShard：无内部版本返回 null（原样拷字节）；有则去掉，去空的条目整条丢', () => {
    assert.equal(filterTextsShard({ a: [{ key: 'default' }], b: [] }), null);
    const out = filterTextsShard({ a: [{ key: 'default' }, { key: 'shidian', visibility: 'internal' }], b: [{ key: 'default', visibility: 'internal' }], c: [{ key: 'default' }] });
    assert.deepEqual(out, { a: [{ key: 'default' }], c: [{ key: 'default' }] });
    assert.equal(filterTextsShard(null), null);
});

test('collatedChapterJsons：只取可公开的整理本版本里 has_json 且文件在的章', () => {
    const r = item({
        'w/manifest.json': { id: 'w', versions: [ver('default', { kind: 'collated' }), ver('wikisource'), ver('shidian', { kind: 'collated', visibility: 'internal' })] },
        'w/default/index.json': { chapters: [{ n: 1, file: '001', has_json: true }, { n: 2, file: '002', has_json: false }, { n: 3, file: '003', has_json: true }] },
        'w/default/001.json': {},
        // 003.json 登记了但文件不在：不取
        'w/wikisource/index.json': { chapters: [{ n: 1, file: '001', has_json: true }] }, // 不是整理本：不取
        'w/wikisource/001.json': {},
        'w/shidian/index.json': { chapters: [{ n: 1, file: '001', has_json: true }] }, // internal：不取
        'w/shidian/001.json': {},
    });
    try {
        const got = collatedChapterJsons(join(r, 'w'));
        assert.deepEqual(got.map((c) => `${c.key}/${c.stem}`), ['default/001']);
        assert.ok(got[0].jsonPath.endsWith(join('default', '001.json')));
        assert.deepEqual(collatedChapterJsons(join(r, 'none')), []);
    } finally { rmSync(r, { recursive: true, force: true }); }
});
