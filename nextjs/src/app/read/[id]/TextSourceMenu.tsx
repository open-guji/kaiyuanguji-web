'use client';

import Link from 'next/link';
import { useConvert } from 'book-index-ui';
import { readerPath } from '@/lib/reader-route';
import { readTextLabel, readTextTitle, type ReadTextRow } from '@/lib/read-texts';

/**
 * 阅读页书名栏上方的「文本」条，分两组，一眼看出两者的关系：
 *   閱讀  [開源古籍自校本] [維基文庫]      對校  [關｜維基文庫｜殆知閣]
 * - 「閱讀」：同一部作品下各个条目已有的文本（本站自己整理的在前），点了换到那一份的阅读页（真链接，关掉 JS 也能点）。
 *   阅读器自带的选择框只管本条目内的版本，作品下别的条目的文本要靠这里。
 * - 「對校」：以正在读的这一份为底本，选一个对照本逐字比对（开关是同一组按钮里的「關」）。
 *   只在本站自己整理的那份（有逐字格位）上出；读的是别家来源时给一句提示，点了回到自校本。
 * 只有一份来源、又没有可对校的版本时不出（调用方判断）。
 */
export default function TextSourceMenu({ currentId, rows, compareId = null, compareKey = null, siblings = [], onCompare }: {
    currentId: string;
    rows: ReadTextRow[];
    /** 正在对校的对照本条目 id（对照本是本书另一个版本时＝本条目 id）；没开为 null */
    compareId?: string | null;
    /** 正在对校的对照本版本 key（对照本是本书另一个版本时才有） */
    compareKey?: string | null;
    /** 本书的其他可对校版本（如光盘本）：章文件与底本一一对应 */
    siblings?: { key: string; label: string }[];
    /** 选对照本：传对照本开始，传 null 结束。不传就不出「對校」组 */
    onCompare?: (t: { id: string; key?: string } | null) => void;
}) {
    const { convert } = useConvert();
    const cur = rows.find((x) => x.id === currentId);
    const own = cur?.own === true || (rows.length === 0 && siblings.length > 0);
    // 对照本：作品下别的来源（条目）＋本书的其他版本
    const options = [
        ...rows.filter((r) => r.id !== currentId).map((r) => ({ key: r.id, label: r.label, t: { id: r.id }, on: compareId === r.id, sibling: false })),
        ...siblings.map((v) => ({ key: `${currentId}-${v.key}`, label: v.label, t: { id: currentId, key: v.key }, on: compareId === currentId && compareKey === v.key, sibling: true })),
    ];
    const comparing = options.some((o) => o.on);
    const ownRow = rows.find((x) => x.own);
    return (
        <nav aria-label={convert('文本来源')} data-testid="text-source" className="src-bar" data-comparing={comparing ? '' : undefined}>
            {rows.length > 1 && (
                <div className="src-group" role="group" aria-label={convert('閱讀哪一份文本')}>
                    <span className="src-label">{convert('閱讀')}</span>
                    {rows.map((r) => {
                        const on = r.id === currentId;
                        return (
                            <Link
                                key={r.id}
                                href={readerPath(r.id)}
                                aria-current={on ? 'true' : undefined}
                                title={readTextTitle(r) ? convert(readTextTitle(r)!) : undefined}
                                className="src-pill"
                            >
                                {convert(readTextLabel(r))}
                                {on && comparing && <span className="src-pill-tag">{convert('底本')}</span>}
                            </Link>
                        );
                    })}
                </div>
            )}
            {onCompare && options.length > 0 && (own ? (
                <div className="src-group" role="group" aria-label={convert('與哪一份對校')}>
                    <span className="src-label">{convert('對校')}</span>
                    <span className="src-seg">
                        <button type="button" data-testid="compare-off" aria-pressed={!comparing} onClick={() => onCompare(null)}>
                            {convert('關')}
                        </button>
                        {options.map((o) => (
                            <button
                                key={o.key}
                                type="button"
                                data-testid={o.sibling ? 'compare-sibling-button' : 'compare-button'}
                                aria-pressed={o.on}
                                title={convert(o.on ? '退出對校' : `以本頁為底本，與「${o.label}」逐字對校`)}
                                onClick={() => onCompare(o.on ? null : o.t)}
                            >
                                {convert(o.label)}
                            </button>
                        ))}
                    </span>
                </div>
            ) : ownRow ? (
                <div className="src-group">
                    <span className="src-label">{convert('對校')}</span>
                    <Link href={readerPath(ownRow.id)} className="src-hint">{convert(`在「${ownRow.label}」上可逐字對校 →`)}</Link>
                </div>
            ) : null)}
        </nav>
    );
}
