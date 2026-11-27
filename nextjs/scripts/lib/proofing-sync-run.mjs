/**
 * proofing-sync-run.mjs — 每日「proofing-sync」的流程（连网的部分都由调用方注入，单测用假的 Worker／KV／COS）
 *
 * 两段，可分开跑（workflow 里分两步，各自只拿自己要的密钥）：
 *   opinions：网站 KV 管理读 /api/cellreview?items=1 → 并进中心库 feedback/lists/web/<书>/items.jsonl（按条目，没有 rev）
 *   publish ：中心库待审条目（feedback/lists/pending/<书>/<章>.items.jsonl，每格一条、没有 rev、没有整张单）里
 *             开着条目登记的单格图（`sprites[]`，图真源在 R2）→ COS [前缀/]proof/<书>/<章>/<name>（同名同内容的跳过）
 * 待审格本身由 Worker /v1/web/pending-doc 现拼，网站精校页读它；COS 上不再发整张单。
 * 老路（GUJI-557：book-text 指针＋GitHub Release）仍由 sync-proof-sprites.mjs 发，不在这里。
 *
 * 日志与 run 摘要只出计数（公开仓），不出票的内容。
 */
import { createHash } from 'node:crypto';
import {
    PROOFING_PREFIX, parseItemsPath, readItems, buildProofIndex, mergeProofIndex, itemSnapshotPath, mergeItemSnapshot, planCosPut, md5Hex,
} from './proofing-sync-plan.mjs';
import {
    FIX_KINDS, THREAD_KINDS, fixesSnapshotPath, threadsSnapshotPath, hiddenListPath, parseHidden, fixesPublicKey, mergeFixes, buildPublicFixes, threadId,
    statusListPath, parseStatusRows, planStatusWrites,
} from './fixes-sync.mjs';

const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
export const SHORT_CACHE = 'public, max-age=300';
/** 雪碧图文件名带内容哈希，内容变了名字就变 */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * 读出各工作区里全部待审条目文件（每章一个）。
 * softWs：列目录失败只记问题、不抛错的工作区（自动推出的）。
 * @param worker {listFiles(ws, prefix) → {files:[{src_path}], truncated}, getFile(ws, path) → {text, sha256} | null}
 * @returns {{entries: [{ws, book, chap, n, sprites}], problems: string[]}}  n＝开着的条目数
 */
export async function collectPendings(worker, wsList, softWs = new Set()) {
    const entries = [];
    const problems = [];
    const seen = new Map();
    for (const ws of wsList) {
        let listing;
        try {
            listing = await worker.listFiles(ws, PROOFING_PREFIX);
        } catch (e) {
            if (!softWs.has(ws)) throw e;
            problems.push(`${ws}：工作区列不出来（自动推出的新书，可能还没建工作区）：${String(e.message || e).slice(0, 120)}`);
            continue;
        }
        if (listing.truncated) problems.push(`${ws}：待审条目文件超过一页（1000 个），只处理了前一页`);
        for (const f of listing.files) {
            const id = parseItemsPath(f.src_path);
            if (!id) continue; // 不是条目文件
            const got = await worker.getFile(ws, f.src_path);
            if (!got) { problems.push(`${ws}：${f.src_path} 列得出、取不到`); continue; }
            const p = readItems(got.text);
            if (p.error) { problems.push(`${ws}：${f.src_path} ${p.error}`); continue; }
            const k = `${id.book}/${id.chap}`;
            if (seen.has(k)) { problems.push(`${k} 同时在工作区 ${seen.get(k)} 与 ${ws}，用前者`); continue; }
            seen.set(k, ws);
            entries.push({ ws, ...id, n: p.n, sprites: p.sprites });
        }
    }
    return { entries, problems };
}

/**
 * 只发一本书或一章（输入 ONLY，如 `96mid1ogzk` 或 `96mid1ogzk/006`，逗号分隔多项）：落票、重出单之后不必等全站。
 * 返回过滤函数；ONLY 空就全收。
 */
export function onlyFilter(only) {
    const keys = String(only || '').split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
    if (!keys.length) return null;
    return (e) => keys.some((k) => (k.includes('/') ? `${e.book}/${e.chap}` === k : e.book === k));
}

/** COS 上的雪碧图和单子里登记的是不是同一份：md5 相同；超 1 MB 分块上传的 ETag 不是 md5，记成 `mp:<字节数>`，
 *  雪碧图文件名带内容哈希，同名同字节数即同一份（不认这个的话，每次发布都会把所有大图重传一遍） */
export const spriteOnCos = (remote, s) => remote === s.md5 || remote === `mp:${s.bytes}`;

/**
 * opinions 段：每本书拉一次按条目记的票，合进快照（一书一份，不分版），变了才写。
 * @param kv {listItemVotes(book) → items[]}
 * @param worker 另需 putFile(ws, path, text, baseSha)
 */
export async function syncOpinions({ worker, kv, entries, dryRun = false }) {
    const rows = [];
    const problems = [];
    const books = new Map();
    for (const e of entries) if (!books.has(e.book)) books.set(e.book, e.ws);
    for (const [book, ws] of [...books.entries()].sort()) {
        const path = itemSnapshotPath(book);
        try {
            const items = await kv.listItemVotes(book);
            const old = await worker.getFile(ws, path);
            const m = mergeItemSnapshot(old?.text ?? '', items, { book });
            const changed = m.text !== (old?.text ?? '') && m.total > 0;
            if (changed && !dryRun) await worker.putFile(ws, path, m.text, old?.sha256 ?? null);
            rows.push({ ws, book, kv: items.length, total: m.total, cells: m.cells, added: m.added, updated: m.updated, kept: m.kept, dropped: m.dropped, written: changed && !dryRun, changed });
        } catch (e) {
            problems.push(`${book}：${e?.message || e}`);
        }
    }
    return { rows, problems };
}

/**
 * publish 段：把开着条目登记的单格图传到 COS，同名同内容（md5／分块 ETag）的跳过。图名带内容哈希，内容变了名字就变。
 * @param cos {listPrefixEtags(prefix) → Map, putObjectBuffer(key, buf, {contentType, cacheControl})}
 * @param blobs {get(sha256) → Buffer}  从 R2 取图（经 Worker 签名链接）；演练时不调用
 * @param proofPrefix 如 'proof/' 或 'staging/proof/'
 */
export async function publishPendings({ cos, entries, proofPrefix, dryRun = false, blobs = null, only = null }) {
    const picked = only ? entries.filter(only) : entries;
    // index.json：全站发布按全部条目生成；only 时只改选中那几章，别的章保持 COS 上现有的写法
    let indexBody = buildProofIndex(entries);
    if (only && cos?.getObjectText) {
        const oldText = await cos.getObjectText(proofPrefix + 'index.json');
        if (oldText) indexBody = mergeProofIndex(oldText, picked);
    }
    let remote = new Map();
    if (cos && !only) remote = await cos.listPrefixEtags(proofPrefix);
    else if (cos) {
        // 只列要动的几处，不列全站（全站几千张图，列一遍就要几十秒）
        for (const sub of ['index.json', ...picked.map((e) => `${e.book}/${e.chap}/`)]) {
            for (const [k, v] of await cos.listPrefixEtags(proofPrefix + sub)) remote.set(sub + k, v);
        }
    }
    const indexPlan = planCosPut([{ key: 'index.json', body: indexBody }], remote);
    const sprites = picked.flatMap((e) => (e.sprites || []).map((s) => ({ ...s, key: `${e.book}/${e.chap}/${s.name}` })));
    const spritePut = sprites.filter((s) => !spriteOnCos(remote.get(s.key), s));
    const spriteSame = sprites.filter((s) => spriteOnCos(remote.get(s.key), s));
    const failed = [];
    if (!dryRun && cos) {
        for (const sp of spritePut) {
            try {
                if (!blobs) throw new Error('没有取图的来源（blobs）');
                const buf = await blobs.get(sp.sha256);
                if (buf.length !== sp.bytes || sha256Hex(buf) !== sp.sha256 || md5Hex(buf) !== sp.md5) throw new Error('从 R2 取回的图与条目里登记的 sha256／md5／字节数不符');
                await cos.putObjectBuffer(proofPrefix + sp.key, buf, { contentType: 'image/webp', cacheControl: IMMUTABLE_CACHE });
            } catch (e) {
                failed.push(`${sp.key}：${e?.message || e}`);
            }
        }
    }
    // index.json 最后传：先传图、后换 index，中途不会指向还没传的图；有图没传上就不换
    const putKeys = spritePut.map((s) => s.key);
    const sameKeys = spriteSame.map((s) => s.key);
    if (indexPlan.same.length) sameKeys.push('index.json');
    if (indexPlan.put.length) {
        putKeys.push('index.json');
        if (!dryRun && cos) {
            if (failed.length) failed.push('index.json：前面有失败，本次不换');
            else {
                try {
                    await cos.putObjectText(proofPrefix + 'index.json', indexBody, { contentType: 'application/json; charset=utf-8', cacheControl: SHORT_CACHE });
                } catch (e) { failed.push(`index.json：${e?.message || e}`); }
            }
        }
    }
    return {
        put: putKeys, same: sameKeys, failed,
        spritesPut: spritePut.map((s) => s.key), spritesSame: spriteSame.map((s) => s.key),
    };
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
    L.push(`待审条目 ${entries.length} 章，开着的条目合计 ${entries.reduce((s, e) => s + e.n, 0)}`);
    for (const p of collectProblems) L.push(`- ⚠️ ${p}`);
    if (opinions) {
        L.push('', '#### 意见 → 中心库', '| 书 | KV 现有 | 快照合计 | 新增 | 改票 | 仅快照有 | 写入 |', '|---|---|---|---|---|---|---|');
        for (const r of opinions.rows) L.push(`| ${r.book} | ${r.kv} | ${r.total} | ${r.added} | ${r.updated} | ${r.kept} | ${r.written ? '是' : r.changed ? '演练' : '无变化'} |`);
        for (const p of opinions.problems) L.push(`- ❌ ${p}`);
    }
    if (publish) {
        L.push('', `#### 待审单 → COS \`${proofPrefix}\``, `上传 ${publish.put.length} · 相同跳过 ${publish.same.length} · 失败 ${publish.failed.length}`
            + (publish.spritesPut.length + publish.spritesSame.length ? ` · 雪碧图 上传 ${publish.spritesPut.length}／已有 ${publish.spritesSame.length}` : ''));
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
