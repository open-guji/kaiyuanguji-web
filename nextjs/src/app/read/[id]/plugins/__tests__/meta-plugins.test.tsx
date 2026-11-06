/**
 * @jest-environment jsdom
 *
 * 下载本冊、文本版本号芯片、补字体三个插件：全部从阅读器给的章上下文（ctx）取数，不再另取 manifest／index。
 */
import { render, screen } from '@testing-library/react';
import { fakeApi } from '@/test-utils/reader-fake-api';

jest.mock('book-index-ui', () => ({ useConvert: () => ({ convert: (s: string) => s }) }));
const mockFont = jest.fn();
jest.mock('@/lib/chapter-font', () => ({ ensureChapterFont: (...a: unknown[]) => mockFont(...a) }));

import { downloadPlugin } from '../download-plugin';
import { versionChipPlugin } from '../version-chip-plugin';
import { fontPlugin } from '../font-plugin';

const CHAPTER = { file: '001', title: '卷首', char_file: '001.char.json', text_version: '0.1.4', punct_version: '0.1.1', entity_version: '0.1.1' };
const ctx = (o: { original?: boolean; viewport?: 'wide' | 'narrow'; chapter?: Record<string, unknown> } = {}) => ({
    viewport: o.viewport ?? 'wide',
    chapter: (o.chapter ?? CHAPTER) as never,
    version: { key: 'v1', label: '自校本', is_original: o.original ?? true, license: 'CC BY-SA 4.0' } as never,
});
const dl = downloadPlugin({ bookId: 'b1', bookTitle: '書名', edition: '某刻本', dataVersion: 'dv1' });

describe('版本号芯片插件', () => {
    it('本项目自做的版本：副标题位显示「文本 v0.1.4」', () => {
        const { api } = fakeApi({ ctx: ctx() });
        render(<>{versionChipPlugin.toolbar!.render(api)}</>);
        expect(screen.getByTestId('text-version').textContent).toBe('文本 v0.1.4');
    });
    it('外来版本、或章条目没有版本号：什么都不出', () => {
        const a = fakeApi({ ctx: ctx({ original: false }) }).api;
        expect(versionChipPlugin.toolbar!.render(a)).toBeNull();
        const b = fakeApi({ ctx: ctx({ chapter: { file: '001' } }) }).api;
        expect(versionChipPlugin.toolbar!.render(b)).toBeNull();
    });
});

describe('下载本冊插件', () => {
    it('宽屏：书名栏位出「下载」芯片，设置抽屉里不出', () => {
        const { api } = fakeApi({ ctx: ctx() });
        render(<>{dl.toolbar!.render(api)}</>);
        expect(screen.getByTestId('download-chip')).toBeTruthy();
        expect(dl.settings!.render(api)).toBeNull();
    });
    it('窄屏：设置抽屉里出下载面板，书名栏位不出', () => {
        const { api } = fakeApi({ ctx: ctx({ viewport: 'narrow' }) });
        expect(dl.toolbar!.render(api)).toBeNull();
        render(<>{dl.settings!.render(api)}</>);
        expect(screen.getByTestId('download-panel')).toBeTruthy();
    });
    it('外来版本：两处都不出', () => {
        for (const viewport of ['wide', 'narrow'] as const) {
            const { api } = fakeApi({ ctx: ctx({ original: false, viewport }) });
            expect(dl.toolbar!.render(api)).toBeNull();
            expect(dl.settings!.render(api)).toBeNull();
        }
    });
});

describe('补字体插件', () => {
    it('换章（含首章）时补这一章的字体子集', () => {
        const transport = { getTextFileUrl: jest.fn() };
        const { api } = fakeApi({ ctx: { versionKey: 'v1', transport: transport as never, chapter: CHAPTER as never } });
        fontPlugin.onChapter!(api.ctx);
        expect(mockFont).toHaveBeenCalledWith(transport, '96mid1ogzk', 'v1', CHAPTER);
    });
});
