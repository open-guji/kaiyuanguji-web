import test from 'node:test';
import assert from 'node:assert/strict';
import { canonVol, rewriteKey, plan, run } from '../vol-renumber.mjs';

const B = '99k3i35yww';
test('canonVol：纯数字按数值补零；映射；其余原样', () => {
    assert.equal(canonVol('001', { width: 1 }), '1');
    assert.equal(canonVol('01', { width: 1 }), '1');
    assert.equal(canonVol('1', { width: 2 }), '01');
    assert.equal(canonVol('001', { width: 2 }), '01');
    assert.equal(canonVol('bxgb', { width: 1, map: { bxgb: '1' } }), '1');
    assert.equal(canonVol('vol01', { width: 2 }), 'vol01');
});
test('rewriteKey：第 3 段换，分片后缀保留，别的书不动', () => {
    assert.deepEqual(rewriteKey(`pd:${B}:001`, B, { width: 1 }), { newKey: `pd:${B}:1`, changed: true });
    assert.equal(rewriteKey(`pd:${B}:001~p2`, B, { width: 1 }).newKey, `pd:${B}:1~p2`);
    assert.equal(rewriteKey(`cf:${B}:01:v1:1:2:3:K7QM2XR9`, B, { width: 1 }).newKey, `cf:${B}:1:v1:1:2:3:K7QM2XR9`);
    assert.equal(rewriteKey(`pd:other:001`, B, { width: 1 }), null);
    assert.equal(rewriteKey(`pd:${B}:1`, B, { width: 1 }).changed, false);
});
test('plan：值里册号字段一并换；新键已有更新的只删旧；cellreview 不在其中', () => {
    const rows = {
        pending: [{ key: `pd:${B}:001`, value: { book: B, vol: '001', s: 'x' }, ts: 5 }, { key: `pd:${B}:1`, value: { book: B, vol: '1', s: 'y' }, ts: 9 }],
        charfix: [{ key: `cf:${B}:01:a:1:1:1:V`, value: { volume: '01', voter: 'V' }, ts: 3 }, { key: `cf:${B}:1:a:1:1:2:V`, value: { volume: '1' }, ts: 3 }],
    };
    const p = plan(rows, B, { width: 1 });
    assert.equal(p.moves.length, 2);
    assert.equal(p.same.length, 2);
    const pd = p.moves.find((m) => m.kind === 'pending');
    assert.equal(pd.keepNew, true);
    const cf = p.moves.find((m) => m.kind === 'charfix');
    assert.equal(cf.newKey, `cf:${B}:1:a:1:1:1:V`);
    assert.equal(cf.value.volume, '1');
    assert.equal(cf.keepNew, false);
});
test('run：dry_run 不写；apply 先写新键再删旧键', async () => {
    const calls = [];
    const data = { pending: [{ key: `pd:${B}:001`, value: { book: B, vol: '001' }, ts: 1 }] };
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || 'GET';
        calls.push(`${method} ${u.searchParams.get('kind') || ''}`);
        if (method === 'GET') {
            const kind = u.searchParams.get('kind'); const prefix = u.searchParams.get('prefix') || '';
            return { ok: true, json: async () => ({ items: (data[kind] || []).filter((r) => r.key.startsWith(prefix)), hasMore: false }) };
        }
        return { ok: true, json: async () => ({}) };
    };
    const logs = [];
    await run({ book: B, width: 1, apply: false, base: 'http://x', token: 't', fetchImpl, log: (s) => logs.push(s) });
    assert.ok(!calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE')));
    calls.length = 0;
    await run({ book: B, width: 1, apply: true, base: 'http://x', token: 't', fetchImpl, log: () => {} });
    assert.deepEqual(calls.filter((c) => !c.startsWith('GET')), ['POST ', 'DELETE pending']);
});
