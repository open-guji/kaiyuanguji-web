import { describe, it, expect } from '@jest/globals';
import { claimAutoRetry, isTransientError, RETRY_WINDOW_MS } from '../auto-retry';

function memStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('isTransientError（overview#322）', () => {
    it.each([
        new TypeError('Failed to fetch'),
        new TypeError('fetch failed'),
        new TypeError('Load failed'),
        new TypeError('NetworkError when attempting to fetch resource.'),
        Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' }),
        new Error('Loading CSS chunk 4 failed'),
        new Error('Failed to fetch dynamically imported module: /x.js'),
        new Error('Connection closed.'),
        Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '12345' }),
    ])('临时错误：%s', (err) => {
        expect(isTransientError(err)).toBe(true);
    });

    it.each([
        new TypeError("Cannot read properties of undefined (reading 'x')"),
        new Error('Minified React error #418'),
        null,
        'Failed to fetch',
        Object.assign(new Error('x'), { digest: '' }),
    ])('不是临时错误：%s', (err) => {
        expect(isTransientError(err)).toBe(false);
    });
});

describe('claimAutoRetry：同一地址窗口内只一次', () => {
    it('第一次 true，窗口内再来 false，过了窗口又 true；不同地址各算各的', () => {
        const s = memStore();
        expect(claimAutoRetry('/read/a', s, 1_000)).toBe(true);
        expect(claimAutoRetry('/read/a', s, 1_000 + RETRY_WINDOW_MS - 1)).toBe(false);
        expect(claimAutoRetry('/read/b', s, 2_000)).toBe(true);
        expect(claimAutoRetry('/read/a', s, 1_000 + RETRY_WINDOW_MS)).toBe(true);
    });

    it('没有 sessionStorage 或读写抛错 → 不重试（没法防循环）', () => {
        expect(claimAutoRetry('/x', null)).toBe(false);
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
        expect(claimAutoRetry('/x', broken)).toBe(false);
    });
});
