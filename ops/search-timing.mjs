#!/usr/bin/env node
/**
 * search-timing.mjs — /api/search 分层实测（overview#353）
 *
 * 每个检索词连发两次：第 1 次带随机后缀（必 MISS，回源 Meili），第 2 次同词（应 HIT）；另有若干热词只看 HIT/STALE。
 * 每次记客户端 TTFB 与响应头 Server-Timing（parse／cache／upstream／meili／total，见 edge-functions/api/search.js 文件头），
 * 末尾按缓存状态分组给 p50／p90：
 *   客户端 TTFB − total      ≈ 读者到边缘函数的网络（境外测量机底数约 1.3 s，看层间差）
 *   upstream − meili         ≈ 函数到上海源站的网络＋排队
 *   meili                    ＝ Meili 自报处理耗时
 *
 * 只发 GET，无依赖、无 secret。CLI：
 *   node ops/search-timing.mjs [--target https://www.kaiyuanguji.com] [--rounds 5]
 */
import { pathToFileURL } from 'node:url';

const HOT = ['史記', '論語', '杜甫', '四庫全書', '说文解字'];
const COLD = ['詩', '禮', '易', '春秋', '左傳'];

/** "parse;dur=0.2, upstream;desc=\"1\";dur=812" → { parse: 0.2, upstream: 812 } */
export function parseServerTiming(header) {
    const out = {};
    for (const part of (header || '').split(',')) {
        const [name, ...params] = part.trim().split(';');
        const dur = params.find((p) => p.trim().startsWith('dur='));
        if (name && dur) out[name] = (out[name] || 0) + Number(dur.trim().slice(4));
    }
    return out;
}

function pct(values, p) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return NaN;
    return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

async function probe(target, q) {
    const url = `${target}/api/search?${new URLSearchParams({ q, limit: '5' })}`;
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    const ttfb = performance.now() - t0;
    await res.arrayBuffer();
    return {
        q,
        status: res.status,
        cache: res.headers.get('x-search-cache') || '-',
        ttfb,
        st: parseServerTiming(res.headers.get('server-timing')),
    };
}

async function main() {
    const args = process.argv.slice(2);
    const arg = (name, def) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : def;
    };
    const target = arg('target', process.env.TARGET || 'https://www.kaiyuanguji.com').replace(/\/$/, '');
    const rounds = Number(arg('rounds', '5'));

    const rows = [];
    for (let r = 0; r < rounds; r++) {
        for (const w of COLD) {
            const q = `${w}${Date.now().toString(36).slice(-4)}${r}`;
            rows.push(await probe(target, q));
            rows.push(await probe(target, q));
        }
        for (const w of HOT) rows.push(await probe(target, w));
    }

    for (const row of rows) {
        const s = row.st;
        console.log(`${row.status} ${row.cache.padEnd(6)} ttfb=${row.ttfb.toFixed(0).padStart(5)}  total=${s.total ?? '-'} upstream=${s.upstream ?? '-'} meili=${s.meili ?? '-'} cache=${s.cache ?? '-'}  ${row.q}`);
    }
    console.log('\n状态    n   ttfb p50/p90      函数 total p50/p90   upstream p50/p90   meili p50/p90');
    const groups = [...new Set(rows.map((r) => r.cache))];
    for (const g of groups) {
        const rs = rows.filter((r) => r.cache === g);
        const col = (f) => `${pct(rs.map(f), 50).toFixed(0)}/${pct(rs.map(f), 90).toFixed(0)}`;
        console.log(`${g.padEnd(7)} ${String(rs.length).padStart(3)}   ${col((r) => r.ttfb).padEnd(16)}  ${col((r) => r.st.total).padEnd(18)}  ${col((r) => r.st.upstream).padEnd(17)}  ${col((r) => r.st.meili)}`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
