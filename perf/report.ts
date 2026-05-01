import type { RequestRecord, PerceivedTiming } from './collector.ts';
import type { NetworkProfile } from './profiles.ts';

export interface ScenarioRun {
    scenarioId: string;
    scenarioName: string;
    profileName: string;
    profileLabel: string;
    baseUrl: string;
    startedAt: string;
    durationMs: number;
    timing: PerceivedTiming;
    requests: RequestRecord[];
    errors: string[];
}

export interface RunReport {
    target: string;
    startedAt: string;
    finishedAt: string;
    runs: ScenarioRun[];
}

function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

function summarize(reqs: RequestRecord[]) {
    const ok = reqs.filter((r) => !r.failed);
    const totalEncoded = ok.reduce((s, r) => s + r.encodedBytes, 0);
    const totalDecoded = ok.reduce((s, r) => s + r.decodedBytes, 0);
    // Real failures only — exclude prefetches that the page cancelled (ERR_ABORTED).
    const failed = reqs.filter((r) => r.failed && !r.aborted);
    const aborted = reqs.filter((r) => r.aborted);

    const byType: Record<string, { count: number; bytes: number }> = {};
    for (const r of ok) {
        const k = r.resourceType || 'other';
        if (!byType[k]) byType[k] = { count: 0, bytes: 0 };
        byType[k].count += 1;
        byType[k].bytes += r.encodedBytes;
    }

    const sorted = [...ok].sort((a, b) => b.encodedBytes - a.encodedBytes).slice(0, 10);
    return {
        totalEncoded,
        totalDecoded,
        byType,
        top: sorted,
        failedCount: failed.length,
        failed,
        abortedCount: aborted.length,
        aborted,
    };
}

export function renderMarkdown(report: RunReport): string {
    const lines: string[] = [];
    lines.push(`# perf report — ${report.target}`);
    lines.push('');
    lines.push(`- 开始: ${report.startedAt}`);
    lines.push(`- 结束: ${report.finishedAt}`);
    lines.push(`- 场景数: ${new Set(report.runs.map((r) => r.scenarioId)).size}`);
    lines.push(`- profile 数: ${new Set(report.runs.map((r) => r.profileName)).size}`);
    lines.push('');

    lines.push('## 总览（场景 × profile）');
    lines.push('');
    const profiles = Array.from(new Set(report.runs.map((r) => r.profileName)));
    const scenarios = Array.from(new Set(report.runs.map((r) => r.scenarioId)));
    lines.push(`| 场景 | ${profiles.map((p) => p).join(' | ')} |`);
    lines.push(`|------|${profiles.map(() => '------').join('|')}|`);
    for (const sid of scenarios) {
        const cells: string[] = [`\`${sid}\``];
        for (const pn of profiles) {
            const run = report.runs.find((r) => r.scenarioId === sid && r.profileName === pn);
            if (!run) {
                cells.push('—');
                continue;
            }
            const sum = summarize(run.requests);
            const lcp = fmtMs(run.timing.lcp);
            const bytes = fmtBytes(sum.totalEncoded);
            cells.push(`${bytes} / LCP ${lcp}`);
        }
        lines.push(`| ${cells.join(' | ')} |`);
    }
    lines.push('');

    lines.push('## 详细');
    lines.push('');
    for (const run of report.runs) {
        const sum = summarize(run.requests);
        lines.push(`### ${run.scenarioId} · ${run.scenarioName} · ${run.profileLabel}`);
        lines.push('');
        lines.push(`- 总请求: **${run.requests.length}** (失败 ${sum.failedCount}${sum.abortedCount ? `, 取消 ${sum.abortedCount}` : ''})`);
        lines.push(`- 下行（压缩后）: **${fmtBytes(sum.totalEncoded)}**`);
        lines.push(`- 解压后总量: ${fmtBytes(sum.totalDecoded)}`);
        lines.push(`- FCP: ${fmtMs(run.timing.fcp)}  ·  LCP: ${fmtMs(run.timing.lcp)}  ·  DCL: ${fmtMs(run.timing.dcl)}  ·  load: ${fmtMs(run.timing.load)}`);
        if (run.timing.lcpDetail) {
            const d = run.timing.lcpDetail;
            const tag = d.tag ?? '?';
            const id = d.id ? `#${d.id}` : '';
            const classes = d.classes ? `.${d.classes.split(' ').join('.')}` : '';
            const url = d.url ? ` url=${d.url}` : '';
            const text = d.textPreview ? ` text=${JSON.stringify(d.textPreview)}` : '';
            const size = typeof d.sizePx === 'number' ? ` size=${d.sizePx}px²` : '';
            lines.push(`- LCP element: \`<${tag}${id}${classes}>\`${url}${text}${size}`);
        }
        lines.push(`- 场景总耗时: ${fmtMs(run.durationMs)}`);
        if (run.errors.length > 0) {
            lines.push(`- ⚠ 错误: ${run.errors.join('; ')}`);
        }
        lines.push('');

        lines.push('| 资源类型 | 请求数 | 字节 |');
        lines.push('|----------|--------|------|');
        for (const [k, v] of Object.entries(sum.byType).sort((a, b) => b[1].bytes - a[1].bytes)) {
            lines.push(`| ${k} | ${v.count} | ${fmtBytes(v.bytes)} |`);
        }
        lines.push('');

        lines.push('**Top 10 by bytes**');
        lines.push('');
        lines.push('| # | 字节 | 类型 | 状态 | 时长 | URL |');
        lines.push('|---|------|------|------|------|-----|');
        sum.top.forEach((r, i) => {
            const u = r.url.length > 100 ? r.url.slice(0, 97) + '...' : r.url;
            lines.push(`| ${i + 1} | ${fmtBytes(r.encodedBytes)} | ${r.resourceType} | ${r.status} | ${fmtMs(r.durationMs)} | \`${u}\` |`);
        });
        lines.push('');

        if (sum.failed.length > 0) {
            lines.push('**失败请求**');
            lines.push('');
            for (const r of sum.failed) {
                lines.push(`- ${r.url} — ${r.failureReason ?? 'unknown'}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

export function renderJson(report: RunReport): string {
    return JSON.stringify(report, null, 2);
}
