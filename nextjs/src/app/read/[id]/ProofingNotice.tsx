'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const KEY = (id: string) => `kyg-proofing-notice:${id}`;

const read = (id: string): boolean => { try { return sessionStorage.getItem(KEY(id)) === 'closed'; } catch { return false; } };
const write = (id: string): void => { try { sessionStorage.setItem(KEY(id), 'closed'); } catch { /* 存不了：本页关掉就算 */ } };

/**
 * 本章正在校对（章条目 `proofing: true`，见 lib/proofing.ts 的 isProofingChapter）时，阅读器正上方的一条邀请：
 * 朱印「校」＋一句话＋「参与校对」按钮，请读者到精校页帮忙。点 × 后本标签页内不再出现；没开校对时不渲染（调用方不传 vol）。
 * 放在站点页头之下、阅读器书名栏之上：读者打开这一章第一眼就能看到，又不挤进阅读器自己的工具栏。
 */
export default function ProofingNotice({ id, vol }: { id: string; vol?: string }) {
    const [closed, setClosed] = useState(true);
    useEffect(() => { setClosed(read(id)); }, [id]);
    if (!vol || closed) return null;
    return (
        <aside
            role="status"
            data-testid="proofing-notice"
            style={{ backgroundColor: 'var(--color-zhu-tint)', borderBottom: '1px solid var(--color-tint-2)', color: 'var(--color-ink)' }}
        >
            <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-2.5 sm:gap-4">
                <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-lg font-bold"
                    style={{ backgroundColor: 'var(--color-zhu)', color: '#fff', fontFamily: 'var(--font-serif, serif)' }}
                >
                    校
                </span>
                <p className="m-0 min-w-0 flex-1 text-[15px] leading-snug">
                    <strong className="font-semibold">这一章正在校对</strong>
                    <span className="hidden sm:inline" style={{ color: 'var(--color-ink-2)' }}>
                        ：机器有几个字拿不准，欢迎对照原图帮我们认一认。
                    </span>
                    <span className="block text-[13px] sm:hidden" style={{ color: 'var(--color-ink-2)' }}>
                        机器有几个字拿不准，欢迎帮忙认一认。
                    </span>
                </p>
                <Link
                    href={`/proofing/${encodeURIComponent(id)}/${encodeURIComponent(vol)}`}
                    className="shrink-0 rounded-md px-3.5 py-1.5 text-[15px] font-medium no-underline transition hover:brightness-110"
                    style={{ backgroundColor: 'var(--color-zhu)', color: '#fff' }}
                >
                    参与校对 →
                </Link>
                <button
                    type="button"
                    aria-label="关闭提示"
                    onClick={() => { write(id); setClosed(true); }}
                    className="shrink-0 rounded px-1.5 text-xl leading-none hover:bg-black/5"
                    style={{ color: 'var(--color-ink-3)' }}
                >
                    ×
                </button>
            </div>
        </aside>
    );
}
