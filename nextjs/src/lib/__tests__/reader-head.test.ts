/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { decodeChapterHead } from '../reader-head';

const enc = (s: string) => new TextEncoder().encode(s);

describe('decodeChapterHead', () => {
    it('末尾切在汉字中间：丢掉残字，不出现替换字符', () => {
        const full = enc('洪範之書\n箕子傳之');
        // 「箕」「子」各 3 字节，把最后一个字砍掉 1 字节
        const cut = full.subarray(0, full.length - 1);
        const out = decodeChapterHead(cut, false);
        expect(out).not.toContain('�');
        expect(out).toBe('洪範之書\n箕子傳');
    });

    it('截断时收到最后一个换行，只给完整段落', () => {
        const out = decodeChapterHead(enc('第一段\n\n第二段\n第三段未完'), true);
        expect(out).toBe('第一段\n\n第二段');
    });

    it('截断但没有换行（单段超长）：保留已有部分', () => {
        expect(decodeChapterHead(enc('一整段很长的字'), true)).toBe('一整段很长的字');
    });

    it('未截断（整文件不足一段）：原样返回', () => {
        expect(decodeChapterHead(enc('短文\n结尾'), false)).toBe('短文\n结尾');
    });
});
