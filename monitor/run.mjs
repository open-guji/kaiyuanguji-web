#!/usr/bin/env node
/**
 * 监控入口。
 *
 *   node monitor/run.mjs --suite probe [--with-data] [--state f.json] [--dry-run]
 *   node monitor/run.mjs --suite smoke --smoke-report e2e/out/results.json
 *
 * --suite probe   A 类主动探测；--with-data 顺带跑 B 类；
 *                 --data-every 55 = 距上次跑 B 类满 55 分钟才顺带跑（记在状态文件里）。
 *                 不按 cron 的分钟判断「整点」：GitHub 的定时常漂移几分钟到几十分钟，按分钟会漏跑或重跑
 * --suite data    只跑 B 类
 * --suite smoke   C 类：读 Playwright JSON 报告，折成一个检查项
 * --dry-run       不碰 GitHub，只打印会开／评论／关哪张单
 * --perf FILE     顺带做新旧架构对比采样（任务书 §六），样本追加进 FILE（JSONL，保留 72 小时）
 *
 * 退出码：检查失败**不**让进程非零——否则 Actions 每 15 分钟再发一封「workflow failed」邮件，
 * 与 issue 通知重复。只有告警链路自身坏了（GitHub API 写失败）才非零，那是真要人看的。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { PROBE_CHECKS } from './checks/probe.mjs';
import { DATA_CHECKS } from './checks/data.mjs';
import { smokeFromReport } from './checks/smoke.mjs';
import { crashed, renderCheck, icon } from './lib/result.mjs';
import { emptyState, decide, reconcile, pushBaseline, medianOf } from './lib/state.mjs';
import { makeGithub, issueTitle, openBody, commentBody, closeBody } from './lib/alert.mjs';
import { readRequiredUi, readPkgChangedAt, readAnchors } from './lib/context.mjs';
import { samplePerf, shadowChecks } from './checks/perf.mjs';
import { loadTargets } from './perf-config.mjs';
import { appendJsonl } from './lib/samples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const a = { suite: 'probe', perf: null, withData: false, dataEvery: null, dryRun: false, state: null, smokeReport: null, only: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--suite') a.suite = argv[++i];
    else if (k === '--with-data') a.withData = true;
    else if (k === '--data-every') a.dataEvery = Number(argv[++i]);
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--state') a.state = argv[++i];
    else if (k === '--smoke-report') a.smokeReport = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',');
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--perf') a.perf = argv[++i];
  }
  return a;
}

export function buildContext({ cfg, now, repoRoot, state, tlsConnect }) {
  return {
    cfg,
    now,
    repoRoot,
    tlsConnect,
    required: readRequiredUi(repoRoot),
    pkgChangedAt: readPkgChangedAt(repoRoot),
    anchors: readAnchors(repoRoot),
    memo: {},
    baseline: (key) => medianOf(state.baselines[key] || []),
    record: (key, v) => { state.baselines[key] = pushBaseline(state.baselines[key] || [], v).values; },
  };
}

export async function runChecks(checks, ctx) {
  return Promise.all(checks.map(async (fn) => {
    try {
      return await fn(ctx);
    } catch (e) {
      return crashed(fn.name, fn.name, e);
    }
  }));
}

/**
 * 按状态机处理告警。gh=null 即 dry-run。
 * @returns { state, log: string[], notify: string[] }
 */
export async function processAlerts({ results, state, now, gh, runUrl, titlePrefix = '' }) {
  const log = [];
  const notify = [];
  let checks = state.checks;
  if (gh) {
    await gh.ensureLabel();
    checks = reconcile(checks, await gh.listOpen());
  }
  const nextChecks = { ...checks };
  for (const r of results) {
    const { next, action } = decide(checks[r.id], r, now);
    nextChecks[r.id] = next;
    if (!action) continue;
    const opts = { now, runUrl, fails: action.fails, reason: action.reason, durationMs: action.durationMs };
    if (action.type === 'open') {
      const title = issueTitle(r, titlePrefix);
      if (gh) nextChecks[r.id].issue = await gh.open(title, openBody(r, opts));
      log.push(`开单 ${r.id}${gh ? ` → #${nextChecks[r.id].issue}` : '（dry-run）'}`);
      notify.push(`🔴 ${r.id} ${r.name} 连续 ${action.fails} 次失败${gh ? `，issue #${nextChecks[r.id].issue}` : ''}`);
    } else if (action.type === 'comment') {
      if (gh) await gh.comment(action.issue, commentBody(r, opts));
      log.push(`评论 ${r.id} #${action.issue}（${action.reason}）${gh ? '' : '（dry-run）'}`);
      if (action.reason === 'changed') notify.push(`🔴 ${r.id} ${r.name} 失败内容有变化，issue #${action.issue}`);
    } else if (action.type === 'close') {
      if (gh) await gh.close(action.issue, closeBody(r, opts));
      log.push(`关单 ${r.id} #${action.issue}${gh ? '' : '（dry-run）'}`);
      notify.push(`✅ ${r.id} ${r.name} 已恢复，issue #${action.issue} 已关`);
    }
  }
  return { state: { ...state, checks: nextChecks }, log, notify };
}

export function renderReport(results, { suite, ms, log }) {
  const head = results.map((r) => `${icon(r.status)} ${r.id} ${r.name}`).join('  \n');
  return [
    `## 监控（${suite}）— ${new Date().toISOString().slice(0, 16)}Z，耗时 ${(ms / 1000).toFixed(1)}s`,
    '',
    head,
    '',
    log.length ? `**告警动作**：${log.join('；')}` : '告警动作：无',
    '',
    ...results.map((r) => renderCheck(r) + '\n'),
  ].join('\n');
}

/** 本轮对比采样的简表：每目标每页面类的成功数与耗时中位数；影子检查的失败项 */
export function renderPerfRun(samples, targets) {
  const label = Object.fromEntries([...targets.map((t) => [t.name, t.label]), ['shared', '共用']]);
  const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
  const groups = new Map();
  for (const r of samples.filter((x) => x.kind !== 'check')) {
    const k = `${r.target}\t${r.kind}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const lines = ['### 新旧对比（本轮采样）', '', '| 目标 | 页面类 | 成功/总数 | 首字节中位 ms | 总耗时中位 ms | CDN 命中 |', '|---|---|---|---|---|---|'];
  for (const [k, g] of groups) {
    const [tg, kind] = k.split('\t');
    const ok = g.filter((r) => r.ok);
    const hits = g.filter((r) => r.hit === true).length;
    const known = g.filter((r) => r.hit != null).length;
    lines.push(`| ${label[tg] || tg} | ${kind} | ${ok.length}/${g.length} | ${med(ok.map((r) => r.ttfb)) ?? '—'} | ${med(ok.map((r) => r.total)) ?? '—'} | ${known ? `${hits}/${known}` : '看不出'} |`);
  }
  const checks = samples.filter((x) => x.kind === 'check');
  if (checks.length) {
    lines.push('', `影子检查（不告警）：${checks.map((c) => `${c.ok ? '✅' : '❌'} ${label[c.target] || c.target} ${c.id}${c.ok ? '' : `（${c.failed.join('；')}）`}`).join('；')}`);
  }
  return lines.join('\n');
}

function loadState(path) {
  if (path && existsSync(path)) {
    try {
      const s = JSON.parse(readFileSync(path, 'utf8'));
      return { ...emptyState(), ...s };
    } catch { /* 坏了就当没有，reconcile 会从 issue 找回 */ }
  }
  return emptyState();
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const repoRoot = resolve(HERE, '..');
  const state = loadState(args.state);
  const now = Date.now();
  const ctx = buildContext({ cfg, now, repoRoot, state });

  let results;
  if (args.suite === 'smoke') {
    results = [smokeFromReport(args.smokeReport)];
  } else {
    if (args.dataEvery != null) {
      const last = state.lastDataRunAt ?? 0;
      args.withData = now - last >= args.dataEvery * 60000;
    }
    const withData = args.suite === 'data' || args.withData;
    if (withData) state.lastDataRunAt = now;
    const checks = args.suite === 'data' ? DATA_CHECKS : [...PROBE_CHECKS, ...(args.withData ? DATA_CHECKS : [])];
    results = await runChecks(checks, ctx);
    if (args.only) results = results.filter((r) => args.only.includes(r.id));
  }

  // 新旧对比采样：出错不影响告警主链路
  let perfNote = '';
  if (args.perf && args.suite === 'probe') {
    try {
      const targets = loadTargets();
      const samples = await samplePerf({ cfg, targets, now });
      for (const tg of targets.filter((x) => !x.alert)) samples.push(...await shadowChecks({ cfg, target: tg, ctx }));
      const kept = appendJsonl(args.perf, samples, { now });
      perfNote = renderPerfRun(samples, targets) + `\n\n样本文件共 ${kept} 条（保留 72 小时）。`;
    } catch (e) {
      perfNote = `新旧对比采样出错：${e.message}`;
      console.error(`::warning::${perfNote}`);
    }
  }

  const repo = process.env.GITHUB_REPOSITORY || 'open-guji/kaiyuanguji-web';
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '（本地运行）';
  const gh = !args.dryRun && cfg.githubToken
    ? makeGithub({ api: cfg.githubApi, repo, token: cfg.githubToken, label: process.env.MON_LABEL || 'monitor' })
    : null;

  let exit = 0;
  let out = { state, log: [], notify: [] };
  try {
    out = await processAlerts({ results, state, now, gh, runUrl, titlePrefix: process.env.MON_TITLE_PREFIX || '' });
  } catch (e) {
    console.error(`::error::告警链路失败：${e.message}`);
    exit = 1;
  }

  let report = renderReport(results, { suite: args.suite + (args.withData ? '+data' : ''), ms: Date.now() - t0, log: out.log });
  if (perfNote) report += `\n\n${perfNote}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (args.state) {
    mkdirSync(dirname(args.state), { recursive: true });
    writeFileSync(args.state, JSON.stringify(out.state, null, 2));
  }
  if (args.out) writeFileSync(args.out, JSON.stringify({ results, log: out.log, ms: Date.now() - t0 }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `notify<<MON_EOF\n${out.notify.join('\n')}\nMON_EOF\n`);
  }
  process.exitCode = exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
