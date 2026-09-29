// 站点自己的 404 页（overview#267 P2-4）。
//
// 任何没有对应路由、或页面调了 notFound() 的地址（/no-such-page、/item/坏id、/catalog?node=zzz）都走这里：
// 站点外壳、中文文案、三个入口。状态码由 Next 保持 404；title 中文、带 noindex（不进搜索引擎）。
// 视觉照 34 卡 §八：一屏只有一个主按钮（回首页），其余入口是文字链接，不加边框和 badge。
import type { Metadata } from 'next';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';

export const metadata: Metadata = {
    title: '找不到这个页面',
    robots: { index: false, follow: false },
};

export default function NotFound() {
    return (
        <LayoutWrapper>
            <div className="mx-auto max-w-xl px-5 py-20 text-center">
                <p className="mb-2 text-sm text-[var(--color-ink-3)]">404</p>
                <h1 className="mb-3 text-2xl font-bold text-[var(--color-ink)]">找不到这个页面</h1>
                <p className="mb-8 leading-relaxed text-[var(--color-ink-2)]">
                    地址可能写错了，或者这一页已经移走。可以从下面几处继续找。
                </p>
                <Link
                    href="/"
                    className="inline-block rounded bg-[var(--color-zhu)] px-6 py-2.5 text-white no-underline hover:bg-[var(--color-zhu-deep)]"
                >
                    回首页
                </Link>
                <p className="mt-6 text-[var(--color-ink-2)]">
                    <Link href="/catalog" className="text-[var(--color-zhu)] underline-offset-4 hover:underline">去古籍总目</Link>
                    <span aria-hidden="true" className="mx-3 text-[var(--color-ink-3)]">·</span>
                    <Link href="/book-index" className="text-[var(--color-zhu)] underline-offset-4 hover:underline">去搜索</Link>
                </p>
            </div>
        </LayoutWrapper>
    );
}
