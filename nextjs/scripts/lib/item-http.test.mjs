/**
 * item-http.test.mjs — 缓存实测对照页的候选来源。
 * 用法：node --test scripts/lib/item-http.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlItemIds, hotItemIds } from './item-http.mjs';

function dataDirWith(entries) {
    const d = mkdtempSync(join(tmpdir(), 'ih-'));
    mkdirSync(join(d, 'entry'));
    for (const e of entries) writeFileSync(join(d, 'entry', `${e.id}.json`), JSON.stringify(e));
    return d;
}

test('ITEM_CONTROL_IDS 优先：逗号分隔、去空白与空项、按 limit 截断，不读本地目录', () => {
    assert.deepEqual(controlItemIds('/no/such/dir', 200, { ITEM_CONTROL_IDS: ' a1 , b2,,c3 ' }), ['a1', 'b2', 'c3']);
    assert.deepEqual(controlItemIds('/no/such/dir', 2, { ITEM_CONTROL_IDS: 'a1,b2,c3' }), ['a1', 'b2']);
});

test('没设（或全是空）就退回读本地产物里"有整理本或有影像"的作品', () => {
    const d = dataDirWith([
        { id: 'w1', type: 'work', has_text: true },
        { id: 'w2', type: 'work' },                        // 没文本没影像：不选
        { id: 'b1', type: 'book', has_text: true },        // 不是作品：不选
        { id: 'w3', type: 'work', has_image: true },
        { id: 'w4', type: 'work', has_text: true, merged_into: 'w1' },   // 被并：不选
    ]);
    assert.deepEqual(hotItemIds(d, 10), ['w1', 'w3']);
    assert.deepEqual(controlItemIds(d, 10, {}), ['w1', 'w3']);
    assert.deepEqual(controlItemIds(d, 10, { ITEM_CONTROL_IDS: ' , ' }), ['w1', 'w3']);
});

test('既没给环境变量、本地也没有产物：返回空（调用方要明说"没检查"）', () => {
    assert.deepEqual(controlItemIds('/no/such/dir', 200, {}), []);
});
