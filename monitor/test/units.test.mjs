import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPii, robotsDisallowsAll } from '../checks/probe.mjs';
import { smokeFromReport } from '../checks/smoke.mjs';
import { readAnchors, readRequiredUi } from '../lib/context.mjs';
import { cmpVersion, rangeFloor, uiVersionFromHtml } from '../lib/version.mjs';
import { aggregate, part } from '../lib/result.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('锚点从真实的 e2e/fixtures/anchors.ts 读得出（那边改了形态这里会红）', () => {
  const a = readAnchors(ROOT);
  assert.match(a.entries.work, /^[0-9a-z]{12}$/);
  assert.match(a.entries.entity, /^[0-9a-z]{12}$/);
  assert.equal(a.workTitle, '史記');
  assert.match(readRequiredUi(ROOT), /^\d+\.\d+\.\d+$/);
});

test('版本比较与 meta 解析', () => {
  assert.ok(cmpVersion('0.9.10', '0.9.7') > 0);
  assert.equal(cmpVersion('0.9.7', '0.9.7'), 0);
  assert.equal(rangeFloor('^0.9.7'), '0.9.7');
  assert.equal(uiVersionFromHtml('<meta name="bim-ui-version" content="0.9.6"/>'), '0.9.6');
  assert.equal(uiVersionFromHtml('<meta name="bim-ui-version" content=""/>'), null);
});

test('PII：邮箱／手机号命中，打码后的与 id 时间戳不误报', () => {
  assert.deepEqual(findPii([{ id: 'fb_1789543011290_xvsa', content: '我的邮箱***@***', createdAt: '2026-09-27T00:00:00Z' }]), []);
  assert.deepEqual(findPii([{ id: 'a', content: '联系 foo.bar@qq.com' }]), ['a.content(邮箱)']);
  assert.deepEqual(findPii([{ id: 'b', reply: '电话13800138000谢谢' }]), ['b.reply(手机)']);
  assert.deepEqual(findPii([{ id: 'c', pageUrl: 'https://x/?id=17895430112901' }]), []);
});

test('robots 全禁判定', () => {
  assert.ok(robotsDisallowsAll('User-agent: *\nDisallow: /\n'));
  assert.ok(!robotsDisallowsAll('User-agent: *\nDisallow: /admin\n'));
  assert.ok(!robotsDisallowsAll('User-agent: Googlebot\nDisallow: /\n'));
  assert.ok(!robotsDisallowsAll(''));
});

test('C 类：Playwright JSON 报告折成一项', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mon-'));
  const p = join(dir, 'r.json');
  writeFileSync(p, JSON.stringify({ suites: [{ title: 'data-pipeline.spec.ts', specs: [], suites: [{ title: '数据管线', specs: [
    { title: 'latest.json 可达', tests: [{ status: 'expected' }] },
    { title: 'version 同版本', tests: [{ status: 'unexpected' }] },
    { title: '偶发', tests: [{ status: 'flaky' }] },
  ] }] }] }));
  const r = smokeFromReport(p);
  assert.equal(r.status, 'fail');
  assert.ok(r.parts.some((x) => x.label.includes('version 同版本')));
  assert.equal(smokeFromReport(join(dir, 'none.json')).status, 'fail');
});

test('失败签名只看哪些子项挂，不看实测值', () => {
  const a = aggregate('X', 'x', [part('耗时', 'fail', '3100ms', '<3000'), part('首页', 'ok', 'HTTP 200')]);
  const b = aggregate('X', 'x', [part('耗时', 'fail', '4200ms', '<3000'), part('首页', 'ok', 'HTTP 200')]);
  assert.equal(a.sig, b.sig);
  assert.equal(aggregate('X', 'x', [part('a', 'skip')]).status, 'skip');
});
