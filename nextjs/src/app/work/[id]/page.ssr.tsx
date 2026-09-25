// G-25 试验（方案 D）：条目页服务端渲染 + ISR。只在 KYG_SSR=1 的全栈构建里存在。
// 目的：量 EdgeOne 全栈模式能否部署、首字节多快、冷启动多慢——不是正式页面。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { SITE_NAME, SITE_URL } from '@/lib/constants';

export const revalidate = 3600; // ISR：渲染结果缓存 1 小时
export const dynamicParams = true;
// 构建时一条都不预生成；首次访问时渲染并缓存（ISR），不占部署文件数
export async function generateStaticParams() {
  return [];
}

const COS = (process.env.NEXT_PUBLIC_COS_BASE || 'https://data.kaiyuanguji.com').replace(/\/$/, '');

type Author = { name?: string; role?: string; dynasty?: string };
type Entry = {
  id: string;
  type: string;
  title?: string;
  authors?: Author[];
  description?: { text?: string } | string;
  juan_count?: number | { number?: number };
  period?: string;
};

async function getEntry(id: string): Promise<Entry | null> {
  if (!/^[0-9a-z]{8,16}$/i.test(id)) return null;
  const latest = await fetch(`${COS}/latest.json`, { next: { revalidate: 300 } }).then((r) => r.json()).catch(() => null);
  const v = latest?.commitId ? `?v=${latest.commitId}` : '';
  const res = await fetch(`${COS}/current/entry/${id}.json${v}`, { next: { revalidate } });
  if (!res.ok) return null;
  return res.json();
}

function descText(e: Entry): string {
  const d = e.description;
  return (typeof d === 'string' ? d : d?.text) || '';
}
function juanOf(e: Entry): number | undefined {
  const j = e.juan_count;
  return typeof j === 'number' ? j : j?.number;
}
function authorLine(e: Entry): string {
  return (e.authors || [])
    .map((a) => [a.dynasty ? `（${a.dynasty}）` : '', a.name, a.role].filter(Boolean).join(''))
    .join('、');
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const e = await getEntry(id);
  if (!e) return { title: '未找到' };
  const desc = descText(e).slice(0, 120);
  return {
    title: e.title,
    description: [authorLine(e), desc].filter(Boolean).join(' · '),
    alternates: { canonical: `/work/${e.id}` },
    openGraph: { title: `${e.title} - ${SITE_NAME}`, description: desc, url: `${SITE_URL}/work/${e.id}`, type: 'book' },
  };
}

export default async function WorkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const e = await getEntry(id);
  if (!e) notFound();
  const desc = descText(e);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: e.title,
    author: (e.authors || []).map((a) => ({ '@type': 'Person', name: a.name })),
    description: desc.slice(0, 500),
    url: `${SITE_URL}/work/${e.id}`,
  };
  return (
    <LayoutWrapper>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <article className="mx-auto max-w-3xl px-5 py-12 leading-relaxed">
        <h1 className="mb-2 text-2xl font-bold">{e.title}</h1>
        {authorLine(e) && <p className="mb-4 text-gray-600">{authorLine(e)}</p>}
        {juanOf(e) ? <p className="mb-4 text-sm text-gray-500">{juanOf(e)} 卷</p> : null}
        {desc && <p className="mb-6 whitespace-pre-wrap">{desc}</p>}
        <a href={`/book-index?id=${e.id}`} className="underline">查看完整详情（版本、资源、整理本）</a>
        <p className="mt-8 text-xs text-gray-400">SSR 试验页 · 渲染于 {new Date().toISOString()}</p>
      </article>
    </LayoutWrapper>
  );
}
