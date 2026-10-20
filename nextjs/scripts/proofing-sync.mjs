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
 *   DRY_RUN=1：只读不写（不 PUT 中心库、不传 COS；有 COS 密钥时仍 LIST 比对）
 */
import { appendFileSync } from 'node:fs';
import { collectPendings, syncOpinions, publishPendings, syncStatus, syncFixes, publishFixes, summarize } from './lib/proofing-sync-run.mjs';
import { SITE_ORIGIN } from '../../config/hosts.mjs';

const PARTS = process.env.PARTS || 'all';
const DATA_URL = (process.env.GUJI_DATA_URL || 'https://data.open-guji.com').replace(/\/+$/, '');
const DATA_TOKEN = process.env.GUJI_DATA_TOKEN || '';
const WS = (process.env.PROOF_WS || 'siku-zongmu').split(',').map((s) => s.trim()).filter(Boolean);
const FIX_BOOKS = (process.env.FIX_BOOKS || '96mid1ogzk').split(',').map((s) => s.trim()).filter(Boolean);
const SITE = (process.env.SITE_BASE || SITE_ORIGIN).replace(/\/+$/, '');
const ADMIN = process.env.FEEDBACK_ADMIN_TOKEN || '';
const DRY_RUN = process.env.DRY_RUN === '1';
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
const opinions = doOpinions ? await syncOpinions({ worker, kv, entries, dryRun: DRY_RUN }) : null;
const publish = doPublish ? await publishPendings({ cos: cosOps, entries, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN }) : null;
const status = doOpinions ? await syncStatus({ worker, site, ws: WS[0], books: FIX_BOOKS, dryRun: DRY_RUN }) : null;
const fixes = doOpinions ? await syncFixes({ worker, kv, ws: WS[0], books: FIX_BOOKS, dryRun: DRY_RUN }) : null;
const fixesPublish = doPublish ? await publishFixes({ worker, cos: cosOps, ws: WS[0], books: FIX_BOOKS, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN }) : null;

const md = summarize({ ws: WS, proofPrefix: PROOF_PREFIX, dryRun: DRY_RUN, entries, collectProblems: problems, opinions, publish, fixes, fixesPublish, status });
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
for (const p of problems) console.log(`::warning::${p}`);
const errors = [...(opinions?.problems || []), ...(publish?.failed || []), ...(status?.problems || []), ...(fixes?.problems || []), ...(fixesPublish?.failed || [])];
for (const e of errors) console.log(`::error::${e}`);
process.exit(errors.length ? 1 : 0);
