import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '内测说明',
  description: '开源古籍现在能用什么、有哪些已知限制、数据会不会变、怎么报问题。',
};

export default function BetaPage() {
  return (
    <LayoutWrapper>
      <article className="mx-auto max-w-3xl px-5 py-12 leading-relaxed text-[var(--color-ink,#222)]">
        <h1 className="mb-6 text-2xl font-bold">内测说明</h1>

        <p className="mb-4">
          开源古籍还在内测阶段，功能与数据都在持续变动。这一页说明现在能用什么、还缺什么、
          数据会不会变，以及遇到问题怎么反馈。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">现在能用什么</h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li>搜索：按书名、作者、分类或来源检索古籍索引</li>
          <li>条目：作品、版本、丛编与相关人物的详情页</li>
          <li>文本：部分古籍的文本（校勘整理或转录）</li>
          <li>反馈：随时提交问题或建议，并能看到处理进展</li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold">已知限制</h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li>阅读器界面正在重新设计，目前的排版与交互还会调整</li>
          <li>全文搜索还没做——目前只能搜到条目和索引，还不能在正文内容里搜词</li>
          <li>古籍影像（扫描图片）还未上线</li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold">怎么报问题</h2>
        <p className="mb-4">
          用页面上的反馈按钮即可，发现错误、缺失资源或有建议都欢迎提交，可以在
          <Link href="/feedback" className="text-[var(--color-vermilion)] underline"> 反馈</Link>
          页看到处理进展。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">数据会不会变</h2>
        <p className="mb-4">
          会。内容真源在 GitHub 上的数据仓库，不是本站页面本身；索引与文本都在持续校对与补充，
          条目内容、统计数字会随之变化。详见
          <Link href="/about" className="text-[var(--color-vermilion)] underline"> 关于</Link>
          页里的仓库链接。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">隐私</h2>
        <p className="mb-4">
          本站收集哪些访问数据、用来做什么、保留多久，见
          <Link href="/privacy" className="text-[var(--color-vermilion)] underline"> 隐私说明</Link>
          页。
        </p>
      </article>
    </LayoutWrapper>
  );
}
