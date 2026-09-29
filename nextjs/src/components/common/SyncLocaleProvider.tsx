'use client';

import { useContext, useMemo, type ComponentProps } from 'react';
import { LocaleContext, LocaleProvider } from 'book-index-ui';
import { Converter } from 'opencc-js/t2cn';

/**
 * 首屏就带繁→简转换的 LocaleProvider（overview#267，测试站 verify：出处名首屏是繁体、换版本后才变简体）。
 *
 * book-index-ui 的 LocaleProvider 在 effect 里才 `import('opencc-js/t2cn')` 出转换函数：
 * 服务端渲染和客户端首帧 converter 都是 null，数据里的繁体原样出（「維基文庫」），
 * 而界面文案（「来源」）已经是简体默认，两者不一致；模块加载完才转成「维基文库」。
 * 这里在 provider 里补一个同步可用的转换函数：简体模式下 converter 还没到就用它，服务端 HTML 与
 * 客户端首帧一致（都已转换，不会水合不一致）；组件库自己的 converter 到了以后交还给它。
 * 繁体模式（读者在 localStorage 里选过）不受影响，converter 仍是 null。
 *
 * 只用在阅读页：条目页、目录页的服务端 HTML 仍出数据原文，不在这次改动范围。
 * 代价：阅读页多带 opencc t2cn 词表（约 68 KB，gzip 后约 30 KB）。
 */

/** 与 book-index-ui 的 LocaleProvider 同一份「转换时原样保留」的名单（其内部常量 ml，未导出） */
const PROTECTED_NAMES = ['曹霑'];

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 逐字对照组件库的 xl：名单里的词整体不转，其余照转 */
function withProtectedNames(convert: (text: string) => string, names: string[]): (text: string) => string {
    const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!list.length) return convert;
    const re = new RegExp(`(${list.map(escapeRegExp).join('|')})`, 'g');
    const set = new Set(list);
    return (text) => {
        if (!text) return convert(text);
        const parts = text.split(re);
        return parts.length === 1
            ? convert(text)
            : parts.map((p, i) => (i % 2 === 1 && set.has(p) ? p : p && convert(p))).join('');
    };
}

let syncConverter: ((text: string) => string) | undefined;
function getSyncConverter() {
    syncConverter ??= withProtectedNames(Converter({ from: 'tw', to: 'cn' }), PROTECTED_NAMES);
    return syncConverter;
}

function SyncConverter({ children }: { children: React.ReactNode }) {
    const ctx = useContext(LocaleContext);
    const value = useMemo(
        () => (ctx && ctx.locale === 'zh-Hans' && !ctx.converter ? { ...ctx, converter: getSyncConverter() } : ctx),
        [ctx],
    );
    return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export default function SyncLocaleProvider(props: ComponentProps<typeof LocaleProvider>) {
    const { children, ...rest } = props;
    return (
        <LocaleProvider {...rest}>
            <SyncConverter>{children}</SyncConverter>
        </LocaleProvider>
    );
}
