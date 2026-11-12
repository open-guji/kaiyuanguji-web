// node --test indexer/lib/entity-doc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntityDoc } from './doc-builders.mjs';
import { SETTINGS } from './meili-ops.mjs';

const base = { id: 'p1', primary_name: '王安石', subtype: 'people', dynasty: '宋', dates: { birth: 1021, death: 1086 } };

test('人物任官：office_ids／office_place_ids 透传（去重、去空）', () => {
    const d = buildEntityDoc({ ...base, office_ids: ['o1', 'o2', 'o1', '', null], office_place_ids: ['pl1'] }, false);
    assert.deepEqual(d.office_ids, ['o1', 'o2']);
    assert.deepEqual(d.office_place_ids, ['pl1']);
});

test('没任官（分片不写键／空数组／非数组）就不写字段', () => {
    for (const extra of [{}, { office_ids: [], office_place_ids: [] }, { office_ids: 'o1' }]) {
        const d = buildEntityDoc({ ...base, ...extra }, false);
        assert.ok(!('office_ids' in d));
        assert.ok(!('office_place_ids' in d));
    }
});

test('entities 索引能按任官筛选', () => {
    for (const f of ['office_ids', 'office_place_ids']) assert.ok(SETTINGS.entities.filterableAttributes.includes(f));
});
