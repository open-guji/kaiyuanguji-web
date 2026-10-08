import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveCodeCommit } from '../code-pointer.mjs';
import { buildVersionBody } from '../../edge-functions/api/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'code-pointer-cases.json'), 'utf-8'));

test('ops/code-pointer.mjs：用例表（与 python 版同一张）', () => {
    for (const c of CASES) {
        const r = resolveCodeCommit(c.latest, c.web);
        assert.deepEqual([r.commit, r.source, r.marked, r.mismatch], [c.commit, c.source, c.marked, c.mismatch], c.name);
        if (r.mismatch) assert.ok(r.notes.length > 0, c.name);
    }
});

// version.js 的 webMatchesPointer 必须按同一口径：拿 info.web 与 resolve 出来的 commit 比。
// 假 fetch 按 URL 返回 latest.json／web.json；latest 为 null / 带 _error 时当读不到
function fakeFetch(latest, web) {
    return async (url) => {
        const u = String(url);
        const doc = u.includes('/web.json') ? web : u.includes('/latest.json') ? latest : undefined;
        if (!doc || doc._error) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => doc };
    };
}
const INFO = (web) => ({ web, bimUi: '1', builtAt: 't', target: 'production', dataBase: 'https://data.kaiyuanguji.com' });

test('edge-functions/api/version.js：webMatchesPointer 与 resolve 口径一致，并带出 codeSource', async () => {
    for (const c of CASES) {
        if (!c.latest || c.latest._error) continue;               // 数据指针读不到时 version.js 不比对（pointer 为 null）
        const latest = { commitId: 'c'.repeat(12), ...c.latest };
        for (const probe of ['a'.repeat(40), 'b'.repeat(40)]) {
            const body = await buildVersionBody(INFO(probe), fakeFetch(latest, c.web));
            const want = c.commit ? c.commit === probe : null;
            assert.equal(body.webMatchesPointer, want, `${c.name} / info.web=${probe[0]}`);
        }
        const body = await buildVersionBody(INFO('a'.repeat(40)), fakeFetch(latest, c.web));
        assert.equal(body.codeSource, c.source, c.name);
        assert.equal(body.dataPointer.codePointer ?? null, c.latest.codePointer ?? null, c.name);   // 标记原样转出
    }
});
