// node --test indexer/test/clip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { clip } from '../lib/doc-builders.mjs';

test('clip：截断处不劈开代理对', () => {
    const s = '虛之有' + '\u{20BB7}' + '尾'; // 𠮷 = 𠮷，占 2 个码元
    assert.equal(clip(s, 4), '虛之有');          // 落在高位代理上：多丢这一个
    assert.equal(clip(s, 5), '虛之有\u{20BB7}'); // 正好带完整一对
    assert.equal(clip(s, 3), '虛之有');
});

test('clip：结果经 JSON.stringify 不含孤代理转义', () => {
    const s = 'a'.repeat(4999) + '\u{29516}' + 'b'; // 𩔖 压在第 5000 个码元上
    const out = JSON.stringify(clip(s, 5000));
    assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(out));
    assert.equal(clip(s, 5000).length, 4999);
});

test('clip：短文本、空值原样', () => {
    assert.equal(clip('短', 200), '短');
    assert.equal(clip('', 200), '');
    assert.equal(clip(undefined, 200), '');
});
