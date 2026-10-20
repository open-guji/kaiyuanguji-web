/**
 * proofing-sync-run.mjs — 每日「proofing-sync」的流程（连网的部分都由调用方注入，单测用假的 Worker／KV／COS）
 *
 * 两段，可分开跑（workflow 里分两步，各自只拿自己要的密钥）：
 *   opinions：中心库所有待审单的 (书, rev) → 网站 KV 管理读 /api/cellreview → 并进中心库 feedback/lists/web/<书>/<rev>.jsonl
 *   publish ：中心库所有待审单 → COS [前缀/]proof/index.json 与 proof/<书>/<章>.pending.json（md5 相同的跳过）
 * 雪碧图仍由 sync-proof-sprites.mjs（GUJI-557）发，不在这里。
 *
 * 日志与 run 摘要只出计数（公开仓），不出票的内容。
 */
import {
    PROOFING_PREFIX, parsePendingPath, readPending, buildProofIndex, webSnapshotPath, mergeSnapshot, planCosPut,
} from './proofing-sync-plan.mjs';
import {
    FIX_KINDS, THREAD_KINDS, fixesSnapshotPath, threadsSnapshotPath, hiddenListPath, parseHidden, fixesPublicKey, mergeFixes, buildPublicFixes, threadId,
    statusListPath, parseStatusRows, planStatusWrites,
} from './fixes-sync.mjs';

export const SHORT_CACHE = 'public, max-age=300';

/**
 * 读出各工作区里全部待审单。
 * @param worker {listFiles(ws, prefix) → {files:[{src_path}], truncated}, getFile(ws, path) → {text, sha256} | null}
 * @returns {{entries: [{ws, book, chap, rev, n, text}], problems: string[]}}
 */
export async function collectPendings(worker, wsList) {
    const entries = [];
    const problems = [];
    const seen = new Map();
    for (const ws of wsList) {
        const listing = await worker.listFiles(ws, PROOFING_PREFIX);
        if (listing.truncated) problems.push(`${ws}：待审单超过一页（1000 个），只处理了前一页`);
        for (const f of listing.files) {
            const id = parsePendingPath(f.src_path);
            if (!id) continue; // 不是待审单（比如将来放进去的说明文件）
            const got = await worker.getFile(ws, f.src_path);
            if (!got) { problems.push(`${ws}：${f.src_path} 列得出、取不到`); continue; }
            const p = readPending(got.text);
            if (p.error) { problems.push(`${ws}：${f.src_path} ${p.error}`); continue; }
            const k = `${id.book}/${id.chap}`;
            if (seen.has(k)) { problems.push(`${k} 同时在工作区 ${seen.get(k)} 与 ${ws}，用前者`); continue; }
            seen.set(k, ws);
            entries.push({ ws, ...id, rev: p.rev, n: p.n, text: got.text });
        }
    }
    return { entries, problems };
}

/**
 * opinions 段：每个 (工作区, 书, rev) 拉一次 KV，合进快照，变了才写。
 * @param kv {listVotes(rev, book) → items[]}
 * @param worker 另需 putFile(ws, path, text, baseSha)
 */
export async function syncOpinions({ worker, kv, entries, dryRun = false }) {
    const groups = new Map();
    for (const e of entries) {
        const k = `${e.ws}\u0000${e.book}\u0000${e.rev}`;
        if (!groups.has(k)) groups.set(k, { ws: e.ws, book: e.book, rev: e.rev });
    }
    const rows = [];
    const problems = [];
    for (const g of [...groups.values()].sort((x, y) => `${x.book}/${x.rev}`.localeCompare(`${y.book}/${y.rev}`))) {
        const path = webSnapshotPath(g.book, g.rev);
        try {
            const items = await kv.listVotes(g.rev, g.book);
            const old = await worker.getFile(g.ws, path);
            const m = mergeSnapshot(old?.text ?? '', items, g);
            const changed = m.text !== (old?.text ?? '') && m.total > 0;
            if (changed && !dryRun) await worker.putFile(g.ws, path, m.text, old?.sha256 ?? null);
            rows.push({ ...g, kv: items.length, total: m.total, added: m.added, updated: m.updated, kept: m.kept, dropped: m.dropped, written: changed && !dryRun, changed });
        } catch (e) {
            problems.push(`${g.book}/${g.rev}：${e?.message || e}`);
        }
    }
    return { rows, problems };
}

/**
 * publish 段：index.json＋各章待审单原文，按 md5 跳过与 COS 相同的。
 * @param cos {listPrefixEtags(prefix) → Map, putObjectText(key, body, {contentType, cacheControl})}
 * @param proofPrefix 如 'proof/' 或 'staging/proof/'
 */
export async function publishPendings({ cos, entries, proofPrefix, dryRun = false }) {
    const objects = [
        { key: 'index.json', body: buildProofIndex(entries) },
        ...entries.map((e) => ({ key: `${e.book}/${e.chap}.pending.json`, body: e.text })),
    ];
    const remote = cos ? await cos.listPrefixEtags(proofPrefix) : new Map();
    const plan = planCosPut(objects, remote);
    // index.json 最后传：网站先看 index 再取待审单，先传单子、后换 index，中途不会指向还没传的文件
    const ordered = [...plan.put.filter((o) => o.key !== 'index.json'), ...plan.put.filter((o) => o.key === 'index.json')];
    const failed = [];
    if (!dryRun && cos) {
        for (const o of ordered) {
            // 有待审单没传上去就不换 index，免得 index 的 rev 与 COS 上的单子对不上
            if (o.key === 'index.json' && failed.length) { failed.push('index.json：前面有失败，本次不换'); break; }
            try {
                await cos.putObjectText(proofPrefix + o.key, o.body, { contentType: 'application/json; charset=utf-8', cacheControl: SHORT_CACHE });
            } catch (e) {
                failed.push(`${o.key}：${e?.message || e}`);
            }
        }
    }
    return { put: ordered.map((o) => o.key), same: plan.same.map((o) => o.key), failed };
}

/**
 * opinions 段之二：读者改字／一段有问题／专名意见（/api/charfix）→ 中心库 feedback/lists/web/<书>/fixes.jsonl（GUJI-597）。
 * @param kv {listFixes(book, kind) → items[]}
 */
export async function syncFixes({ worker, kv, ws, books, dryRun = false }) {
    const rows = [];
    const problems = [];
    for (const book of books) {
        try {
            const items = [];
            for (const kind of FIX_KINDS) items.push(...(await kv.listFixes(book, kind)));
            const path = fixesSnapshotPath(book);
            const old = await worker.getFile(ws, path);
            const m = mergeFixes(old?.text ?? '', items, book);
            const changed = m.text !== (old?.text ?? '') && m.total > 0;
            if (changed && !dryRun) await worker.putFile(ws, path, m.text, old?.sha256 ?? null);
            rows.push({ book, kv: items.length, total: m.total, added: m.added, updated: m.updated, kept: m.kept, dropped: m.dropped, written: changed && !dryRun, changed });
        } catch (e) {
            problems.push(`${book} 意见：${e?.message || e}`);
        }
        // 讨论（表态、回复，/api/thread）另存 threads.jsonl；KV 没有该接口（旧部署）时 listThreads 抛错，记问题不中断
        if (!kv.listThreads) continue;
        try {
            const items = [];
            for (const kind of THREAD_KINDS) items.push(...(await kv.listThreads(book, kind)));
            const path = threadsSnapshotPath(book);
            const old = await worker.getFile(ws, path);
            const m = mergeFixes(old?.text ?? '', items, book, threadId);
            const changed = m.text !== (old?.text ?? '') && m.total > 0;
            if (changed && !dryRun) await worker.putFile(ws, path, m.text, old?.sha256 ?? null);
            rows.push({ book: `${book}（讨论）`, kv: items.length, total: m.total, added: m.added, updated: m.updated, kept: m.kept, dropped: m.dropped, written: changed && !dryRun, changed });
        } catch (e) {
            problems.push(`${book} 讨论：${e?.message || e}`);
        }
    }
    return { rows, problems };
}

/**
 * opinions 段之三（M11 B2，GUJI-714）：意见处理结论回写网站。
 * 中心库 feedback/lists/web/<书>/status.jsonl（cv `guji opinions publish-status` 写）→ 与 KV 现状（/api/fixes 实时读）比 →
 * 不同的才 POST /api/fixes（state／version／reason；reply 只在 KV 与快照里都还没有同样文字的整理组回复时才发）。
 * 要放在 syncFixes 之前：刚发的整理组回复当次就能被 threads.jsonl 快照收进去。
 * @param site {liveFixes(book, volume) → /api/fixes 回包, postFixes(body) → 回包}
 */
export async function syncStatus({ worker, site, ws, books, dryRun = false }) {
    const rows = [];
    const problems = [];
    const planned = [];
    for (const book of books) {
        try {
            const got = await worker.getFile(ws, statusListPath(book));
            if (!got) continue;
            const parsed = parseStatusRows(got.text, book);
            const live = {};
            for (const vol of [...new Set(parsed.rows.map((r) => r.volume))]) {
                try {
                    const j = await site.liveFixes(book, vol);
                    if (!j || j.success === false) throw new Error(j?.error || '读不到');
                    live[vol] = j.threads?.[vol] || {};
                } catch (e) {
                    problems.push(`${book}/${vol} 状态：读 /api/fixes 失败，本册不回写（${e?.message || e}）`);
                }
            }
            const threads = await worker.getFile(ws, threadsSnapshotPath(book));
            const plan = planStatusWrites(parsed.rows, live, threads?.text ?? '', book);
            let posted = 0;
            for (const p of plan.posts) {
                planned.push({ book, volume: p.body.volume, target: p.body.target, from: p.from, to: p.state ? p.body.state : null, reply: p.reply });
                if (dryRun) continue;
                try {
                    await site.postFixes(p.body);
                    posted++;
                } catch (e) {
                    problems.push(`${book}/${p.body.volume} ${p.body.target} 回写：${e?.message || e}`);
                }
            }
            rows.push({ book, total: parsed.rows.length, bad: parsed.bad, post: plan.posts.length, posted, same: plan.same, skipped: plan.skipped });
        } catch (e) {
            problems.push(`${book} 状态：${e?.message || e}`);
        }
    }
    return { rows, planned, problems };
}

/**
 * publish 段之二：中心库 fixes.jsonl → COS [前缀/]proof/fixes/<书>.json（公开清单，整册反馈页读它）。中心库没有快照的书跳过。
 */
export async function publishFixes({ worker, cos, ws, books, proofPrefix, dryRun = false }) {
    const objects = [];
    const failed = [];
    for (const book of books) {
        try {
            const got = await worker.getFile(ws, fixesSnapshotPath(book));
            if (!got) continue;
            const threads = await worker.getFile(ws, threadsSnapshotPath(book));
            const hidden = await worker.getFile(ws, hiddenListPath(book));
            const status = await worker.getFile(ws, statusListPath(book));
            objects.push({ key: fixesPublicKey(book), body: buildPublicFixes(got.text, book, threads?.text ?? '', parseHidden(hidden?.text), status?.text ?? '') });
        } catch (e) {
            failed.push(`${book} 意见清单：${e?.message || e}`);
        }
    }
    const remote = cos ? await cos.listPrefixEtags(`${proofPrefix}fixes/`) : new Map();
    const plan = planCosPut(objects, remote);
    if (!dryRun && cos) {
        for (const o of plan.put) {
            try {
                await cos.putObjectText(proofPrefix + o.key, o.body, { contentType: 'application/json; charset=utf-8', cacheControl: SHORT_CACHE });
            } catch (e) {
                failed.push(`${o.key}：${e?.message || e}`);
            }
        }
    }
    return { put: plan.put.map((o) => o.key), same: plan.same.map((o) => o.key), failed };
}

/** run 摘要（markdown），只有计数 */
export function summarize({ ws, proofPrefix, dryRun, entries, collectProblems, opinions, publish, fixes, fixesPublish, status }) {
    const L = [];
    L.push(`### proofing-sync（工作区 ${ws.join('、')}${dryRun ? '，演练：不写' : ''}）`);
    L.push(`待审单 ${entries.length} 章，待审格合计 ${entries.reduce((s, e) => s + e.n, 0)}`);
    for (const p of collectProblems) L.push(`- ⚠️ ${p}`);
    if (opinions) {
        L.push('', '#### 意见 → 中心库', '| 书 | rev | KV 现有 | 快照合计 | 新增 | 改票 | 仅快照有 | 写入 |', '|---|---|---|---|---|---|---|---|');
        for (const r of opinions.rows) L.push(`| ${r.book} | ${r.rev} | ${r.kv} | ${r.total} | ${r.added} | ${r.updated} | ${r.kept} | ${r.written ? '是' : r.changed ? '演练' : '无变化'} |`);
        for (const p of opinions.problems) L.push(`- ❌ ${p}`);
    }
    if (publish) {
        L.push('', `#### 待审单 → COS \`${proofPrefix}\``, `上传 ${publish.put.length} · 相同跳过 ${publish.same.length} · 失败 ${publish.failed.length}`);
        for (const k of publish.put) L.push(`- ${k}`);
        for (const p of publish.failed) L.push(`- ❌ ${p}`);
    }
    if (fixes) {
        L.push('', '#### 改字与段落意见 → 中心库', '| 书 | KV 现有 | 快照合计 | 新增 | 改动 | 仅快照有 | 写入 |', '|---|---|---|---|---|---|---|');
        for (const r of fixes.rows) L.push(`| ${r.book} | ${r.kv} | ${r.total} | ${r.added} | ${r.updated} | ${r.kept} | ${r.written ? '是' : r.changed ? '演练' : '无变化'} |`);
        for (const p of fixes.problems) L.push(`- ❌ ${p}`);
    }
    if (status) {
        L.push('', '#### 意见处理结论 → 网站（/api/fixes）', '| 书 | 结论行 | 不合规 | 要回写 | 已回写 | 已一致 | 册没读到 |', '|---|---|---|---|---|---|---|');
        for (const r of status.rows) L.push(`| ${r.book} | ${r.total} | ${r.bad} | ${r.post} | ${dryRun ? '演练' : r.posted} | ${r.same} | ${r.skipped} |`);
        for (const p of status.planned) L.push(`- ${p.book}/${p.volume} \`${p.target}\`：${p.to ? `${p.from} → ${p.to}` : '状态不变'}${p.reply ? '，加整理组回复' : ''}`);
        for (const p of status.problems) L.push(`- ❌ ${p}`);
    }
    if (fixesPublish) {
        L.push('', `#### 意见清单 → COS \`${proofPrefix}fixes/\``, `上传 ${fixesPublish.put.length} · 相同跳过 ${fixesPublish.same.length} · 失败 ${fixesPublish.failed.length}`);
        for (const p of fixesPublish.failed) L.push(`- ❌ ${p}`);
    }
    return L.join('\n') + '\n';
}
