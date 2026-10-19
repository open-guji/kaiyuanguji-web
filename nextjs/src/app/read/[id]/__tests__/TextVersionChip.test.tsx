/**
 * 阅读器书名栏的版本号：默认只显示文本线，点按（或悬停）展开标点、专名。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('book-index-ui', () => ({ useConvert: () => ({ convert: (s: string) => s }) }));

import TextVersionChip, { textVersionsOf } from '../TextVersionChip';

describe('textVersionsOf', () => {
    it('三线都取', () => {
        expect(textVersionsOf({ text_version: '0.1.4', punct_version: '0.1.1', entity_version: '1.2.0' }))
            .toEqual({ text: '0.1.4', punct: '0.1.1', entity: '1.2.0' });
    });
    it('没有文本线就不出；别的线不合口径记为没有', () => {
        expect(textVersionsOf({ punct_version: '0.1.1' })).toBeUndefined();
        expect(textVersionsOf({ text_version: 'v1' })).toBeUndefined();
        expect(textVersionsOf({ text_version: '1.0.0', punct_version: 'x' })).toEqual({ text: '1.0.0', punct: undefined, entity: undefined });
        expect(textVersionsOf(undefined)).toBeUndefined();
    });
});

describe('TextVersionChip', () => {
    it('默认只显示文本版本，标点、专名收着', () => {
        render(<p><TextVersionChip versions={{ text: '0.1.4', punct: '0.1.1', entity: '0.1.1' }} /></p>);
        expect(screen.getByTestId('text-version').textContent).toBe('文本 v0.1.4');
        expect(screen.queryByTestId('text-version-pop')).toBeNull();
    });
    it('点一下展开三线，再点收起；按 Esc 也收起', () => {
        render(<p><TextVersionChip versions={{ text: '0.1.4', punct: '0.1.1' }} /></p>);
        const btn = screen.getByTestId('text-version');
        fireEvent.click(btn);
        const pop = screen.getByTestId('text-version-pop');
        expect(pop.textContent).toContain('标点v0.1.1');
        expect(pop.textContent).toContain('专名—');
        expect(pop.textContent).toContain('校对中');
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(btn);
        expect(screen.queryByTestId('text-version-pop')).toBeNull();
        fireEvent.click(btn);
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(screen.queryByTestId('text-version-pop')).toBeNull();
    });
    it('主版本号 1 写「可用」', () => {
        render(<p><TextVersionChip versions={{ text: '1.0.0' }} /></p>);
        fireEvent.click(screen.getByTestId('text-version'));
        expect(screen.getByTestId('text-version-pop').textContent).toContain('可用');
    });
});
