/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const loadProofing = jest.fn();
const loadFacsimile = jest.fn();
jest.mock('book-index-ui', () => ({ createTextApi: () => ({}), adaptCharCord: () => [] }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({}) }));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
jest.mock('@/lib/duidu-data', () => ({ getJson: async () => null }));
jest.mock('@/lib/facsimile', () => ({ loadFacsimile: (...a: unknown[]) => loadFacsimile(...a) }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <>{children}</>);
jest.mock('@/lib/proofing', () => ({ ...jest.requireActual('@/lib/proofing'), loadProofing: (...a: unknown[]) => loadProofing(...a) }));

import ProofingClient from '../ProofingClient';

const img = (x: number) => ({ s: 'p0009.webp', x, y: 0, w: 96, h: 96 });
const ok = (cells: unknown[]) => ({ status: 'ok', pending: { rev: 'r1', cells }, cord: null, versionKey: 'default', pendingFile: '001.pending.json' });

// jsdom 不加载图片：按 src 触发 onload／onerror
let failUrls: RegExp | null = null;
beforeEach(() => {
    loadProofing.mockReset();
    loadFacsimile.mockReset().mockResolvedValue([]);
    failUrls = null;
    Object.defineProperty(global.Image.prototype, 'src', {
        configurable: true,
        set(this: HTMLImageElement, v: string) {
            setTimeout(() => (failUrls?.test(v) ? this.onerror?.(new Event('error')) : this.onload?.(new Event('load'))), 0);
        },
    });
});
afterEach(cleanup);

describe('精校页显示（GUJI-557）', () => {
    it('每格都有雪碧图：卡片显示雪碧图（书影只给左栏整页用）', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己', img: img(0) }, { a: '9:7:18', c: '已', img: img(96) }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await waitFor(() => expect(screen.getAllByTestId('sprite-crop')).toHaveLength(2));
    });

    it('没有 img 的格回退原叶裁图', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己' }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await waitFor(() => expect(loadFacsimile).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('sprite-crop')).toBeNull();
        expect(screen.getByText('（没有这一格的图）')).toBeTruthy();
        expect(screen.queryByTestId('context')).toBeNull(); // 没有 char_file 就没有上下文行
    });

    it('雪碧图加载失败回退原叶裁图，不报错', async () => {
        failUrls = /\/proof\//;
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己', img: img(0) }]));
        render(<ProofingClient book="b2" vol="vol01" />); // 换书：图片按地址缓存，别用前一例已成功的地址
        await waitFor(() => expect(loadFacsimile).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByTestId('sprite-crop')).toBeNull());
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('0.1 数据（无任何新字段）照常渲染，没有依据区、原因行', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '3:1:2', c: '天', cand: [{ c: '夭' }] }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await screen.findByText('夭');
        expect(screen.queryByText('依据')).toBeNull();
        expect(screen.queryByTestId('why')).toBeNull();
        expect(screen.queryByTestId('preselect')).toBeNull();
    });

    it('why：已知码中文、未知码原样；ref 显示「整理本作 X」；候选带分数，多的在「更多」里', async () => {
        loadProofing.mockResolvedValue(ok([{
            a: '1:1:1', c: '己', why: ['none', 'future_code'], ref: { c: '已' }, cand: [{ c: '己' }, { c: '已' }],
            libTop: [{ c: '巳', s: 0.7 }, { c: '以', s: 0.6 }, { c: '目', s: 0.5 }, { c: '日', s: 0.4 }],
        }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        expect((await screen.findByTestId('why')).textContent).toContain('future_code');
        expect(screen.getByText(/整理本作「已」/)).toBeTruthy();
        expect(screen.getByText('像 70%')).toBeTruthy();
        expect(screen.queryByText('以')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^还有 \d+ 个$/ }));
        expect(screen.getByText('以')).toBeTruthy();
    });

    it("why 只有 none 时显示『机器没把握，需要人看一眼』，不回退显示 cls 原值", async () => {
        loadProofing.mockResolvedValue(ok([{ a: '2:1:1', c: '天', why: ['none'], cls: 'other', cand: [{ c: '夭' }] }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        const t = (await screen.findByTestId('why')).textContent;
        expect(t).toContain('机器没把握，需要人看一眼');
        expect(t).not.toContain('other');
    });

    it('stale 预选其字、occ 预选「图上没有字」，都不自动提交', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '己', stale: { c: '已' } }, { a: '1:1:2', c: '日', occ: { refBlank: true } }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await screen.findByText(/以前有人判为「已」/);
        expect(screen.getByText(/先替你选了「图上没有字」/)).toBeTruthy();
        expect(screen.getAllByRole('button', { name: '图上没有字' })[1].getAttribute('aria-pressed')).toBe('true');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    const ex = { 曰: [{ s: 'ex-001.webp', x: 0, y: 0, w: 96, h: 96 }, { s: 'ex-001.webp', x: 96, y: 0, w: 96, h: 96 }], 日: [{ s: 'ex-001.webp', x: 192, y: 0, w: 96, h: 96 }] };

    it('ex 有就显示同字例子（每个候选字一行）', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '曰', ex }]));
        render(<ProofingClient book="b3" vol="vol01" />);
        const box = await screen.findByTestId('examples');
        expect(box.querySelectorAll('[role=img]')).toHaveLength(3);
    });

    it('ex 的图没传上去（404）就整块不显示，不留空白框；没有 ex 也不渲染', async () => {
        failUrls = /ex-001/;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '曰', ex }, { a: '1:1:2', c: '日' }]));
        render(<ProofingClient book="b4" vol="vol01" />);
        await screen.findAllByText(/机器读作/);
        await waitFor(() => expect(screen.queryByTestId('examples')).toBeNull());
    });

    // 左栏整页＋上下文（用户 10-18 反馈）
    const cord = {
        boxes: new Map([['9:1:2', [100, 200, 50, 60]], ['9:2:1', [40, 200, 50, 60]], ['10:1:1', [100, 100, 50, 60]]]),
        pages: new Map([[9, { seq: '0009', width: 1000, height: 1500 }], [10, { seq: '0010', width: 1000, height: 1500 }]]),
        iiifVol: '01',
    };
    const order = [
        { a: '9:1:1', c: '甲' }, { a: '9:1:2', c: '乙' }, { a: '9:1:3', c: '丙' }, { a: '9:2:1', c: '丁' }, { a: '10:1:1', c: '戊' },
    ];
    const facs = [
        { seq: '0009', url: 'https://x/0009/full/1200,/0/default.webp', hiresUrl: 'https://x/0009/full/1000,/0/default.webp', width: 1000, height: 1500 },
        { seq: '0010', url: 'https://x/0010/full/1200,/0/default.webp', hiresUrl: 'https://x/0010/full/1000,/0/default.webp', width: 1000, height: 1500 },
    ];
    const full = () => ({
        status: 'ok', cord, order, versionKey: 'default', pendingFile: '001.pending.json',
        pending: { rev: 'r1', cells: [
            { a: '9:1:2', c: '乙', img: img(0), why: ['near_form'], cls: 'near_form', libTop: [{ c: '乙', s: 0.99 }, { c: '己', s: 0.98 }], lib: { verdict: 'unsure', cov: 0.99, wmax: 10.8 }, ctx: { c: '', margin: 0.18, src: 'prior' } },
            { a: '9:2:1', c: '丁', img: img(96) },
            { a: '10:1:1', c: '戊', img: img(192) },
        ] },
    });

    it('左栏显示第一张卡所在整页，红框框住它；同页其他待审格虚线框', async () => {
        loadProofing.mockResolvedValue(full());
        loadFacsimile.mockResolvedValue(facs);
        render(<ProofingClient book="b5" vol="vol01" />);
        const panel = await screen.findByTestId('page-panel');
        expect(panel.textContent).toContain('第 9 葉');
        await waitFor(() => expect(panel.querySelector('img')?.getAttribute('src')).toBe(facs[0].url));
        const boxes = screen.getAllByTestId('page-box');
        expect(boxes).toHaveLength(2); // 第 10 葉那格不画在这页上
        const on = boxes.find(b => b.dataset.selected)!;
        expect(on.getAttribute('aria-label')).toContain('第 9 葉 第 1 列第 2 字');
        expect(on.style.left).toBe(`${((100 - 50 * 0.12) / 1000) * 100}%`);
    });

    it('点另一张卡：左栏换页、红框跟过去', async () => {
        loadProofing.mockResolvedValue(full());
        loadFacsimile.mockResolvedValue(facs);
        render(<ProofingClient book="b5" vol="vol01" />);
        const cards = await screen.findAllByTestId('cell-card');
        fireEvent.click(cards[2]);
        const panel = screen.getByTestId('page-panel');
        expect(panel.textContent).toContain('第 10 葉');
        expect(cards[2].dataset.selected).toBe('1');
        await waitFor(() => expect(panel.querySelector('img')?.getAttribute('src')).toBe(facs[1].url));
    });

    it('点整页上的虚线框：选中那张卡', async () => {
        loadProofing.mockResolvedValue(full());
        loadFacsimile.mockResolvedValue(facs);
        render(<ProofingClient book="b5" vol="vol01" />);
        const other = (await screen.findAllByTestId('page-box')).find(b => !b.dataset.selected)!;
        fireEvent.click(other);
        expect(screen.getAllByTestId('cell-card')[1].dataset.selected).toBe('1');
    });

    it('卡片上有前后文：本位红框、别的待审格标色', async () => {
        loadProofing.mockResolvedValue(full());
        render(<ProofingClient book="b5" vol="vol01" />);
        const ctx = (await screen.findAllByTestId('context'))[0];
        expect(ctx.textContent).toContain('甲乙丙丁戊');
        expect(ctx.querySelector('[data-testid=ctx-at]')?.textContent).toBe('乙');
        expect(ctx.querySelector('[title="格 9:2:1 也在待审"]')?.textContent).toBe('丁');
    });

    it('机器判断：两句大白话常显，细节可展开，不出现英文码', async () => {
        loadProofing.mockResolvedValue(full());
        render(<ProofingClient book="b5" vol="vol01" />);
        const ev = (await screen.findAllByTestId('evidence'))[0];
        expect(ev.textContent).toContain('比字形：和本书别处的「乙」「己」都很像，分不出是哪个');
        expect(ev.textContent).toContain('看前后文：看不出是哪个字');
        expect(ev.textContent).toContain('更多机器判断');
        expect(ev.textContent).toContain('「乙」99%');
        expect(ev.textContent).toContain('形近字');
        // 给公众看的字里不出现英文码和缩写
        const card = screen.getAllByTestId('cell-card')[0].textContent ?? '';
        expect(card).not.toMatch(/[A-Za-z]{2,}/);
    });
});

describe('切坏格一类（GUJI-624）', () => {
    it('有两类以上时出类别筛选；点「切坏格」只留切坏格，点「全部」回来', async () => {
        loadProofing.mockResolvedValue(ok([
            { a: '9:7:17', c: '己', cls: 'near_form' },
            { a: '89:7:2', c: '', cls: 'seg_defect', why: ['seg_defect'] },
            { a: '89:7:3', c: '', cls: 'seg_defect', why: ['seg_defect'] },
        ]));
        render(<ProofingClient book="b1" vol="vol01" />);
        const bar = await screen.findByTestId('class-filter');
        expect(bar.textContent).toContain('全部 3');
        expect(bar.textContent).toContain('切坏格 2');
        fireEvent.click(screen.getByRole('button', { name: '切坏格 2' }));
        await waitFor(() => expect(screen.getAllByTestId('cell-card')).toHaveLength(2));
        expect(screen.getAllByPlaceholderText('看书影，写出这个字')).toHaveLength(2);
        fireEvent.click(screen.getByRole('button', { name: '全部 3' }));
        await waitFor(() => expect(screen.getAllByTestId('cell-card')).toHaveLength(3));
    });

    it('只有一类时不出筛选条', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己', cls: 'near_form' }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await screen.findByTestId('cell-card');
        expect(screen.queryByTestId('class-filter')).toBeNull();
        expect(screen.getByPlaceholderText('都不对？写一个字')).toBeTruthy();
    });
});

describe('精校页页头与说明', () => {
    it('页头有返回阅读（指回这一章）、书名、作者与章名；说明里有进度', async () => {
        loadProofing.mockResolvedValue({ ...ok([{ a: '9:1:1', c: '甲', why: [] }]), chapterTitle: '卷首' });
        render(<ProofingClient book="b1" vol="001" info={{ title: '某書', author: '（清）某人撰' }} />);
        await waitFor(() => expect(screen.getByTestId('proofing-progress')).toBeTruthy());
        const header = screen.getByTestId('proofing-header');
        expect(screen.getByRole('link', { name: /返回阅读/ })).toHaveAttribute('href', '/read/b1/001');
        expect(header).toHaveTextContent('某書');
        expect(header).toHaveTextContent('（清）某人撰 · 卷首');
        expect(screen.getByTestId('proofing-progress')).toHaveTextContent('0 / 1 个字');
        expect(document.body.textContent).not.toMatch(/b1 \/ 001/);
    });
    it('取不到待校对的字时仍有页头和返回阅读', async () => {
        loadProofing.mockResolvedValue({ status: 'none' });
        render(<ProofingClient book="b1" vol="002" info={null} />);
        await waitFor(() => expect(screen.getByText('这一章暂时没有待校对的字。')).toBeTruthy());
        expect(screen.getByRole('link', { name: /返回阅读/ })).toHaveAttribute('href', '/read/b1/002');
    });
});
