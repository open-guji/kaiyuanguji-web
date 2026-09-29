/**
 * 夜间性能门槛（overview#280 T2）：读 runner 产出的 out/latest.json，按 thresholds.json 判定；
 * 另外单独量「条目页缓存命中首字节」。超标退出码 1，并写 out/gate.json、out/gate.md
 * （CI 里再据此开单，见 .github/workflows/test.yml 的 perf-prod）。
 *
 * 用法：tsx gate.ts [--target=https://www.kaiyuanguji.com] [--out=out] [--thresholds=thresholds.json]
 *
 * 首字节：GET 同一个干净条目地址若干次（Node fetch，取到响应头的时刻），只统计响应头
 * `EO-Cache-Status: Cache Hit` 的样本，取中位数。命中样本不足（缓存没热起来、被别的层挡了）不算超标，
 * 报「样本不足」为警告：门槛判的是命中路径的速度，不是命中率。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Thresholds {
    lcpMs: Record<string, number>;
    itemTtfb: { path: string; samples: number; minHits: number; medianMs: number };
}

export interface RunLite {
    scenarioId: string;
    profileName: string;
    timing: { lcp: number | null };
    errors: string[];
}

export interface Breach {
    kind: 'lcp' | 'ttfb' | 'run-error';
    subject: string;
    actual: number | null;
    limit: number | null;
    message: string;
}

export interface GateResult {
    ok: boolean;
    breaches: Breach[];
    warnings: string[];
    lcp: { scenarioId: string; lcpMs: number | null; limitMs: number }[];
    ttfb: { hits: number; samples: number; medianMs: number | null; limitMs: number; values: number[] } | null;
}

export function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** LCP 判定：只看 fast 档；场景没跑成（有错误、没观测到 LCP）算超标——门槛失效比慢更糟 */
export function judgeLcp(runs: RunLite[], t: Thresholds): Pick<GateResult, 'breaches' | 'warnings' | 'lcp'> {
    const breaches: Breach[] = [];
    const warnings: string[] = [];
    const lcp: GateResult['lcp'] = [];
    for (const [id, limit] of Object.entries(t.lcpMs)) {
        const run = runs.find((r) => r.scenarioId === id && r.profileName === 'fast');
        if (!run) {
            breaches.push({ kind: 'run-error', subject: id, actual: null, limit, message: `${id}：报告里没有 fast 档的这个场景（没跑？）` });
            lcp.push({ scenarioId: id, lcpMs: null, limitMs: limit });
            continue;
        }
        lcp.push({ scenarioId: id, lcpMs: run.timing.lcp, limitMs: limit });
        if (run.errors.length > 0) {
            breaches.push({ kind: 'run-error', subject: id, actual: null, limit, message: `${id}：场景出错：${run.errors.join('; ')}` });
        } else if (run.timing.lcp == null) {
            breaches.push({ kind: 'run-error', subject: id, actual: null, limit, message: `${id}：没有观测到 LCP` });
        } else if (run.timing.lcp > limit) {
            breaches.push({ kind: 'lcp', subject: id, actual: run.timing.lcp, limit, message: `${id}：LCP ${Math.round(run.timing.lcp)}ms 超过 ${limit}ms` });
        }
    }
    return { breaches, warnings, lcp };
}

export interface TtfbSample {
    ms: number;
    cacheStatus: string | null;
    status: number;
}

/** 首字节判定：只算 Cache Hit 样本的中位数 */
export function judgeTtfb(samples: TtfbSample[], t: Thresholds['itemTtfb']): { breach: Breach | null; warning: string | null; info: NonNullable<GateResult['ttfb']> } {
    const hits = samples.filter((s) => s.status === 200 && /hit/i.test(s.cacheStatus ?? '') && !/miss/i.test(s.cacheStatus ?? ''));
    const values = hits.map((h) => Math.round(h.ms));
    const med = median(values);
    const info = { hits: hits.length, samples: samples.length, medianMs: med, limitMs: t.medianMs, values };
    const bad = samples.filter((s) => s.status !== 200);
    if (bad.length === samples.length) {
        return { breach: { kind: 'ttfb', subject: t.path, actual: null, limit: t.medianMs, message: `${t.path}：全部 ${samples.length} 次请求都不是 200（${[...new Set(bad.map((b) => b.status))].join('/')}）` }, warning: null, info };
    }
    if (hits.length < t.minHits) {
        return { breach: null, warning: `${t.path}：${samples.length} 次里只有 ${hits.length} 次 Cache Hit（要 ≥${t.minHits}），首字节门槛本次未判`, info };
    }
    if (med !== null && med > t.medianMs) {
        return { breach: { kind: 'ttfb', subject: t.path, actual: med, limit: t.medianMs, message: `${t.path}：缓存命中首字节中位数 ${med}ms 超过 ${t.medianMs}ms（${values.join('/')}）` }, warning: null, info };
    }
    return { breach: null, warning: null, info };
}

async function probeTtfb(target: string, t: Thresholds['itemTtfb']): Promise<TtfbSample[]> {
    const out: TtfbSample[] = [];
    const url = new URL(t.path, target).toString();
    for (let i = 0; i < t.samples; i++) {
        const t0 = performance.now();
        const res = await fetch(url, { headers: { 'accept-encoding': 'gzip, br', 'user-agent': 'kyg-perf-gate/1' }, redirect: 'manual' });
        const ms = performance.now() - t0; // fetch 在收到响应头时 resolve
        out.push({ ms, cacheStatus: res.headers.get('eo-cache-status'), status: res.status });
        await res.arrayBuffer().catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
    }
    return out;
}

export function renderMarkdown(target: string, r: GateResult): string {
    const L: string[] = [`# 夜间性能门槛 — ${target}`, '', r.ok ? '**通过**' : `**未通过**（${r.breaches.length} 项）`, ''];
    L.push('| 场景（fast 档） | LCP | 门槛 |', '|---|---|---|');
    for (const x of r.lcp) L.push(`| \`${x.scenarioId}\` | ${x.lcpMs == null ? '—' : `${Math.round(x.lcpMs)} ms`} | ${x.limitMs} ms |`);
    if (r.ttfb) {
        L.push('', `条目页缓存命中首字节：${r.ttfb.hits}/${r.ttfb.samples} 次命中，中位数 ${r.ttfb.medianMs == null ? '—' : `${r.ttfb.medianMs} ms`}（门槛 ${r.ttfb.limitMs} ms）；样本 ${r.ttfb.values.join('/') || '—'}`);
    }
    if (r.breaches.length) L.push('', '## 超标', '', ...r.breaches.map((b) => `- ${b.message}`));
    if (r.warnings.length) L.push('', '## 警告', '', ...r.warnings.map((w) => `- ${w}`));
    return L.join('\n') + '\n';
}

async function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const arg = (name: string, dflt: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
    const target = arg('target', 'https://www.kaiyuanguji.com');
    const outDir = resolve(arg('out', resolve(here, 'out')));
    const thresholds: Thresholds = JSON.parse(await readFile(resolve(arg('thresholds', resolve(here, 'thresholds.json'))), 'utf-8'));
    const report = JSON.parse(await readFile(resolve(outDir, 'latest.json'), 'utf-8')) as { runs: RunLite[] };

    const lcp = judgeLcp(report.runs, thresholds);
    const breaches = [...lcp.breaches];
    const warnings = [...lcp.warnings];
    let ttfbInfo: GateResult['ttfb'] = null;
    try {
        const j = judgeTtfb(await probeTtfb(target, thresholds.itemTtfb), thresholds.itemTtfb);
        ttfbInfo = j.info;
        if (j.breach) breaches.push(j.breach);
        if (j.warning) warnings.push(j.warning);
    } catch (e: any) {
        breaches.push({ kind: 'ttfb', subject: thresholds.itemTtfb.path, actual: null, limit: thresholds.itemTtfb.medianMs, message: `首字节探测失败：${e?.message ?? e}` });
    }

    const result: GateResult = { ok: breaches.length === 0, breaches, warnings, lcp: lcp.lcp, ttfb: ttfbInfo };
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'gate.json'), JSON.stringify(result, null, 2));
    const md = renderMarkdown(target, result);
    await writeFile(resolve(outDir, 'gate.md'), md);
    console.log(md);
    process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(2); });
