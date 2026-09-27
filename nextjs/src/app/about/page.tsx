import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { GITHUB_ORG } from '@/lib/constants';

export const metadata: Metadata = {
  title: '关于开源古籍',
  description: '开源古籍是什么、在做什么、数据从哪里来、以及怎么参与。',
};

const GITHUB_BASE = `https://github.com/${GITHUB_ORG}`;

export default function AboutPage() {
  return (
    <LayoutWrapper>
      <article className="mx-auto max-w-3xl px-5 py-12 leading-relaxed text-[var(--color-ink,#222)]">
        <h1 className="mb-6 text-2xl font-bold">关于开源古籍</h1>

        <p className="mb-4">
          开源古籍是一个把古籍数字化全链路公开出来的项目：从扫描图片，到预处理、版面与字符识别、人工校对，
          到索引与知识关联、排版还原，再到开放发布，每一段的代码与数据都公开在 GitHub 上。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">在做什么</h2>
        <p className="mb-2">目前同时推进三件事：</p>
        <ul className="mb-4 list-disc space-y-2 pl-6">
          <li>
            <strong>古籍目录索引</strong>：汇集历代目录学著录与公开馆藏书目，做一部尽量准确完整、
            可供程序直接调用的在线古籍目录，收录作品、版本、丛编与相关人物。
          </li>
          <li>
            <strong>整理本与全文</strong>：把古籍原文整理成结构化文本，收录已校勘的整理本与全文，
            与目录索引共用同一套编号互相关联。
          </li>
          <li>
            <strong>图片初步数字化</strong>：用自研 OCR 与版面分析模型，让机器先做第一遍识别，
            再靠人工校对把工作量压缩到"只看差异"。
          </li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold">数据来源与许可</h2>
        <p className="mb-4">
          索引数据来自历代目录学著录、公开馆藏书目，以及各类可获取的古籍扫描与文本资源；
          具体来源在每条索引自己的资源字段里逐条标注，可以顺着链接查到出处。
          各开源仓库的许可以仓库内的 LICENSE 文件为准：book-text 仓本身（整理本及本站自行整理的部分）用
          CC0 1.0 Universal；图片数字化引擎 open-guji-cv 仓用 Apache License 2.0；古籍目录索引
          book-index、book-index-draft 两仓目前未在仓库根目录声明许可文件。
        </p>
        <p className="mb-4">
          <strong>全文另有来源许可。</strong>
          站上收录的全文多数转录自第三方，沿用来源的许可，不适用上面的 CC0：
          例如来自维基文库的全文为 CC BY-SA 4.0，来自 Kanripo（漢籍リポジトリ）的全文为 CC BY-SA。
          每部全文的阅读页顶部都标有来源名称、原始链接和许可；转载或再利用这些全文时，
          请按对应许可署名来源并以相同许可发布。
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold">内容真源在 GitHub</h2>
        <p className="mb-2">
          本站呈现的内容不是最终事实来源——GitHub 上的数据仓库才是，本站只是这些数据的一个展示端。
          随时可以去仓库里核对原始数据、看改动历史，或者直接提交修改：
        </p>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li>
            古籍目录索引：
            <a href={`${GITHUB_BASE}/book-index`} target="_blank" rel="noopener noreferrer" className="text-[var(--color-vermilion)] underline">book-index</a>
            （正式）／
            <a href={`${GITHUB_BASE}/book-index-draft`} target="_blank" rel="noopener noreferrer" className="text-[var(--color-vermilion)] underline">book-index-draft</a>
            （草稿）
          </li>
          <li>
            整理本与全文：
            <a href={`${GITHUB_BASE}/book-text`} target="_blank" rel="noopener noreferrer" className="text-[var(--color-vermilion)] underline">book-text</a>
          </li>
          <li>
            图片数字化引擎：
            <a href={`${GITHUB_BASE}/open-guji-cv`} target="_blank" rel="noopener noreferrer" className="text-[var(--color-vermilion)] underline">open-guji-cv</a>
          </li>
          <li>
            更多仓库见组织主页：
            <a href={GITHUB_BASE} target="_blank" rel="noopener noreferrer" className="text-[var(--color-vermilion)] underline">github.com/{GITHUB_ORG}</a>
          </li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold">怎么参与</h2>
        <ul className="mb-4 list-disc space-y-2 pl-6">
          <li>
            用页面上的反馈按钮：发现错误、缺失资源或有建议，随手提交，可以在
            <Link href="/feedback" className="text-[var(--color-vermilion)] underline">反馈</Link>
            页看到处理进展。
          </li>
          <li>
            想深度参与整理、校对或开发：提交反馈时选「想参与/联系」类型，留下联系方式，我们会联系你。
          </li>
          <li>
            也可以直接去上面的 GitHub 仓库提 Issue 或 PR。
          </li>
        </ul>

        <p className="mt-8 text-sm text-secondary">
          内测阶段的功能范围与已知限制见
          <Link href="/beta" className="text-[var(--color-vermilion)] underline"> 内测说明</Link>
          页；隐私相关说明见
          <Link href="/privacy" className="text-[var(--color-vermilion)] underline"> 隐私说明</Link>
          页。
        </p>
      </article>
    </LayoutWrapper>
  );
}
