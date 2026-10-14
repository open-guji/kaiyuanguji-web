/**
 * verify-merge-redirects.mjs — 只读：合并墓碑的 308 跳转 ＋ keeper 的 Work 页版本数（GUJI-146）。
 *
 * 做两件事（只发 GET，无任何写操作）：
 *  (1) 对每个墓碑 id 请求 <站点>/item/<id>（redirect:manual），要求状态 308 且 Location 指向 keeper（墓碑文件里的 merged_into）。
 *  (2) 对 keeper 对应的 Work 页（keeper 是 Work 就是它自己；是 Book 就取它的 work_id），
 *      从页面读版本数，与预期比：预期＝book-index 里 work_id 指向该 Work、且自己不是墓碑的 Book 数。
 *      页面版本数取两处并交叉：正文「本站收錄其版本 N 種」（缺省视为 0）和 JSON-LD workExample 里 Book 的个数。
 *
 * 用法：
 *   node scripts/verify-merge-redirects.mjs --site https://www.openguji.com --book-index /path/to/book-index \
 *        [--type work|book] [--limit 10] [--ids-file ids.txt] [--concurrency 4] [--json out.json]
 *   墓碑来源：--ids-file（每行一个 id，# 起首为注释）优先；否则扫 book-index 里 --type 类型带 merged_into 的条目。
 *   换成 book-index#274 的 Book 墓碑清单：--type book --ids-file <清单> 即可，不改代码。
 * 退出码：0 全部通过；1 有不一致；2 参数错。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 描述长度达到这个数就当作被站点截断（实测截断后 150～160 字，有句子的最长 113 字） */
const DESC_CAP_GUESS = 140;
const ID_RE = /^[0-9a-z]{10,13}$/;

/** 扫 book-index，返回 {tomb: Map(id→{id,type,merged_into,work_id}), booksByWork: Map(work_id→非墓碑 Book 数), entries: Map(id→{type,work_id,merged_into})} */
export function loadIndex(root) {
    const entries = new Map();
    const booksByWork = new Map();
    for (const top of ['Work', 'Book']) {
        const base = join(root, top);
        if (!existsSync(base)) continue;
        for (const a of readdirSync(base)) for (const b of readdirSync(join(base, a))) for (const c of readdirSync(join(base, a, b))) {
            const dir = join(base, a, b, c);
            for (const f of readdirSync(dir)) {
                if (!f.endsWith('.json')) continue;
                let e;
                try { e = JSON.parse(readFileSync(join(dir, f), 'utf-8')); } catch { continue; }
                if (!e || !e.id) continue;
                const mi = typeof e.merged_into === 'string' ? e.merged_into : (e.merged_into && e.merged_into.id) || null;
                entries.set(e.id, { id: e.id, type: e.type, work_id: e.work_id || null, merged_into: mi });
                if (e.type === 'book' && !mi && e.work_id) booksByWork.set(e.work_id, (booksByWork.get(e.work_id) || 0) + 1);
            }
        }
    }
    return { entries, booksByWork };
}

/** 墓碑清单：ids 给定则按 ids（必须在索引里且带 merged_into，否则报错项），否则按 type 扫 */
export function pickTombstones(index, { type, ids, limit }) {
    const out = []; const problems = [];
    if (ids) {
        for (const id of ids) {
            const e = index.entries.get(id);
            if (!e) problems.push({ id, error: '索引里没有该 id' });
            else if (!e.merged_into) problems.push({ id, error: '不是墓碑（无 merged_into）' });
            else out.push(e);
        }
    } else {
        for (const e of index.entries.values()) if (e.type === type && e.merged_into) out.push(e);
        out.sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    return { tombs: limit ? out.slice(0, limit) : out, problems };
}

/** keeper 对应要核对版本数的 Work id；keeper 自己也是墓碑或索引里没有时返回 null＋原因 */
export function workPageFor(index, keeperId) {
    const k = index.entries.get(keeperId);
    if (!k) return { error: 'keeper 不在索引里' };
    if (k.merged_into) return { error: `keeper 自己也是墓碑（→ ${k.merged_into}）` };
    if (k.type === 'work') return { workId: k.id };
    if (k.type === 'book') return k.work_id ? { workId: k.work_id } : { error: 'keeper Book 没有 work_id' };
    return { error: `keeper 类型 ${k.type} 无版本数` };
}

/**
 * 从 Work 页 HTML 读版本数：JSON-LD workExample 里 Book 个数（可靠），与描述句「本站收錄其版本 N 種」交叉。
 * 描述句在简介很长时会被站点截断（以「…」结尾或停在 150 字上下，实测 d59f2hqmmeio、d59f28k96d4z）而读不到——此时 text 为 null，不参与比对；
 * 没有该句也没被截断＝0 个版本。
 */
export function parseVersionCount(html) {
    const m = html.match(/本站收[錄录]其版本\s*(\d+)\s*[種种]/);
    const d = html.match(/<meta name="description" content="([^"]*)"/);
    const text = m ? Number(m[1]) : (d && (d[1].endsWith('…') || d[1].length >= DESC_CAP_GUESS) ? null : 0);
    const w = html.match(/"workExample":\[(.*?)\]/);
    const ld = w ? (w[1].match(/"@type":"Book"/g) || []).length : 0;
    return { text, ld };
}

/** Location 是否指向 keeper（接受相对或绝对，路径必须恰为 /item/<keeper>，允许末尾斜杠） */
export function locationIsKeeper(location, keeperId) {
    if (!location) return false;
    let p = location;
    try { p = new URL(location, 'https://x.invalid').pathname; } catch { return false; }
    return p.replace(/\/$/, '') === `/item/${keeperId}`;
}

async function pool(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

async function get(url, timeoutMs = 30_000) {
    return fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
}

export async function checkRedirect(site, t) {
    const first = await checkRedirectOnce(site, t);
    if (first.ok) return first;
    const second = await checkRedirectOnce(site, t);   // 冷缓存首次未命中时可能出双 Location（overview#491），再问一次区分
    return { ...first, retryOk: second.ok, retryLocation: second.location };
}

async function checkRedirectOnce(site, t) {
    try {
        const res = await get(`${site}/item/${t.id}`);
        const loc = res.headers.get('location');
        const ok = res.status === 308 && locationIsKeeper(loc, t.merged_into);
        return { id: t.id, keeper: t.merged_into, status: res.status, location: loc, reason: res.headers.get('x-kyg-item-redirect') || '', ok };
    } catch (err) {
        return { id: t.id, keeper: t.merged_into, status: 0, location: null, ok: false, error: err.message };
    }
}

export async function checkWorkPage(site, workId, expected) {
    try {
        const res = await get(`${site}/item/${workId}`);
        if (res.status !== 200) return { workId, expected, status: res.status, ok: false, error: `状态 ${res.status}` };
        const { text, ld } = parseVersionCount(await res.text());
        return { workId, expected, status: 200, pageText: text, pageJsonLd: ld, ok: ld === expected && (text === null || text === expected) };
    } catch (err) {
        return { workId, expected, status: 0, ok: false, error: err.message };
    }
}

function parseArgs(argv) {
    const a = { type: 'work', concurrency: 4 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--site') a.site = argv[++i].replace(/\/$/, '');
        else if (k === '--book-index') a.bookIndex = argv[++i];
        else if (k === '--type') a.type = argv[++i];
        else if (k === '--limit') a.limit = Number(argv[++i]);
        else if (k === '--ids-file') a.idsFile = argv[++i];
        else if (k === '--concurrency') a.concurrency = Number(argv[++i]);
        else if (k === '--json') a.json = argv[++i];
        else throw new Error(`未知参数 ${k}`);
    }
    if (!a.site || !a.bookIndex) throw new Error('必须给 --site 和 --book-index');
    if (!['work', 'book'].includes(a.type)) throw new Error('--type 只能是 work 或 book');
    return a;
}

export async function main(argv) {
    let a;
    try { a = parseArgs(argv); } catch (e) { console.error(`参数错：${e.message}`); return 2; }
    const ids = a.idsFile
        ? readFileSync(a.idsFile, 'utf-8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter((s) => ID_RE.test(s))
        : null;
    const index = loadIndex(a.bookIndex);
    const { tombs, problems } = pickTombstones(index, { type: a.type, ids, limit: a.limit });
    console.log(`站点 ${a.site}；索引 ${index.entries.size} 条；墓碑 ${tombs.length} 个；输入问题 ${problems.length} 个`);

    const redirects = await pool(tombs, a.concurrency, (t) => checkRedirect(a.site, t));
    const pages = new Map(); const pageErrors = [];
    for (const t of tombs) {
        const w = workPageFor(index, t.merged_into);
        if (w.error) { pageErrors.push({ id: t.id, keeper: t.merged_into, error: w.error }); continue; }
        pages.set(w.workId, index.booksByWork.get(w.workId) || 0);
    }
    const pageResults = await pool([...pages], a.concurrency, ([workId, exp]) => checkWorkPage(a.site, workId, exp));

    console.log('\n## 308 跳转');
    for (const r of redirects) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.id} → ${r.status} ${r.location ?? ''}（期望 /item/${r.keeper}）${r.reason ? ` [${r.reason}]` : ''}${r.error ? ` ${r.error}` : ''}${r.ok ? '' : `；重试${r.retryOk ? '通过（首次失败＝冷缓存类问题）' : '仍失败'}`}`);
    console.log('\n## keeper Work 页版本数（预期＝book-index 中非墓碑 Book 数）');
    for (const r of pageResults) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.workId} 预期 ${r.expected}，页面描述句 ${r.pageText === null ? '被截断(不比)' : (r.pageText ?? '-')}，JSON-LD ${r.pageJsonLd ?? '-'}${r.error ? ` ${r.error}` : ''}`);
    if (pageErrors.length || problems.length) {
        console.log('\n## 无法核对');
        for (const p of [...problems, ...pageErrors]) console.log(`SKIP ${p.id} ${p.keeper ? `→ ${p.keeper} ` : ''}${p.error}`);
    }
    const bad = redirects.filter((r) => !r.ok).length + pageResults.filter((r) => !r.ok).length + pageErrors.length + problems.length;
    console.log(`\n汇总：跳转 ${redirects.filter((r) => r.ok).length}/${redirects.length} 通过；Work 页 ${pageResults.filter((r) => r.ok).length}/${pageResults.length} 通过；无法核对 ${pageErrors.length + problems.length}`);
    if (a.json) writeFileSync(a.json, JSON.stringify({ site: a.site, redirects, pages: pageResults, pageErrors, problems }, null, 1));
    return bad ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main(process.argv.slice(2)).then((c) => process.exit(c));
}
