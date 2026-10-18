import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import CharFixEntry from '../CharFixEntry';
import { collectChars, collectEntities, entityFileVersion, entityIdsAt, isNewChar, reportableEntitiesAt, type CharFixCtx } from '@/lib/charfix';
import { LOCALE_STORAGE_KEY } from '@/lib/site-locale';

const ctx: CharFixCtx = {
    book: '96mid1ogzk', volume: '002', chapter: '002', textVersion: '1.0.0',
    chars: new Map([['4:3:8', '於'], ['4:3:9a', '天'], ['5:1:1', '王']]),
    entities: [{ id: 'e00001', start: '4:3:7', end: '4:3:9', text: '紀昀於' }],
    entityVersion: '1.8.12',
};

afterEach(() => { localStorage.clear(); jest.restoreAllMocks(); });

function Host({ withCtx = true, fetchImpl, c = ctx }: { withCtx?: boolean; fetchImpl?: typeof fetch; c?: CharFixCtx }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <>
            <div ref={ref}>
                <span data-char-id="4:3:8">於</span>
                <span data-char-id="4:3:9a">天</span>
                <span data-char-id="bad">x</span>
                <span data-char-id="5:1:1">王</span>
                <span id="punct">。</span>
            </div>
            <CharFixEntry containerRef={ref} getCtx={() => (withCtx ? c : null)} fetchImpl={fetchImpl} />
        </>
    );
}

describe('CharFixEntry', () => {
    it('点对读字：字旁浮出「第 4 页 3 列 8 格「於」［改字］」；点标点或非法格位不出', () => {
        render(<Host />);
        fireEvent.click(document.getElementById('punct')!);
        expect(screen.queryByRole('toolbar')).toBeNull();
        fireEvent.click(screen.getByText('x'));
        expect(screen.queryByRole('toolbar')).toBeNull();
        fireEvent.click(screen.getByText('於'));
        expect(screen.getByRole('toolbar').textContent).toContain('第 4 页 3 列 8 格「於」');
        fireEvent.click(screen.getByLabelText('关闭'));
        expect(screen.queryByRole('toolbar')).toBeNull();
    });

    it('浮条锚在字旁（fixed 定位），不是视口底部；滚动后收起，弹窗开着时不收', () => {
        render(<Host />);
        fireEvent.click(screen.getByText('於'));
        const bar = screen.getByRole('toolbar');
        expect(bar.style.left).not.toBe('');
        expect(bar.style.top).not.toBe('');
        expect(bar.style.bottom).toBe('');
        fireEvent.scroll(window);
        expect(screen.queryByRole('toolbar')).toBeNull();
        fireEvent.click(screen.getByText('於'));
        fireEvent.click(screen.getByRole('button', { name: '改字' }));
        fireEvent.scroll(window);
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('纯 .txt 章（没有改字上下文）不出入口', () => {
        render(<Host withCtx={false} />);
        fireEvent.click(screen.getByText('於'));
        expect(screen.queryByRole('toolbar')).toBeNull();
    });

    it('提交：POST /api/charfix，old_char 取 char.json 原字，entity_ids 按 anchor 命中算出；成功后显示谢谢', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
        render(<Host fetchImpl={fetchImpl as unknown as typeof fetch} />);
        fireEvent.click(screen.getByText('於'));
        fireEvent.click(screen.getByRole('button', { name: '改字' }));
        const submit = screen.getByRole('button', { name: '提交' });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByLabelText('建议字'), { target: { value: '于' } });
        fireEvent.change(screen.getByLabelText('依据'), { target: { value: '宋本作于' } });
        expect(submit).toBeEnabled();
        await act(async () => { fireEvent.click(submit); });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/api/charfix');
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({ kind: 'char', book_id: '96mid1ogzk', volume: '002', text_version: '1.0.0', cell_id: '4:3:8', old_char: '於', new_char: '于', basis: '宋本作于', entity_ids: ['e00001'] });
        expect(typeof body.aid).toBe('string');
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已收到'));
    });

    it('建议字与原字相同、多于一字都不能提交；组字式可以；服务端报错显示在弹窗里', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ success: false }) });
        render(<Host fetchImpl={fetchImpl as unknown as typeof fetch} />);
        fireEvent.click(screen.getByText('於'));
        fireEvent.click(screen.getByRole('button', { name: '改字' }));
        const input = screen.getByLabelText('建议字');
        const submit = screen.getByRole('button', { name: '提交' });
        for (const bad of ['於', '于乎']) {
            fireEvent.change(input, { target: { value: bad } });
            expect(submit).toBeDisabled();
        }
        fireEvent.change(input, { target: { value: '{{⿰虫斤}}' } });
        expect(submit).toBeEnabled();
        await act(async () => { fireEvent.click(submit); });
        expect(screen.getByRole('alert').textContent).toContain('太频繁');
    });
});

describe('专名有误（GUJI-590）', () => {
    it('字落在专名 anchor 区间里才出「专名有误」；区间外只有「改字」', () => {
        render(<Host />);
        fireEvent.click(screen.getByText('王'));
        expect(screen.queryByRole('button', { name: '专名有误' })).toBeNull();
        fireEvent.click(screen.getByText('於'));
        expect(screen.getByRole('button', { name: '专名有误' })).toBeTruthy();
        expect(screen.getByRole('button', { name: '改字' })).toBeTruthy();
    });

    it('本章没有专名层版本、或该条缺原文：不出入口（接口要 entity_version 与 text）', () => {
        const { unmount } = render(<Host c={{ ...ctx, entityVersion: '' }} />);
        fireEvent.click(screen.getByText('於'));
        expect(screen.queryByRole('button', { name: '专名有误' })).toBeNull();
        unmount();
        render(<Host c={{ ...ctx, entities: [{ ...ctx.entities[0], text: '' }] }} />);
        fireEvent.click(screen.getByText('於'));
        expect(screen.queryByRole('button', { name: '专名有误' })).toBeNull();
    });

    it('提交 kind=entity：带 entity_id＋volume＋chapter＋anchor 起止＋text＋entity_version＋note（GUJI-592 必填）', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
        render(<Host fetchImpl={fetchImpl as unknown as typeof fetch} />);
        fireEvent.click(screen.getByText('於'));
        fireEvent.click(screen.getByRole('button', { name: '专名有误' }));
        expect(screen.getByRole('dialog').textContent).toContain('「紀昀於」（第 4 页 3 列 7 格起）');
        const submit = screen.getByRole('button', { name: '提交' });
        expect(submit).toBeDisabled(); // note 必填
        fireEvent.change(screen.getByLabelText('哪里有误'), { target: { value: '「於」不在人名里' } });
        await act(async () => { fireEvent.click(submit); });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/api/charfix');
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
            kind: 'entity', book_id: '96mid1ogzk', volume: '002', chapter: '002', entity_id: 'e00001', entity_version: '1.8.12',
            anchor: { start: '4:3:7', end: '4:3:9' }, text: '紀昀於', note: '「於」不在人名里',
        });
        expect(body).not.toHaveProperty('target');
        await waitFor(() => expect(screen.getByRole('status').textContent).toContain('专名标注'));
    });

    it('一格落在几个专名里：弹窗里选是哪一个', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
        const c = { ...ctx, entities: [...ctx.entities, { id: 'e00002', start: '4:3:8', end: '4:3:8', text: '於' }] };
        render(<Host c={c} fetchImpl={fetchImpl as unknown as typeof fetch} />);
        fireEvent.click(screen.getByText('於'));
        fireEvent.click(screen.getByRole('button', { name: '专名有误' }));
        fireEvent.change(screen.getByLabelText('哪个专名'), { target: { value: '1' } });
        fireEvent.change(screen.getByLabelText('哪里有误'), { target: { value: 'x' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '提交' })); });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ entity_id: 'e00002', anchor: { start: '4:3:8', end: '4:3:8' } });
    });
});

describe('Sylvie 旁注（GUJI-590）', () => {
    it('缺 text_version：浮条照出，写明「暂不能改字」，没有「改字」按钮；专名意见照收', () => {
        render(<Host c={{ ...ctx, textVersion: '' }} />);
        fireEvent.click(screen.getByText('於'));
        const bar = screen.getByRole('toolbar');
        expect(bar.textContent).toContain('本章缺文本版本，暂不能改字');
        expect(screen.queryByRole('button', { name: '改字' })).toBeNull();
        expect(screen.getByRole('button', { name: '专名有误' })).toBeTruthy();
    });

    it('界面文字走站点字典：存了繁体偏好就是繁体', () => {
        localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-Hant');
        render(<Host />);
        fireEvent.click(screen.getByText('於'));
        expect(screen.getByRole('toolbar').textContent).toContain('第 4 頁 3 列 8 格');
        expect(screen.getByRole('button', { name: '專名有誤' })).toBeTruthy();
        expect(screen.getByLabelText('關閉')).toBeTruthy();
    });

    it('触屏：字贴视口底、下方放不下时浮条翻到字上方；上下都放不下时贴着视口底', () => {
        const vh = window.innerHeight;
        const BAR_H = 44;
        let charRect = { top: vh - 30, bottom: vh - 6, left: 100, right: 124, width: 24, height: 24 };
        const hadMM = 'matchMedia' in window;
        const prevMM = window.matchMedia;
        Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (q: string) => ({ matches: q.includes('coarse') }) });
        jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            if (this.classList.contains('og-cf-bar')) {
                const top = parseFloat((this as HTMLElement).style.top);
                const below = this.classList.contains('og-cf-bar--below');
                const y = below ? top : top - BAR_H;
                return { top: y, bottom: y + BAR_H, left: 40, right: 260, width: 220, height: BAR_H, x: 40, y } as DOMRect;
            }
            return { ...charRect, x: charRect.left, y: charRect.top } as DOMRect;
        });
        const { unmount } = render(<Host />);
        fireEvent.click(screen.getByText('於'));
        let bar = screen.getByRole('toolbar');
        expect(bar.classList.contains('og-cf-bar--below')).toBe(false);
        expect(parseFloat(bar.style.top)).toBe(charRect.top - 8);
        unmount();

        // 视口很矮：上方也放不下 → 留在下方，整条夹进视口
        charRect = { top: 40, bottom: 64, left: 100, right: 124, width: 24, height: 24 };
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100 });
        try {
            render(<Host />);
            fireEvent.click(screen.getByText('於'));
            bar = screen.getByRole('toolbar');
            expect(bar.classList.contains('og-cf-bar--below')).toBe(true);
            expect(parseFloat(bar.style.top) + BAR_H).toBeLessThanOrEqual(100 - 8);
        } finally {
            Object.defineProperty(window, 'innerHeight', { configurable: true, value: vh });
            if (hadMM) window.matchMedia = prevMM; else delete (window as { matchMedia?: unknown }).matchMedia;
        }
    });
});

describe('lib/charfix', () => {
    it('reportableEntitiesAt：只给 e\\d+ id、有原文的；没有 entity_version 全不给', () => {
        const c = { ...ctx, entities: [{ id: 'e1', start: '4:3:8', end: '4:3:8', text: '於' }, { id: 'hixhd1', start: '4:3:8', end: '4:3:8', text: '於' }, { id: 'e2', start: '4:3:8', end: '4:3:8', text: '' }] };
        expect(reportableEntitiesAt('4:3:8', c).map((e) => e.id)).toEqual(['e1']);
        expect(reportableEntitiesAt('4:3:8', { ...c, entityVersion: '' })).toEqual([]);
    });

    it('isNewChar：单字（含扩展区）与 {{组字式}}', () => {
        expect(isNewChar('𠀀')).toBe(true);
        expect(isNewChar('{{虫+斤}}')).toBe(true);
        expect(['', '于乎', '{{}}', '{{ a }}', null].some(isNewChar)).toBe(false);
    });

    it('entityIdsAt：按（页，列，格序）区间命中；起止同为夹注行时须在同一行；格位不合法为空', () => {
        const es = [{ id: 'e1', start: '4:5:10a', end: '4:5:13a', text: '' }, { id: 'e2', start: '4:3:7', end: '4:4:2', text: '' }];
        expect(entityIdsAt('4:5:11a', es)).toEqual(['e1']);
        expect(entityIdsAt('4:5:11b', es)).toEqual([]);
        expect(entityIdsAt('4:3:20', es)).toEqual(['e2']);
        expect(entityIdsAt('4:6:1', es)).toEqual([]);
        expect(entityIdsAt('oops', es)).toEqual([]);
    });

    it('collectChars／collectEntities：容忍坏数据', () => {
        const pages = [{ columns: [{ chars: [{ id: '1:1:1', char: '天' }, { id: 3 }, null] }] }, null];
        expect([...collectChars(pages)]).toEqual([['1:1:1', '天']]);
        expect(collectChars('x').size).toBe(0);
        expect(collectEntities({ entities: [{ id: 'e1', text: ' 王弼 ', anchor: { start: '1:1:1', end: '1:1:2' } }, { id: 'e2' }, { id: 'e3', anchor: { start: 'x', end: 'y' } }] })).toEqual([{ id: 'e1', start: '1:1:1', end: '1:1:2', text: '王弼' }]);
        expect(entityFileVersion({ version: '1.8.12' })).toBe('1.8.12');
        expect(entityFileVersion({ version: 1 })).toBe('');
        expect(collectEntities(null)).toEqual([]);
    });
});
