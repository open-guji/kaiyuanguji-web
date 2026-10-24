/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';

const loadProofing = jest.fn();
const loadFacsimile = jest.fn();
const loadProofIndex = jest.fn();
jest.mock('book-index-ui', () => ({ createTextApi: () => ({}), adaptCharCord: () => [] }));
jest.mock('@/lib/transport', () => ({ getTransport: () => ({}) }));
jest.mock('@/components/common/SourceContext', () => ({ useSource: () => ({ source: 'cos' }) }));
jest.mock('@/lib/duidu-data', () => ({ getJson: async () => null }));
jest.mock('@/lib/facsimile', () => ({ loadFacsimile: (...a: unknown[]) => loadFacsimile(...a) }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <>{children}</>);
jest.mock('@/lib/proofing', () => ({ ...jest.requireActual('@/lib/proofing'), loadProofing: (...a: unknown[]) => loadProofing(...a), loadProofIndex: () => loadProofIndex() }));

import ProofingClient from '../ProofingClient';

const img = (x: number) => ({ s: 'p0009.webp', x, y: 0, w: 96, h: 96 });
const ok = (cells: unknown[]) => ({ status: 'ok', pending: { rev: 'r1', cells }, cord: null, versionKey: 'default', pendingFile: '001.pending.json' });

// jsdom 不加载图片：按 src 触发 onload／onerror
let failUrls: RegExp | null = null;
beforeEach(() => {
    loadProofing.mockReset();
    loadFacsimile.mockReset().mockResolvedValue([]);
    loadProofIndex.mockReset().mockResolvedValue(null);
    failUrls = null;
    localStorage.clear();                                       // 「只看还没回应的」缺省勾着：别让上一个用例记的「已提交」把卡藏了
    Object.defineProperty(global.Image.prototype, 'src', {
        configurable: true,
        set(this: HTMLImageElement, v: string) {
            setTimeout(() => (failUrls?.test(v) ? this.onerror?.(new Event('error')) : this.onload?.(new Event('load'))), 0);
        },
    });
});
afterEach(cleanup);

describe('精校页显示（GUJI-557）', () => {
    it('0 格且总表没列这一章：说名单还没发布，不说已校完', async () => {
        loadProofing.mockResolvedValue(ok([]));
        render(<ProofingClient book="b1" vol="005" />);
        await screen.findByText('这一章的待校对名单还没有发布，请稍后再来。');
        expect(screen.queryByText('这一章的字都已校完，谢谢！')).toBeNull();
    });

    it('0 格且总表列了这一章（n=0）：才说已校完', async () => {
        loadProofIndex.mockResolvedValue({ b1: { '001': { rev: 'r1', n: 0 } } });
        loadProofing.mockResolvedValue(ok([]));
        render(<ProofingClient book="b1" vol="001" />);
        await screen.findByText('这一章的字都已校完，谢谢！');
    });

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

    it('why：「原因：」加短语，未知码不露英文；ref 显示「整理本作 X」；候选带分数，多的在「更多」里', async () => {
        loadProofing.mockResolvedValue(ok([{
            a: '1:1:1', c: '己', why: ['none', 'future_code'], ref: { c: '已' }, cand: [{ c: '己' }, { c: '已' }],
            libTop: [{ c: '巳', s: 0.7 }, { c: '以', s: 0.6 }, { c: '目', s: 0.5 }, { c: '日', s: 0.4 }],
        }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        const why = (await screen.findByTestId('why')).textContent ?? '';
        expect(why).toBe('原因：其他疑点');
        expect(why).not.toMatch(/[A-Za-z]/);
        expect(screen.getByText(/整理本作「已」/)).toBeTruthy();
        expect(screen.getByText('像 70%')).toBeTruthy();
        expect(screen.queryByText('以')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^还有 \d+ 个$/ }));
        expect(screen.getByText('以')).toBeTruthy();
    });

    it("why 只有 none 时显示『原因：机器没把握』，不回退显示 cls 原值", async () => {
        loadProofing.mockResolvedValue(ok([{ a: '2:1:1', c: '天', why: ['none'], cls: 'other', cand: [{ c: '夭' }] }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        const t = (await screen.findByTestId('why')).textContent;
        expect(t).toBe('原因：机器没把握');
        expect(t).not.toContain('other');
    });

    it('stale 预选其字，不自动提交；occ 不预选「图上没有字」', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '己', stale: { c: '已' } }, { a: '1:1:2', c: '日', occ: { refBlank: true } }]));
        render(<ProofingClient book="b1" vol="vol01" />);
        await screen.findByText(/以前有人判为「已」/);
        expect(screen.queryByText(/先替你选了「图上没有字」/)).toBeNull();
        for (const b of screen.getAllByRole('button', { name: '图上没有字' })) expect(b.getAttribute('aria-pressed')).toBe('false');
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

    // 相似字（以字找字，用户 10-19）：出待审单时算好，页面只显示；缺省展开 10 个
    const alt = Array.from({ length: 14 }, (_, i) => ({
        c: String.fromCodePoint(0x5f0a + i), s: 0.9 - i * 0.01, p: '弊', src: 'v', g: { s: 'alt-001.webp', x: i * 96, y: 0, w: 96, h: 96 },
    }));

    it('alt 有就显示相似字：缺省 10 个带字形图，「再看 4 个」展开全部；点一个就提交', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '弊', alt }]));
        render(<ProofingClient book="b5" vol="vol01" />);
        const grid = await screen.findByTestId('alt-grid');
        expect(grid.querySelectorAll('button[aria-label^="选「"]')).toHaveLength(10);
        expect(grid.querySelector('[role=img]')?.getAttribute('style')).toContain('alt-001.webp');
        fireEvent.click(screen.getByRole('button', { name: '再看 4 个' }));
        expect(grid.querySelectorAll('button[aria-label^="选「"]')).toHaveLength(14);
        fireEvent.click(screen.getByRole('button', { name: `选「${alt[2].c}」` }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({ choice: 'char', char: alt[2].c, pick_src: 'alt', pick_rank: 3, pivot: '弊' });
    });

    it('本站字体显示不出来的字（私用区、Jigmo 缺的 U+2B81E 等）显示码位，悬停是原字；提交的仍是原字', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        const g = '\u{2B81E}';                                  // 扩 D 里 Jigmo 唯一缺的字
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: g, ref: { c: g }, cand: [{ c: g }], alt: [{ c: g, s: 0.9, p: '弊' }, { c: '弊', s: 0.8 }] }]));
        render(<ProofingClient book="b10" vol="vol01" />);
        const grid = await screen.findByTestId('alt-grid');
        expect(grid.textContent).toContain('U+2B81E');
        expect(grid.textContent).not.toContain(g);
        expect(screen.getByText(/整理本作「U\+2B81E」/)).toBeTruthy();
        const cps = screen.getAllByTestId('zi-cp');
        expect(cps.length).toBeGreaterThanOrEqual(3);
        expect(cps[0].getAttribute('title')).toBe(g);
        // 候选按钮、相似字按钮的无障碍名称都是原字（读屏不念码位）
        const named = screen.getAllByRole('button', { name: `选「${g}」` });
        expect(named.length).toBe(2);
        fireEvent.click(named[1]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({ char: g, pick_src: 'alt', pick_rank: 1 });
    });

    it('不再每卡常驻特殊符号；cv 给的候选里有符号才出现；字和下面四项可以同时交，备注交过也能改（用户 10-21）', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        localStorage.clear();                                   // 别的用例在同一 rev 下记过「已提交」
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '', cand: [{ c: '口' }, { c: '○' }] }, { a: '1:1:2', c: '日', cand: [{ c: '曰' }] }]));
        render(<ProofingClient book="b11" vol="vol01" />);
        await screen.findAllByTestId('cell-card');
        expect(screen.queryByTestId('symbols')).toBeNull();
        expect(screen.queryAllByRole('button', { name: /^□/ })).toHaveLength(0);
        const body = (i: number) => JSON.parse(fetchSpy.mock.calls[i][1].body);
        // 先点「切分错了」：不跳卡，接着给字
        fireEvent.click(screen.getAllByRole('button', { name: '切分错了' })[0]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(body(0)).toMatchObject({ a: '1:1:1', choice: 'cut' });
        expect(body(0).char).toBeUndefined();
        expect((await screen.findByTestId('done-badge')).textContent).toBe('已提交');
        fireEvent.click(screen.getByRole('button', { name: '○' }));          // 候选里的符号照常点
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(body(1)).toMatchObject({ a: '1:1:1', choice: 'cut', char: '○', pick_src: 'cand', pick_rank: 2 });
        const card = screen.getAllByTestId('cell-card')[0];
        await waitFor(() => expect([...card.querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent)).toEqual(['○', '切分错了']));
        expect(screen.getAllByRole('button', { name: '切分错了' })[0].getAttribute('aria-pressed')).toBe('true');
        // 换成「小注被当成正文切了」：字还带着
        fireEvent.click(screen.getAllByRole('button', { name: '小注被当成正文切了' })[0]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
        expect(body(2)).toMatchObject({ a: '1:1:1', choice: 'jiazhu', char: '○' });
        // 交过之后改备注：照原来的字和项再交
        fireEvent.change(screen.getAllByLabelText('备注')[0], { target: { value: '是圈不是口' } });
        fireEvent.click(screen.getByRole('button', { name: '更新备注' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
        expect(body(3)).toMatchObject({ a: '1:1:1', choice: 'jiazhu', char: '○', note: '是圈不是口' });
        expect(screen.queryByRole('button', { name: '更新备注' })).toBeNull();
        // 再点一次已选的项＝取消，只留字
        fireEvent.click(screen.getAllByRole('button', { name: '小注被当成正文切了' })[0]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(5));
        expect(body(4)).toMatchObject({ a: '1:1:1', choice: 'char', char: '○', note: '是圈不是口' });
        // 先选字再点「图上没有字」也带字
        fireEvent.click(screen.getByRole('button', { name: '曰' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(6));
        fireEvent.click(screen.getAllByRole('button', { name: '图上没有字' })[1]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(7));
        expect(body(6)).toMatchObject({ a: '1:1:2', choice: 'none', char: '曰', pick_src: 'cand', pick_rank: 1 });
        localStorage.clear();                                   // 别让后面的用例以为这两格回应过
    });

    it('提交带上选字来源：候选按钮第几个、机器读字、自己写；「图上没有字」带上已选的字和来源', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '未', cand: [{ c: '己' }, { c: '已' }] }]));
        render(<ProofingClient book="b9" vol="vol01" />);
        const body = (i: number) => JSON.parse(fetchSpy.mock.calls[i][1].body);
        fireEvent.click(await screen.findByRole('button', { name: '已' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(body(0)).toMatchObject({ char: '已', pick_src: 'cand', pick_rank: 2 });
        fireEvent.click(screen.getByRole('button', { name: '未' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(body(1)).toMatchObject({ char: '未', pick_src: 'machine' });
        expect(body(1).pick_rank).toBeUndefined();
        fireEvent.change(screen.getByLabelText('另写一字'), { target: { value: '末' } });
        fireEvent.click(screen.getByRole('button', { name: '提交这个字' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
        expect(body(2)).toMatchObject({ char: '末', pick_src: 'custom' });
        fireEvent.click(screen.getByRole('button', { name: '图上没有字' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(4));
        expect(body(3)).toMatchObject({ choice: 'none', char: '末', pick_src: 'custom' });
    });

    it('GUJI-683：整理本字是第一个候选并标「整理本」；没机器字不放大「？」；夹注档按真实含义写；备注随提交带上', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', ref: { c: '臼' }, libTop: [{ c: '曰', s: 0.9 }], ctx: { c: '曰' } }]));
        render(<ProofingClient book="b10" vol="vol01" />);
        const card = (await screen.findAllByTestId('cell-card'))[0];
        const refBtn = await screen.findByRole('button', { name: /^臼/ });
        expect(refBtn.querySelector('[data-testid=cand-ref]')?.textContent).toBe('整理本');
        expect(card.querySelector('[data-testid=no-machine-char]')).toBeTruthy();
        expect(card.textContent).not.toContain('看前后文');              // 上下文字＝库首选，只是回声
        expect(screen.queryByRole('button', { name: '这是夹注小字' })).toBeNull();
        expect(screen.getByRole('button', { name: '小注被当成正文切了' })).toBeTruthy();
        fireEvent.change(screen.getByLabelText('备注'), { target: { value: '  看上面一横  ' } });
        fireEvent.click(refBtn);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({ char: '臼', note: '看上面一横', pick_src: 'cand', pick_rank: 1 });
    });

    it('GUJI-689：快捷键选候选／四档、j 换卡；回应后自动跳到下一张没回应的；只看未回应；切分错了带上框里的字', async () => {
        const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        loadProofing.mockResolvedValue(ok([
            { a: '1:1:1', c: '己', cand: [{ c: '己' }, { c: '已' }] },
            { a: '1:1:2', c: '日', cand: [{ c: '曰' }] },
            { a: '1:1:3', c: '人', cand: [{ c: '入' }] },
        ]));
        render(<ProofingClient book="b11" vol="vol01" />);
        const body = (i: number) => JSON.parse(fetchSpy.mock.calls[i][1].body);
        const sel = () => screen.getAllByTestId('cell-card').find(el => el.getAttribute('data-selected') === '1')?.id;
        await screen.findAllByTestId('cell-card');
        expect(screen.getByTestId('hotkey-hint').textContent).toContain('1–9');
        expect(sel()).toBe('cell-1:1:1');
        fireEvent.keyDown(document, { key: '2' });                    // 第 2 个候选「已」
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(body(0)).toMatchObject({ a: '1:1:1', char: '已', pick_src: 'cand', pick_rank: 2 });
        await waitFor(() => expect(sel()).toBe('cell-1:1:2'));        // 自动跳到下一张
        fireEvent.keyDown(document, { key: 'j' });
        expect(sel()).toBe('cell-1:1:3');
        fireEvent.keyDown(document, { key: 'k' });
        expect(sel()).toBe('cell-1:1:2');
        fireEvent.keyDown(document, { key: 'n' });                    // 图上没有字
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(body(1)).toMatchObject({ a: '1:1:2', choice: 'none' });
        // 输入框里打字不触发快捷键；切分错了带上框里的一个字
        const input = screen.getAllByLabelText('另写一字')[2];
        fireEvent.keyDown(input, { key: 'n' });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        fireEvent.change(input, { target: { value: '入' } });
        fireEvent.click(screen.getAllByRole('button', { name: '切分错了' })[2]);
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
        expect(body(2)).toMatchObject({ a: '1:1:3', choice: 'cut', char: '入' });
        // 只看未回应缺省勾着，但刚回应的卡留在原地；关掉再勾上（三张都回应过了）→ 一张不剩
        expect(screen.getByTestId('only-open')).toBeChecked();
        expect(screen.queryAllByTestId('cell-card')).toHaveLength(3);
        fireEvent.click(screen.getByTestId('only-open'));
        fireEvent.click(screen.getByTestId('only-open'));
        await waitFor(() => expect(screen.queryAllByTestId('cell-card')).toHaveLength(0));
    });

    it('相似字的字形图没传上去就只显示字；没有 alt 不渲染', async () => {
        failUrls = /alt-001/;
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '弊', alt: alt.slice(0, 3) }, { a: '1:1:2', c: '日' }]));
        render(<ProofingClient book="b6" vol="vol01" />);
        const grid = await screen.findByTestId('alt-grid');
        await waitFor(() => expect(grid.querySelector('[role=img]')).toBeNull());
        expect(grid.textContent).toContain(alt[0].c);
        expect(screen.getAllByTestId('alt-grid')).toHaveLength(1);
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

describe('只看还没回应的（缺省勾上，用户 10-24）', () => {
    it('打开时已回应过的格藏起来；取消勾选就回来', async () => {
        localStorage.setItem('kyg-cr-done:r1', JSON.stringify({ '1:1:1': '「甲」' }));
        loadProofing.mockResolvedValue(ok([{ a: '1:1:1', c: '甲' }, { a: '1:1:2', c: '乙' }]));
        render(<ProofingClient book="b7" vol="vol01" />);
        await waitFor(() => expect(screen.queryAllByTestId('cell-card')).toHaveLength(1));
        expect(screen.getByTestId('only-open')).toBeChecked();
        fireEvent.click(screen.getByTestId('only-open'));
        await waitFor(() => expect(screen.queryAllByTestId('cell-card')).toHaveLength(2));
    });
});

describe('复审格（cv republish --recheck）', () => {
    it('说明和已有判断常显在机器判断最前面，不用展开', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '9:7:17', c: '由', note: '旧裁 山，新票 由，请定', prior: { c: '山', ts: '2026-10-22T08:00:00Z' } }]));
        render(<ProofingClient book="b5" vol="vol01" />);
        expect((await screen.findByTestId('recheck-note')).textContent).toContain('再看一次：旧裁 山，新票 由，请定');
        expect(screen.getByTestId('recheck-prior').textContent).toContain('2026-10-22 判为「山」。这次提交的选择会替代它');
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

describe('精校页：是图形，不是字（char v0.3 图片格，GUJI-742）', () => {
    let fetchSpy: jest.Mock;
    beforeEach(() => {
        fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        (global as { fetch?: unknown }).fetch = fetchSpy;
        localStorage.clear(); // 已回应记录按 rev 存，别让上一条用例的「已提交」带过来
    });
    const body = (i: number) => JSON.parse(fetchSpy.mock.calls[i][1].body);

    it('卡上有「是图形，不是字」与用法说明；点它先弹说明框，不直接提交', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '148:2:14', c: '口', cand: [{ c: '日' }] }]));
        render(<ProofingClient book="b12" vol="005" />);
        await screen.findAllByTestId('cell-card');
        expect(screen.getByTestId('figure-hint').textContent).toContain('只用于不是字的图形');
        expect(screen.getByTestId('figure-hint').textContent).toContain('看不清');
        expect(screen.queryByTestId('figure-box')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '是图形，不是字' }));
        expect(screen.getByTestId('figure-box')).toBeTruthy();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('填说明后提交：choice=figure、alt，不带字；快捷键 g 同样弹框', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '148:2:14', c: '口', cand: [{ c: '日' }] }]));
        render(<ProofingClient book="b12" vol="005" />);
        await screen.findAllByTestId('cell-card');
        fireEvent.keyDown(document, { key: 'g' });
        await screen.findByTestId('figure-box');
        fireEvent.change(screen.getByLabelText('图形说明'), { target: { value: ' 左半圈连一实点 ' } });
        fireEvent.click(screen.getByRole('button', { name: '提交：是图形' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(body(0)).toMatchObject({ book: 'b12', a: '148:2:14', choice: 'figure', alt: '左半圈连一实点' });
        expect(body(0).char).toBeUndefined();
        await waitFor(() => expect(screen.queryByTestId('figure-box')).toBeNull());
        expect(screen.getByTestId('done-badge')).toBeTruthy();
    });

    it('说明可空：不带 alt 也能提交；取消不提交', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '148:2:14', c: '口' }]));
        render(<ProofingClient book="b12" vol="005" />);
        await screen.findAllByTestId('cell-card');
        fireEvent.click(screen.getByRole('button', { name: '是图形，不是字' }));
        fireEvent.click(screen.getByRole('button', { name: '取消' }));
        expect(screen.queryByTestId('figure-box')).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: '是图形，不是字' }));
        fireEvent.click(screen.getByRole('button', { name: '提交：是图形' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        expect(body(0)).toMatchObject({ choice: 'figure' });
        expect(body(0).alt).toBeUndefined();
    });

    it('已交「是图形」后又选了字：改交 char，不再带图形', async () => {
        loadProofing.mockResolvedValue(ok([{ a: '148:2:14', c: '口', cand: [{ c: '日' }] }]));
        render(<ProofingClient book="b12" vol="005" />);
        await screen.findAllByTestId('cell-card');
        fireEvent.click(screen.getByRole('button', { name: '是图形，不是字' }));
        fireEvent.click(screen.getByRole('button', { name: '提交：是图形' }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        fireEvent.click(await screen.findByRole('button', { name: /日/ }));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        expect(body(1)).toMatchObject({ choice: 'char', char: '日' });
        expect(body(1).alt).toBeUndefined();
    });
});

