#!/usr/bin/env node
/**
 * data-package-check.mjs — 在打好的数据包（$KYG_DATA_ROOT）上做上传前检查：格式契约、数量不突降、不变量。
 *
 * overview#470 P0：先用「只报告」模式接进 deploy.yml（continue-on-error），每次把统计写进 job summary，
 * 攒两周数据再校准阈值、再开阻断。本脚本不联网上传任何东西，只在最后（可选）读一次线上上一次发布的
 * latest.json／meta.json 作对比基线；读不到就跳过对比，不算失败。
 *
 * 检查内容（出处见各处注释）：
 *   · entry/<id>.json 逐个：id＝文件名、type 合法、名字字段在、已核实字段的类型对、未知字段清单（ops/data-contract.mjs）
 *   · meta.json／version.json／latest.json／meta-home/sections.json：必有字段与格式、各计数与条目实数一致
 *   · read/tree.json、catalog/tree.json、index/texts/<片>.json、items/<id>/manifest.json（抽样）：结构
 *   · 条目总数下限（deploy.yml 的 N_ENTRY≥100000）与各类计数区间（e2e/fixtures/anchors.ts 的 COUNT_RANGES）
 *   · 相对上一次发布不突降（THRESHOLDS，建议值，需用户拍板；P0 先观察）
 *
 * 用法：
 *   node ops/data-package-check.mjs [--root <数据根>] [--baseline <数据站根地址，空串＝不对比>]
 *                                   [--summary <markdown 追加到的文件>] [--json <统计写到的文件>] [--enforce]
 *   默认数据根取 KYG_DATA_ROOT（同 nextjs/scripts/lib/data-dirs.mjs），默认基线 https://data.kaiyuanguji.com
 * 退出码：检查结果（findings）默认不影响退出码（只报告恒 0；--enforce 时有 block 级问题退出 1）；
 *   脚本自身出错（读写失败等）退出 1，并把失败说明写进 summary——deploy.yml 里这一步是 continue-on-error，所以只是步骤标红、不拦发布。
 */
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    checkEntryDoc, checkMeta, checkVersion, checkLatest, checkTree, checkTextIndexShard,
    checkTextManifest, checkMetaHome, ENTRY_TYPES,
} from './data-contract.mjs';

export const DEFAULT_BASELINE = 'https://data.kaiyuanguji.com';

/**
 * 数量阈值（建议值，推断，需用户拍板；P0 只报告，按两周实测波动校准）。
 * 条数 ≥ smallBelow 的用百分比，更小的（如 collections 84）用绝对值。
 */
export const THRESHOLDS = Object.freeze({
    dropWarnPct: 0.2,
    dropBlockPct: 1,
    growthBlockPct: 20,
    smallBelow: 1000,
    smallDropWarn: 1,
    smallDropBlock: 2,
});

/** 绝对下限：同 e2e/fixtures/anchors.ts:65-70 的 COUNT_RANGES 与 deploy.yml 的 N_ENTRY 闸（改一处记得改两处）。 */
export const COUNT_RANGES = Object.freeze({
    works: { min: 60_000, max: 200_000 },
    books: { min: 12_000, max: 60_000 },
    collections: { min: 40, max: 500 },
    entities: { min: 20_000, max: 200_000 },
});
export const MIN_ENTRY_FILES = 100_000;

const MAX_EXAMPLES = 5;

/** 按「级别＋code」聚合 finding：计数＋最多 5 个例子（同一个 code 出现不同级别时分开记，不能把后来的 block 记成先来的 warn）。 */
export class Findings {
    constructor() { this.byKey = new Map(); }
    add(f) {
        const key = `${f.severity}:${f.code}`;
        let e = this.byKey.get(key);
        if (!e) { e = { severity: f.severity, code: f.code, count: 0, examples: [] }; this.byKey.set(key, e); }
        e.count++;
        if (e.examples.length < MAX_EXAMPLES) e.examples.push(f.message);
    }
    addAll(list) { for (const f of list) this.add(f); }
    list() {
        const order = { block: 0, warn: 1, info: 2 };
        return [...this.byKey.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
    }
    count(severity) { return this.list().filter((e) => e.severity === severity).reduce((n, e) => n + e.count, 0); }
}

function readJsonSafe(path, findings, code, label) {
    if (!existsSync(path)) { findings.add({ severity: 'block', code, message: `${label} 缺失（${path}）` }); return undefined; }
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch (e) {
        findings.add({ severity: 'block', code: `${code}.json`, message: `${label} 不是合法 JSON：${e.message}` });
        return undefined;
    }
}

// ─── 条目扫描 ───

export function scanEntries(entryDir, findings) {
    const stats = { files: 0, byType: Object.fromEntries(ENTRY_TYPES.map((t) => [t, 0])), merged: 0, noType: 0, hasText: 0, hasImage: 0, hasCollated: 0 };
    const unknownTop = new Map();       // 非 `_` 起首的未知字段（可能是新格式）
    const unknownDerived = new Map();   // `_` 起首的未知字段（派生字段）
    if (!existsSync(entryDir)) { findings.add({ severity: 'block', code: 'entry.dir-missing', message: `entry/ 目录缺失（${entryDir}）` }); return { stats, unknownTop, unknownDerived }; }
    for (const file of readdirSync(entryDir)) {
        if (!file.endsWith('.json')) continue;
        stats.files++;
        let doc;
        try { doc = JSON.parse(readFileSync(join(entryDir, file), 'utf-8')); } catch (e) {
            findings.add({ severity: 'block', code: 'entry.json', message: `${file}：不是合法 JSON（${e.message}）` });
            continue;
        }
        const r = checkEntryDoc(doc, file);
        findings.addAll(r.findings);
        if (r.type && stats.byType[r.type] !== undefined) stats.byType[r.type]++; else stats.noType++;
        if (doc && typeof doc === 'object') {
            if (doc.merged_into) stats.merged++;
            if (doc.has_text === true || doc._has_text === true) stats.hasText++;
            if (doc.has_image === true || doc._has_image === true) stats.hasImage++;
            if (doc.has_collated === true || doc._has_collated === true) stats.hasCollated++;
        }
        for (const k of r.unknownFields) {
            const m = k.startsWith('_') ? unknownDerived : unknownTop;
            m.set(k, (m.get(k) || 0) + 1);
        }
    }
    for (const [k, n] of unknownTop) findings.add({ severity: 'warn', code: 'entry.unknown-field', message: `非 \`_\` 起首的未知字段 ${k}（${n} 个条目）：可能是新格式` });
    for (const [k, n] of unknownDerived) findings.add({ severity: 'info', code: 'entry.unknown-derived-field', message: `\`_\` 起首的未知字段 ${k}（${n} 个条目）` });
    return { stats, unknownTop, unknownDerived };
}

// ─── 文本：index/texts、items ───

function countFiles(dir) {
    let n = 0;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) stack.push(join(d, e.name)); else n++;
        }
    }
    return n;
}

export function scanTexts(dataDir, findings, { sample = 300 } = {}) {
    const out = { indexShards: 0, indexOwners: 0, indexVersions: 0, itemOwners: 0, itemFiles: 0, itemDirsWithoutManifest: 0, manifestsChecked: 0, danglingIndexOwners: 0 };
    const itemsDir = join(dataDir, 'items');
    // items/<id>/ 里有 manifest.json 的才是文本 owner；没有的（只放 fragments／sources 等非文本资源，bundle-data 的 copyItemDir 整目录复制）不是
    const hasManifest = new Set();
    let owners = [];
    if (existsSync(itemsDir)) {
        const dirs = readdirSync(itemsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
        for (const d of dirs) {
            if (existsSync(join(itemsDir, d, 'manifest.json'))) { hasManifest.add(d); owners.push(d); } else out.itemDirsWithoutManifest++;
        }
        out.itemOwners = owners.length;
        out.itemFiles = countFiles(itemsDir);
    } else findings.add({ severity: 'info', code: 'items.missing', message: 'items/ 目录不存在（无阅读文本）' });
    if (out.itemDirsWithoutManifest > 0) {
        findings.add({ severity: 'info', code: 'items.no-manifest', message: `items/ 下有 ${out.itemDirsWithoutManifest} 个目录没有 manifest.json（只放非文本资源，不算文本 owner）` });
    }

    const idxDir = join(dataDir, 'index', 'texts');
    if (existsSync(idxDir)) {
        for (const f of readdirSync(idxDir).filter((x) => x.endsWith('.json')).sort()) {
            out.indexShards++;
            try {
                const shard = JSON.parse(readFileSync(join(idxDir, f), 'utf-8'));
                const r = checkTextIndexShard(shard, f);
                findings.addAll(r.findings);
                out.indexOwners += r.owners;
                out.indexVersions += r.versions;
                // 全局清单里登记的 owner 必须有对应的 items/<id>/manifest.json，否则阅读入口点进去没有文本
                if (existsSync(itemsDir) && shard && typeof shard === 'object' && !Array.isArray(shard)) {
                    for (const id of Object.keys(shard)) {
                        if (!hasManifest.has(id)) {
                            out.danglingIndexOwners++;
                            findings.add({ severity: 'warn', code: 'texts-index.dangling-owner', message: `index/texts/${f} 登记了 ${id}，但 items/${id}/manifest.json 不存在` });
                        }
                    }
                }
            } catch (e) { findings.add({ severity: 'block', code: 'texts-index.json', message: `index/texts/${f} 不是合法 JSON（${e.message}）` }); }
        }
    } else findings.add({ severity: 'block', code: 'texts-index.missing', message: 'index/texts/ 目录缺失' });

    const step = Math.max(1, Math.floor(owners.length / sample));
    for (let i = 0; i < owners.length; i += step) {
        const name = owners[i];
        out.manifestsChecked++;
        try { findings.addAll(checkTextManifest(JSON.parse(readFileSync(join(itemsDir, name, 'manifest.json'), 'utf-8')), name)); } catch (e) {
            findings.add({ severity: 'block', code: 'manifest.json', message: `items/${name}/manifest.json 不是合法 JSON（${e.message}）` });
        }
    }
    return out;
}

// ─── 与上一次发布对比 ───

/** 取线上上一次发布的计数基线；读不到返回 null。 */
export async function fetchBaseline(base, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
    if (!base) return null;
    const root = base.replace(/\/$/, '');
    const get = async (path) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetchImpl(`${root}/${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`, { signal: ctl.signal, headers: { 'cache-control': 'no-cache' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally { clearTimeout(t); }
    };
    try {
        const latest = await get('latest.json');
        const v = latest.cacheKey || latest.commitId;
        const meta = await get(`current/meta.json${v ? `?v=${encodeURIComponent(v)}` : ''}`);
        return {
            base: root,
            commit: latest.commitId ?? null, cacheKey: latest.cacheKey ?? null, bundleDate: latest.bundleDate ?? null,
            counts: {
                works: meta.works, books: meta.books, collections: meta.collections, entities: meta.entities,
                hasText: meta.resourceCounts?.hasText, hasImage: meta.resourceCounts?.hasImage,
            },
        };
    } catch (e) {
        return { base: root, error: e.message };
    }
}

/**
 * 当前计数 vs 基线：每项给出 {key, cur, base, delta, pct, verdict}，并把越线项记成 finding。
 * @param {Record<string, number>} cur
 * @param {Record<string, number>} base
 */
export function compareToBaseline(cur, base, findings, t = THRESHOLDS) {
    const rows = [];
    for (const key of Object.keys(cur)) {
        const c = cur[key];
        const b = base?.[key];
        if (!Number.isFinite(c) || !Number.isFinite(b)) { rows.push({ key, cur: c, base: b ?? null, delta: null, pct: null, verdict: 'n/a' }); continue; }
        const delta = c - b;
        const pct = b === 0 ? (c === 0 ? 0 : Infinity) : (delta / b) * 100;
        let verdict = 'ok';
        if (b < t.smallBelow) {
            const drop = -delta;
            if (drop >= t.smallDropBlock) verdict = 'block';
            else if (drop >= t.smallDropWarn) verdict = 'warn';
        } else {
            if (-pct > t.dropBlockPct || pct > t.growthBlockPct) verdict = 'block';
            else if (-pct > t.dropWarnPct) verdict = 'warn';
        }
        if (verdict !== 'ok') {
            const dir = delta < 0 ? '下降' : '上升';
            findings.add({
                severity: verdict, code: 'baseline.delta',
                message: `${key}：${b} → ${c}（${dir} ${Math.abs(delta)}，${Number.isFinite(pct) ? pct.toFixed(2) : '∞'}%）`,
            });
        }
        rows.push({ key, cur: c, base: b, delta, pct, verdict });
    }
    return rows;
}

/** 绝对下限：条目文件总数与各类计数区间。 */
export function checkAbsolute(entryStats, findings) {
    if (entryStats.files < MIN_ENTRY_FILES) findings.add({ severity: 'block', code: 'abs.entry-files', message: `entry 文件只有 ${entryStats.files} 个（下限 ${MIN_ENTRY_FILES}）` });
    const map = { works: 'work', books: 'book', collections: 'collection', entities: 'entity' };
    for (const [k, r] of Object.entries(COUNT_RANGES)) {
        const n = entryStats.byType[map[k]];
        if (n < r.min || n > r.max) findings.add({ severity: 'block', code: 'abs.range', message: `${k}=${n} 超出合理区间 [${r.min}, ${r.max}]` });
    }
}

// ─── 总装 ───

/**
 * 在数据根上跑全部检查，返回报告对象。不抛错（读不到的文件记成 finding）。
 * @param {{ root: string, baseline?: object|null, absolute?: boolean }} o  absolute=false 时跳过绝对下限（测试小包用）
 */
export function runCheck({ root, baseline = null, absolute = true }) {
    const t0 = Date.now();
    const dataDir = join(root, 'data');
    const findings = new Findings();
    const timings = {};
    const mark = (k, from) => { timings[k] = ((Date.now() - from) / 1000); };

    let t = Date.now();
    const { stats: entries, unknownTop, unknownDerived } = scanEntries(join(dataDir, 'entry'), findings);
    mark('entries', t);

    const meta = readJsonSafe(join(dataDir, 'meta.json'), findings, 'meta.missing', 'meta.json');
    if (meta !== undefined) findings.addAll(checkMeta(meta));
    const version = readJsonSafe(join(dataDir, 'version.json'), findings, 'version.missing', 'version.json');
    if (version !== undefined) findings.addAll(checkVersion(version));
    const latest = readJsonSafe(join(root, 'latest.json'), findings, 'latest.missing', 'latest.json');
    if (latest !== undefined) findings.addAll(checkLatest(latest));

    // 计数与条目实数一致：口径（是否含被并条目等）要看两周实测再升级成 block，先记 warn
    if (meta && typeof meta === 'object') {
        const map = { works: 'work', books: 'book', collections: 'collection', entities: 'entity' };
        for (const [k, ty] of Object.entries(map)) {
            if (Number.isInteger(meta[k]) && meta[k] !== entries.byType[ty]) {
                findings.add({ severity: 'warn', code: 'meta.entry-mismatch', message: `meta.${k}=${meta[k]} 与 entry/ 里 ${ty} 的实数 ${entries.byType[ty]} 不一致` });
            }
        }
    }
    if (absolute) checkAbsolute(entries, findings);

    t = Date.now();
    const trees = {};
    for (const [label, rel] of [['read/tree.json', 'read/tree.json'], ['catalog/tree.json', 'catalog/tree.json']]) {
        const doc = readJsonSafe(join(dataDir, rel), findings, `tree.missing`, label);
        if (doc !== undefined) {
            const r = checkTree(doc, label);
            findings.addAll(r.findings);
            trees[label] = { top: r.topCount, nodes: r.nodes, countSum: r.countSum };
        }
    }
    const mh = readJsonSafe(join(dataDir, 'meta-home', 'sections.json'), findings, 'meta-home.missing', 'meta-home/sections.json');
    if (mh !== undefined) findings.addAll(checkMetaHome(mh, meta));
    mark('trees', t);

    t = Date.now();
    const texts = scanTexts(dataDir, findings);
    mark('texts', t);

    // 与上一次发布对比
    let rows = [];
    if (baseline && baseline.counts) {
        const cur = {
            entries: entries.files, works: entries.byType.work, books: entries.byType.book,
            collections: entries.byType.collection, entities: entries.byType.entity,
            hasText: meta?.resourceCounts?.hasText, hasImage: meta?.resourceCounts?.hasImage,
        };
        const base = {
            entries: [baseline.counts.works, baseline.counts.books, baseline.counts.collections, baseline.counts.entities].every(Number.isFinite)
                ? baseline.counts.works + baseline.counts.books + baseline.counts.collections + baseline.counts.entities : undefined,
            ...baseline.counts,
        };
        rows = compareToBaseline(cur, base, findings);
    } else if (baseline && baseline.error) {
        findings.add({ severity: 'info', code: 'baseline.unavailable', message: `读不到线上基线（${baseline.base}）：${baseline.error}；本次不做对比` });
    } else {
        findings.add({ severity: 'info', code: 'baseline.skipped', message: '没有配置对比基线，本次不做「相对上一次发布」的检查' });
    }

    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        seconds: (Date.now() - t0) / 1000,
        timings,
        package: {
            commitId: latest?.commitId ?? null, productionCommitId: latest?.productionCommitId ?? null,
            textCommitId: latest?.textCommitId ?? null, dataFormat: latest?.dataFormat ?? null, bundleDate: latest?.bundleDate ?? null,
        },
        counts: {
            entryFiles: entries.files, byType: entries.byType, merged: entries.merged,
            flags: { hasText: entries.hasText, hasImage: entries.hasImage, hasCollated: entries.hasCollated },
            meta: meta && typeof meta === 'object' ? { works: meta.works, books: meta.books, collections: meta.collections, entities: meta.entities, resourceCounts: meta.resourceCounts } : null,
        },
        texts, trees,
        unknownFields: {
            top: Object.fromEntries([...unknownTop].sort((a, b) => b[1] - a[1]).slice(0, 30)),
            derived: Object.fromEntries([...unknownDerived].sort((a, b) => b[1] - a[1]).slice(0, 30)),
        },
        baseline: baseline ? { base: baseline.base, commit: baseline.commit ?? null, cacheKey: baseline.cacheKey ?? null, error: baseline.error ?? null } : null,
        comparison: rows,
        findings: findings.list(),
        summary: { block: findings.count('block'), warn: findings.count('warn'), info: findings.count('info') },
    };
}

// ─── 输出 ───

const ICON = { block: '🔴', warn: '🟡', info: 'ℹ️', ok: '✓', 'n/a': '–' };

export function renderSummary(report, { enforce = false } = {}) {
    const L = [];
    const s = report.summary;
    L.push(`## 数据包检查（${enforce ? '阻断模式' : '只报告，不阻断'}，overview#470 P0）`);
    L.push('');
    L.push(`数据包：commit \`${(report.package.commitId || '?').slice(0, 12)}\`、book-index \`${(report.package.productionCommitId || '?').slice(0, 12)}\`、book-text \`${(report.package.textCommitId || '?').slice(0, 12)}\`，dataFormat ${report.package.dataFormat ?? '（未设）'}；耗时 ${report.seconds.toFixed(1)} 秒。`);
    L.push(`结果：${ICON.block} ${s.block} 项会阻断（强制模式下）、${ICON.warn} ${s.warn} 项警告、${ICON.info} ${s.info} 项提示。`);
    L.push('');
    if (report.comparison.length) {
        L.push(`### 与上一次发布对比（基线 ${report.baseline?.base ?? ''}，commit \`${(report.baseline?.commit || '?').slice(0, 12)}\`）`);
        L.push('');
        L.push('| 项 | 本次 | 上次 | 变化 | 判定 |');
        L.push('|---|---:|---:|---:|---|');
        for (const r of report.comparison) {
            const ch = r.delta === null ? '–' : `${r.delta >= 0 ? '+' : ''}${r.delta}（${Number.isFinite(r.pct) ? `${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(2)}%` : '∞'}）`;
            L.push(`| ${r.key} | ${r.cur ?? '–'} | ${r.base ?? '–'} | ${ch} | ${ICON[r.verdict]} ${r.verdict} |`);
        }
        L.push('');
    }
    L.push('### 本包统计');
    L.push('');
    const c = report.counts;
    L.push(`- 条目文件 ${c.entryFiles}（work ${c.byType.work}／book ${c.byType.book}／collection ${c.byType.collection}／entity ${c.byType.entity}；被并 ${c.merged}）`);
    L.push(`- 条目里的标志：has_text ${c.flags.hasText}、has_image ${c.flags.hasImage}、has_collated ${c.flags.hasCollated}（meta.resourceCounts：${JSON.stringify(c.meta?.resourceCounts ?? null)}）`);
    L.push(`- 阅读文本：index/texts ${report.texts.indexShards} 片、${report.texts.indexOwners} 个 owner、${report.texts.indexVersions} 个版本；items/ ${report.texts.itemOwners} 个 owner、${report.texts.itemFiles} 个文件；抽查 manifest ${report.texts.manifestsChecked} 个`);
    for (const [k, v] of Object.entries(report.trees)) L.push(`- ${k}：顶层 ${v.top} 个、共 ${v.nodes} 个节点、顶层 count 之和 ${v.countSum}`);
    L.push('');
    if (report.findings.length) {
        L.push('### 发现');
        L.push('');
        L.push('| 级别 | 代码 | 数量 | 例子 |');
        L.push('|---|---|---:|---|');
        for (const f of report.findings) {
            const ex = f.examples.map((e) => e.replace(/\|/g, '\\|')).join('<br>');
            L.push(`| ${ICON[f.severity]} ${f.severity} | \`${f.code}\` | ${f.count} | ${ex} |`);
        }
        L.push('');
    }
    const top = Object.entries(report.unknownFields.top);
    const derived = Object.entries(report.unknownFields.derived);
    if (top.length || derived.length) {
        L.push('### 字段表里没有的字段（新字段清单，不阻断）');
        L.push('');
        if (top.length) L.push(`- 非 \`_\` 起首：${top.map(([k, n]) => `\`${k}\`×${n}`).join('、')}`);
        if (derived.length) L.push(`- \`_\` 起首（派生）：${derived.map(([k, n]) => `\`${k}\`×${n}`).join('、')}`);
        L.push('');
    }
    L.push(`<sub>各段耗时（秒）：${Object.entries(report.timings).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('，')}</sub>`);
    return L.join('\n') + '\n';
}

// ─── CLI ───

function parseArgs(argv) {
    const a = { enforce: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--enforce') a.enforce = true;
        else if (['--root', '--baseline', '--summary', '--json'].includes(k)) a[k.slice(2)] = argv[++i];
        else { console.error(`未知参数：${k}`); process.exit(2); }
    }
    return a;
}

async function main(args) {
    let root = args.root;
    if (!root) {
        const { resolveDataDirs } = await import('../nextjs/scripts/lib/data-dirs.mjs');
        root = resolveDataDirs().root;
    }
    root = resolve(root);
    if (!existsSync(join(root, 'data'))) { console.error(`❌ ${join(root, 'data')} 不存在：先跑 bundle-data.mjs`); process.exit(args.enforce ? 1 : 0); }
    const baselineBase = args.baseline === undefined ? DEFAULT_BASELINE : args.baseline;
    const baseline = await fetchBaseline(baselineBase);
    const report = runCheck({ root, baseline });
    const md = renderSummary(report, { enforce: args.enforce });
    console.log(md);
    if (args.summary) appendFileSync(args.summary, md + '\n');
    if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
    if (args.enforce && report.summary.block > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    main(args).catch((e) => {
        // 检查结果（findings）不影响退出码；但脚本自己出错必须看得见：写一段失败说明进 summary、打 ::warning::，退出 1。
        // deploy.yml 里这一步是 continue-on-error，所以只是步骤标红、不拦发布。
        const msg = `## 数据包检查：脚本自身出错\n\n\`\`\`\n${e.stack || e.message}\n\`\`\`\n\n本次没有产出检查结果（只报告模式，不拦发布）。\n`;
        console.error(msg);
        console.log(`::warning title=数据包检查脚本出错::${String(e.message).split('\n')[0]}`);
        if (args.summary) { try { appendFileSync(args.summary, msg + '\n'); } catch { /* summary 也写不了就只有日志了 */ } }
        process.exit(1);
    });
}
