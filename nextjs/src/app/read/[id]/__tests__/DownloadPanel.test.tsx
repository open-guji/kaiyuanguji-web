/**
 * 手机上「阅读设置」抽屉里的「下载本冊」面板（A41）：内联、无浮层，行为同 DownloadChip。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('book-index-ui', () => ({ useConvert: () => ({ convert: (s: string) => s }) }));
const buildExport = jest.fn(async () => ({ filename: 'a.md', text: 'x' }));
const saveText = jest.fn();
jest.mock('@/lib/export/download', () => ({
    ...jest.requireActual('@/lib/export/download'),
    buildExport: (...a: unknown[]) => (buildExport as (...x: unknown[]) => unknown)(...a),
    saveText: (...a: unknown[]) => saveText(...a),
}));

import DownloadPanel from '../DownloadPanel';

const target = {
    id: '96mid1ogzk', versionKey: 'default', bookTitle: '欽定四庫全書總目',
    chapter: { file: '020', char_file: '020.char.json', punct_file: '020.punct.json', entity_file: '020.entity.json', text_version: '0.6.0' },
};

describe('DownloadPanel', () => {
    beforeEach(() => { buildExport.mockClear(); saveText.mockClear(); });

    it('直接铺开选项（不用先点开），按所选格式与字形生成并保存', async () => {
        render(<DownloadPanel target={target} storage={{}} />);
        fireEvent.click(screen.getByTestId('download-fmt-entity'));
        fireEvent.click(screen.getByTestId('download-glyph-simplified'));
        fireEvent.click(screen.getByTestId('download-go'));
        await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1));
        expect(buildExport.mock.calls[0][0]).toMatchObject({ format: 'entity', glyph: 'simplified', links: true });
        expect(screen.getByTestId('download-go').textContent).toContain('已下載');
    });

    it('「带库内链接」只在专名本可选，别的格式置灰不隐藏', () => {
        render(<DownloadPanel target={target} storage={{}} />);
        expect((screen.getByTestId('download-links') as HTMLInputElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('download-fmt-entity'));
        expect((screen.getByTestId('download-links') as HTMLInputElement).disabled).toBe(false);
    });

    it('章条目没声明任何可导出层时整块不出', () => {
        const { container } = render(<DownloadPanel target={{ ...target, chapter: { file: '020' } }} storage={{}} />);
        expect(container.firstChild).toBeNull();
    });
});
