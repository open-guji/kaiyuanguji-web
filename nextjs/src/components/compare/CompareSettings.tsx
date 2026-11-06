'use client';

import type { CompareItem, SegResult } from '@/lib/compare/compare';
import type { DiffCat } from '@/lib/compare/classify';
import { ALL_CATS } from '@/lib/compare/classify';
import { CAT_NAME, countByCat } from '@/lib/compare/decorate';
import type { ComparePrefs } from '@/lib/compare/prefs';
import { CAT_COLOR } from './cat-colors';

export type CompareStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CompareSource {
    id: string;
    /** 来源名：「維基文庫」 */
    label: string;
}

/**
 * 「阅读设置」里的「对校」栏：选对照本（开／关）、各类差异的显示开关与条数、下标／简洁。
 * 纯展示组件：状态由宿主（对校插件）持有。
 */
export default function CompareSettings({ sources, targetId, onTarget, status, items, segments, prefs, onPrefs, convert = (s) => s }: {
    /** 可对校的来源（作品下除本份之外的全文） */
    sources: CompareSource[];
    /** 当前对照本；null＝没开对校 */
    targetId: string | null;
    onTarget: (id: string | null) => void;
    status: CompareStatus;
    items: readonly CompareItem[];
    segments: readonly SegResult[];
    prefs: ComparePrefs;
    onPrefs: (p: ComparePrefs) => void;
    convert?: (s: string) => string;
}) {
    const counts = countByCat(items);
    const failed = segments.filter((s) => s.status !== 'ok');
    return (
        <div data-testid="compare-settings" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--color-ink-2, #666)' }}>{convert('對照本')}</span>
                <select
                    value={targetId ?? ''}
                    onChange={(e) => onTarget(e.target.value || null)}
                    style={{ flex: 1, minWidth: 0, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--color-tint-2, rgba(0,0,0,.2))', background: 'transparent', color: 'inherit' }}
                >
                    <option value="">{convert('不對校')}</option>
                    {sources.map((s) => (
                        <option key={s.id} value={s.id}>{convert(s.label)}</option>
                    ))}
                </select>
            </label>
            {targetId && (
                <>
                    <div aria-live="polite" style={{ color: 'var(--color-ink-2, #666)' }}>
                        {status === 'loading' && convert('正在比對…')}
                        {status === 'error' && convert('對照本暫時取不到，已按普通閱讀顯示')}
                        {status === 'ready' && failed.length > 0 && convert(`有 ${failed.length} 卷沒有對應的對照文本，未比對`)}
                    </div>
                    <div role="group" aria-label={convert('顯示哪些差異')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {ALL_CATS.filter((c: DiffCat) => counts[c] > 0 || prefs.cats[c]).map((c) => {
                            const on = prefs.cats[c];
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => onPrefs({ ...prefs, cats: { ...prefs.cats, [c]: !on } })}
                                    style={{
                                        padding: '3px 10px', borderRadius: 999, cursor: 'pointer', font: 'inherit',
                                        border: `1px solid ${CAT_COLOR[c]}`, color: on ? '#fff' : CAT_COLOR[c], background: on ? CAT_COLOR[c] : 'transparent',
                                    }}
                                >
                                    {convert(CAT_NAME[c])} {counts[c]}
                                </button>
                            );
                        })}
                    </div>
                    <div role="group" aria-label={convert('標記方式')} style={{ display: 'flex', gap: 6 }}>
                        {([['sub', '下標'], ['simple', '簡潔']] as const).map(([m, label]) => (
                            <button
                                key={m}
                                type="button"
                                aria-pressed={prefs.mode === m}
                                onClick={() => onPrefs({ ...prefs, mode: m })}
                                style={{
                                    padding: '3px 12px', borderRadius: 6, cursor: 'pointer', font: 'inherit',
                                    border: '1px solid var(--color-tint-2, rgba(0,0,0,.25))',
                                    background: prefs.mode === m ? 'var(--color-zhu, #a33)' : 'transparent', color: prefs.mode === m ? '#fff' : 'inherit',
                                }}
                            >
                                {convert(label)}
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
