/**
 * overview#235／#307：阅读页的「版本」下拉框（book-index-ui ≥ 0.28.1 的 TextReader 工具条）。
 * 这里用真组件、假 transport（新结构：manifest＋<key>/index.json），验网站这一半的接线：
 * 多份版本出下拉框（含整理本）、切换后地址变化且停在同一章、单份没有下拉框。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let pathname = '';
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }), usePathname: () => pathname }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));

const version = (key: string, label: string, kind: string, license: string) => ({ key, kind, label, source: key === 'default' ? 'collated' : key, source_name: label, license });
const indexOf = (n: number) => ({ chapters: Array.from({ length: n }, (_, i) => ({ n: i + 1, file: String(i + 1).padStart(3, '0'), title: `第${i + 1}卷` })) });

let manifest: { id: string; versions: ReturnType<typeof version>[] };
jest.mock('@/lib/transport', () => ({
    getTransport: () => ({
        getItem: async () => ({ title: '詩序' }),
        getTextManifest: async () => manifest,
        getTextIndex: async (_id: string, key: string) => (key === 'kanripo' ? indexOf(1) : indexOf(3)),
        getChapter: async (_id: string, key: string, ch: string) => ({ md: `# ${key}-${ch}\n${key}正文${ch}`, json: null }),
    }),
}));

import ReaderClient from '../ReaderClient';

const SHIXU = 'd59f2ew0ctmo';
const TWO = { id: SHIXU, versions: [version('default', '維基文庫', 'transcription', 'CC BY-SA 4.0'), version('kanripo', 'Kanripo', 'transcription', 'CC BY 4.0')] };

beforeEach(() => {
    manifest = TWO;
    pathname = `/read/${SHIXU}`;
    window.history.replaceState(null, '', `/read/${SHIXU}`);
});

describe('阅读页版本下拉框', () => {
    it('两份版本：工具条出「版本」下拉框，默认主版本，选项只写来源', async () => {
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        const select = await screen.findByRole('combobox', { name: '版本' });
        expect(select).toHaveValue('default');
        expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['维基文库', 'Kanripo']);
    });

    it('切换版本：地址变成 /<key>/<章>，停在同一章（对不上回第一章），出处授权跟着变', async () => {
        window.history.replaceState(null, '', `/read/${SHIXU}/003`);
        pathname = `/read/${SHIXU}/003`;
        render(<ReaderClient id={SHIXU} initial={{ chapter: '003' }} bookTitle="詩序" />);
        const select = await screen.findByRole('combobox', { name: '版本' });
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));

        // Kanripo 只有 1 章，003 对不上 → 第一章
        await act(async () => { fireEvent.change(select, { target: { value: 'kanripo' } }); });
        await waitFor(() => expect(window.location.pathname).toBe(`/read/${SHIXU}/kanripo/001`));
        await waitFor(() => expect(screen.getAllByText(/CC BY 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByText(/CC BY-SA 4\.0/)).toBeNull();

        // 切回主版本，地址里不带 key
        await act(async () => { fireEvent.change(await screen.findByRole('combobox', { name: '版本' }), { target: { value: 'default' } }); });
        await waitFor(() => expect(window.location.pathname).toBe(`/read/${SHIXU}/001`));
    });

    it('只有一份版本：没有下拉框', async () => {
        manifest = { id: SHIXU, versions: [TWO.versions[0]] };
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByRole('combobox', { name: '版本' })).toBeNull();
    });

    it('有全文版：下拉里不列目录型 default，只剩全文版（没有下拉框），地址不带 key（overview#456）', async () => {
        manifest = { id: SHIXU, versions: [version('default', '整理本', 'collated', 'CC BY-SA 4.0'), version('wikisource', '維基文庫', 'transcription', 'CC BY-SA 4.0')] };
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByRole('combobox', { name: '版本' })).toBeNull();
        expect(screen.getByText(/wikisource-001/)).toBeInTheDocument();
        expect(window.location.pathname).toBe(`/read/${SHIXU}/001`);
    });

    it('有全文版又有别的全文版：下拉只列全文版，主版本在前', async () => {
        manifest = { id: SHIXU, versions: [version('default', '整理本', 'collated', '未知'), version('wikisource', '維基文庫', 'transcription', 'CC BY-SA 4.0'), version('kanripo', 'Kanripo', 'transcription', 'CC BY 4.0')] };
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        const select = await screen.findByRole('combobox', { name: '版本' });
        expect(select).toHaveValue('wikisource');
        expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['维基文库', 'Kanripo']);
    });

    it('只有整理本且 license=未知：保留 default，license 原样显示「未知」（不改写）', async () => {
        manifest = { id: SHIXU, versions: [version('default', '网络', 'collated', '未知')] };
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getAllByText(/未知/).length).toBeGreaterThan(0));
        expect(screen.queryAllByText(/版权未知/)).toHaveLength(0);
        expect(screen.queryByRole('combobox', { name: '版本' })).toBeNull();
    });

    it('目录型 default 被隐藏时，地址里的章号保留（/read/<id>/003 不回第一章）', async () => {
        manifest = { id: SHIXU, versions: [version('default', '整理本', 'collated', 'CC BY-SA 4.0'), version('wikisource', '維基文庫', 'transcription', 'CC BY-SA 4.0')] };
        window.history.replaceState(null, '', `/read/${SHIXU}/003`);
        pathname = `/read/${SHIXU}/003`;
        render(<ReaderClient id={SHIXU} initial={{ chapter: '003' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getByText(/wikisource-003/)).toBeInTheDocument());
        expect(window.location.pathname).toBe(`/read/${SHIXU}/003`);
    });

    it('default 是全文版、另有 key=collated 的整理本（古文觀止）：下拉里不列整理本，没有下拉框', async () => {
        manifest = { id: SHIXU, versions: [version('default', '維基文庫', 'transcription', 'CC BY-SA 4.0'), version('collated', '維基文庫', 'collated', 'CC BY-SA 4.0')] };
        render(<ReaderClient id={SHIXU} initial={{ chapter: '001' }} bookTitle="詩序" />);
        await waitFor(() => expect(screen.getAllByText(/CC BY-SA 4\.0/).length).toBeGreaterThan(0));
        expect(screen.queryByRole('combobox', { name: '版本' })).toBeNull();
    });
});
