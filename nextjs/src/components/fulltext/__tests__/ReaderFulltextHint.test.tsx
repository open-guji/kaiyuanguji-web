import { createRef } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ReaderFulltextHint from '../ReaderFulltextHint';

function setup(search: string, chapter: string | null, bodyHtml = '<p>前文</p><p id="hit">子曰：學而時習之。</p>') {
    const host = document.createElement('div');
    host.innerHTML = bodyHtml;
    document.body.appendChild(host);
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
    ref.current = host;
    const scroll = jest.fn();
    host.querySelectorAll('p').forEach((p) => { (p as HTMLElement).scrollIntoView = scroll; });
    const utils = render(<ReaderFulltextHint hostRef={ref} chapter={chapter} search={search} />);
    return { host, scroll, ...utils };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('ReaderFulltextHint', () => {
    it('章匹配：把含查询词的段滚到视口中央，并显示提示', () => {
        const { scroll } = setup('?ft=001:3-8&ftq=' + encodeURIComponent('學而時習之'), '001');
        expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
        expect(screen.getByRole('status').textContent).toContain('學而時習之');
    });

    it('正文稍后才渲染出来：MutationObserver 等到了再滚', async () => {
        const { host, scroll } = setup('?ft=001:3-8&ftq=' + encodeURIComponent('甲乙'), '001', '<p>空</p>');
        expect(scroll).not.toHaveBeenCalled();
        await act(async () => {
            const p = document.createElement('p');
            p.textContent = '甲乙丙';
            p.scrollIntoView = scroll;
            host.appendChild(p);
        });
        expect(scroll).toHaveBeenCalledTimes(1);
    });

    it('无 ft：不渲染、不滚（阅读页行为不变）', () => {
        const { scroll, container } = setup('', '001');
        expect(scroll).not.toHaveBeenCalled();
        expect(container.innerHTML).toBe('');
    });

    it('ft 的章与当前章不一致：不定位', () => {
        const { scroll, container } = setup('?ft=002:3-8&ftq=' + encodeURIComponent('學而'), '001');
        expect(scroll).not.toHaveBeenCalled();
        expect(container.innerHTML).toBe('');
    });

    it('ftq 里是 HTML：只作文本显示，DOM 里没有该元素', () => {
        const { container } = setup('?ft=001:1-2&ftq=' + encodeURIComponent('<img src=x onerror=alert(1)>'), '001');
        expect(document.querySelector('img')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByRole('status').textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('可关闭提示', () => {
        setup('?ft=001:3-8&ftq=' + encodeURIComponent('學而'), '001');
        fireEvent.click(screen.getByRole('button'));
        expect(screen.queryByRole('status')).toBeNull();
    });
});
