/**
 * @jest-environment jsdom
 *
 * overview#605 D1.2：校对模式标注层（mock 数据）。
 */
import { describe, it, expect } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createProofStore, markedCells, proofDecorations, proofPlugin, readProofPref, PROOF_PREF_KEY } from '../ReaderProof';
import { parseProof } from '@/lib/proof';
import { fakeApi, rect } from '@/test-utils/reader-fake-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ID = 'kyg:proof';
const LAYER = parseProof({
    cells: [
        { a: '1:1:1', c: '洪', method: 'ocr', review: 'pending', cand: ['鴻'] },
        { a: '1:1:2', method: 'cv:glyph', review: 'auto', cand: { lib: '範', ocr: '範', rare: '笵' } },
        { a: '1:1:3', c: '□', method: 'ocr', review: 'pending' },
        { a: '1:1:4', c: '書', method: 'manual', review: 'human' },
        { a: '-1', c: 'x', method: 'ocr', review: 'pending' },
    ],
});
const CELLS = ['1:1:1', '1:1:2', '1:1:3', '1:1:4', '1:1:5'].map(anchor => ({ anchor, char: '字' }));

/** 插件 + 一份已取到校对层的章状态；开关 on=true/false/null */
function setup(on: boolean | null) {
    const store = createProofStore(() => {});
    store.patch({ on });
    const plugin = proofPlugin(store);
    const f = fakeApi({
        cells: CELLS,
        state: { [ID]: { layer: LAYER, loaded: true } },
        rects: Object.fromEntries(CELLS.map((c, i) => [c.anchor, rect(10 * i, 20)])),
    });
    return { store, plugin, ...f };
}

async function mount(node: React.ReactNode) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<>{node}</>); });
    return el;
}

describe('校对插件（kyg:proof）', () => {
    it('只标存疑字与缺字；auto／human 与框外格不标', () => {
        expect(markedCells(LAYER).map(c => c.a).sort()).toEqual(['1:1:1', '1:1:3']);
        const d = proofDecorations(markedCells(LAYER), null);
        expect([...d.keys()].sort()).toEqual(['1:1:1', '1:1:3']);
        expect(d.get('1:1:1')).toMatchObject({ tone: 'warn', underline: 'dotted' });
        expect(d.get('1:1:3')).toMatchObject({ tone: 'muted', underline: 'dashed' });
    });

    it('开关关着（false／null）：不修饰任何字、浮层不渲染（null）或只有开关', async () => {
        for (const on of [false, null] as const) {
            const { plugin, api } = setup(on);
            expect(plugin.decorate!(api)).toBeUndefined();
        }
        const off = setup(null);
        expect((await mount(off.plugin.overlay!(off.api))).innerHTML).toBe('');
        const unchecked = setup(false);
        const el = await mount(unchecked.plugin.overlay!(unchecked.api));
        expect(el.querySelector('input[type=checkbox]')).not.toBeNull();
        expect(el.textContent).not.toContain('存疑');
    });

    it('开着：decorate 给存疑／缺字格；焦点格带 focus', () => {
        const { plugin, api, store } = setup(true);
        expect([...plugin.decorate!(api)!.keys()].sort()).toEqual(['1:1:1', '1:1:3']);
        store.patch({ focus: '1:1:3' });
        expect(plugin.decorate!(api)!.get('1:1:3')!.focus).toBe(true);
        expect(plugin.decorate!(api)!.get('1:1:1')!.focus).toBeUndefined();
    });

    it('悬停有数据的字出气泡，字段齐全；没数据的字不出', async () => {
        const { plugin, api } = setup(true);
        const el = await mount(plugin.overlay!(api));
        const hover = async (anchor: string | null) => {
            await act(async () => { plugin.onCell!.hover!(anchor ? { anchor, char: '字', rect: api.rectOf(anchor) } : null, api); });
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
        await hover(null);
        expect(el.querySelector('[data-proof-tip]')).toBeNull();
    });

    it('键盘：下一处按钮滚到存疑字、设焦点、出气泡', async () => {
        const { plugin, api, calls, store } = setup(true);
        const el = await mount(plugin.overlay!(api));
        const next = [...el.querySelectorAll('button')].find(b => b.textContent === '下一处')!;
        await act(async () => { next.click(); });
        expect(calls.scrollTo[0]).toEqual(['1:1:1', { block: 'center' }]);
        expect(store.get().focus).toBe('1:1:1');
        expect(calls.refresh).toContain(ID);
        expect(el.querySelector('[data-proof-tip]')).not.toBeNull();
        await act(async () => { next.click(); });
        expect(store.get().focus).toBe('1:1:3');
    });

    it('开关改变会要求重算修饰；onChapter 开着时取 proof_file', async () => {
        const { api, calls, store, plugin } = setup(false);
        await mount(plugin.overlay!(api));
        const before = calls.refresh.length;
        await act(async () => { store.patch({ on: true }); });
        expect(calls.refresh.length).toBeGreaterThan(before);
        // 没声明 proof_file 的章：取到空层，不抛
        const st = await plugin.onChapter!(api.ctx) as { loaded: boolean };
        expect(st.loaded).toBe(true);
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
