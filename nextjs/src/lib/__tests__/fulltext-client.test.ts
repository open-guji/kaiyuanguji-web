import sample from '../fulltext/__fixtures__/sample_response.json';
import { fetchFulltext, fetchFulltextStatus, buildFulltextUrl, isFulltextResponse } from '../fulltext/fulltext-client';

const resp = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    ({
        status, ok: status >= 200 && status < 300,
        headers: { get: (k: string) => headers[k] ?? null },
        json: async () => { if (body === undefined) throw new Error('no json'); return body; },
    }) as unknown as Response;
const withFetch = (fn: (...a: any[]) => any) => ({ fetchImpl: fn as unknown as typeof fetch });

describe('fulltext-client', () => {
    it('样例响应通过形态检查，字段集合与样例一致', async () => {
        expect(isFulltextResponse(sample)).toBe(true);
        const r = await fetchFulltext({ q: '學而時習之' }, withFetch(async () => resp(200, sample)));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(Object.keys(r.data).sort()).toEqual(Object.keys(sample).sort());
            expect(r.data.groups[0].hits[0].label).toBe('學而第一');
            expect(r.data.groups[0].hits[1].label).toBeNull();
        }
    });
    it('URL：只带给定参数，q 被编码', () => {
        const u = buildFulltextUrl({ q: '學 而&x', mode: 'exact', limit: 20.7, offset: 0 });
        expect(u).toBe('/api/fulltext?q=%E5%AD%B8+%E8%80%8C%26x&mode=exact&limit=20&offset=0');
    });
    it('400 / 429(Retry-After) / 503 / 504', async () => {
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(400)))).toEqual({ ok: false, kind: 'bad_query', status: 400 });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(429, undefined, { 'Retry-After': '30' }))))
            .toEqual({ ok: false, kind: 'rate_limited', status: 429, retryAfterSec: 30 });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(429)))).toMatchObject({ kind: 'rate_limited', retryAfterSec: null });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(503)))).toEqual({ ok: false, kind: 'unavailable', status: 503 });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(504)))).toEqual({ ok: false, kind: 'timeout', status: 504 });
    });
    it('客户端超时 → timeout；网络错误 → offline', async () => {
        const hang = (_u: string, init: RequestInit) => new Promise((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
        expect(await fetchFulltext({ q: 'a' }, { ...withFetch(hang), timeoutMs: 20 })).toEqual({ ok: false, kind: 'timeout' });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => { throw new TypeError('Failed to fetch'); }))).toEqual({ ok: false, kind: 'offline' });
    });
    it('坏 JSON / 形态不对 / 其他状态码 → bad_response，不抛', async () => {
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(200)))).toMatchObject({ ok: false, kind: 'bad_response' });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(200, { q: 'a', groups: [{ entry: 1 }] })))).toMatchObject({ kind: 'bad_response' });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(500)))).toMatchObject({ kind: 'bad_response', status: 500 });
    });
    it('503 {error:disabled}（全局开关关了）→ disabled；其余 503（busy／warming／无 JSON）→ unavailable', async () => {
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(503, { error: 'disabled' })))).toEqual({ ok: false, kind: 'disabled', status: 503 });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(503, { error: 'busy' })))).toEqual({ ok: false, kind: 'unavailable', status: 503 });
        expect(await fetchFulltext({ q: 'a' }, withFetch(async () => resp(503)))).toEqual({ ok: false, kind: 'unavailable', status: 503 });
    });
});

describe('fetchFulltextStatus（运行时开关）', () => {
    it('请求 /api/fulltext?op=status；enabled:true → 开', async () => {
        const f = jest.fn(async () => resp(200, { enabled: true }));
        expect(await fetchFulltextStatus(withFetch(f))).toEqual({ enabled: true });
        expect((f.mock.calls[0] as unknown[])[0]).toBe('/api/fulltext?op=status');
    });
    it('enabled:false 带 reason → 关并带 reason', async () => {
        expect(await fetchFulltextStatus(withFetch(async () => resp(200, { enabled: false, reason: '维护' })))).toEqual({ enabled: false, reason: '维护' });
    });
    it('任何失败都当关：非 200、坏 JSON、形状不对、网络错、超时', async () => {
        expect(await fetchFulltextStatus(withFetch(async () => resp(500, { enabled: true })))).toEqual({ enabled: false });
        expect(await fetchFulltextStatus(withFetch(async () => resp(200)))).toEqual({ enabled: false });
        expect(await fetchFulltextStatus(withFetch(async () => resp(200, { enabled: 'true' })))).toEqual({ enabled: false });
        expect(await fetchFulltextStatus(withFetch(async () => { throw new TypeError('Failed to fetch'); }))).toEqual({ enabled: false });
        const hang = (_u: string, init: RequestInit) => new Promise((_res, rej) => {
            init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
        expect(await fetchFulltextStatus({ ...withFetch(hang), timeoutMs: 20 })).toEqual({ enabled: false });
    });
});
