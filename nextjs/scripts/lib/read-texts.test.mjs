#!/usr/bin/env node
/** read-texts.mjs 的单测：作品「文本来源」汇总。用法：node --test scripts/lib/read-texts.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReadTexts, readerVersions, sourceLabel } from './read-texts.mjs';

const wiki = { key: 'wikisource', kind: 'transcription', label: '維基文庫', source_name: '維基文庫' };
const wikiDefault = { key: 'default', kind: 'collated', label: '整理本', source_name: '維基文庫' };
const fine = { key: 'default', kind: 'self_collated', label: '開源古籍自校本', source_name: '開源古籍CV整理（武英殿刻本）', quality: 'fine' };
const rough = { key: 'cv-proof', kind: 'self_collated', label: '開源古籍自校本（粗校）', source_name: '開源古籍CV整理（武英殿刻本）', quality: 'rough' };

test('欽定四庫全書總目：自校殿本在前，维基文库第二；Work 与 Book 共用一张表', () => {
    const m = buildReadTexts([
        { id: 'W', type: 'work', versions: [wikiDefault, wiki] },
        { id: 'B1', type: 'book', work_id: 'W', edition: '清乾隆六十年武英殿刻本', versions: [fine, rough] },
    ]);
    assert.deepEqual(m.get('W'), [
        { id: 'B1', label: '開源古籍自校本', edition: '清乾隆六十年武英殿刻本', own: true },
        { id: 'W', label: '維基文庫' },
    ]);
    assert.equal(m.get('B1'), m.get('W'));
});

test('只有一个可读条目的作品不出；没有 work_id 的 Book 不进', () => {
    assert.equal(buildReadTexts([{ id: 'W', type: 'work', versions: [wiki] }]).size, 0);
    assert.equal(buildReadTexts([{ id: 'B', type: 'book', versions: [fine] }, { id: 'W', type: 'work', versions: [wiki] }]).size, 0);
});

test('多个 Book：自建在前，Work 次之，其余 Book 按 id', () => {
    const k = { key: 'default', kind: 'transcription', label: 'Kanripo', source_name: 'Kanripo' };
    const m = buildReadTexts([
        { id: 'Bz', type: 'book', work_id: 'W', edition: '萬有文庫本', versions: [k] },
        { id: 'W', type: 'work', versions: [wiki] },
        { id: 'Ba', type: 'book', work_id: 'W', edition: '殿本', versions: [fine] },
        { id: 'Bb', type: 'book', work_id: 'W', edition: '四部叢刊本', versions: [k] },
    ]);
    assert.deepEqual(m.get('W').map((r) => r.id), ['Ba', 'W', 'Bb', 'Bz']);
});

test('readerVersions 与阅读页同规则；sourceLabel 跳过类别词', () => {
    assert.deepEqual(readerVersions([wikiDefault, wiki]).map((v) => v.key), ['wikisource']);
    assert.deepEqual(readerVersions([fine, rough]).map((v) => v.key), ['default']);
    assert.equal(sourceLabel(wikiDefault), '維基文庫');
});
