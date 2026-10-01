#!/usr/bin/env node
/**
 * item-revalidate.mjs — 发版后按改动失效条目页（W2-3，31 卡 §A.6 第 2 条）。
 *
 * 读 item-changes.mjs 的改动集，POST 给站点的 /internal/revalidate（只在全栈构建存在）。
 * 新增／变更／删除都要失效：删除的条目页要从缓存里的旧内容变成 404。
 * 超过阈值（ITEM_REVALIDATE_ALL_OVER，默认 5000，大宗批量修改时）改为整体失效。
 * 阅读页 /read/<id>…（ISR，overview#322）不看改动集，每次都整体失效。
 *
 * 环境变量：ITEM_SITE、KYG_REVALIDATE_SECRET、ITEM_CHANGES_OUT（默认 $KYG_DATA_ROOT/item-changes.json）
 */
import { join } from 'node:path';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { SITE, readChanges } from './lib/item-http.mjs';

const SECRET = process.env.KYG_REVALIDATE_SECRET || '';
const ALL_OVER = Number(process.env.ITEM_REVALIDATE_ALL_OVER || 5000);
const BATCH = 500;
const changes = readChanges(process.env.ITEM_CHANGES_OUT || join(resolveDataDirs().root, 'item-changes.json'));
const ids = [...changes.added, ...changes.changed, ...changes.removed];

if (!SECRET) { console.error('❌ 没有 KYG_REVALIDATE_SECRET'); process.exit(1); }

async function post(body) {
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(`${SITE}/internal/revalidate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-kyg-revalidate': SECRET },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
        }).catch((err) => ({ ok: false, status: 0, text: async () => err.message }));
        if (res.ok) return res.json();
        const detail = await res.text();
        if (attempt >= 3 || res.status === 401 || res.status === 503) throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
}

// 阅读页（ISR，overview#322）每次发版整体失效一次：文本改动不一定体现在条目改动集里
console.log('✓ 已整体失效阅读页', await post({ read: true }));

if (ids.length === 0) {
    console.log('· 没有条目改动，不失效任何条目页');
} else if (ids.length > ALL_OVER) {
    console.log(`· 改动 ${ids.length} 条，超过 ${ALL_OVER}：整体失效全部条目页`, await post({ all: true }));
} else {
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
        const r = await post({ ids: ids.slice(i, i + BATCH) });
        done += r.revalidated ?? 0;
    }
    console.log(`✓ 已失效 ${done} 个条目页（新增 ${changes.added.length}、变更 ${changes.changed.length}、删除 ${changes.removed.length}）`);
}
