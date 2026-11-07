'use client';

import Link from 'next/link';
import { useConvert } from 'book-index-ui';
import { readerPath } from '@/lib/reader-route';
import { readTextLabel, type ReadTextRow } from '@/lib/read-texts';

/**
 * 阅读页书名栏上方的「来源」条：同一部作品下各个条目已有的文本（本站自己整理的在前，其后维基文庫、别的来源……）。
 * 阅读器自带的选择框只管本条目内的版本，作品下别的条目的文本要靠这里。只有一份来源时不出（调用方判断）。
 * 点了换到那一份的阅读页（各条目独立地址 /read/<id>）；都是真链接，关掉 JS 也能点。
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
    /** 点「對校」：传对照本开始，传 null 结束。不传就不出按钮 */
    onCompare?: (t: { id: string; key?: string } | null) => void;
}) {
    const { convert } = useConvert();
    return (
        <nav
            aria-label={convert('文本来源')}
            data-testid="text-source"
            style={{
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px clamp(12px, 2vw, 24px)', fontSize: 13,
                borderBottom: '1px solid var(--color-tint-2, rgba(0,0,0,.08))', background: 'var(--color-paper, transparent)',
            }}
        >
            <span style={{ color: 'var(--color-ink-2, #666)' }}>{convert('来源')}</span>
            {rows.map((r) => {
                const on = r.id === currentId;
                // 「對校」只在本站自己整理的那份（有逐字格位）上出，对着作品下别的来源
                const canCompare = !!onCompare && !on && rows.find((x) => x.id === currentId)?.own === true;
                const comparing = compareId === r.id && !compareKey;
                return (
                    <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Link
                        href={readerPath(r.id)}
                        aria-current={on ? 'true' : undefined}
                        style={{
                            padding: '2px 10px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap',
                            border: '1px solid var(--color-tint-2, rgba(0,0,0,.18))',
                            background: on ? 'var(--color-zhu, #a33)' : 'transparent',
                            color: on ? '#fff' : 'var(--color-ink, #222)',
                        }}
                    >
                        {convert(readTextLabel(r))}
                    </Link>
                    {canCompare && (
                        <button
                            type="button"
                            data-testid="compare-button"
                            aria-pressed={comparing}
                            title={convert(comparing ? '退出對校' : `與「${r.label}」逐字對校`)}
                            onClick={() => onCompare!(comparing ? null : { id: r.id })}
                            className="cmp-source-btn"
                        >
                            {convert('對校')}
                        </button>
                    )}
                    </span>
                );
            })}
            {onCompare && rows.find((x) => x.id === currentId)?.own === true && siblings.map((v) => {
                const comparing = compareId === currentId && compareKey === v.key;
                return (
                    <button
                        key={v.key}
                        type="button"
                        data-testid="compare-sibling-button"
                        aria-pressed={comparing}
                        title={convert(comparing ? '退出對校' : `與「${v.label}」逐字對校`)}
                        onClick={() => onCompare(comparing ? null : { id: currentId, key: v.key })}
                        className="cmp-source-btn"
                    >
                        {convert(`對校 · ${v.label}`)}
                    </button>
                );
            })}
        </nav>
    );
}
