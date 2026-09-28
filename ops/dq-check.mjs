#!/usr/bin/env node
/**
 * dq-check.mjs — 正式数据巡检（DQ 道）命令行入口。逻辑在 dq-lib.mjs。
 *
 * 只读：只对 data.kaiyuanguji.com 发 GET／HEAD，不碰 COS 写、不碰数据仓。
 *
 * 用法（仓库根目录，Node ≥ 20，无依赖）：
 *   node ops/dq-check.mjs
 *   node ops/dq-check.mjs --entry-rate 0.05 --text-rate 0.1 --seed 42
 *   node ops/dq-check.mjs --h1-prefix staging/h1          # 测试站那份 h1
 *   node ops/dq-check.mjs --out dq-report                 # 写 dq-report.md 与 dq-report.json
 *
 * 选项（也可用同名大写环境变量，如 DQ_ENTRY_RATE）：
 *   --base          站点根，默认 https://data.kaiyuanguji.com
 *   --h1-prefix     h1 子路径，默认 h1
 *   --entry-rate    条目抽样率，默认 0.02
 *   --text-rate     全文／整理本 owner 抽样率，默认 0.05
 *   --seed          抽样种子（整数），默认取当前时间；报告里会写出来，用同一个值可复现
 *   --concurrency   并发，默认 8，上限 8
 *   --pointer-retry 指针与 latest.json 对不上时等多少秒再看一次，默认 90（0 不等）
 *   --fail-on       packaging（默认：有打包问题就退出码 1）| any（数据仓问题也算）| none
 *   --out           报告文件前缀（写 <out>.md、<out>.json）
 *
 * 在 GitHub Actions 里会把 Markdown 报告追加到 $GITHUB_STEP_SUMMARY。
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runDq, renderMarkdown, hasFailures, DEFAULT_BASE, MAX_CONCURRENCY } from './dq-lib.mjs';

const { values: a } = parseArgs({
    options: {
        base: { type: 'string' },
        'h1-prefix': { type: 'string' },
        'entry-rate': { type: 'string' },
        'text-rate': { type: 'string' },
        seed: { type: 'string' },
        concurrency: { type: 'string' },
        'pointer-retry': { type: 'string' },
        'fail-on': { type: 'string' },
        out: { type: 'string' },
    },
});

const env = (k) => {
    const v = process.env[`DQ_${k.replace(/-/g, '_').toUpperCase()}`];
    return v === '' ? undefined : v;
};
const opt = (k) => a[k] ?? env(k);

function num(k, def, { min = -Infinity, max = Infinity } = {}) {
    const raw = opt(k);
    if (raw === undefined) return def;
    const x = Number(raw);
    if (!Number.isFinite(x) || x < min || x > max) {
        console.error(`--${k}=${raw} 不合法（应在 ${min}–${max}）`);
        process.exit(2);
    }
    return x;
}

const failOn = opt('fail-on') ?? 'packaging';
if (!['packaging', 'any', 'none'].includes(failOn)) {
    console.error(`--fail-on=${failOn} 不合法（packaging｜any｜none）`);
    process.exit(2);
}

const report = await runDq({
    base: opt('base') ?? DEFAULT_BASE,
    h1Prefix: opt('h1-prefix') ?? 'h1',
    entryRate: num('entry-rate', 0.02, { min: 0, max: 1 }),
    textRate: num('text-rate', 0.05, { min: 0, max: 1 }),
    seed: Math.trunc(num('seed', Date.now() % 2 ** 31, { min: 0 })),
    concurrency: Math.trunc(num('concurrency', MAX_CONCURRENCY, { min: 1, max: MAX_CONCURRENCY })),
    pointerRetryMs: num('pointer-retry', 90, { min: 0, max: 600 }) * 1000,
    log: (m) => console.log(`[dq] ${m}`),
});

const md = renderMarkdown(report);
console.log('\n' + md);

const out = opt('out');
if (out) {
    writeFileSync(`${out}.md`, md);
    writeFileSync(`${out}.json`, JSON.stringify(report, null, 2));
    console.log(`[dq] 报告已写到 ${out}.md ／ ${out}.json`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

if (hasFailures(report, failOn)) {
    console.error(`[dq] 有${failOn === 'any' ? '问题' : '网站打包问题'}，退出码 1（--fail-on=${failOn}）`);
    process.exit(1);
}
