/**
 * C 类：浏览器冒烟（每 6 小时）——对正式站跑 e2e 的 contract 项目，
 * 把 Playwright 的 JSON 报告折成一个检查项 C1-contract，走同一套告警状态机。
 */
import { readFileSync } from 'node:fs';
import { part, aggregate } from '../lib/result.mjs';

export function smokeFromReport(path) {
  const id = 'C1-contract';
  const name = 'e2e 契约冒烟（正式站）';
  let rep;
  try {
    rep = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return aggregate(id, name, [part('Playwright 报告', 'fail', `读不到：${e.code || e.message}`, '存在', '多半是安装或运行本身挂了，看 Actions 日志')]);
  }
  const specs = [];
  const walk = (s, trail) => {
    const t = [...trail, s.title].filter(Boolean);
    for (const sp of s.specs || []) specs.push({ title: [...t, sp.title].join(' › '), sp });
    for (const c of s.suites || []) walk(c, t);
  };
  for (const s of rep.suites || []) walk(s, []);

  const failed = [];
  const flaky = [];
  let passed = 0;
  let skipped = 0;
  for (const { title, sp } of specs) {
    for (const t of sp.tests || []) {
      const st = t.status; // expected | unexpected | flaky | skipped
      if (st === 'unexpected') failed.push(title);
      else if (st === 'flaky') flaky.push(title);
      else if (st === 'skipped') skipped += 1;
      else passed += 1;
    }
  }
  const parts = [part('用例', failed.length ? 'fail' : 'ok', `过 ${passed}／挂 ${failed.length}／重试后过 ${flaky.length}／跳过 ${skipped}`, '挂 0')];
  for (const f of failed.slice(0, 10)) parts.push(part(f, 'fail', '失败', '通过'));
  if (flaky.length) parts.push(part('重试后才过', 'warn', flaky.slice(0, 5).join('；'), '一次过', '偶发，留意'));
  if (!specs.length) parts.push(part('用例数', 'fail', 0, '> 0', '一个用例都没跑到'));
  return aggregate(id, name, parts);
}
