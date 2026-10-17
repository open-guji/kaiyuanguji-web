'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const KEY = (id: string) => `kyg-proofing-notice:${id}`;

const read = (id: string): boolean => { try { return sessionStorage.getItem(KEY(id)) === 'closed'; } catch { return false; } };
const write = (id: string): void => { try { sessionStorage.setItem(KEY(id), 'closed'); } catch { /* 存不了：本页关掉就算 */ } };

/**
 * 本册正在校对（章条目 `proofing: true`，见 lib/proofing.ts 的 isProofingChapter）时，阅读页顶部的一条窄提示，
 * 请读者到精校页帮忙。点 × 后本标签页内不再出现；没开校对时不渲染（调用方不传 vol）。
 */
export default function ProofingNotice({ id, vol }: { id: string; vol?: string }) {
    const [closed, setClosed] = useState(true);
    useEffect(() => { setClosed(read(id)); }, [id]);
    if (!vol || closed) return null;
    return (
        <div
            role="status"
            data-testid="proofing-notice"
            className="flex items-center justify-center gap-3 px-3 py-1 text-center text-xs"
            style={{ backgroundColor: 'var(--color-tint)', color: 'var(--color-ink-2)', borderBottom: '1px solid var(--color-tint-2)' }}
        >
            <span>本书正在校对，欢迎帮助 →</span>
            <Link href={`/proofing/${encodeURIComponent(id)}/${encodeURIComponent(vol)}`} className="underline">进入校对页</Link>
            <button
                type="button"
                aria-label="关闭提示"
                onClick={() => { write(id); setClosed(true); }}
                className="px-1 text-sm leading-none"
                style={{ color: 'inherit' }}
            >
                ×
            </button>
        </div>
    );
}
