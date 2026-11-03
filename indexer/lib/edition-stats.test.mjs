import test from 'node:test';
import assert from 'node:assert/strict';
// 只引无第三方依赖的模块：CI 的 node --test 不装 indexer/ 的依赖
import { addEditionStats, editionCountKnown } from './derived-core.mjs';
import { editionCoverageProblem } from './work-fields.mjs';

test('editionCountKnown：_edition_count → _books 长度 → null', () => {
    assert.equal(editionCountKnown({ _edition_count: 0, _books: [{ id: 'a' }] }), 0);
    assert.equal(editionCountKnown({ _books: [{ id: 'a' }] }), 1);
    assert.equal(editionCountKnown({ books: ['a'] }), null);
    assert.equal(editionCountKnown(null), null);
});

test('addEditionStats：产物删了 _edition_count、只留 _books 时覆盖闸照样过', () => {
    const s = { total: 0, present: 0, positive: 0 };
    for (let i = 0; i < 60; i++) addEditionStats(s, { _books: [] }, false);
    for (let i = 0; i < 40; i++) addEditionStats(s, { _books: [{ id: `b${i}` }] }, false);
    addEditionStats(s, { _books: [{ id: 'd' }] }, true);   // 草稿不计
    assert.deepEqual(s, { total: 100, present: 100, positive: 40 });
    assert.equal(editionCoverageProblem(s), null);
});

test('addEditionStats：两样都没有（读不到产物）仍被闸挡住', () => {
    const s = { total: 0, present: 0, positive: 0 };
    for (let i = 0; i < 10; i++) addEditionStats(s, { title: 'x' }, false);
    assert.deepEqual(s, { total: 10, present: 0, positive: 0 });
    assert.match(editionCoverageProblem(s), /0\.0%/);
});
