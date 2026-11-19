/**
 * @jest-environment jsdom
 *
 * 阅读设置栏底部的网站版本小字（kyg:site-version）。
 */
import { render, screen } from '@testing-library/react';
import { fakeApi } from '@/test-utils/reader-fake-api';
import { siteVersionLabel, siteVersionPlugin } from '../site-version-plugin';

describe('siteVersionLabel', () => {
    it('版本与提交都有：v0.2.17 · 7 位提交', () => {
        expect(siteVersionLabel('0.2.17', 'c7d83617391e36160127312d48bb214821ed5adb')).toBe('网站版本 v0.2.17 · c7d8361');
    });
    it('只有版本、只有提交、都没有', () => {
        expect(siteVersionLabel('0.2.17', '')).toBe('网站版本 v0.2.17');
        expect(siteVersionLabel('', 'c7d83617')).toBe('网站版本 c7d8361');
        expect(siteVersionLabel('', '')).toBe('');
    });
});

describe('siteVersionPlugin', () => {
    it('挂在「更多」组最后，渲染出小字', () => {
        const prev = process.env.NEXT_PUBLIC_WEB_VERSION;
        process.env.NEXT_PUBLIC_WEB_VERSION = '9.9.9';
        try {
            expect(siteVersionPlugin.settings?.group).toBe('more');
            render(<>{siteVersionPlugin.settings!.render(fakeApi({}).api as never)}</>);
            expect(screen.getByTestId('site-version').textContent).toContain('v9.9.9');
        } finally {
            if (prev === undefined) delete process.env.NEXT_PUBLIC_WEB_VERSION; else process.env.NEXT_PUBLIC_WEB_VERSION = prev;
        }
    });
});
