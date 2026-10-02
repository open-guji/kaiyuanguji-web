'use client';

/**
 * 带候选下拉的检索框（overview#342）：首页、元数据首页共用。只管输入框和下拉，外面的 <form> 由页面自己写。
 *
 * - 输入时出条目候选（lib/search/suggest：调同站 /api/search，不引 book-index-ui，首页不变重）；
 *   空框聚焦出最近检索，与结果页的检索框共用历史。
 * - 选条目直接去 /item/<id>；选历史等于用这个词提交所在表单；没选中时回车照常提交表单。
 * - ↑↓ 选、回车确认、Esc 收起；输入法组字时的回车不算。取不到候选就不出下拉，检索不受影响。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { entryHref } from '@/lib/item-id';
import { useSiteT } from '@/i18n/use-site-t';
import {
    clearSearchHistory,
    fetchSuggestions,
    pushSearchHistory,
    readSearchHistory,
    removeSearchHistory,
    type SuggestEntry,
} from '@/lib/search/suggest';

/** 停手多久再请求：代理有边缘缓存，但逐字打仍会多发几次 */
const DEBOUNCE_MS = 120;

type Item = { kind: 'entry'; entry: SuggestEntry } | { kind: 'history'; text: string };

export interface SearchSuggestProps {
    value: string;
    onChange: (value: string) => void;
    name?: string;
    id?: string;
    placeholder?: string;
    'aria-label'?: string;
    /** 外层（定位容器）的 class／style；输入框的样式沿用页面原有选择器，或用 inputStyle */
    className?: string;
    style?: React.CSSProperties;
    inputStyle?: React.CSSProperties;
}

export default function SearchSuggest({
    value, onChange, name = 'q', id, placeholder, className, style, inputStyle, ...rest
}: SearchSuggestProps) {
    const t = useSiteT();
    const router = useRouter();
    const listId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const [history, setHistory] = useState<string[]>([]);
    const [entries, setEntries] = useState<SuggestEntry[]>([]);
    // 选了历史：等词写进框里（下一次渲染）再提交——首页的 onSubmit 读的是 state，元数据首页是原生 GET 读 DOM
    const submitPending = useRef(false);

    const q = value.trim();

    // 取候选：防抖＋丢弃过时的请求；失败当作没有候选
    useEffect(() => {
        setActive(-1);
        if (!open || !q) {
            setEntries([]);
            return;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => {
            fetchSuggestions(q, ctrl.signal)
                .then((list) => { if (!ctrl.signal.aborted) setEntries(list); })
                .catch(() => { if (!ctrl.signal.aborted) setEntries([]); });
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            ctrl.abort();
        };
    }, [q, open]);

    // 提交所在表单（回车、点按钮、选历史）都记进最近检索
    useEffect(() => {
        const form = inputRef.current?.form;
        if (!form) return;
        const onSubmit = () => {
            pushSearchHistory(inputRef.current?.value ?? '');
            setOpen(false);
        };
        form.addEventListener('submit', onSubmit);
        return () => form.removeEventListener('submit', onSubmit);
    }, []);

    useEffect(() => {
        if (!submitPending.current) return;
        submitPending.current = false;
        inputRef.current?.form?.requestSubmit();
    }, [value]);

    const items: Item[] = q
        ? entries.map((entry) => ({ kind: 'entry', entry }))
        : history.map((text) => ({ kind: 'history', text }));
    const expanded = open && items.length > 0;

    useEffect(() => {
        if (active < 0) return;
        listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
    }, [active]);

    const openList = useCallback(() => {
        setHistory(readSearchHistory());
        setOpen(true);
    }, []);

    const choose = useCallback((item: Item) => {
        setOpen(false);
        if (item.kind === 'entry') {
            router.push(entryHref(item.entry.id));
            return;
        }
        // 历史只在空框时出，词必与当前值不同，[value] 的 effect 一定会跑
        submitPending.current = true;
        onChange(item.text);
    }, [router, onChange]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp': {
                e.preventDefault();
                if (!expanded) { openList(); return; }
                const n = items.length;
                setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
                return;
            }
            case 'Enter':
                if (expanded && active >= 0 && active < items.length) {
                    e.preventDefault();
                    choose(items[active]);
                }
                return;
            case 'Escape':
                if (expanded) {
                    e.preventDefault();
                    setOpen(false);
                }
                return;
        }
    };

    const optionId = (i: number) => `${listId}-${i}`;

    return (
        <div className={`og-suggest${className ? ` ${className}` : ''}`} style={style}>
            <input
                ref={inputRef}
                id={id}
                type="search"
                name={name}
                value={value}
                placeholder={placeholder}
                aria-label={rest['aria-label']}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={expanded}
                aria-controls={listId}
                aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
                autoComplete="off"
                style={inputStyle}
                onChange={(e) => { onChange(e.target.value); setOpen(true); }}
                onFocus={openList}
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
            />
            {expanded && (
                <div className="og-suggest-pop">
                    {!q && (
                        <div className="og-suggest-head">
                            <span>{t('common.suggest.history')}</span>
                            <button
                                type="button"
                                tabIndex={-1}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { clearSearchHistory(); setHistory([]); }}
                            >
                                {t('common.suggest.clear')}
                            </button>
                        </div>
                    )}
                    <ul ref={listRef} id={listId} role="listbox" aria-label={t('common.suggest.label')}>
                        {items.map((item, i) => (
                            <li
                                key={item.kind === 'entry' ? item.entry.id : `h:${item.text}`}
                                id={optionId(i)}
                                role="option"
                                aria-selected={i === active}
                                className="og-suggest-item"
                                // 按下时不让输入框失焦，否则 onBlur 先把下拉收了，点不中
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => choose(item)}
                            >
                                {item.kind === 'entry' ? (
                                    <>
                                        <span className="og-suggest-type">{t(`common.suggest.types.${item.entry.type}`)}</span>
                                        <span className="og-suggest-title">{item.entry.title}</span>
                                        <span className="og-suggest-meta">
                                            {[item.entry.dynasty, item.entry.author].filter(Boolean).join(' ')}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <span className="og-suggest-title">{item.text}</span>
                                        <button
                                            type="button"
                                            tabIndex={-1}
                                            className="og-suggest-remove"
                                            aria-label={t('common.suggest.remove', { q: item.text })}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                removeSearchHistory(item.text);
                                                setHistory(readSearchHistory());
                                            }}
                                        >
                                            ×
                                        </button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
