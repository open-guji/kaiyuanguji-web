import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import CharFixEntry from '../CharFixEntry';
import { collectChars, collectEntities, entityIdsAt, isNewChar, type CharFixCtx } from '@/lib/charfix';

const ctx: CharFixCtx = {
    book: '96mid1ogzk', volume: '002', textVersion: '1.0.0',
    chars: new Map([['4:3:8', '於'], ['4:3:9a', '天']]),
    entities: [{ id: 'e00001', start: '4:3:7', end: '4:3:9' }],
};

function Host({ withCtx = true, fetchImpl }: { withCtx?: boolean; fetchImpl?: typeof fetch }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <>
            <div ref={ref}>
                <span data-char-id="4:3:8">於</span>
                <span data-char-id="4:3:9a">天</span>
                <span data-char-id="bad">x</span>
                <span id="punct">。</span>
            </div>
            <CharFixEntry containerRef={ref} getCtx={() => (withCtx ? ctx : null)} fetchImpl={fetchImpl} />
        </>
    );
}

describe('CharFixEntry', () => {
    it('点对读字：底部浮出「第 4 頁 3 列 8 格「於」［改字］」；点标点或非法格位不出', () => {
        render(<Host />);
        fireEvent.click(document.getElementById('punct')!);
        expect(screen.queryByRole('toolbar')).toBeNull();
        fireEvent.click(screen.getByText('x'));
        expect(screen.queryByRole('toolbar')).toBeNull();
        fireEvent.click(screen.getByText('於'));
        expect(screen.getByRole('toolbar').textContent).toContain('第 4 頁 3 列 8 格「於」');
        fireEvent.click(screen.getByLabelText('關閉'));
        expect(screen.queryByRole('toolbar')).toBeNull();
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
        fireEvent.click(screen.getByText('改字'));
        const submit = screen.getByRole('button', { name: '提交' });
        expect(submit).toBeDisabled();
        fireEvent.change(screen.getByLabelText('建議字'), { target: { value: '于' } });
        fireEvent.change(screen.getByLabelText('依據'), { target: { value: '宋本作于' } });
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
        fireEvent.click(screen.getByText('改字'));
        const input = screen.getByLabelText('建議字');
        const submit = screen.getByRole('button', { name: '提交' });
        for (const bad of ['於', '于乎']) {
            fireEvent.change(input, { target: { value: bad } });
            expect(submit).toBeDisabled();
        }
        fireEvent.change(input, { target: { value: '{{⿰虫斤}}' } });
        expect(submit).toBeEnabled();
        await act(async () => { fireEvent.click(submit); });
        expect(screen.getByRole('alert').textContent).toContain('太頻繁');
    });
});

describe('lib/charfix', () => {
    it('isNewChar：单字（含扩展区）与 {{组字式}}', () => {
        expect(isNewChar('𠀀')).toBe(true);
        expect(isNewChar('{{虫+斤}}')).toBe(true);
        expect(['', '于乎', '{{}}', '{{ a }}', null].some(isNewChar)).toBe(false);
    });

    it('entityIdsAt：按（页，列，格序）区间命中；起止同为夹注行时须在同一行；格位不合法为空', () => {
        const es = [{ id: 'e1', start: '4:5:10a', end: '4:5:13a' }, { id: 'e2', start: '4:3:7', end: '4:4:2' }];
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
        expect(collectEntities({ entities: [{ id: 'e1', anchor: { start: '1:1:1', end: '1:1:2' } }, { id: 'e2' }, { id: 'e3', anchor: { start: 'x', end: 'y' } }] })).toEqual([{ id: 'e1', start: '1:1:1', end: '1:1:2' }]);
        expect(collectEntities(null)).toEqual([]);
    });
});
