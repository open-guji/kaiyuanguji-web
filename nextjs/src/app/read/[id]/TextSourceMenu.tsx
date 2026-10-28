'use client';

import { useRouter } from 'next/navigation';
import { useConvert } from 'book-index-ui';
import { readerPath } from '@/lib/reader-route';
import { readTextLabel, type ReadTextRow } from '@/lib/read-texts';

/**
 * 阅读页书名栏的「来源」选择：同一部作品下各个条目已有的文本（本站自己整理的在前，其后维基文庫、别的来源……）。
 * 阅读器自带的选择框只管本条目内的版本，作品下别的条目的文本要靠这里。只有一份来源时不出（调用方判断）。
 * 选了就整页换到那一份的阅读页（各条目独立地址，/read/<id>），不是同页换版本。
 */
export default function TextSourceMenu({ currentId, rows }: { currentId: string; rows: ReadTextRow[] }) {
    const router = useRouter();
    const { convert } = useConvert();
    return (
        <label data-testid="text-source" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ color: 'var(--color-ink-2, #666)' }}>{convert('来源')}</span>
            <select
                value={currentId}
                aria-label={convert('来源')}
                onChange={(e) => router.push(readerPath(e.target.value))}
                style={{
                    font: 'inherit', fontSize: 13, maxWidth: 260, padding: '2px 4px', cursor: 'pointer',
                    border: '1px solid var(--color-tint-2, rgba(0,0,0,.12))', borderRadius: 4,
                    background: 'transparent', color: 'var(--color-ink, #222)',
                }}
            >
                {rows.map((r) => <option key={r.id} value={r.id}>{convert(readTextLabel(r))}</option>)}
            </select>
        </label>
    );
}
