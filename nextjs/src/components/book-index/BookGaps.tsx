'use client';

import { useEffect, useState } from 'react';
import { useConvert, type IndexStorage } from 'book-index-ui';
import { collectBookGaps, type ChapterGaps } from '@/lib/book-gaps';
import { readerPath } from '@/lib/reader-route';
import { parseItemId } from '@/lib/item-id';

/**
 * 书介绍页的「缺页」：这本书（主版本）里各册／章声明了缺页的，逐条列出缺在哪一页之后、缺了什么。
 * 数据是章条目的 gaps_file（guji-gaps/0.1）；没有缺页或取不到就什么也不出。
 */
export default function BookGaps({ id, transport }: { id: string; transport: IndexStorage }) {
    const [rows, setRows] = useState<ChapterGaps[]>([]);
    const { convert } = useConvert();
    // 只有版本（Book）自己带文本；丛编、人物、作品页不取，免得多发请求（丛编页条目请求数有上限，detail-pages.spec）
    const isBook = parseItemId(id)?.type === 'book';
    useEffect(() => {
        if (!isBook) { setRows([]); return; }
        let alive = true;
        collectBookGaps(transport as never, id).then(r => { if (alive) setRows(r); });
        return () => { alive = false; };
    }, [id, transport, isBook]);
    if (rows.length === 0) return null;
    return (
        <details className="mt-2 text-sm" data-testid="book-gaps" open>
            <summary className="cursor-pointer font-semibold">{convert(`缺頁（${rows.reduce((n, r) => n + r.gaps.length, 0)} 處）`)}</summary>
            <ul className="mt-1 list-disc space-y-1 pl-5">
                {rows.map(r => r.gaps.map(g => (
                    <li key={`${r.chapter}-${g.afterPage}`}>
                        <a className="underline" href={readerPath(id, { chapter: r.chapter })}>{convert(r.title || r.chapter)}</a>
                        {convert(`　第 ${g.afterPage} 頁之後：${g.what}（${g.kind}${g.estChars ? `，約 ${g.estChars} 字` : ''}）`)}
                    </li>
                )))}
            </ul>
        </details>
    );
}
