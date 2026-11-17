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
 * 对校设置（右下角对校浮条点「設置」展开）：选对照本（开／关）、各类差异的显示开关与条数、下标／简洁。
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
        <div data-testid="compare-settings" className="cmp-settings">
            <label className="cmp-field">
                <span className="cmp-field-label">{convert('對照本')}</span>
                <select value={targetId ?? ''} onChange={(e) => onTarget(e.target.value || null)} className="cmp-select">
                    <option value="">{convert('不對校')}</option>
                    {sources.map((s) => (
                        <option key={s.id} value={s.id}>{convert(s.label)}</option>
                    ))}
                </select>
            </label>
            {targetId && (
                <>
                    <div aria-live="polite" className="cmp-note" hidden={!(status === 'loading' || status === 'error' || (status === 'ready' && failed.length > 0))}>
                        {status === 'loading' && convert('正在比對…')}
                        {status === 'error' && convert('對照本暫時取不到，已按普通閱讀顯示')}
                        {status === 'ready' && failed.length > 0 && convert(`有 ${failed.length} 卷沒有對應的對照文本，未比對`)}
                    </div>
                    <div className="cmp-sub">{convert('顯示哪些差異（點按開關）')}</div>
                    <div role="group" aria-label={convert('顯示哪些差異')} className="cmp-chips">
                        {ALL_CATS.filter((c: DiffCat) => counts[c] > 0 || prefs.cats[c]).map((c) => {
                            const on = prefs.cats[c];
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => onPrefs({ ...prefs, cats: { ...prefs.cats, [c]: !on } })}
                                    className="cmp-chip"
                                    style={{ ['--c' as string]: CAT_COLOR[c] }}
                                >
                                    {convert(CAT_NAME[c])} <span className="cmp-chip-n">{counts[c]}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="cmp-sub">{convert('對照字的寫法')}</div>
                    <div role="group" aria-label={convert('標記方式')} className="cmp-seg">
                        {([['sub', '下標', '對照本的寫法排在字後'], ['simple', '簡潔', '只畫底線，點字看詳情']] as const).map(([m, label, tip]) => (
                            <button key={m} type="button" title={convert(tip)} aria-pressed={prefs.mode === m} onClick={() => onPrefs({ ...prefs, mode: m })}>
                                {convert(label)}
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
