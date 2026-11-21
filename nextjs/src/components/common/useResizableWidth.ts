'use client';
// 侧栏宽度可拖：返回当前宽度、拖拽条的事件，宽度记在 localStorage（读不到就用默认值）。键盘左右键也能调。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export function clampWidth(w: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(w)));
}

export function useResizableWidth(key: string, def: number, min: number, max: number) {
    const [width, setWidth] = useState(def);
    const widthRef = useRef(def);
    const apply = useCallback((w: number, save: boolean) => {
        const v = clampWidth(w, min, max);
        widthRef.current = v;
        setWidth(v);
        if (save) { try { localStorage.setItem(key, String(v)); } catch { /* 无存储就不记 */ } }
    }, [key, min, max]);
    useEffect(() => {
        try {
            const n = Number(localStorage.getItem(key));
            if (n) apply(n, false);
        } catch { /* ignore */ }
    }, [key, apply]);
    const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = widthRef.current;
        const move = (ev: globalThis.PointerEvent) => apply(startW + ev.clientX - startX, false);
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            apply(widthRef.current, true);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }, [apply]);
    const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            apply(widthRef.current + (e.key === 'ArrowRight' ? 16 : -16), true);
        }
    }, [apply]);
    const reset = useCallback(() => apply(def, true), [apply, def]);
    return { width, onPointerDown, onKeyDown, reset };
}
