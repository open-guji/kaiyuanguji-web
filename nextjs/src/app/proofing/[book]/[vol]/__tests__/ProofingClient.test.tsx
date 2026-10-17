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
    it('每格都有雪碧图：显示雪碧图，不取书影（manifest／原叶图一个都不请求）', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己', img: img(0) }, { a: '9:7:18', c: '已', img: img(96) }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await waitFor(() => expect(screen.getAllByTestId('sprite-crop')).toHaveLength(2));
        expect(loadFacsimile).not.toHaveBeenCalled();
    });

    it('没有 img 的格回退原叶裁图：这时才取书影', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '己' }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await waitFor(() => expect(loadFacsimile).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId('sprite-crop')).toBeNull();
        expect(screen.getByText('（无裁图，仅供看字）')).toBeTruthy();
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
        expect(screen.getByText('0.70')).toBeTruthy();
        expect(screen.queryByText('以')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /更多/ }));
        expect(screen.getByText('以')).toBeTruthy();
    });

    it("why 只有 none 时显示『无具体疑点，仍需人看』，不回退显示 cls 原值", async () => {
        loadProofing.mockResolvedValue(ok([{ a: '2:1:1', c: '天', why: ['none'], cls: 'other', cand: [{ c: '夭' }] }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        const t = (await screen.findByTestId('why')).textContent;
        expect(t).toContain('无具体疑点，仍需人看');
        expect(t).not.toContain('other');
    });

    it('stale 预选其字、occ 预选「图上没有字」，都不自动提交', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '己', stale: { c: '已' } }, { a: '1:1:2', c: '日', occ: { refBlank: true } }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await screen.findByText(/预选「已」/);
        expect(screen.getByText(/预选「图上没有字」/)).toBeTruthy();
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
});
