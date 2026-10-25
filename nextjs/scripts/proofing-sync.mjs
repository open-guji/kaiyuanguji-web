#!/usr/bin/env node
/**
 * proofing-sync.mjs — 待审单与公众意见的每日同步（ai-team `team/整理/设计/待审单与公众意见走中心库.md` 块 C）
 *
 *   opinions：中心库待审单的 (书, rev) → 网站 /api/cellreview 管理读 → 中心库 feedback/lists/web/<书>/<rev>.jsonl
 *             另：/api/charfix 管理读（改字、一段有问题、专名意见）→ 中心库 feedback/lists/web/<书>/fixes.jsonl（GUJI-597）
 *                 /api/thread 管理读（同意／有不同看法、回复）→ 中心库 feedback/lists/web/<书>/threads.jsonl
 *             站方要撤下的条目写进中心库 feedback/lists/web/<书>/hidden.txt（一行一个 id），公开清单不出
 *             状态回写（M11 B2）：中心库 feedback/lists/web/<书>/status.jsonl（cv 意见池的处理结论）→ 与 KV 现状比 → POST /api/fixes
 *   publish ：中心库待审单 → COS [前缀/]proof/index.json、proof/<书>/<章>.pending.json
 *             待审单带 sprites[]（GUJI-675）的，先把 R2 里的雪碧图经 Worker 签名链接取回，传到 proof/<书>/<章>/<name>
 *             另：中心库 fixes.jsonl → COS [前缀/]proof/fixes/<书>.json（整册反馈页读的公开清单）
 * 流程与纯函数在 lib/proofing-sync-run.mjs、lib/proofing-sync-plan.mjs（有单测）。
 *
 * 环境变量：
 *   PARTS=opinions|publish|all（默认 all）
 *   GUJI_DATA_URL（默认 https://data.open-guji.com）、GUJI_DATA_TOKEN（web 角色令牌，必填；Action 里用网站管理令牌 FEEDBACK_ADMIN_TOKEN）
 *   PROOF_WS（中心库工作区 id，逗号分隔，默认 siku-zongmu）
 *   opinions：SITE_BASE（默认正式站 SITE_ORIGIN；旧域名 www.kaiyuanguji.com 的 /api/* 在国内 404，GUJI-706）、FEEDBACK_ADMIN_TOKEN
 *   publish ：COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET、COS_REGION（默认 ap-shanghai）、COS_PATH_PREFIX（staging 演练）
 *   FIX_BOOKS（收改字意见的书，逗号分隔，默认 96mid1ogzk；快照写在 PROOF_WS 第一个工作区）
 *   REISSUE_OUT：opinions 段把「已投票格 ≥ 20%、该落票重出单」的 (书, rev) 逐行写进这个文件（工作流据此开提醒 issue，GUJI-688）
 *   ONLY：只发这几本书或这几章（`96mid1ogzk` 或 `96mid1ogzk/006`，逗号分隔）。opinions 只拉这几章的票，publish 只传这几章的单子和图
 *         （index.json 照全站重算）；改字意见、处理结论两项跳过（它们按书每日跑）。落票重出单后用，一两分钟上线
 *   DRY_RUN=1：只读不写（不 PUT 中心库、不传 COS；有 COS 密钥时仍 LIST 比对）
 */
import { appendFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPendings, onlyFilter, syncOpinions, publishPendings, syncStatus, syncFixes, publishFixes, summarize } from './lib/proofing-sync-run.mjs';
import { reissueHints } from './lib/proofing-sync-plan.mjs';
import { SITE_ORIGIN, DATA_ORIGIN } from '../../config/hosts.mjs';

const PARTS = process.env.PARTS || 'all';
const DATA_URL = (process.env.GUJI_DATA_URL || 'https://data.open-guji.com').replace(/\/+$/, '');
const DATA_TOKEN = process.env.GUJI_DATA_TOKEN || '';
const WS = (process.env.PROOF_WS || 'siku-zongmu').split(',').map((s) => s.trim()).filter(Boolean);
const FIX_BOOKS = (process.env.FIX_BOOKS || '96mid1ogzk').split(',').map((s) => s.trim()).filter(Boolean);
const SITE = (process.env.SITE_BASE || SITE_ORIGIN).replace(/\/+$/, '');
const ADMIN = process.env.FEEDBACK_ADMIN_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY = onlyFilter(process.env.ONLY);
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const PROOF_PREFIX = [PREFIX, 'proof'].filter(Boolean).join('/') + '/';

if (!['opinions', 'publish', 'all'].includes(PARTS)) { console.error('❌ PARTS 只能是 opinions／publish／all'); process.exit(1); }
if (!DATA_TOKEN) { console.error('❌ 缺 GUJI_DATA_TOKEN（中心库 web 角色令牌；Action 里就是 FEEDBACK_ADMIN_TOKEN）'); process.exit(1); }
const doOpinions = PARTS !== 'publish';
const doPublish = PARTS !== 'opinions';
if (doOpinions && !ADMIN) { console.error('❌ 缺 FEEDBACK_ADMIN_TOKEN'); process.exit(1); }

async function call(url, init = {}, { allow404 = false, tries = 3 } = {}) {
    let err;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
            if (allow404 && res.status === 404) return null;
            const body = await res.text();
            if (!res.ok) {
                const e = new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
                if (res.status < 500) throw Object.assign(e, { final: true });
                throw e;
            }
            return JSON.parse(body);
        } catch (e) {
            if (e.final) throw e;
            err = e;
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
    }
    throw err;
}

const auth = { Authorization: `Bearer ${DATA_TOKEN}` };
const q = (o) => new URLSearchParams({ branch: 'main', ...o }).toString();
const worker = {
    listFiles: (ws, prefix) => call(`${DATA_URL}/v1/files?${q({ ws, prefix })}`, { headers: auth }),
    getFile: async (ws, path) => {
        const r = await call(`${DATA_URL}/v1/files?${q({ ws, src_path: path })}`, { headers: auth }, { allow404: true });
        return r ? { text: r.text, sha256: r.sha256 } : null;
    },
    putFile: (ws, path, text, baseSha) => call(`${DATA_URL}/v1/files?${q({ ws, src_path: path })}`, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, base_sha: baseSha }),
    }),
};

/** R2 里按 sha256 存的雪碧图：先向 Worker 要签名链接（web 角色令牌），再直取。取不到抛错，由 publishPendings 记失败 */
const blobs = {
    async get(sha256) {
        const sig = await call(`${DATA_URL}/v1/assets/sign`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucket: 'main', op: 'get', sha256, ext: 'webp' }),
        });
        let err;
        for (let i = 0; i < 3; i++) {
            try {
                const res = await fetch(sig.url, { signal: AbortSignal.timeout(60_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return Buffer.from(await res.arrayBuffer());
            } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
        }
        throw err;
    },
};

const kv = {
    async listVotes(rev, book) {
        const items = [];
        let cursor = '';
        for (let page = 0; page < 1000; page++) {
            const p = new URLSearchParams({ rev, book, limit: '256' });
            if (cursor) p.set('cursor', cursor);
            const r = await call(`${SITE}/api/cellreview?${p}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
            items.push(...(r.items || []));
            if (!r.hasMore || !r.cursor) return items;
            cursor = r.cursor;
        }
        throw new Error('KV 翻页超过 1000 页');
    },
    async listThreads(book, kind) {
        const items = [];
        let cursor = '';
        for (let page = 0; page < 1000; page++) {
            const p = new URLSearchParams({ book, kind, limit: '256' });
            if (cursor) p.set('cursor', cursor);
            const r = await call(`${SITE}/api/thread?${p}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
            items.push(...(r.items || []));
            if (!r.hasMore || !r.cursor) return items;
            cursor = r.cursor;
        }
        throw new Error('KV 翻页超过 1000 页');
    },
    async listFixes(book, kind) {
        const items = [];
        let cursor = '';
        for (let page = 0; page < 1000; page++) {
            const p = new URLSearchParams({ book, kind, limit: '256' });
            if (cursor) p.set('cursor', cursor);
            const r = await call(`${SITE}/api/charfix?${p}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
            items.push(...(r.items || []));
            if (!r.hasMore || !r.cursor) return items;
            cursor = r.cursor;
        }
        throw new Error('KV 翻页超过 1000 页');
    },
};

const site = {
    liveFixes: (book, volume) => call(`${SITE}/api/fixes?${new URLSearchParams({ book, volume })}`),
    postFixes: (body) => call(`${SITE}/api/fixes`, {
        method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, { tries: 1 }), // POST 不重试：服务端已写成但回包丢了时，重试会多出一条整理组回复；没写成的次日再比、再发
};

let cosOps = null;
if (doPublish) {
    const haveKeys = !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET);
    if (!haveKeys && !DRY_RUN) { console.error('❌ 缺 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET'); process.exit(1); }
    if (haveKeys) {
        const { requireCosSdk, createCosOps } = await import('./lib/h1-sync-core.mjs');
        const COS = requireCosSdk();
        const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 60 * 1000 });
        cosOps = createCosOps({ cos, bucket: process.env.COS_BUCKET, region: process.env.COS_REGION || 'ap-shanghai' });
        // 二进制（雪碧图）：落临时文件，走 uploadOne（带签名类错误的重试，超 1 MB 自动分块）
        cosOps.putObjectBuffer = async (key, buf, { contentType, cacheControl }) => {
            const dir = mkdtempSync(join(tmpdir(), 'proof-sprite-'));
            try {
                const full = join(dir, 'blob');
                writeFileSync(full, buf);
                await cosOps.uploadOne({ full }, key, cacheControl, contentType);
            } finally { rmSync(dir, { recursive: true, force: true }); }
        };
    } else {
        console.log('· DRY_RUN 且没有 COS 密钥：按「COS 上全空」估计划');
    }
}

let collected;
try {
    collected = await collectPendings(worker, WS);
} catch (e) {
    console.log(`::error::读中心库待审单失败：${e?.message || e}`);
    process.exit(1);
}
const { entries, problems } = collected;
console.log(`· 待审单 ${entries.length} 章（工作区 ${WS.join('、')}）`);
if (ONLY) {
    const n = entries.filter(ONLY).length;
    console.log(`· 只发 ${process.env.ONLY}：${n} 章`);
    if (!n) { console.log(`::error::ONLY=${process.env.ONLY} 在中心库里一章都没有`); process.exit(1); }
}
const opinions = doOpinions ? await syncOpinions({ worker, kv, entries: ONLY ? entries.filter(ONLY) : entries, dryRun: DRY_RUN }) : null;
const publish = doPublish ? await publishPendings({ cos: cosOps, entries, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN, blobs, only: ONLY }) : null;
const status = doOpinions && !ONLY ? await syncStatus({ worker, site, ws: WS[0], books: FIX_BOOKS, dryRun: DRY_RUN }) : null;
const fixes = doOpinions && !ONLY ? await syncFixes({ worker, kv, ws: WS[0], books: FIX_BOOKS, dryRun: DRY_RUN }) : null;
const fixesPublish = doPublish && !ONLY ? await publishFixes({ worker, cos: cosOps, ws: WS[0], books: FIX_BOOKS, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN }) : null;

const reissue = opinions ? reissueHints(opinions.rows, entries) : [];
let md = summarize({ ws: WS, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN, entries, collectProblems: problems, opinions, publish, fixes, fixesPublish, status });
if (reissue.length) {
    md += ['', '#### 该落票、重出单了（线上单已有 ≥ 20% 的格投过票）', ...reissue.map((h) => `- ${h.book}／${h.rev}：${h.voted}／${h.n} 格（${h.pct}%）`), ''].join('\n');
    for (const h of reissue) console.log(`::notice::${h.book}/${h.rev} 已投 ${h.voted}/${h.n} 格（${h.pct}%），该落票重出单`);
}
if (process.env.REISSUE_OUT && opinions) writeFileSync(process.env.REISSUE_OUT, reissue.map((h) => `${h.book}/${h.rev}\t${h.voted}\t${h.n}\t${h.pct}\n`).join(''));
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
// 这次传了的文件逐行写成完整地址，给工作流下一步清 CDN 用：数据域名的节点不认源站 max-age=300（10-21 实测旧单缓存了 14 小时）
if (process.env.PURGE_URLS_OUT) {
    // 只发某几章（重出单）时，COS 上已有的图也清一遍：图可能先于单子上传、刚上传时被探测过，CDN 缓存了 403（10-25 vol11–13 实测 50 分钟没好）
    const sameSprites = ONLY ? (publish?.spritesSame || []) : [];
    const keys = DRY_RUN ? [] : [...(publish?.put || []), ...sameSprites, ...(fixesPublish?.put || [])];
    writeFileSync(process.env.PURGE_URLS_OUT, keys.map((k) => `${DATA_ORIGIN}/${PROOF_PREFIX}${k}\n`).join(''));
}
for (const p of problems) console.log(`::warning::${p}`);
const errors = [...(opinions?.problems || []), ...(publish?.failed || []), ...(status?.problems || []), ...(fixes?.problems || []), ...(fixesPublish?.failed || [])];
for (const e of errors) console.log(`::error::${e}`);
process.exit(errors.length ? 1 : 0);
