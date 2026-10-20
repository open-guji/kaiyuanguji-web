'use client';

import Link from 'next/link';

export interface ProofBookInfo { title: string; author?: string }

/**
 * 校对页（v0.x）与反馈页（v1.x）共用的页头：先是「返回阅读」，再是书名与状态标，下面一行作者、章名。
 * 两页上方一模一样，只有状态标不同（校对中／读者反馈），读者在两个阶段看到的是同一本书的同一个入口。
 */
export default function ProofHeader({ back, info, sub, badge }: { back: string; info: ProofBookInfo | null; sub?: string; badge: string }) {
    const line = [info?.author, sub].filter(Boolean).join(' · ');
    return (
        <header data-testid="proofing-header" style={{ borderBottom: '1px solid var(--color-tint-2)' }}>
            <div className="mx-auto max-w-[1400px] px-4 pb-4 pt-3">
                <Link href={back} className="inline-flex items-center gap-1 no-underline hover:brightness-95 active:brightness-90"
                    style={{ border: '1px solid #b8ad9a', borderRadius: 6, background: '#fff', color: 'var(--color-ink)', padding: '1px 8px', fontSize: 13, lineHeight: 1.4, boxShadow: '0 1px 0 rgba(0,0,0,0.06)' }}>
                    <span aria-hidden="true">‹</span> 返回阅读
                </Link>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="m-0 text-[26px] font-semibold leading-tight" style={{ fontFamily: 'var(--font-serif)', color: 'var(--color-ink)' }}>
                        {info?.title ?? badge}
                    </h1>
                    <span className="rounded px-2 py-0.5 text-[13px] font-medium" style={{ backgroundColor: 'var(--color-zhu)', color: '#fff' }}>{badge}</span>
                </div>
                {line && <p className="m-0 mt-1 text-[15px]" style={{ color: 'var(--color-ink-2)' }}>{line}</p>}
            </div>
        </header>
    );
}
