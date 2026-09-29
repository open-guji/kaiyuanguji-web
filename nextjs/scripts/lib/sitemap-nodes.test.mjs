import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeIds, nodePagePaths } from './sitemap-nodes.mjs';

const TREE = [
    { id: 'cjing', label: '經部', count: 3, children: [{ id: 'cyi', label: '易類', count: 2, children: [{ id: 'cyi2', label: '子', count: 1 }] }] },
    { id: 'unclassified', label: '未分類', count: 1 },
];

test('nodeIds：含各级子孙，先父后子', () => {
    assert.deepEqual(nodeIds(TREE), ['cjing', 'cyi', 'cyi2', 'unclassified']);
});

test('nodeIds：不合法的 id（含路径穿越、大写、空）不收，空树／缺失返回空', () => {
    assert.deepEqual(nodeIds([{ id: '../x' }, { id: 'ABC' }, { id: '' }, { id: 'ok1' }]), ['ok1']);
    assert.deepEqual(nodeIds(null), []);
    assert.deepEqual(nodeIds([]), []);
});

test('nodePagePaths：总目与阅读各一套；阅读树缺就只列总目', () => {
    assert.deepEqual(nodePagePaths({ catalog: TREE, read: [{ id: 'cjing' }] }), [
        '/catalog?node=cjing', '/catalog?node=cyi', '/catalog?node=cyi2', '/catalog?node=unclassified', '/read?node=cjing',
    ]);
    assert.deepEqual(nodePagePaths({ catalog: [{ id: 'a1' }], read: null }), ['/catalog?node=a1']);
    assert.deepEqual(nodePagePaths({ catalog: null, read: null }), []);
});
