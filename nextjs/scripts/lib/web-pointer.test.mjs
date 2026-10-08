/**
 * web-pointer.test.mjs — 代码指针 web.json 的生成与解析。
 * 用法：node --test scripts/lib/web-pointer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webPointerKey, buildWebPointer, parseWebPointer } from './web-pointer.mjs';

const SHA = 'fb93c1e316db0f940f73fb7b93830a38c86e4f43';

test('webPointerKey：正式站在根，测试站在 staging/，多余斜杠去掉', () => {
    assert.equal(webPointerKey(''), 'web.json');
    assert.equal(webPointerKey(undefined), 'web.json');
    assert.equal(webPointerKey('staging'), 'staging/web.json');
    assert.equal(webPointerKey('/staging/'), 'staging/web.json');
});

test('buildWebPointer：三个字段，deployedAt 是 ISO 时间，runId 转字符串', () => {
    const p = buildWebPointer({ webCommitId: SHA, runId: 123, now: new Date('2026-10-07T01:02:03Z') });
    assert.deepEqual(p, { webCommitId: SHA, deployedAt: '2026-10-07T01:02:03.000Z', runId: '123' });
});

test('buildWebPointer：不是 40 位 commit 一律抛错，不写半截指针', () => {
    for (const bad of ['', undefined, null, 'abc123', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}0`]) {
        assert.throws(() => buildWebPointer({ webCommitId: bad }), /40 位 commit/);
    }
});

test('parseWebPointer：合法的读回来；坏 JSON、非对象、缺或坏 commit 返回 null', () => {
    const text = JSON.stringify(buildWebPointer({ webCommitId: SHA, runId: '9' }));
    assert.equal(parseWebPointer(text).webCommitId, SHA);
    assert.equal(parseWebPointer(text).runId, '9');
    for (const bad of ['', '{', 'null', '[]', '{}', JSON.stringify({ webCommitId: 'abc' }), JSON.stringify({ webCommitId: 5 })]) {
        assert.equal(parseWebPointer(bad), null, bad);
    }
});

test('parseWebPointer：额外字段忽略，deployedAt／runId 缺省为空串', () => {
    const p = parseWebPointer(JSON.stringify({ webCommitId: SHA, extra: 1 }));
    assert.deepEqual(p, { webCommitId: SHA, deployedAt: '', runId: '' });
});
