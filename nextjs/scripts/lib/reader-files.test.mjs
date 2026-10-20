/**
 * reader-files.test.mjs — 对读章阅读器瘦身副本（GUJI-700 P1-2）：
 * 副本经 book-index-ui 的读法（adaptCharCord／iiifVolumeOf／adaptPunctJson）得到的结果与原文件逐字段相同；
 * 打包时写副本、回写 index.json、删旧副本。
 * 用法：node --test scripts/lib/reader-files.test.mjs
 * 设了 READER_FILES_SAMPLE_DIR（含 002.char.json／002.cord.json／002.punct.json 的目录）时，再拿真样本章比一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptCharCord, adaptEntityJson, adaptPunctJson, iiifVolumeOf } from 'book-index-ui';
import { buildItemReaderFiles, READER_CHAR_SUFFIX, READER_CORD_SUFFIX, READER_ENTITY_SUFFIX, READER_PUNCT_SUFFIX, slimChar, slimCord, slimEntity, slimPunct } from './reader-files.mjs';

const canvas = (n) => ({ id: `https://data.test/iiif/bk/canvas/02/${n}`, seq: n, width: 1000, height: 1400 });
const CHAR = {
    version: '1.0.1', book_id: 'bk', volume: 2,
    pages: [
        { page: 1, columns: [] },
        { page: 3, label: '三', columns: [{ col: 1, raised: 1, cells: [{ a: '3:1:1', c: '欽' }, { a: '3:1:2', c: '定', lane: 'left' }] }, { col: 2, kind: 'blank', cells: [] }] },
        { page: 4, columns: [{ col: 1, cells: [{ a: '4:1:1a', c: '四' }, { a: '4:1:1b', c: '庫' }] }] },
    ],
};
const CORD = {
    $schema: 'x', book_id: 'bk', volume: 2,
    pages: [
        { page: 1, canvas: canvas('0001'), image: { width: 1000, height: 1400, sha256: 'ab' }, producers: [{ x: 1 }], regions: [], columns: [], marks: [], cells: [] },
        { page: 2, canvas: canvas('0002'), cells: [] },
        { page: 3, canvas: { id: canvas('0003').id, seq: '0003' }, image: { width: 900, height: 1300 }, regions: [{ r: 1 }], cells: [{ a: '3:1:1', box: [1, 2, 3, 4], id: 'g1' }, { a: '3:1:2', box: [5, 6, 7, 8], id: 'g2' }, { id: 'noanchor', box: [0, 0, 1, 1] }] },
        { page: 4, canvas: canvas('0004'), cells: [{ a: '4:1:1a', box: [1, 1, 2, 2], id: 'g3' }, { a: '4:1:1b' }] },
    ],
};
const PUNCT = {
    version: '1.0.0', book_id: 'bk', metadata: { m: 1 }, stats: { n: 3 },
    punctuations: [
        { mark: '#', kind: 'heading', pos: 'before', char_offset: 0, anchor: '3:1:1', label: '卷一', source: 'claude' },
        { mark: '。', kind: 'point', pos: 'after', char_offset: 2, pre_char: '定', anchor: '3:1:2', source: 'rule' },
        { mark: '\n\n', kind: 'break', pos: 'after', anchor: '4:1:1a', id: 'p3' },
    ],
};

const ENTITY = {
    version: '1.10.0', text_version: '1.0.1', book_id: 'bk', volume: 2, metadata: { creator: 'x' }, stats: { total_entities: 3 },
    entities: [
        { id: 'e1', type: 'people', text: '王弼', anchor: { start: '3:1:1', end: '3:1:2' }, span: { start_offset: 0, end_offset: 2 },
          target: { status: 'matched', entity_id: 'hixhd2h9bne6', canonical_name: '王弼', href: 'book-index://Entity/hixhd2h9bne6' }, source: '补标:N8' },
        { id: 'e2', type: 'works', text: '庫', anchor: { start: '4:1:1b', end: '4:1:1b' }, span: { start_offset: 3, end_offset: 4 },
          target: { status: 'matched', href: 'book-index://Entity/abcdefgh1234' }, source: 'glm', group: 'g1' },
        { id: 'e3', type: 'places', text: '四', anchor: { start: '4:1:1a', end: '4:1:1a' }, span: { start_offset: 2, end_offset: 3 },
          target: { status: 'new_candidate', confidence: 0.4, note: 'n' }, source: 'glm' },
    ],
};

test('entity 副本：adaptEntityJson 结果相同；source／metadata／stats 去掉，有 entity_id 时去掉 href，顶层 version 留着', () => {
    const slim = slimEntity(ENTITY);
    assert.deepEqual(adaptEntityJson(slim), adaptEntityJson(ENTITY));
    assert.deepEqual(Object.keys(slim).sort(), ['book_id', 'entities', 'text_version', 'version', 'volume']);
    assert.ok(!JSON.stringify(slim).includes('source'));
    assert.equal(slim.entities[0].target.href, undefined);
    assert.equal(slim.entities[1].target.href, 'book-index://Entity/abcdefgh1234'); // 没有 entity_id 时靠 href 兜底
});

test('char 副本：内容与原文件相同', () => {
    assert.deepEqual(slimChar(CHAR), CHAR);
});

test('cord 副本：adaptCharCord 与 iiifVolumeOf 结果与原文件相同，用不到的字段都去掉', () => {
    const slim = slimCord(CORD);
    assert.deepEqual(adaptCharCord(CHAR, slim), adaptCharCord(CHAR, CORD));
    assert.deepEqual(iiifVolumeOf(slim), iiifVolumeOf(CORD));
    const text = JSON.stringify(slim);
    for (const gone of ['producers', 'regions', 'marks', 'sha256', '"id":"g1"', 'noanchor']) assert.ok(!text.includes(gone), gone);
    assert.deepEqual(slim.pages[2].image, { width: 900, height: 1300 }); // canvas 缺尺寸时要靠它
    assert.equal(slim.$schema, 'x');
});

test('punct 副本：adaptPunctJson 结果相同；source／char_offset／metadata／stats 去掉', () => {
    const slim = slimPunct(PUNCT);
    assert.deepEqual(adaptPunctJson(slim), adaptPunctJson(PUNCT));
    assert.deepEqual(Object.keys(slim).sort(), ['book_id', 'punctuations', 'version']);
    assert.ok(!JSON.stringify(slim).includes('source') && !JSON.stringify(slim).includes('char_offset'));
});

test('打包：对读章写副本并记进 index.json，非对读章不动；源里缺了的章删掉旧副本与字段', () => {
    const item = mkdtempSync(join(tmpdir(), 'rf-'));
    const dir = join(item, 'default');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ chapters: [
        { file: '002', char_file: '002.char.json', cord_file: '002.cord.json', punct_file: '002.punct.json', entity_file: '002.entity.json' },
        { file: '003', title: '非对读' },
        { file: '004', char_file: '004.char.json', cord_file: '004.cord.json', reader_cord_file: '004.cord.reader.json', reader_punct_file: 'x' },
    ] }));
    writeFileSync(join(dir, '002.cord.json'), JSON.stringify(CORD));
    writeFileSync(join(dir, '002.punct.json'), JSON.stringify(PUNCT));
    writeFileSync(join(dir, '002.entity.json'), JSON.stringify(ENTITY, null, 2));
    writeFileSync(join(dir, '002.char.json'), JSON.stringify(CHAR, null, 2));
    writeFileSync(join(dir, `007${READER_ENTITY_SUFFIX}`), 'stale');
    writeFileSync(join(dir, `004${READER_CORD_SUFFIX}`), 'stale'); // 004 的 cord 取不到
    writeFileSync(join(dir, `009${READER_PUNCT_SUFFIX}`), 'stale');
    assert.equal(buildItemReaderFiles(item), 4);
    const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
    assert.equal(idx.chapters[0].reader_cord_file, '002.cord.reader.json');
    assert.equal(idx.chapters[0].reader_punct_file, '002.punct.reader.json');
    assert.equal(idx.chapters[0].reader_entity_file, '002.entity.reader.json');
    assert.equal(idx.chapters[0].reader_char_file, '002.char.reader.json');
    assert.equal(readFileSync(join(dir, `002${READER_CHAR_SUFFIX}`), 'utf-8'), JSON.stringify(CHAR)); // 不带缩进
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `002${READER_ENTITY_SUFFIX}`), 'utf-8')), slimEntity(ENTITY));
    assert.equal(existsSync(join(dir, `007${READER_ENTITY_SUFFIX}`)), false);
    assert.deepEqual(idx.chapters[1], { file: '003', title: '非对读' });
    assert.equal(idx.chapters[2].reader_cord_file, undefined);
    assert.equal(idx.chapters[2].reader_punct_file, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `002${READER_CORD_SUFFIX}`), 'utf-8')), slimCord(CORD));
    assert.equal(existsSync(join(dir, `004${READER_CORD_SUFFIX}`)), false);
    assert.equal(existsSync(join(dir, `009${READER_PUNCT_SUFFIX}`)), false);
    // 再跑一遍：index.json 不再改动
    const before = readFileSync(join(dir, 'index.json'), 'utf-8');
    buildItemReaderFiles(item);
    assert.equal(readFileSync(join(dir, 'index.json'), 'utf-8'), before);
});

test('条目输出目录不存在（整个条目 internal，没拷）：返回 0，不抛错', () => {
    assert.equal(buildItemReaderFiles(join(tmpdir(), 'rf-nonexistent-dir')), 0);
});

test('真样本章（设 READER_FILES_SAMPLE_DIR 才跑）：读法结果逐字段相同', (t) => {
    const d = process.env.READER_FILES_SAMPLE_DIR;
    if (!d || !existsSync(join(d, '002.cord.json'))) return t.skip('没设 READER_FILES_SAMPLE_DIR');
    const read = (f) => JSON.parse(readFileSync(join(d, f), 'utf-8'));
    const [char, cord, punct] = ['002.char.json', '002.cord.json', '002.punct.json'].map(read);
    assert.deepEqual(adaptCharCord(char, slimCord(cord)), adaptCharCord(char, cord));
    assert.deepEqual(iiifVolumeOf(slimCord(cord)), iiifVolumeOf(cord));
    assert.deepEqual(adaptPunctJson(slimPunct(punct)), adaptPunctJson(punct));
    if (existsSync(join(d, '002.entity.json'))) {
        const entity = read('002.entity.json');
        assert.deepEqual(adaptEntityJson(slimEntity(entity)), adaptEntityJson(entity));
    }
});
