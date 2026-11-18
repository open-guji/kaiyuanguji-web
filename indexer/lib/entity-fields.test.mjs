// node --test indexer/lib/entity-fields.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officeFields } from './entity-fields.mjs';
import { SETTINGS } from './meili-ops.mjs';

test('人物任官：office_ids／office_place_ids 透传（去重、去空）', () => {
    const d = officeFields({ office_ids: ['o1', 'o2', 'o1', '', null], office_place_ids: ['pl1'] });
    assert.deepEqual(d, { office_ids: ['o1', 'o2'], office_place_ids: ['pl1'] });
});

test('没任官（分片不写键／空数组／非数组）就不写字段', () => {
    for (const e of [{}, { office_ids: [], office_place_ids: [] }, { office_ids: 'o1' }, undefined]) {
        assert.deepEqual(officeFields(e), {});
    }
});

test('entities 索引能按任官筛选', () => {
    for (const f of ['office_ids', 'office_place_ids']) assert.ok(SETTINGS.entities.filterableAttributes.includes(f));
});
