#!/usr/bin/env node
/**
 * 册号位数统一：把一部书在 D1 收件箱里按 <书>/<册> 挂的记录，册号换成新位数的写法（一次性，手动触发：
 * .github/workflows/vol-renumber.yml）。用户 11-27 定：册号位数＝全书总册数的位数（1–9 册一位、10–99 两位、100 起三位），
 * 凡比对册号一律按数值认。方案与键形见 ai-team domain/CV/交接/册号位数统一-迁移-2026-11-27.md。
 *
 * 动哪些（键里的册号 + 值里的 vol／volume／册号字段一并换）：
 *   pending   pd:<书>:<册>[~pN]          （值里 book、vol）
 *   charfix   cf:/cs:/ce:<书>:<册>:…     （值里 volume）
 *   thread    tv:/tm:<书>:<册>:…
 *   fixstate  fs:<书>:<册>:<target>
 * 不动：cellreview（键是 cr:i:<书>:<条目>:<投票人>，不含册号；值里 vol 单列在报告里，等 CV0 定要不要改；rev 前缀按用户约定不改写）。
 *
 * 规则：册号只有纯数字才换（数值不变，只改位数：`001`、`01` → width 位）；非数字册名（vol01、bxgb）原样，要改名走 --map 旧=新。
 * 新键上已有记录时：留时间较新的一条（ts 大者；pending 整单按 pd 主键判断）；旧键写完新键才删。
 *
 * 默认只读（dry_run）：打印清单（只输出计数和键，不输出正文）；--apply 才写。--backup <文件> 先把这本书相关的行原样存下来。
 * 用法：WEB_INBOX_TOKEN=… node ops/vol-renumber.mjs --book 99k3i35yww --width 1 [--map 旧=新 …] [--backup f.json] [--apply]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** kind → 键前缀（不含书）；值里册号字段名 */
export const KINDS = [
    { kind: 'pending', prefixes: ['pd'], fields: ['vol'] },
    { kind: 'charfix', prefixes: ['cf', 'cs', 'ce'], fields: ['volume'] },
    { kind: 'thread', prefixes: ['tv', 'tm'], fields: ['volume'] },
    { kind: 'fixstate', prefixes: ['fs'], fields: ['volume', 'vol'] },
];

/** 册号换写法：纯数字按数值补零到 width；--map 里列的按映射；其余原样 */
export function canonVol(vol, { width, map = {} }) {
    if (typeof vol !== 'string') return vol;
    if (Object.prototype.hasOwnProperty.call(map, vol)) return map[vol];
    if (/^[0-9]{1,6}$/.test(vol) && width) return String(Number(vol)).padStart(width, '0');
    return vol;
}

/** 键第 3 段（册号，pending 带可选 ~pN 分片后缀）换新写法；不是这本书的键返回 null；没变也返回（changed:false） */
export function rewriteKey(key, book, opt) {
    const parts = String(key).split(':');
    if (parts.length < 3 || parts[1] !== book) return null;
    const m = /^(.*?)(~p\d+)?$/.exec(parts[2]);
    const vol = canonVol(m[1], opt);
    parts[2] = vol + (m[2] || '');
    const newKey = parts.join(':');
    return { newKey, changed: newKey !== key };
}

export function rewriteValue(value, fields, opt) {
    if (!value || typeof value !== 'object') return value;
    const out = { ...value };
    for (const f of fields) if (typeof out[f] === 'string') out[f] = canonVol(out[f], opt);
    return out;
}

export function plan(rowsByKind, book, opt) {
    const moves = []; const same = [];
    for (const { kind, prefixes, fields } of KINDS) {
        const rows = rowsByKind[kind] || [];
        const byKey = new Map(rows.map((r) => [r.key, r]));
        for (const r of rows) {
            if (!prefixes.includes(String(r.key).split(':')[0])) continue;
            const rk = rewriteKey(r.key, book, opt);
            if (!rk) continue;
            const value = rewriteValue(r.value, fields, opt);
            const valueChanged = JSON.stringify(value) !== JSON.stringify(r.value);
            if (!rk.changed && !valueChanged) { same.push({ kind, key: r.key }); continue; }
            const clash = rk.changed ? byKey.get(rk.newKey) : null;
            const keepNew = !!clash && (clash.ts ?? 0) >= (r.ts ?? 0);   // 新键上已有更新的：留它，旧的只删
            moves.push({ kind, oldKey: r.key, newKey: rk.newKey, value, ts: r.ts, keyChanged: rk.changed, clash: !!clash, keepNew });
        }
    }
    return { moves, same };
}

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

export async function run({ book, width, map = {}, apply, backup, base, token, fetchImpl, log = console.log, save = (f, s) => writeFileSync(f, s) }) {
    if (!/^[0-9a-z]{4,24}$/.test(book || '')) throw new Error('--book 无效');
    if (!width && !Object.keys(map).length) throw new Error('要给 --width 或 --map');
    const c = client({ base, token, fetchImpl });
    const opt = { width, map };
    const rowsByKind = {}; const dump = {};
    for (const { kind, prefixes } of KINDS) {
        rowsByKind[kind] = [];
        for (const p of prefixes) rowsByKind[kind].push(...await c.readAll(kind, `${p}:${book}:`));
        dump[kind] = rowsByKind[kind];
    }
    const cr = await c.readAll('cellreview', `cr:i:${book}:`);
    dump.cellreview = cr;
    const crVols = {};
    for (const r of cr) { const v = r.value?.vol; if (v !== undefined) crVols[v] = (crVols[v] || 0) + 1; }
    const { moves, same } = plan(rowsByKind, book, opt);
    const n = (k) => moves.filter((m) => m.kind === k).length;
    log(`书 ${book}，目标位数 ${width ?? '（只按 --map）'}${Object.keys(map).length ? `，映射 ${JSON.stringify(map)}` : ''}`);
    for (const { kind } of KINDS) log(`${kind}：共 ${rowsByKind[kind].length} 行，要改 ${n(kind)}，已是新写法 ${same.filter((s) => s.kind === kind).length}`);
    log(`其中新键上已有记录 ${moves.filter((m) => m.clash).length}（留较新的一条）`);
    log(`cellreview（不动）：共 ${cr.length} 行，值里 vol 分布 ${JSON.stringify(crVols)}`);
    for (const m of moves.slice(0, 40)) log(`  ${m.kind} ${m.oldKey} → ${m.newKey}${m.keepNew ? '（新键已有更新的，只删旧）' : ''}`);
    if (moves.length > 40) log(`  …另有 ${moves.length - 40} 条`);
    if (backup) { save(backup, JSON.stringify({ book, at: new Date().toISOString(), rows: dump })); log(`已备份 ${Object.values(dump).reduce((a, b) => a + b.length, 0)} 行到 ${backup}`); }
    if (!apply) { log('dry_run：未写任何数据。确认无误后用 --apply。'); return { applied: false, moves }; }
    let wrote = 0; let removed = 0; const leftover = [];
    for (const m of moves) {
        if (!m.keepNew) { await c.write([{ kind: m.kind, key: m.newKey, value: m.value, ts: m.ts }]); wrote += 1; }
        if (m.keyChanged) { if (await c.del(m.kind, m.oldKey)) removed += 1; else leftover.push(`${m.kind} ${m.oldKey}`); }
    }
    log(`已写 ${wrote}，删旧键 ${removed}${leftover.length ? `，删不掉 ${leftover.length}：\n${leftover.join('\n')}` : ''}`);
    return { applied: true, moves, leftover };
}

function parseArgs(argv) {
    const o = { map: {} };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--apply') o.apply = true;
        else if (a === '--book') o.book = argv[++i];
        else if (a === '--width') o.width = Number(argv[++i]);
        else if (a === '--backup') o.backup = argv[++i];
        else if (a === '--map') { const [k, v] = String(argv[++i]).split('='); o.map[k] = v; }
    }
    return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const token = process.env.WEB_INBOX_TOKEN || process.env.FEEDBACK_ADMIN_TOKEN;
    if (!token) { console.error('没有令牌（WEB_INBOX_TOKEN）'); process.exit(1); }
    const base = (process.env.WEB_INBOX_URL || 'https://data.open-guji.com').replace(/\/+$/, '');
    try { await run({ ...parseArgs(process.argv.slice(2)), base, token }); } catch (e) { console.error(`❌ ${e.message}`); process.exitCode = 1; }
}
