/**
 * overview#235：阅读页的「版本」下拉框（book-index-ui ≥ 0.10.4 的 ReaderShell 工具条）。
 * 这里用真组件、假 transport，验网站这一半的接线：两份出下拉框、切换后地址变化、单份没有下拉框。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }), useSearchParams: () => new URLSearchParams() }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

const source = (name: string, license: string) => ({ name, url: `https://example.org/${name}`, license });
const indexOf = (label: string, src: ReturnType<typeof source>) => ({
    version_label: label,
    source: src,
    chapters: [{ file: '001.md', title: '第一卷' }, { file: '002.md', title: '第二卷' }],
});
const INDEXES: Record<string, ReturnType<typeof indexOf>> = {
    wikisource: indexOf('維基文庫本', source('維基文庫', 'CC BY-SA 4.0')),
    'kanripo-01': indexOf('Kanripo本', source('Kanripo', 'CC BY 4.0')),
};

const getWorkFullTextList = jest.fn();
jest.mock('@/lib/transport', () => ({
    getTransport: () => ({
        getWorkFullTextList,
        getWorkFullTextIndex: async (_id: string, key: string) => INDEXES[key],
        getWorkFullTextChapter: async () => '正文',
    }),
}));

import ReaderClient from '../ReaderClient';

const SHIXU = 'd59f2ew0ctmo';
const entry = (key: string, primary = false) => ({ key, owner_type: 'Work', primary, source_name: key, version_label: key });

beforeEach(() => {
    getWorkFullTextList.mockReset();
    window.history.replaceState(null, '', `/read/${SHIXU}?kind=fulltext`);
});

describe('阅读页版本下拉框', () => {
    it('两份全文：工具条出「版本」下拉框，默认首选那份', async () => {
        getWorkFullTextList.mockResolvedValue([entry('wikisource', true), entry('kanripo-01')]);
        render(<ReaderClient id={SHIXU} initial={{ kind: 'fulltext' }} bookTitle="詩序" />);
        const select = await screen.findByRole('combobox', { name: '版本' });
        expect(select).toHaveValue('wikisource');
        expect(select.querySelectorAll('option')).toHaveLength(2);
    });

    it('切换版本：地址的 key 变、卷号去掉，出处授权跟着变', async () => {
        getWorkFullTextList.mockResolvedValue([entry('wikisource', true), entry('kanripo-01')]);
        window.history.replaceState(null, '', `/read/${SHIXU}?kind=fulltext&juan=002`);
        render(<ReaderClient id={SHIXU} initial={{ kind: 'fulltext', juan: '002' }} bookTitle="詩序" />);
        const select = await screen.findByRole('combobox', { name: '版本' });
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));

        act(() => { fireEvent.change(select, { target: { value: 'kanripo-01' } }); });
        await waitFor(() => expect(window.location.pathname + window.location.search)
            .toBe(`/read/${SHIXU}?kind=fulltext&key=kanripo-01`));
        await waitFor(() => expect(screen.getAllByText(/CC BY 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByText(/CC BY-SA 4\.0/)).toBeNull();
    });

    it('只有一份全文：没有下拉框', async () => {
        getWorkFullTextList.mockResolvedValue([entry('wikisource', true)]);
        render(<ReaderClient id={SHIXU} initial={{ kind: 'fulltext' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByRole('combobox', { name: '版本' })).toBeNull();
    });
});
