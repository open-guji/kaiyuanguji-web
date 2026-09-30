'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_LAYOUT, DEFAULT_THEME, LAYOUTS, THEMES, applyLayout, applyTheme, currentLayout, currentTheme,
  storeLayout, storeTheme, type LayoutName, type ThemeName,
} from '../../lib/theme';

/** 配色选项的小样：底色＋主色（设计稿「外观」面板） */
const SWATCH: Record<ThemeName, { bg: string; ac: string; hint: string }> = {
  zhusha: { bg: '#f6f3ec', ac: '#9c3a2c', hint: '宣纸底' },
  indigo: { bg: '#f4efe4', ac: '#2e5266', hint: '米白底' },
  ink: { bg: '#f5f5f3', ac: '#222221', hint: '素白底' },
};

/**
 * 顶栏「外观」面板（v4，overview#291 P0）：替换原来的两个主题圆点。
 * 版式两选（疏朗／界栏）＋配色三选（朱砂／靛青／墨），单选语义；设置存本浏览器（localStorage），全站通用。
 * 首帧一律按默认渲染（与 SSR 一致），挂载后再从 <html> 读实际生效的值（<head> 里的防闪脚本在首帧前设好）。
 * 键盘：Esc 关闭并把焦点还给按钮；点面板外关闭。
 */
export default function AppearancePicker() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);
  const [layout, setLayout] = useState<LayoutName>(DEFAULT_LAYOUT);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    setTheme(currentTheme());
    setLayout(currentLayout());
  }, []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const chooseTheme = (t: ThemeName) => {
    setTheme(applyTheme(t));
    storeTheme(t);
  };
  const chooseLayout = (l: LayoutName) => {
    setLayout(applyLayout(l));
    storeLayout(l);
  };

  return (
    <span className="og-look" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="og-look-btn"
        aria-label="外观设置"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" />
          <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
        </svg>
        <span className="og-look-label" aria-hidden="true">外观</span>
      </button>
      {open && (
        <div className="og-look-panel" id={panelId} role="group" aria-label="外观设置">
          <div className="og-look-sec">
            <span className="og-look-cap" id={`${panelId}-ly`}>版式</span>
            <div className="og-look-grid2" role="radiogroup" aria-labelledby={`${panelId}-ly`}>
              {LAYOUTS.map((l) => (
                <button
                  key={l.name}
                  type="button"
                  role="radio"
                  aria-checked={layout === l.name}
                  className="og-look-opt"
                  onClick={() => chooseLayout(l.name)}
                >
                  <span className={`og-look-ly og-look-ly--${l.name}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="og-look-name">
                    <span>{l.label}</span>
                    <span className="og-look-hint">{l.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="og-look-sec">
            <span className="og-look-cap" id={`${panelId}-th`}>配色</span>
            <div className="og-look-list" role="radiogroup" aria-labelledby={`${panelId}-th`}>
              {THEMES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.name}
                  className="og-look-opt"
                  onClick={() => chooseTheme(t.name)}
                >
                  <span className="og-look-sw" aria-hidden="true">
                    <i style={{ background: SWATCH[t.name].bg }} />
                    <i style={{ background: SWATCH[t.name].ac }} />
                  </span>
                  <span>{t.label}</span>
                  <span className="og-look-hint og-look-hint--r">{SWATCH[t.name].hint}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="og-look-note">设置保存在本浏览器，全站通用</p>
        </div>
      )}
    </span>
  );
}
