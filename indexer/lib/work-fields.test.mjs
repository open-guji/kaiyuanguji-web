import test from 'node:test';
import assert from 'node:assert/strict';
import { editionCoverageProblem, classificationRatioProblem, derivedInputProblem, classificationCoverageProblem, classificationL1, derivedClassification, editionCount } from './work-fields.mjs';

test('分类：build 产物 _classifications 优先（zongmu），再回退分片行；详情里的旧 classification 不再读', () => {
    const detail = { classification: { l1: '舊部' }, _classifications: [{ scheme: 'x', l1: '乙部' }, { scheme: 'zongmu', l1: '史部' }] };
    assert.equal(classificationL1(derivedClassification(detail), { l1: '行' }), '史部');
    assert.equal(classificationL1(derivedClassification({ classification: { l1: '經部' } }), { l1: '集部' }), '集部');
    assert.equal(classificationL1(derivedClassification({}), { l1: '集部' }), '集部');
    assert.equal(classificationL1(derivedClassification({ _classifications: [] })), '');
});

test('版本数：只读 _edition_count（含 0）；旧 books 数组不再数', () => {
    assert.equal(editionCount({ _edition_count: 3, books: ['a'] }), 3);
    assert.equal(editionCount({ _edition_count: 0, books: ['a'] }), 0);
    assert.equal(editionCount({ books: ['a', 'b'] }), 0);
    assert.equal(editionCount({}), 0);
    assert.equal(editionCount(null), 0);
});

test('部类覆盖闸：四部都有命中才放行；任何一部 0 条／缺值都报，并点名', () => {
    assert.equal(classificationCoverageProblem({ 經部: 900, 史部: 12000, 子部: 3000, 集部: 80000 }), null);
    assert.match(classificationCoverageProblem({ 經部: 0, 史部: 0, 子部: 0, 集部: 0 }), /經部、史部、子部、集部/);
    assert.match(classificationCoverageProblem({ 經部: 10, 史部: 5, 子部: 0, 集部: 1 }), /子部/);
    assert.match(classificationCoverageProblem({ 經部: 10, 史部: 5, 子部: 3 }), /集部/);
    assert.match(classificationCoverageProblem(undefined), /經部/);
});

test('部类非空比例：有基线看掉幅（>5pp 拒），无基线看绝对下限 80%', () => {
    assert.equal(classificationRatioProblem(0.9, 0.88), null);
    assert.equal(classificationRatioProblem(0.9, 0.97), null);
    assert.match(classificationRatioProblem(0.9, 0.8), /掉了超过/);
    assert.match(classificationRatioProblem(0.9, 0), /掉了超过/);
    assert.equal(classificationRatioProblem(null, 0.85), null);
    assert.match(classificationRatioProblem(null, 0.5), /下限/);
    assert.match(classificationRatioProblem(null, NaN), /算不出/);
});

test('产物准入：schema-v2 缺目录／缺 SOURCE_COMMIT／commit 不一致都拒；旧 schema 不管', () => {
    const ok = { schemaV2: true, derivedDir: '/d', dirExists: true, derivedCommit: 'abc123abc123abc', sourceCommit: 'abc123abc123abc' };
    assert.equal(derivedInputProblem(ok), null);
    assert.equal(derivedInputProblem({ ...ok, schemaV2: false, derivedDir: '' }), null);
    assert.match(derivedInputProblem({ ...ok, derivedDir: '' }), /没设/);
    assert.match(derivedInputProblem({ ...ok, dirExists: false }), /不存在/);
    assert.match(derivedInputProblem({ ...ok, derivedCommit: '' }), /SOURCE_COMMIT/);
    assert.match(derivedInputProblem({ ...ok, derivedCommit: 'zzz999zzz999zzz' }), /不一致/);
});

test('版本数覆盖闸：带 _edition_count 的比例 <95% 拒；无 works 不拦', () => {
    assert.equal(editionCoverageProblem({ total: 100, present: 100, positive: 0 }), null);
    assert.equal(editionCoverageProblem({ total: 100, present: 95, positive: 10 }), null);
    assert.match(editionCoverageProblem({ total: 100, present: 0, positive: 0 }), /0\.0%/);
    assert.equal(editionCoverageProblem({ total: 0, present: 0, positive: 0 }), null);
});
