#!/usr/bin/env node
/**
 * 会员号回填与旧 UUID 票迁移（一次性，手动触发：.github/workflows/member-code-backfill.yml）。
 *
 * 背景：11-27 会员 ID 由 UUIDv7 改成 8 位会员号（docs/membership.md）。现在会员只有几个，直接做完：
 *   1. 给还没有会员号的会员发号（同时写索引 membercode:<号>），已有号的不动；
 *   2. 把 voter 是 UUID 的精校票／改字／讨论迁成会员号：写新键（键里的 UUID 换成号）＋值里 voter 换成号，再删旧键；
 *      新键上已有票（会员改号后又投过）时保留较新的一条；cellreview 的 Worker 不许删，旧键留给整理侧清（只列号，不列邮箱）；
 *   3. 反馈记录里 member 是 UUID 的，改成会员号。
 *
 * 默认 dry_run：只读，打印将做什么；--apply 才写。公开仓的日志谁都能看，所以只输出计数和会员号，
 * 绝不输出邮箱、昵称、正文；邮箱与号的对应只存在于库里。
 *
 * 用法：WEB_INBOX_TOKEN=... node ops/member-code-backfill.mjs [--apply]   （WEB_INBOX_URL 默认 https://data.open-guji.com）
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { newMemberCode, normalizeMemberCode } from '../edge-functions/api/feedback.js';

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;
const VOTE_KINDS = ['cellreview', 'charfix', 'thread'];

/** 键里的 UUID 换成会员号；键里没有 UUID 返回 null */
export function swapKeyVoter(key, uid, code) {
    return String(key).includes(uid) ? String(key).split(uid).join(code) : null;
}

/** 由成员行得出：已有号的、需要发号的、uid→号。rows 是 [{key,value:{s}}]；已删除墓碑跳过。 */
export function planMembers(rows, takenCodes, gen = newMemberCode) {
    const taken = new Set(takenCodes);
    const out = { keep: 0, issue: [], uidToCode: new Map(), skipped: 0 };
    for (const r of rows) {
        let m;
        try { m = JSON.parse(r.value?.s ?? ''); } catch { out.skipped += 1; continue; }
        if (!m || typeof m !== 'object' || m._deleted) { out.skipped += 1; continue; }
        let code = m.code;
        if (normalizeMemberCode(code) === code) {
            out.keep += 1;
            taken.add(code);
        } else {
            code = '';
            for (let i = 0; i < 20 && !code; i += 1) { const c = gen(); if (!taken.has(c)) code = c; }
            if (!code) throw new Error('发号 20 次都撞，停');
            taken.add(code);
            out.issue.push({ key: r.key, rec: { ...m, code }, code });
        }
        if (typeof m.uid === 'string' && UUID_RE.test(m.uid)) out.uidToCode.set(m.uid, code);
    }
    return out;
}

/** 票行：voter 是 UUID 且能映射到号的，给出迁移动作；映射不到的列在 unmapped（只记 uuid 前 8 位，不含邮箱） */
export function planVotes(kind, rows, uidToCode) {
    const moves = []; const unmapped = [];
    for (const r of rows) {
        const voter = r.value?.voter;
        if (typeof voter !== 'string' || !UUID_RE.test(voter) || voter.length !== 36) continue;
        const code = uidToCode.get(voter);
        if (!code) { unmapped.push(voter.slice(0, 8)); continue; }
        const newKey = swapKeyVoter(r.key, voter, code);
        if (!newKey) { unmapped.push(voter.slice(0, 8)); continue; }
        moves.push({ kind, oldKey: r.key, newKey, code, value: { ...r.value, voter: code }, ts: r.ts });
    }
    return { moves, unmapped };
}

/** 反馈行：member 是 UUID 的改成号 */
export function planFeedback(rows, uidToCode) {
    const edits = []; const unmapped = [];
    for (const r of rows) {
        let rec;
        try { rec = JSON.parse(r.value?.s ?? ''); } catch { continue; }
        if (!rec || typeof rec.member !== 'string' || !UUID_RE.test(rec.member)) continue;
        const code = uidToCode.get(rec.member);
        if (!code) { unmapped.push(rec.member.slice(0, 8)); continue; }
        edits.push({ key: r.key, value: { ...r.value, s: JSON.stringify({ ...rec, member: code }) }, code });
    }
    return { edits, unmapped };
}

// ---------- 与 Worker 对话 ----------
function client({ base, token, fetchImpl = fetch }) {
    const H = { Authorization: `Bearer ${token}` };
    return {
        async readAll(kind, prefix = '') {
            const out = []; let after = 0;
            for (let p = 0; p < 2000; p += 1) {
                const q = new URLSearchParams({ kind, limit: '500', after: String(after) });
                if (prefix) q.set('prefix', prefix);
                const res = await fetchImpl(`${base}/v1/web/inbox?${q}`, { headers: H });
                if (!res.ok) throw new Error(`读 ${kind} HTTP ${res.status}`);
                const page = await res.json();
                out.push(...(page.items || []));
                if (!page.hasMore) return out;
                after = page.next;
            }
            throw new Error(`读 ${kind} 超过页数上限`);
        },
        async write(items) {
            const res = await fetchImpl(`${base}/v1/web/inbox`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
            if (!res.ok) throw new Error(`写入 HTTP ${res.status}`);
        },
        async del(kind, key) {
            const res = await fetchImpl(`${base}/v1/web/inbox?${new URLSearchParams({ kind, key })}`, { method: 'DELETE', headers: H });
            return res.ok;
        },
    };
}

export async function run({ apply, base, token, fetchImpl, log = console.log }) {
    const c = client({ base, token, fetchImpl });
    const memberRows = await c.readAll('kv', 'member:');
    const taken = (await c.readAll('kv', 'membercode:')).map((r) => r.key.slice('membercode:'.length));
    const mp = planMembers(memberRows, taken);
    log(`会员：已有号 ${mp.keep}，需发号 ${mp.issue.length}，跳过（墓碑／坏记录）${mp.skipped}`);
    log(`有 UUID 旧别名的会员：${mp.uidToCode.size}`);

    const votePlans = [];
    for (const kind of VOTE_KINDS) {
        const rows = await c.readAll(kind);
        const byKey = new Map(rows.map((r) => [r.key, r]));
        const vp = planVotes(kind, rows, mp.uidToCode);
        votePlans.push({ kind, ...vp, byKey });
        log(`${kind}：共 ${rows.length} 条，UUID 票待迁 ${vp.moves.length}，映射不到 ${vp.unmapped.length}${vp.unmapped.length ? `（uuid 前 8 位：${[...new Set(vp.unmapped)].join(',')}）` : ''}`);
    }
    const fbRows = await c.readAll('kv', 'fb_');
    const fp = planFeedback(fbRows, mp.uidToCode);
    log(`反馈：共 ${fbRows.length} 条，member 是 UUID 待改 ${fp.edits.length}，映射不到 ${fp.unmapped.length}`);

    if (!apply) { log('dry_run：未写任何数据。确认无误后用 --apply。'); return { applied: false, mp, votePlans, fp }; }

    // 1. 发号：先写索引再写成员记录（索引多一条无害，反过来会出现没占位的号）
    for (const it of mp.issue) {
        await c.write([{ kind: 'kv', key: `membercode:${it.code}`, value: { s: memberEmailFromKey(it.key) } }]);
        await c.write([{ kind: 'kv', key: it.key, value: { s: JSON.stringify(it.rec) } }]);
    }
    log(`已发号 ${mp.issue.length} 个`);

    // 2. 迁票
    const leftover = [];
    for (const vp of votePlans) {
        let moved = 0; let kept = 0;
        for (const m of vp.moves) {
            const existing = vp.byKey.get(m.newKey);
            if (existing && (existing.ts ?? 0) >= (m.ts ?? 0)) kept += 1; // 新键上已有更新的票，保留它
            else { await c.write([{ kind: m.kind, key: m.newKey, value: m.value, ts: m.ts }]); moved += 1; }
            const deleted = await c.del(m.kind, m.oldKey);
            if (!deleted) leftover.push(`${m.kind} ${m.oldKey.replace(/^.*?:/, '…:')}`);
        }
        log(`${vp.kind}：已迁 ${moved}，新键上已有更新票保留 ${kept}`);
    }
    if (leftover.length) log(`旧键删不掉（Worker 不许删该类），请整理侧清理 ${leftover.length} 条：\n${leftover.join('\n')}`);

    // 3. 反馈
    for (const e of fp.edits) await c.write([{ kind: 'kv', key: e.key, value: e.value }]);
    log(`反馈已改 ${fp.edits.length} 条`);
    return { applied: true, mp, votePlans, fp, leftover };
}

/** 成员行的键 member:<编码邮箱> → 邮箱（kvDec：~xxxx~ 还原） */
export function memberEmailFromKey(key) {
    return String(key).slice('member:'.length).replace(/~([0-9a-f]{4})~/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const token = process.env.WEB_INBOX_TOKEN || process.env.FEEDBACK_ADMIN_TOKEN;
    if (!token) { console.error('没有令牌（WEB_INBOX_TOKEN）'); process.exit(1); }
    const base = (process.env.WEB_INBOX_URL || 'https://data.open-guji.com').replace(/\/+$/, '');
    const lines = [];
    const log = (s) => { console.log(s); lines.push(s); };
    try {
        await run({ apply: process.argv.includes('--apply'), base, token, log });
    } catch (e) {
        log(`❌ ${e.message}`);
        process.exitCode = 1;
    } finally {
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
    }
}
