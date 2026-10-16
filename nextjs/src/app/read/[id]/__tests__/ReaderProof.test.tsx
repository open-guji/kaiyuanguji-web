/**
 * @jest-environment jsdom
 *
 * overview#605 D1.2：校对模式标注层（mock 数据）。
 */
import { describe, it, expect } from '@jest/globals';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ReaderProof, { markedCells, proofCss, readProofPref, PROOF_PREF_KEY } from '../ReaderProof';
import { parseProof } from '@/lib/proof';

const LAYER = parseProof({
    cells: [
        { a: '1:1:1', c: '洪', method: 'ocr', review: 'pending', cand: ['鴻'] },
        { a: '1:1:2', method: 'cv:glyph', review: 'auto', cand: { lib: '範', ocr: '範', rare: '笵' } },
        { a: '1:1:3', c: '□', method: 'ocr', review: 'pending' },
        { a: '1:1:4', c: '書', method: 'manual', review: 'human' },
        { a: '-1', c: 'x', method: 'ocr', review: 'pending' },
    ],
});

function Host({ on }: { on: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <div ref={ref}>
            <div id="reader">
                {['1:1:1', '1:1:2', '1:1:3', '1:1:4', '1:1:5'].map(id => <span key={id} data-char-id={id}>字</span>)}
            </div>
            <ReaderProof layer={LAYER} hostRef={ref} on={on} onToggle={() => {}} />
        </div>
    );
}

async function mount(on: boolean) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<Host on={on} />); });
    return el;
}

describe('ReaderProof', () => {
    it('只标存疑字与缺字；auto／human 与框外格不标', () => {
        expect(markedCells(LAYER).map(c => c.a).sort()).toEqual(['1:1:1', '1:1:3']);
        const css = proofCss(markedCells(LAYER));
        expect(css).toContain('[data-char-id="1:1:1"]');
        expect(css).toContain('[data-char-id="1:1:3"]');
        expect(css).not.toContain('1:1:2');
        expect(css).not.toContain('1:1:4');
    });

    it('开关关着：不出样式、不改正文 DOM（正文区逐字节一致）', async () => {
        const off = await mount(false);
        const reader = off.querySelector('#reader')!.outerHTML;
        expect(off.querySelector('[data-proof-style]')).toBeNull();
        expect(reader).toBe('<div id="reader"><span data-char-id="1:1:1">字</span><span data-char-id="1:1:2">字</span><span data-char-id="1:1:3">字</span><span data-char-id="1:1:4">字</span><span data-char-id="1:1:5">字</span></div>');
        const on = await mount(true);
        // 打开后也只加样式，不改阅读器 DOM
        expect(on.querySelector('#reader')!.outerHTML).toBe(reader);
        expect(on.querySelector('[data-proof-style]')!.textContent).toContain('1:1:1');
    });

    it('悬停有数据的字出气泡，字段齐全；没数据的字不出', async () => {
        const el = await mount(true);
        const hover = async (id: string) => {
            const t = el.querySelector(`[data-char-id="${id}"]`)!;
            await act(async () => { t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        };
        await hover('1:1:1');
        const tip = el.querySelector('[data-proof-tip]')!;
        expect(tip.textContent).toContain('存疑字');
        expect(tip.textContent).toContain('洪');
        expect(tip.textContent).toContain('1:1:1');
        expect(tip.textContent).toContain('ocr');
        expect(tip.textContent).toContain('鴻');
        await hover('1:1:2');
        expect(el.querySelector('[data-proof-tip]')!.textContent).toContain('範（lib、ocr）');
        expect(el.querySelector('[data-proof-tip]')!.textContent).toContain('笵（rare）');
        await hover('1:1:5');
        expect(el.querySelector('[data-proof-tip]')).toBeNull();
        await hover('1:1:3');
        expect(el.querySelector('[data-proof-tip]')!.textContent).toContain('缺字');
    });

    it('键盘：下一处按钮跳到存疑字并出气泡', async () => {
        const el = await mount(true);
        (Element.prototype as any).scrollIntoView = () => {};
        const next = [...el.querySelectorAll('button')].find(b => b.textContent === '下一处')!;
        await act(async () => { next.click(); });
        expect(el.querySelector('[data-char-id="1:1:1"]')!.classList.contains('proof-focus')).toBe(true);
        expect(el.querySelector('[data-proof-tip]')).not.toBeNull();
    });

    it('偏好：URL 优先于本机；都没有＝null（不渲染）', () => {
        const st = (v: string | null) => ({ getItem: (k: string) => (k === PROOF_PREF_KEY ? v : null) });
        expect(readProofPref('', st(null))).toBeNull();
        expect(readProofPref('?proof=1', st(null))).toBe(true);
        expect(readProofPref('?proof=0', st('1'))).toBe(false);
        expect(readProofPref('', st('1'))).toBe(true);
        expect(readProofPref('?proof=x', st(null))).toBeNull();
        expect(readProofPref('', null)).toBeNull();
    });
});
