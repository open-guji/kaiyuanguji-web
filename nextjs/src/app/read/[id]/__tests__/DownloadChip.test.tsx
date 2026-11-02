/**
 * 书名栏「下载本冊」浮层：选项、置灰、焦点、下载后提示（A41 评审意见）。生成本身见 lib/export/__tests__。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('book-index-ui', () => ({ useConvert: () => ({ convert: (s: string) => s }) }));
const buildExport = jest.fn(async () => ({ filename: 'a.md', text: 'x' }));
const saveText = jest.fn();
jest.mock('@/lib/export/download', () => ({
    ...jest.requireActual('@/lib/export/download'),
    buildExport: (...a: unknown[]) => (buildExport as (...x: unknown[]) => unknown)(...a),
    saveText: (...a: unknown[]) => saveText(...a),
}));

import DownloadChip from '../DownloadChip';

const target = {
    id: '96mid1ogzk', versionKey: 'default', bookTitle: '欽定四庫全書總目',
    chapter: { file: '020', char_file: '020.char.json', punct_file: '020.punct.json', entity_file: '020.entity.json', text_version: '0.6.0' },
};

describe('DownloadChip', () => {
    beforeEach(() => { buildExport.mockClear(); saveText.mockClear(); });

    it('打开后焦点在第一个单选项，Esc 关闭后回到按钮', () => {
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        const btn = screen.getByTestId('download-chip');
        fireEvent.click(btn);
        expect(document.activeElement).toBe(screen.getByTestId('download-fmt-lines'));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('download-pop')).toBeNull();
        expect(document.activeElement).toBe(btn);
    });

    it('「带库内链接」只在专名本可选，别的格式置灰不隐藏', () => {
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        expect((screen.getByTestId('download-links') as HTMLInputElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('download-fmt-entity'));
        expect((screen.getByTestId('download-links') as HTMLInputElement).disabled).toBe(false);
        fireEvent.click(screen.getByTestId('download-fmt-lines'));
        expect((screen.getByTestId('download-links') as HTMLInputElement).disabled).toBe(true);
    });

    it('字形带说明；没有专名层时不列专名本和链接项', () => {
        render(<p><DownloadChip target={{ ...target, chapter: { ...target.chapter, entity_file: undefined } }} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        expect(screen.getByTestId('download-pop').textContent).toContain('異體字歸一');
        expect(screen.queryByTestId('download-fmt-entity')).toBeNull();
        expect(screen.queryByTestId('download-links')).toBeNull();
    });

    it('下载后按钮短暂显示「已下載 ✓」', async () => {
        jest.useFakeTimers();
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        fireEvent.click(screen.getByTestId('download-fmt-entity'));
        await act(async () => { fireEvent.click(screen.getByTestId('download-go')); });
        expect(buildExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'entity', links: true, glyph: 'original' }), {});
        expect(saveText).toHaveBeenCalled();
        expect(screen.getByTestId('download-go').textContent).toBe('已下載 ✓');
        act(() => { jest.advanceTimersByTime(2100); });
        expect(screen.getByTestId('download-go').textContent).toBe('下載 .md');
        jest.useRealTimers();
    });

    it('默认选项：标点本、带链接、原书字形', async () => {
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        await act(async () => { fireEvent.click(screen.getByTestId('download-go')); });
        expect(buildExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'punct', links: true, glyph: 'original' }), {});
    });

    // 每一种组合都原样传给 buildExport（生成结果另在 lib/export/__tests__/cases 逐字节对照）
    const combos: [string, boolean, string][] = [];
    for (const fmt of ['lines', 'punct', 'entity']) for (const links of [true, false]) for (const glyph of ['original', 'traditional', 'simplified']) combos.push([fmt, links, glyph]);
    it.each(combos)('格式 %s、链接 %s、字形 %s', async (fmt, links, glyph) => {
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        // 先切到专名本设链接，再切到要的格式（链接项在别的格式下置灰，但选过的值保留）
        fireEvent.click(screen.getByTestId('download-fmt-entity'));
        const box = screen.getByTestId('download-links') as HTMLInputElement;
        if (box.checked !== links) fireEvent.click(box);
        fireEvent.click(screen.getByTestId(`download-fmt-${fmt}`));
        fireEvent.click(screen.getByTestId(`download-glyph-${glyph}`));
        await act(async () => { fireEvent.click(screen.getByTestId('download-go')); });
        expect(buildExport).toHaveBeenCalledTimes(1);
        expect(buildExport).toHaveBeenCalledWith(expect.objectContaining({ ...target, format: fmt, links, glyph }), {});
    });

    it('生成出错：显示原因，不存文件', async () => {
        buildExport.mockImplementationOnce(async () => { throw new Error('本冊標點取不到'); });
        render(<p><DownloadChip target={target} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        await act(async () => { fireEvent.click(screen.getByTestId('download-go')); });
        expect(saveText).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toContain('本冊標點取不到');
    });

    it('只有字层：只列分行本', () => {
        render(<p><DownloadChip target={{ ...target, chapter: { file: '020', char_file: '020.char.json' } }} storage={{}} /></p>);
        fireEvent.click(screen.getByTestId('download-chip'));
        expect(screen.getByTestId('download-fmt-lines')).toBeTruthy();
        expect(screen.queryByTestId('download-fmt-punct')).toBeNull();
    });

    it('没有字层：不出按钮', () => {
        render(<p><DownloadChip target={{ ...target, chapter: { file: '020' } }} storage={{}} /></p>);
        expect(screen.queryByTestId('download-chip')).toBeNull();
    });
});
