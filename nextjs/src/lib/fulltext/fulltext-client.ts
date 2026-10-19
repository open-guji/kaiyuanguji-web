/**
 * 全文搜索客户端（GUJI-163 / F6 步 2）：`/api/fulltext`（F1 契约）的类型与 `fetchFulltext()`。
 *
 * - `matches` 是章内 Unicode 码点偏移（见 fulltext-offsets.ts）；`passage` 是该段在章内的 [起,止) 码点区间。
 * - `snippet` 是响应里唯一可作 innerHTML 的字段（只含 `<mark>`）；`q`、`label`、`title` 一律当文本节点。
 * - 错误不抛给调用方：返回判别联合 `{ ok:false, kind }`，界面按 kind 降级。
 * - 运行时开关：`fetchFulltextStatus()` 查 `/api/fulltext?op=status`（边缘函数读 COS 上的开关文件）；
 *   搜索时边缘函数回 503 `{error:'disabled'}` 映射成 kind `disabled`，界面据此立刻隐藏入口。
 */

/** near＝差一字（多一字、少一字、错一字都算，≥4 字才放宽）；前端暂不提供入口 */
export type FulltextMode = 'exact' | 'fuzzy' | 'near';
export type CodepointRange = [number, number];

export interface FulltextHit {
    chapter: string;
    label: string | null;
    passage: CodepointRange;
    matches: CodepointRange[];
    snippet: string;
}

export interface FulltextGroup {
    entry: string;
    title: string;
    hit_count: number;
    /** 仅 mode=near：该书完全命中原串的段数 */
    exact_count?: number;
    hits: FulltextHit[];
}

export interface FulltextResponse {
    q: string;
    mode: FulltextMode;
    normalized: string;
    truncated: boolean;
    total_books: number;
    total_books_capped: boolean;
    has_more: boolean;
    total_hits: number;
    capped: boolean;
    groups: FulltextGroup[];
    took_ms: { search: number; locate: number; total: number };
}

export interface FulltextParams {
    q: string;
    mode?: FulltextMode;
    group?: string;
    limit?: number;
    offset?: number;
    per_book?: number;
    entry?: string;
}

export type FulltextError =
    | { ok: false; kind: 'bad_query'; status: 400 }
    | { ok: false; kind: 'rate_limited'; status: 429; retryAfterSec: number | null }
    | { ok: false; kind: 'unavailable'; status: 503 }
    | { ok: false; kind: 'disabled'; status: 503 }
    | { ok: false; kind: 'timeout'; status?: 504 }
    | { ok: false; kind: 'offline' }
    | { ok: false; kind: 'bad_response'; status?: number };

export type FulltextResult = { ok: true; data: FulltextResponse } | FulltextError;

export const FULLTEXT_ENDPOINT = '/api/fulltext';
export const FULLTEXT_TIMEOUT_MS = 10000;

export function buildFulltextUrl(p: FulltextParams, base = FULLTEXT_ENDPOINT): string {
    const u = new URLSearchParams();
    u.set('q', p.q);
    if (p.mode) u.set('mode', p.mode);
    if (p.group) u.set('group', p.group);
    if (p.entry) u.set('entry', p.entry);
    for (const k of ['limit', 'offset', 'per_book'] as const) {
        const v = p[k];
        if (typeof v === 'number' && Number.isFinite(v)) u.set(k, String(Math.trunc(v)));
    }
    return `${base}?${u.toString()}`;
}

const isRange = (r: unknown): r is CodepointRange =>
    Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]);

/** 形态检查：只确认客户端要用到的字段；多余字段忽略（向前兼容）。 */
export function isFulltextResponse(v: unknown): v is FulltextResponse {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    if (typeof o.q !== 'string' || typeof o.total_hits !== 'number' || !Array.isArray(o.groups)) return false;
    return o.groups.every((g: any) =>
        g && typeof g.entry === 'string' && typeof g.title === 'string' && Array.isArray(g.hits) &&
        g.hits.every((h: any) =>
            h && typeof h.chapter === 'string' && isRange(h.passage) && Array.isArray(h.matches) &&
            h.matches.every(isRange) && typeof h.snippet === 'string'));
}

export async function fetchFulltext(
    p: FulltextParams,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; base?: string } = {},
): Promise<FulltextResult> {
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) return { ok: false, kind: 'offline' };
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs ?? FULLTEXT_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', () => ctrl.abort());
    try {
        const res = await f(buildFulltextUrl(p, opts.base), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (res.status === 400) return { ok: false, kind: 'bad_query', status: 400 };
        if (res.status === 429) {
            const raw = res.headers?.get?.('Retry-After');
            const ra = raw ? Number(raw) : NaN;
            return { ok: false, kind: 'rate_limited', status: 429, retryAfterSec: Number.isFinite(ra) && ra >= 0 ? ra : null };
        }
        if (res.status === 503) {
            // 全局开关关了（边缘函数回 {error:'disabled'}）与服务忙／预热中（busy／warming…）分开
            let err: unknown;
            try { err = await res.json(); } catch { err = null; }
            const disabled = !!err && typeof err === 'object' && (err as { error?: unknown }).error === 'disabled';
            return disabled ? { ok: false, kind: 'disabled', status: 503 } : { ok: false, kind: 'unavailable', status: 503 };
        }
        if (res.status === 504) return { ok: false, kind: 'timeout', status: 504 };
        if (!res.ok) return { ok: false, kind: 'bad_response', status: res.status };
        let json: unknown;
        try { json = await res.json(); } catch { return { ok: false, kind: 'bad_response', status: res.status }; }
        return isFulltextResponse(json) ? { ok: true, data: json } : { ok: false, kind: 'bad_response', status: res.status };
    } catch {
        if (timedOut) return { ok: false, kind: 'timeout' };
        if (opts.signal?.aborted) return { ok: false, kind: 'offline' };
        return { ok: false, kind: 'offline' };
    } finally {
        clearTimeout(timer);
    }
}

export interface FulltextStatus {
    enabled: boolean;
    reason?: string;
}

export const FULLTEXT_STATUS_TIMEOUT_MS = 5000;

/**
 * 运行时开关：`GET /api/fulltext?op=status` → `{ enabled, reason? }`。
 * 任何失败（网络错、超时、非 200、形状不对）都当关：宁可不显示入口，也别挂着坏的。
 */
export async function fetchFulltextStatus(
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number; base?: string } = {},
): Promise<FulltextStatus> {
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) return { enabled: false };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FULLTEXT_STATUS_TIMEOUT_MS);
    try {
        const res = await f(`${opts.base ?? FULLTEXT_ENDPOINT}?op=status`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return { enabled: false };
        const j: unknown = await res.json();
        if (!j || typeof j !== 'object' || (j as { enabled?: unknown }).enabled !== true) {
            const reason = j && typeof j === 'object' && typeof (j as { reason?: unknown }).reason === 'string' ? (j as { reason: string }).reason : undefined;
            return reason ? { enabled: false, reason } : { enabled: false };
        }
        return { enabled: true };
    } catch {
        return { enabled: false };
    } finally {
        clearTimeout(timer);
    }
}
