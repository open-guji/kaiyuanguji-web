#!/usr/bin/env node
// 新旧逐文档对比（overview#561）：旧 full-reindex 截获的 <idx>.jsonl vs render-docs 的 docs/<idx>.jsonl.gz
// 用法：node ops/compare-docs.mjs <旧目录> <新 docs 目录> [--examples N] [--json out.json]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
const [oldDir, newDir, ...rest] = process.argv.slice(2);
const ex = Number(rest[rest.indexOf('--examples') + 1]) || 3;
const jsonOut = rest.includes('--json') ? rest[rest.indexOf('--json') + 1] : null;
const load = (p, gz) => {
    const buf = readFileSync(p); const txt = (gz ? gunzipSync(buf) : buf).toString('utf-8');
    const m = new Map(); let dup = 0;
    for (const l of txt.split('\n')) { if (!l) continue; const d = JSON.parse(l); if (m.has(d.id)) dup++; m.set(d.id, d); }
    return { m, dup };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const report = {};
for (const f of readdirSync(newDir).filter(f => f.endsWith('.jsonl.gz'))) {
    const idx = f.replace('.jsonl.gz', '');
    let o; try { o = load(join(oldDir, `${idx}.jsonl`), false); } catch { console.log(`[${idx}] 旧侧无文件`); continue; }
    const n = load(join(newDir, f), true);
    const onlyOld = [...o.m.keys()].filter(k => !n.m.has(k)), onlyNew = [...n.m.keys()].filter(k => !o.m.has(k));
    const fieldDiff = {}, examples = {}; let diffDocs = 0, orderOnly = 0;
    for (const [id, od] of o.m) {
        const nd = n.m.get(id); if (!nd) continue;
        let bad = false;
        for (const k of new Set([...Object.keys(od), ...Object.keys(nd)])) {
            if (same(od[k], nd[k])) continue;
            // 数组仅顺序不同单独计
            if (Array.isArray(od[k]) && Array.isArray(nd[k]) && same([...od[k]].sort(), [...nd[k]].sort())) { fieldDiff[k + '(仅顺序)'] = (fieldDiff[k + '(仅顺序)'] || 0) + 1; orderOnly++; continue; }
            bad = true; fieldDiff[k] = (fieldDiff[k] || 0) + 1;
            (examples[k] ||= []).length < ex && examples[k].push({ id, old: od[k], new: nd[k] });
        }
        if (bad) diffDocs++;
    }
    report[idx] = { old: o.m.size, new: n.m.size, dupOld: o.dup, dupNew: n.dup, onlyOld: onlyOld.length, onlyNew: onlyNew.length, diffDocs, fieldDiff, examples, onlyOldSample: onlyOld.slice(0, 5), onlyNewSample: onlyNew.slice(0, 5) };
    console.log(`[${idx}] 旧 ${o.m.size} / 新 ${n.m.size} · 仅旧 ${onlyOld.length} · 仅新 ${onlyNew.length} · 内容不同 ${diffDocs} 条 · 字段差 ${JSON.stringify(fieldDiff)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
