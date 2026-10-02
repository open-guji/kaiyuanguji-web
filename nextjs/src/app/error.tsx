'use client';

// 站点的错误页（overview#322「第一次打开报错、刷新就好」）。
//
// 原先没有 error.tsx：RSC 导航取数失败、服务端渲染抛错、客户端渲染抛错，读者看到的都是 Next 默认的
// 白底英文「Application error: a client-side exception has occurred」，只能自己想到去刷新。
// 现在：刷新多半就好的错误（网络类、服务端渲染错）自动重新加载一次（lib/auto-retry.ts，同一地址 60 秒内只一次）；
// 其余的、或重试后仍错的，出中文错误页，给「重试」「刷新页面」「回首页」。
// 视觉照 404 页（app/not-found.tsx）。
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import T from '@/i18n/T';
import { reportError } from '@/lib/error-report';
import { reloadPage, shouldAutoRetry, type RetryableError } from '@/lib/auto-retry';

export default function ErrorPage({ error, reset }: { error: RetryableError; reset: () => void }) {
    const [retrying, setRetrying] = useState(true);

    useEffect(() => {
        const auto = shouldAutoRetry(error);
        reportError({
            kind: 'react',
            message: `${error.message || error.name || 'Error'}${error.digest ? ` (digest ${error.digest})` : ''}${auto ? '（已自动重新加载）' : ''}`,
            stack: error.stack,
        });
        if (auto) {
            reloadPage();
            return;
        }
        setRetrying(false);
    }, [error]);

    // 自动重新加载的那一瞬不闪错误页
    if (retrying) return <div className="min-h-[50vh]" aria-busy="true" />;

    return (
        <LayoutWrapper>
            <div className="og-paper mx-auto max-w-xl px-5 py-20 text-center" role="alert">
                <h1 className="mb-3 text-2xl font-bold text-[var(--color-ink)]"><T k="common.error.title" /></h1>
                <p className="mb-8 leading-relaxed text-[var(--color-ink-2)]">
                    <T k="common.error.body" />
                </p>
                <button
                    type="button"
                    onClick={() => reset()}
                    className="inline-block rounded bg-[var(--color-zhu)] px-6 py-2.5 text-white hover:bg-[var(--color-zhu-deep)]"
                >
                    <T k="common.error.retry" />
                </button>
                <p className="mt-6 text-[var(--color-ink-2)]">
                    <button type="button" onClick={() => reloadPage()} className="text-[var(--color-zhu)] underline-offset-4 hover:underline">
                        <T k="common.error.reload" />
                    </button>
                    <span aria-hidden="true" className="mx-3 text-[var(--color-ink-3)]">·</span>
                    <Link href="/" className="text-[var(--color-zhu)] underline-offset-4 hover:underline"><T k="common.notFound.home" /></Link>
                </p>
            </div>
        </LayoutWrapper>
    );
}
