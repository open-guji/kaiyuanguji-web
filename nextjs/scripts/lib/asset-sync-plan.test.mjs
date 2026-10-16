/** 用法：node --test scripts/lib/asset-sync-plan.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAssetSync, isAssetPath, MAX_BYTES } from './asset-sync-plan.mjs';

const P = (id, n = 1) => `entity/${id.at(-3)}/${id.at(-2)}/${id.at(-1)}/${id}/${n}.webp`;
const a = P('hixi6zykf4ea'), b = P('hixi6zykf4eb'), c = P('hixi6zykf4ec', 2);

test('路径校验：只收 entity 分片路径与 1–8 序号的 webp', () => {
    assert.equal(isAssetPath(a), true);
    assert.equal(isAssetPath('README.md'), false);
    assert.equal(isAssetPath('entity/4/e/a/hixi6zykf4ea/9.webp'), false);
    assert.equal(isAssetPath('entity/4/e/a/hixi6zykf4ea/1.png'), false);
    assert.equal(isAssetPath('entity/4/e/a/../x/1.webp'), false);
});

test('新增、相同、变更、孤儿各归各类', () => {
    const local = new Map([[a, { md5: 'm1', size: 10 }], [b, { md5: 'm2', size: 10 }], [c, { md5: 'm3', size: 10 }]]);
    const remote = new Map([[a, 'm1'], [b, 'OLD'], ['entity/x/y/z/gone/1.webp', 'm9']]);
    const p = planAssetSync(local, remote);
    assert.deepEqual(p.add, [c]);
    assert.deepEqual(p.same, [a]);
    assert.deepEqual(p.changed, [b]);
    assert.deepEqual(p.orphans, ['entity/x/y/z/gone/1.webp']);
    assert.deepEqual(p.rejected, []);
});

test('分块对象（mp:）按相同处理；路径不合与超限的拒收且不上传', () => {
    const local = new Map([
        [a, { md5: 'm1', size: 10 }],
        ['README.md', { md5: 'r', size: 5 }],
        [b, { md5: 'm2', size: MAX_BYTES + 1 }],
    ]);
    const p = planAssetSync(local, new Map([[a, 'mp:10']]));
    assert.deepEqual(p.same, [a]);
    assert.deepEqual(p.add, []);
    assert.deepEqual(p.rejected.map(r => r.rel).sort(), ['README.md', b].sort());
});
