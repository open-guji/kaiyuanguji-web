import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLive, overlayLive } from '../../edge-functions/api/text-progress.js';

const CONN = 'postgresql://ro:pw@ep-x-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require';
const SNAP = {
  schema: 'text-progress/1', volumes: [],
  sections: [{ section: 'review', title: '人审', sort: 30 }, { section: 'jobs', title: '旧', sort: 40 }],
  metrics: [{ section: 'review', key: 'a' }, { section: 'jobs', key: 'board', label: '旧快照' }],
};

function fakeNeon(rowsBySql) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const rows = body.query.includes('progress.metric') ? rowsBySql.metrics : rowsBySql.sections;
    return { ok: true, status: 200, json: async () => ({ rows }) };
  };
  f.calls = calls;
  return f;
}

test('readLive：连接串放在头里，请求发到 https://<host>/sql', async () => {
  const f = fakeNeon({ metrics: [{ section: 'jobs', key: 'board', at: '2026-10-25T22:00:00Z' }], sections: [{ section: 'jobs', title: '重跑任务', sort: 40 }] });
  const r = await readLive(CONN, f);
  assert.equal(r.metrics.length, 1);
  assert.equal(f.calls[0].url, 'https://ep-x-pooler.us-west-2.aws.neon.tech/sql');
  assert.equal(f.calls[0].init.headers['Neon-Connection-String'], CONN);
});

test('readLive：没配、HTTP 错、超时都返回 error 而不是抛', async () => {
  assert.equal((await readLive(null)).error, 'not-configured');
  assert.match((await readLive(CONN, async () => ({ ok: false, status: 500 }))).error, /HTTP 500/);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  assert.equal((await readLive(CONN, hang, 20)).error, 'timeout');
});

test('overlayLive：只替换 jobs 栏，其余栏目原样；失败时标 live.ok=false 且不动快照内容', () => {
  const live = { metrics: [{ section: 'jobs', key: 'board', label: '实时', at: '2026-10-25T22:00:00Z' }], sections: [{ section: 'jobs', title: '重跑任务', sort: 40 }] };
  const o = overlayLive(SNAP, live);
  assert.equal(o.live.ok, true);
  assert.deepEqual(o.metrics.map((m) => m.label ?? m.key), ['a', '实时']);
  assert.equal(o.sections.find((x) => x.section === 'jobs').title, '重跑任务');
  assert.equal(SNAP.metrics[1].label, '旧快照');
  const bad = overlayLive(SNAP, { error: 'timeout' });
  assert.deepEqual(bad.live, { ok: false, error: 'timeout' });
  assert.equal(bad.metrics.length, 2);
});

test('overlayLive：快照还没有时也能只靠实时数据出页', () => {
  const o = overlayLive(null, { metrics: [{ section: 'jobs', key: 'board' }], sections: [{ section: 'jobs', title: '重跑任务', sort: 40 }] });
  assert.equal(o.metrics.length, 1);
  assert.equal(o.schema, 'text-progress/1');
});
