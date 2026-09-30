#!/usr/bin/env node
/**
 * item-cache-verify.mjs — 发版后实测「改一条数据 → 该页 5 分钟内更新，其它页 CDN 仍命中」
 * （W2-3 判据）。在 item-revalidate.mjs 之后跑。（原来后面还有 item-prewarm.mjs，overview#293 起已删。）
 *
 *  1. 改动页：从改动集里抽至多 3 个（新增／变更），每 20 秒取一次，直到页面的
 *     data-ssr-version 等于本轮新 root（h1:<newRoot>），超时 5 分钟判失败；
 *  2. 未改动页：取一个不在改动集里的热门页，连取两次，第二次须 CDN 命中（EO-Cache-Status 含 hit）。
 * 结果写进 $GITHUB_STEP_SUMMARY（有的话）。
 *
 * 环境变量：ITEM_SITE、ITEM_CHANGES_OUT、ITEM_VERIFY_TIMEOUT_S（默认 300）
 */
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { SITE, readChanges, getItemPage, hotItemIds } from './lib/item-http.mjs';

const TIMEOUT_S = Number(process.env.ITEM_VERIFY_TIMEOUT_S || 300);
const { root, dataDir } = resolveDataDirs();
const changes = readChanges(process.env.ITEM_CHANGES_OUT || join(root, 'item-changes.json'));
const want = `h1:${changes.newRoot}`;
const lines = [`### 条目页缓存实测（${SITE}）`, ''];
let failed = false;

const touched = new Set([...changes.added, ...changes.changed, ...changes.removed]);
const sample = [...changes.changed, ...changes.added].slice(0, 3);
if (!sample.length) {
    lines.push('- 本轮没有条目改动，跳过「改动页 5 分钟内更新」');
} else {
    const t0 = Date.now();
    const pending = new Map(sample.map((id) => [id, null]));
    while (pending.size && (Date.now() - t0) / 1000 < TIMEOUT_S) {
        for (const id of [...pending.keys()]) {
            const r = await getItemPage(id);
            pending.set(id, r);
            if (r.status === 200 && r.version === want) {
                lines.push(`- ✓ 改动页 \`${id}\` ${((Date.now() - t0) / 1000).toFixed(0)} s 内换成新版（${r.cache || '无缓存头'}）`);
                pending.delete(id);
            }
        }
        if (pending.size) await new Promise((r) => setTimeout(r, 20_000));
    }
    for (const [id, r] of pending) {
        failed = true;
        lines.push(`- ✗ 改动页 \`${id}\` ${TIMEOUT_S} s 后仍是旧版：status ${r?.status}、version ${r?.version}、${r?.cache}（应为 ${want}）`);
    }
}

const control = hotItemIds(dataDir, 200).find((id) => !touched.has(id));
if (control) {
    const a = await getItemPage(control);
    const b = await getItemPage(control);
    const hit = /hit/i.test(b.cache);
    if (!hit) failed = true;
    lines.push(`- ${hit ? '✓' : '✗'} 未改动页 \`${control}\`：第一次 ${a.cache || '无缓存头'} ${a.ms} ms，第二次 ${b.cache || '无缓存头'} ${b.ms} ms`);
}

const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (failed) process.exit(1);
