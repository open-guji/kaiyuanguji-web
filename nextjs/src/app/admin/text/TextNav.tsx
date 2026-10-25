'use client';

// 「文本整理」下的小标题：总览＋各领域栏目。侧栏（md 以上）和手机上的页签共用。
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { sectionHref, sectionsOf } from './model';
import { useTextProgress } from './useTextProgress';

export function useTextNavItems() {
  const load = useTextProgress();
  const sections = sectionsOf(load.state === 'ok' ? load.snapshot : null);
  return [
    { key: '', href: '/admin/text', label: '总览' },
    ...sections.map((s) => ({ key: s.section, href: sectionHref(s.section), label: s.title })),
  ];
}

function useActiveKey(): string | null {
  const path = (usePathname() || '').replace(/\/$/, '');
  const sp = useSearchParams();
  if (path === '/admin/text') return '';
  if (path === '/admin/text/section') return sp?.get('s') ?? '';
  return null;
}

/** 侧栏里挂在「文本整理」下面的一列小标题 */
export function TextSideNav() {
  const items = useTextNavItems();
  const active = useActiveKey();
  return (
    <ul className="mt-1 mb-2 ml-3 pl-2 border-l border-gray-200 space-y-0.5">
      {items.map((it) => (
        <li key={it.key || '_'}>
          <Link
            href={it.href}
            className={`block px-2 py-1 rounded text-[13px] ${active === it.key ? 'text-gray-900 font-medium bg-gray-100' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'}`}
          >
            {it.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 手机上：页面顶部一排页签 */
export function TextTabs() {
  const items = useTextNavItems();
  const active = useActiveKey();
  return (
    <div className="md:hidden -mx-4 px-4 overflow-x-auto border-b border-gray-200">
      <div className="flex gap-4 whitespace-nowrap text-sm">
        {items.map((it) => (
          <Link
            key={it.key || '_'}
            href={it.href}
            className={`py-2 -mb-px border-b-2 ${active === it.key ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500'}`}
          >
            {it.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
