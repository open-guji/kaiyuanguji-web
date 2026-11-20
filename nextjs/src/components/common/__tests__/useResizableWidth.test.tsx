import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { clampWidth, useResizableWidth } from '../useResizableWidth';

function Probe() {
    const rz = useResizableWidth('test-w', 200, 100, 400);
    return <div data-testid="h" tabIndex={0} onKeyDown={rz.onKeyDown} onDoubleClick={rz.reset}>{rz.width}</div>;
}

describe('useResizableWidth', () => {
    beforeEach(() => localStorage.clear());
    it('clampWidth 夹在范围内', () => {
        expect(clampWidth(50, 100, 400)).toBe(100);
        expect(clampWidth(999, 100, 400)).toBe(400);
    });
    it('读记住的宽度；键盘调整并记住；双击还原', () => {
        localStorage.setItem('test-w', '300');
        render(<Probe />);
        expect(screen.getByTestId('h').textContent).toBe('300');
        fireEvent.keyDown(screen.getByTestId('h'), { key: 'ArrowRight' });
        expect(screen.getByTestId('h').textContent).toBe('316');
        expect(localStorage.getItem('test-w')).toBe('316');
        fireEvent.doubleClick(screen.getByTestId('h'));
        expect(screen.getByTestId('h').textContent).toBe('200');
    });
});
