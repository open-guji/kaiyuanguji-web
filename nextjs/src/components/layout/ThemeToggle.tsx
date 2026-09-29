'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_THEME, THEMES, applyTheme, currentTheme, storeTheme, type ThemeName } from '../../lib/theme';

/**
 * 顶栏右上角的主题切换：两个色点（朱砂、靛藍），单选语义。
 * 首帧一律按默认渲染（与 SSR 一致），挂载后再从 <html> 读实际生效的主题——
 * <html> 上的属性由 <head> 里的防闪脚本在首帧前设好。
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const choose = (t: ThemeName) => {
    setTheme(applyTheme(t));
    storeTheme(t);
  };

  return (
    <div className="og-theme" role="radiogroup" aria-label="主題">
      {THEMES.map((t) => (
        <button
          key={t.name}
          type="button"
          role="radio"
          aria-checked={theme === t.name}
          aria-label={t.label}
          title={t.label}
          className={`og-theme-dot og-theme-dot--${t.name}`}
          onClick={() => choose(t.name)}
        />
      ))}
    </div>
  );
}
