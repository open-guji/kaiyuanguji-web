#!/usr/bin/env node
/**
 * 反馈「删除」与隐藏清单（overview#337 C2）。由 .github/workflows/feedback-hide.yml 手动触发，也可本地跑。
 *
 * feedback.js 没有硬删除接口，「删除」按标记处理：action:'update' 写 test=true＋visibility=hidden。
 * 公开读即剔除这条，KV 里原文留档，要恢复再 update 回来即可。
 *
 * 两种模式：
 *   hide         对 --ids 里的每条：先用管理读查到现状并打印，dry_run（默认）到此为止；
 *                --apply 才真写。id 不在库里、格式不对的一律跳过并记为失败，不会写。
 *   list_hidden  用管理读列出公开读看不到的那部分（test=true／visibility=hidden／「想参与」类），只读不改。
 *
 * 隐私：本仓是公开仓，Actions 日志与 Step Summary 谁都能看。所以
 *   - 公开读本来就看得到的条目（hide 模式里将被隐藏的那些），只打 id、时间、类型、状态、标记、来源页和正文前 40 字，
 *     正文先过 feedback.js 自己的 desensitizeText（邮箱／手机／QQ微信号／身份证号打码）；
 *   - 公开读本来就看不到的（test／hidden／「想参与」类，list_hidden 列的全是这种），正文一个字都不出，只给字数；
 *   - contact 字段（读者留的联系方式）与 updatedBy 任何情况下都不输出。
 *
 * 用法：
 *   FEEDBACK_ADMIN_TOKEN=... node ops/feedback-hide.mjs hide --ids fb_1_a,fb_2_b [--apply]
 *   FEEDBACK_ADMIN_TOKEN=... node ops/feedback-hide.mjs list_hidden
 * 环境变量 FEEDBACK_BASE 改目标站（默认正式站）。
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// 直接复用线上同一份脱敏规则，不另抄一份免得两边漂移。feedback.js 是 ESM 写法但仓库没有 "type": "module"，
// 要 Node ≥22（默认按语法认出 ESM）才能这样引；工作流里固定用 Node 22。
import { desensitizeText } from '../edge-functions/api/feedback.js';

export const DEFAULT_BASE = 'https://www.openguji.com';
const ID_RE = /^fb_\d+_[a-z0-9]+$/;
const SNIPPET_LEN = 40;

/** 逗号／空白分隔的 id 串 → 去重后的数组；格式不对的单独列出 */
export function parseIds(raw) {
    const all = [...new Set(String(raw ?? '').split(/[\s,，]+/).filter(Boolean))];
    return { ids: all.filter((x) => ID_RE.test(x)), invalid: all.filter((x) => !ID_RE.test(x)) };
}

/** 与 feedback.js 的 isPubliclyVisible 互为反面：公开读看不到的那部分 */
export function isHidden(rec) {
    return rec.visibility === 'hidden' || rec.test === true || rec.type === 'contact';
}

/** 一行摘要：只取可公开的字段，正文脱敏后截断；contact、updatedBy 不出现 */
export function summarize(rec) {
    const raw = String(rec.content ?? '');
    const text = desensitizeText(raw).replace(/\s+/g, ' ').trim();
    const flags = [rec.test === true && 'test', rec.visibility === 'hidden' && 'hidden'].filter(Boolean).join('+') || '—';
    return {
        id: rec.id,
        createdAt: String(rec.createdAt ?? '').slice(0, 16).replace('T', ' '),
        type: rec.type ?? '',
        status: rec.status ?? '',
        flags,
        page: String(rec.pageUrl ?? '').replace(/^https?:\/\/[^/]+/, '').slice(0, 60) || '—',
        // 已不公开的条目正文不出（公开仓的日志谁都能看），只给字数
        snippet: isHidden(rec) ? `（不公开，正文 ${[...raw].length} 字不输出）`
            : text.length > SNIPPET_LEN ? `${text.slice(0, SNIPPET_LEN)}…` : text,
    };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/`/g, "'");

export function renderTable(recs) {
    const rows = recs.map(summarize).map((r) =>
        `| ${r.id} | ${r.createdAt} | ${r.type} | ${r.status} | ${r.flags} | ${cell(r.page)} | ${cell(r.snippet)} |`);
    return ['| id | 时间（UTC） | 类型 | 状态 | 标记 | 来源页 | 正文（公开条目取前 40 字并脱敏；不公开的不输出） |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

/** 管理读，翻完所有页 */
export async function listAll({ base, token, fetchImpl = fetch }) {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 100; page++) {
        const url = `${base}/api/feedback?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(`管理读失败：HTTP ${res.status} ${data.error ?? ''}`.trim());
        out.push(...(data.items ?? []));
        if (!data.hasMore || !data.cursor) return out;
        cursor = data.cursor;
    }
    throw new Error('管理读翻页超过 100 页，停下');
}

export async function hide({ base, token, ids, apply, fetchImpl = fetch, log = console.log }) {
    const byId = new Map((await listAll({ base, token, fetchImpl })).map((r) => [r.id, r]));
    const result = { planned: [], done: [], skipped: [], failed: [] };
    for (const id of ids) {
        const rec = byId.get(id);
        if (!rec) {
            result.failed.push({ id, reason: '库里没有这条' });
            continue;
        }
        if (rec.test === true && rec.visibility === 'hidden') {
            result.skipped.push({ id, reason: '已是 test＋hidden' });
            continue;
        }
        result.planned.push(rec);
        if (!apply) continue;
        const res = await fetchImpl(`${base}/api/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'update', token, id, test: true, visibility: 'hidden' }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) result.done.push(id);
        else result.failed.push({ id, reason: `HTTP ${res.status} ${data.error ?? ''}`.trim() });
    }
    log(`${apply ? '真跑' : 'dry_run（不写）'}：计划改 ${result.planned.length} 条，已改 ${result.done.length}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`);
    return result;
}

function summary(md) {
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n\n`);
}

async function main(argv) {
    const [mode, ...rest] = argv;
    const flag = (name) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    const token = process.env.FEEDBACK_ADMIN_TOKEN;
    const base = (process.env.FEEDBACK_BASE || DEFAULT_BASE).replace(/\/$/, '');
    if (!token) throw new Error('缺 FEEDBACK_ADMIN_TOKEN');

    if (mode === 'list_hidden') {
        const hidden = (await listAll({ base, token })).filter(isHidden);
        summary(`### 公开读看不到的反馈（${hidden.length} 条，只读）\n\n${renderTable(hidden)}`);
        return 0;
    }
    if (mode === 'hide') {
        const { ids, invalid } = parseIds(flag('--ids'));
        if (invalid.length) throw new Error(`id 格式不对：${invalid.join(', ')}`);
        if (!ids.length) throw new Error('没有给 --ids');
        const apply = rest.includes('--apply');
        const r = await hide({ base, token, ids, apply });
        const lines = [
            `### 反馈隐藏：${apply ? '真跑' : 'dry_run，未写'}`,
            '',
            `将改为 test=true＋visibility=hidden 的（${r.planned.length} 条，下面是改之前的状态）：`,
            '',
            renderTable(r.planned),
        ];
        if (apply) lines.push('', `已改：${r.done.join(', ') || '无'}`);
        if (r.skipped.length) lines.push('', `跳过：${r.skipped.map((x) => `${x.id}（${x.reason}）`).join('；')}`);
        if (r.failed.length) lines.push('', `失败：${r.failed.map((x) => `${x.id}（${x.reason}）`).join('；')}`);
        summary(lines.join('\n'));
        return r.failed.length ? 1 : 0;
    }
    throw new Error(`未知模式 ${mode}（hide｜list_hidden）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (e) => {
            console.error(`❌ ${e.message}`);
            process.exit(1);
        },
    );
}
