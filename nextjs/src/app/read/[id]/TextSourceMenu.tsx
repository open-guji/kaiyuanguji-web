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
export default function TextSourceMenu({ currentId, rows }: { currentId: string; rows: ReadTextRow[] }) {
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
                return (
                    <Link
                        key={r.id}
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
                );
            })}
        </nav>
    );
}
