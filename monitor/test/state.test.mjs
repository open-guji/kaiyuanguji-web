// 告警状态机：连续 2 次才开、恢复自动关、持续失败不刷屏（任务书 §四·2）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, reconcile, medianOf, pushBaseline } from '../lib/state.mjs';

const MIN = 60_000;
const fail = (sig = 'fail:首页') => ({ status: 'fail', sig });
const ok = { status: 'ok', sig: 'ok' };

test('一次失败不开单，第二次连续失败才开', () => {
  const a = decide(undefined, fail(), 0);
  assert.equal(a.action, null);
  assert.equal(a.next.fails, 1);
  const b = decide(a.next, fail(), 15 * MIN);
  assert.equal(b.action.type, 'open');
  assert.equal(b.action.fails, 2);
});

test('失败—成功—失败 不算连续，不开单', () => {
  let s = decide(undefined, fail(), 0).next;
  s = decide(s, ok, 15 * MIN).next;
  const r = decide(s, fail(), 30 * MIN);
  assert.equal(r.action, null);
  assert.equal(r.next.fails, 1);
});

test('已开单：同样的失败 6 小时内不再评论，满 6 小时补一条', () => {
  let s = decide(undefined, fail(), 0).next;
  s = decide(s, fail(), 15 * MIN).next;
  s = { ...s, issue: 7 };
  let comments = 0;
  for (let t = 30 * MIN; t < 15 * MIN + 6 * 60 * MIN; t += 15 * MIN) {
    const r = decide(s, fail(), t);
    if (r.action) comments += 1;
    s = r.next;
  }
  assert.equal(comments, 0, '6 小时内 22 轮持续失败不该有任何评论');
  const r = decide(s, fail(), 15 * MIN + 6 * 60 * MIN);
  assert.equal(r.action.type, 'comment');
  assert.equal(r.action.reason, 'remind');
});

test('已开单：失败内容变了立刻评论一次，之后不重复', () => {
  let s = { fails: 3, issue: 7, sig: 'fail:首页', lastCommentAt: 0, firstFailAt: 0 };
  const r = decide(s, fail('fail:首页|robots'), 15 * MIN);
  assert.equal(r.action.type, 'comment');
  assert.equal(r.action.reason, 'changed');
  s = r.next;
  assert.equal(decide(s, fail('fail:首页|robots'), 30 * MIN).action, null);
});

test('只是实测值变（签名不变）不算变化', () => {
  const s = { fails: 3, issue: 7, sig: 'fail:耗时', lastCommentAt: 0, firstFailAt: 0 };
  assert.equal(decide(s, { status: 'fail', sig: 'fail:耗时', detail: '3100ms' }, MIN).action, null);
});

test('恢复即关单，带持续时长；关后状态清零', () => {
  const s = { fails: 5, issue: 9, sig: 'fail:x', lastCommentAt: 0, firstFailAt: 1000 };
  const r = decide(s, ok, 1000 + 75 * MIN);
  assert.deepEqual(r.action, { type: 'close', issue: 9, since: 1000, durationMs: 75 * MIN });
  assert.equal(r.next.fails, 0);
  assert.equal(r.next.issue, null);
});

test('warn 视同恢复（不开单、会关单）', () => {
  const r = decide({ fails: 2, issue: 3, firstFailAt: 0 }, { status: 'warn', sig: 'warn:x' }, MIN);
  assert.equal(r.action.type, 'close');
});

test('skip（未配置）既不计失败也不关单', () => {
  const s = { fails: 1, issue: null, firstFailAt: 0 };
  const r = decide(s, { status: 'skip' }, MIN);
  assert.equal(r.action, null);
  assert.equal(r.next.fails, 1);
  const s2 = { fails: 4, issue: 5, firstFailAt: 0 };
  assert.equal(decide(s2, { status: 'skip' }, MIN).action, null);
  assert.equal(decide(s2, { status: 'skip' }, MIN).next.issue, 5);
});

test('reconcile：状态丢了但仓里有 open 单 → 认回来，下一次失败不重复开单', () => {
  const s = reconcile({}, new Map([['A1-home', 12]]));
  assert.equal(s['A1-home'].issue, 12);
  const r = decide(s['A1-home'], fail(), 0);
  assert.notEqual(r.action?.type, 'open');
});

test('reconcile：单被人手动关了 → 忘掉，之后再失败会重新开', () => {
  const s = reconcile({ 'A1-home': { fails: 6, issue: 12, sig: 'fail:首页', lastCommentAt: 0 } }, new Map());
  assert.equal(s['A1-home'].issue, null);
  assert.equal(decide(s['A1-home'], fail(), 0).action.type, 'open');
});

test('基线取中位数，样本不足不判', () => {
  assert.equal(medianOf([100, 101]), null);
  assert.equal(medianOf([100, 300, 101]), 101);
  assert.equal(pushBaseline(Array(50).fill(1), 2).values.length, 48);
});
