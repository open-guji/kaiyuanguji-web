#!/usr/bin/env node
/**
 * item-changes.mjs — 算出本轮发布相对上一版「哪些条目变了」（W2-3）。
 *
 * 旧版：发布前记下的 h1 指针所指的 root（OLD_H1_ROOT），root 文档和分片都从 COS 取
 *       （内容寻址、不可变，发布后也还在——孤儿清理保留最近 N 个 root）。
 * 新版：本地 bundle-hashed.mjs 刚产出的 data-h1/roots/*.json 与 manifest/ 分片；
 *       本地没有时（例如只想事后复算）用 NEW_H1_ROOT 从 COS 取。
 *
 * 输出 JSON（ITEM_CHANGES_OUT，默认 $KYG_DATA_ROOT/item-changes.json）：
 *   { oldRoot, newRoot, shardsCompared, added[], changed[], removed[] }
 * 下游：item-revalidate.mjs（失效这些页）。（原来还有 item-prewarm.mjs 预热这些页，overview#293 起已删，不再预热。）
 *
 * 环境变量：
 *   ITEM_DATA_BASE  数据根（测试站 https://data.kaiyuanguji.com/staging）
 *   OLD_H1_ROOT     旧 root 文件名（如 87af1c4e4e2e5193.json）；空＝首次发布，全部算新增
 *   NEW_H1_ROOT     可选，新 root 文件名；不给就用本地 data-h1/roots/ 里唯一那个
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { changedShardKeys, diffShard, mergeDiffs } from './lib/item-changes.mjs';

const BASE = (process.env.ITEM_DATA_BASE || 'https://data.kaiyuanguji.com').replace(/\/$/, '');
const { root: dataRoot, h1Dir } = resolveDataDirs();
const OUT = process.env.ITEM_CHANGES_OUT || join(dataRoot, 'item-changes.json');
const OLD_ROOT = (process.env.OLD_H1_ROOT || '').trim();
const CONCURRENCY = 16;

async function getJson(url) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
}

function readLocal(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

async function loadNewRoot() {
    const name = (process.env.NEW_H1_ROOT || '').trim();
    if (name) {
        const local = readLocal(join(h1Dir, 'roots', name));
        return { name, doc: local ?? (await getJson(`${BASE}/h1/roots/${name}`)), local: !!local };
    }
    const dir = join(h1Dir, 'roots');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    if (files.length !== 1) throw new Error(`本地 ${dir} 应恰好有 1 个 root，实际 ${files.length} 个（先跑 bundle-hashed.mjs，或给 NEW_H1_ROOT）`);
    return { name: files[0], doc: readLocal(join(dir, files[0])), local: true };
}

async function pool(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

const t0 = Date.now();
const next = await loadNewRoot();
if (!next.doc) throw new Error(`取不到新 root ${next.name}`);
const old = OLD_ROOT ? await getJson(`${BASE}/h1/roots/${OLD_ROOT}`) : null;
if (OLD_ROOT && !old) console.warn(`⚠️ 旧 root ${OLD_ROOT} 在 COS 上已不存在，按首次发布处理（全部算新增）`);

let result;
if (OLD_ROOT && OLD_ROOT === next.name) {
    result = { added: [], changed: [], removed: [] };
    console.log('· 新旧 root 相同：数据没变');
} else {
    const keys = changedShardKeys(old, next.doc);
    const diffs = await pool(keys, async (k) => {
        const oh = old?.shards?.[k];
        const nh = next.doc.shards?.[k];
        const oldShard = oh ? await getJson(`${BASE}/h1/manifest/${k}.${oh}.json`) : null;
        const newShard = nh
            ? (next.local ? readLocal(join(h1Dir, 'manifest', `${k}.${nh}.json`)) : null) ?? (await getJson(`${BASE}/h1/manifest/${k}.${nh}.json`))
            : null;
        if (oh && !oldShard) throw new Error(`旧分片 ${k}.${oh}.json 取不到，改动集会漏算`);
        return diffShard(oldShard, newShard);
    });
    result = { ...mergeDiffs(diffs), shardsCompared: keys.length };
}

const summary = { oldRoot: OLD_ROOT || null, newRoot: next.name, ...result };
writeFileSync(OUT, JSON.stringify(summary));
console.log(`改动集 ${OLD_ROOT || '（无旧版）'} → ${next.name}：新增 ${summary.added.length}、变更 ${summary.changed.length}、删除 ${summary.removed.length}`
    + `（比对分片 ${summary.shardsCompared ?? 0} 个，${((Date.now() - t0) / 1000).toFixed(1)} s）→ ${OUT}`);
